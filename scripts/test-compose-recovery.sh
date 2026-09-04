#!/usr/bin/env bash
set -euo pipefail

if [[ "${RUN_DOCKER_COMPOSE_RECOVERY_TEST:-}" != "true" ]]; then
  echo "SKIP: set RUN_DOCKER_COMPOSE_RECOVERY_TEST=true to run the disposable Compose recovery test."
  exit 0
fi

compose=(docker compose -f tests/compose/docker-compose.topology-test.yml)
cleanup() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
"${compose[@]}" build
"${compose[@]}" up -d postgres-test
for _ in $(seq 1 45); do
  if pg_isready -h 127.0.0.1 -p 55432 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
"${compose[@]}" run --rm migrate-test
"${compose[@]}" up -d api-test worker-test
for _ in $(seq 1 45); do
  if curl --fail --silent http://127.0.0.1:53110/api/ready >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:53110/api/ready >/dev/null

cookie=$(mktemp)
login=$(curl --fail --silent -c "$cookie" -H 'content-type: application/json' \
  -H 'origin: https://content-generator.vyte.dev' \
  --data '{"email":"operator@example.test","password":"topology-test-operator-password"}' \
  http://127.0.0.1:53110/api/auth/login)
csrf=$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.csrf_token)' "$login")
created=$(curl --fail --silent -b "$cookie" -H 'content-type: application/json' \
  -H "x-csrf-token: $csrf" -H 'origin: https://content-generator.vyte.dev' \
  -H 'Idempotency-Key: compose-recovery-create-1' --data '{"plane_ticket":"MM03-01","primary_keyword":"modern chairs","related_keywords":["designer chairs"],"page_type":"blog","word_count_target":1200,"locales_for_translation":[]}' \
  http://127.0.0.1:53110/api/runs)
run_id=$(node -e 'const d=JSON.parse(process.argv[1]); if(!d.queue_accepted)process.exit(1); process.stdout.write(d.run_id)' "$created")

# Stop before expiry, persist a synthetic crashed lease under the real queue
# constraints, then restart. Recovery must take over this exact durable work.
docker stop compose-worker-test-1 >/dev/null
before_count=$(docker exec compose-postgres-test-1 psql -p 55432 -U postgres -d topology_test -Atc \
  "select count(*) from run_activity_events where run_id='$run_id'")
lease_token=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
docker exec compose-postgres-test-1 psql -p 55432 -U postgres -d topology_test -v ON_ERROR_STOP=1 -c \
  "alter table pipeline_queue_jobs disable trigger pipeline_queue_jobs_state_guard; update pipeline_queue_jobs set state='leased', attempt=2, lease_token='$lease_token', lease_owner='crashed-compose-worker', lease_expires_at=clock_timestamp()-interval '1 second', available_at=clock_timestamp()-interval '1 second' where run_id='$run_id'; alter table pipeline_queue_jobs enable trigger pipeline_queue_jobs_state_guard" >/dev/null
"${compose[@]}" up -d worker-test
for _ in $(seq 1 90); do
  snapshot=$(docker exec compose-postgres-test-1 psql -p 55432 -U postgres -d topology_test -AtF '|' -c \
    "select state,coalesce(lease_owner,''),coalesce(lease_token::text,''),attempt from pipeline_queue_jobs where run_id='$run_id' order by created_at desc limit 1")
  state=${snapshot%%|*}
  [[ "$state" == "operator_action" ]] && break
  sleep 1
done
[[ "$state" == "operator_action" ]] || { echo "queue did not reach the exact recovered terminal state: $snapshot" >&2; exit 1; }
IFS='|' read -r state owner token attempt <<<"$snapshot"
[[ -z "$owner" && -z "$token" && "$attempt" == "3" ]] || { echo "stale lease was not safely cleared: $snapshot" >&2; exit 1; }
count=$(docker exec compose-postgres-test-1 psql -p 55432 -U postgres -d topology_test -Atc \
  "select count(*) from run_activity_events where run_id='$run_id'")
(( count > before_count )) || { echo "restart added no persisted lifecycle activity" >&2; exit 1; }
duplicate_paid=$(docker exec compose-postgres-test-1 psql -p 55432 -U postgres -d topology_test -Atc \
  "select count(*) from (select provider,request_id from provider_usage where run_id='$run_id' and request_id is not null group by provider,request_id having count(*)>1) d")
[[ "$duplicate_paid" == "0" ]] || { echo "duplicate provider work was recorded" >&2; exit 1; }
migration_count=$(docker exec compose-postgres-test-1 psql -p 55432 -U postgres -d topology_test -Atc \
  "select count(*) from drizzle.__drizzle_migrations")
[[ "$migration_count" == "55" ]] || { echo "native Drizzle ledger is incomplete: $migration_count" >&2; exit 1; }
# Prove drift fails closed in the same disposable database, then restore the disposable row.
original_hash=$(docker exec compose-postgres-test-1 psql -p 55432 -U postgres -d topology_test -Atc \
  "select hash from drizzle.__drizzle_migrations order by created_at limit 1")
docker exec compose-postgres-test-1 psql -p 55432 -U postgres -d topology_test -v ON_ERROR_STOP=1 -c \
  "update drizzle.__drizzle_migrations set hash=repeat('0',64) where created_at=(select min(created_at) from drizzle.__drizzle_migrations)" >/dev/null
if "${compose[@]}" run --rm migrate-test >/dev/null 2>&1; then
  echo "migration checksum drift was accepted" >&2
  exit 1
fi
docker exec compose-postgres-test-1 psql -p 55432 -U postgres -d topology_test -v ON_ERROR_STOP=1 -c \
  "update drizzle.__drizzle_migrations set hash='$original_hash' where created_at=(select min(created_at) from drizzle.__drizzle_migrations)" >/dev/null
echo "Compose recovery passed: run=$run_id queue=$state activity=$count; native ledger drift refused"
