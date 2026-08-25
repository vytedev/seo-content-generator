import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  CalibrationCombinedReportSchema,
  CalibrationPostResultSchema,
  CalibrationRunDetailSchema,
  CalibrationSnapshotSchema,
  type CalibrationCombinedReport,
  type CalibrationPostResult,
  type CalibrationRunDetail,
  type CalibrationSnapshot,
} from "../../shared/contracts/calibration.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";

export interface PipelineBinding {
  pipeline_run_id: string;
  final_document_version_id: string;
  export_id: string | null;
  pipeline_outcome: "succeeded" | "blocked";
}
export interface StoredSnapshot {
  id: string;
  snapshot: CalibrationSnapshot;
  binding: PipelineBinding;
}
export interface CalibrationLease {
  token: string;
  owner: string;
}
export interface CalibrationRepository {
  createOrReplay(key: string, inputHash: string): Promise<CalibrationRunDetail>;
  claim(id: string, owner: string): Promise<CalibrationLease | null>;
  getRun(id: string): Promise<CalibrationRunDetail>;
  listRuns(): Promise<CalibrationRunDetail[]>;
  setState(
    id: string,
    lease: CalibrationLease,
    status: CalibrationRunDetail["status"],
    checkpoint: CalibrationRunDetail["checkpoint"],
    error?: "CALIBRATION_OPERATION_FAILED" | null,
  ): Promise<void>;
  saveSnapshot(
    runId: string,
    lease: CalibrationLease,
    snapshot: CalibrationSnapshot,
    binding: PipelineBinding,
  ): Promise<StoredSnapshot>;
  getSnapshots(id: string): Promise<StoredSnapshot[]>;
  saveResult(
    runId: string,
    lease: CalibrationLease,
    snapshotId: string,
    result: CalibrationPostResult,
    hash: string,
  ): Promise<void>;
  getResults(id: string): Promise<CalibrationPostResult[]>;
  saveCombined(
    id: string,
    lease: CalibrationLease,
    report: CalibrationCombinedReport,
    hash: string,
  ): Promise<void>;
  getCombined(id: string): Promise<CalibrationCombinedReport>;
  createReferenceVersions(
    id: string,
  ): Promise<
    Array<{ reference_version_id: string; editorial_status: "pending_editorial_approval" }>
  >;
}

export class PostgresCalibrationRepository implements CalibrationRepository {
  constructor(
    private readonly pool: Pool,
    private readonly leaseMs = 60_000,
  ) {}
  private async detail(
    id: string,
    client: Pool | PoolClient = this.pool,
  ): Promise<CalibrationRunDetail> {
    const row = (
      await client.query<any>(
        `select r.*,
      (select count(*) from calibration_run_snapshots s where s.calibration_run_id=r.id) snapshot_count,
      (select count(*) from calibration_results x where x.calibration_run_id=r.id) result_count,
      exists(select 1 from calibration_reports p where p.calibration_run_id=r.id) has_combined_report
      from calibration_runs r where r.id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new NotFoundError("Calibration run was not found.");
    const { lease_token: _leaseToken, ...safeRow } = row;
    return CalibrationRunDetailSchema.parse({
      ...safeRow,
      snapshot_count: Number(row.snapshot_count),
      result_count: Number(row.result_count),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      lease_expires_at: row.lease_expires_at?.toISOString() ?? null,
    });
  }
  async createOrReplay(key: string, inputHash: string) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = (
        await client.query<{ id: string; input_hash: string }>(
          "select id,input_hash from calibration_runs where idempotency_key=$1 for update",
          [key],
        )
      ).rows[0];
      if (existing && existing.input_hash !== inputHash)
        throw new ConflictError("Calibration idempotency key was reused with different input.");
      const id =
        existing?.id ??
        (
          await client.query<{ id: string }>(
            "insert into calibration_runs(idempotency_key,input_hash) values($1,$2) returning id",
            [key, inputHash],
          )
        ).rows[0]!.id;
      const detail = await this.detail(id, client);
      await client.query("commit");
      return detail;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async claim(id: string, owner: string): Promise<CalibrationLease | null> {
    const token = randomUUID();
    const row = (
      await this.pool.query(
        `update calibration_runs set lease_token=$3,lease_owner=$2,lease_expires_at=clock_timestamp()+$4::interval,updated_at=clock_timestamp()
      where id=$1 and status<>'succeeded' and (lease_token is null or lease_expires_at<=clock_timestamp()) returning id`,
        [id, owner, token, `${this.leaseMs} milliseconds`],
      )
    ).rows[0];
    if (!row) {
      const run = await this.getRun(id);
      if (run.status === "succeeded") return null;
      throw new ConflictError("Calibration run is already leased.");
    }
    return { token, owner };
  }
  getRun(id: string) {
    return this.detail(id);
  }
  async listRuns() {
    const rows = (
      await this.pool.query<{ id: string }>(
        "select id from calibration_runs order by created_at desc",
      )
    ).rows;
    return Promise.all(rows.map(({ id }) => this.detail(id)));
  }
  private async fenced(client: Pool | PoolClient, id: string, lease: CalibrationLease) {
    const row = (
      await client.query(
        "select 1 from calibration_runs where id=$1 and lease_token=$2 and lease_owner=$3 and lease_expires_at>clock_timestamp()",
        [id, lease.token, lease.owner],
      )
    ).rows[0];
    if (!row) throw new ConflictError("Calibration lease is stale.");
  }
  async setState(
    id: string,
    lease: CalibrationLease,
    status: CalibrationRunDetail["status"],
    checkpoint: CalibrationRunDetail["checkpoint"],
    error: "CALIBRATION_OPERATION_FAILED" | null = null,
  ) {
    const release = status === "succeeded" || status === "retryable_failed";
    const result = await this.pool.query(
      `update calibration_runs set status=$4,checkpoint=$5,error=$6,updated_at=clock_timestamp(),lease_token=case when $7 then null else lease_token end,lease_owner=case when $7 then null else lease_owner end,lease_expires_at=case when $7 then null else clock_timestamp()+$8::interval end where id=$1 and lease_token=$2 and lease_owner=$3 and lease_expires_at>clock_timestamp()`,
      [
        id,
        lease.token,
        lease.owner,
        status,
        checkpoint,
        error,
        release,
        `${this.leaseMs} milliseconds`,
      ],
    );
    if (!result.rowCount) throw new ConflictError("Calibration lease is stale.");
  }
  async saveSnapshot(
    runId: string,
    lease: CalibrationLease,
    raw: CalibrationSnapshot,
    binding: PipelineBinding,
  ): Promise<StoredSnapshot> {
    const s = CalibrationSnapshotSchema.parse(raw);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.fenced(client, runId, lease);
      const inserted = (
        await client.query<{ id: string }>(
          `insert into calibration_snapshots(slot,url,canonical_url,http_status,retrieved_at,title,meta_description,published_time,article_markdown,content_hash,safe_metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) on conflict(slot,content_hash) do nothing returning id`,
          [
            s.slot,
            s.url,
            s.canonical_url,
            s.http_status,
            s.retrieved_at,
            s.title,
            s.meta_description,
            s.published_time,
            s.article_markdown,
            s.content_hash,
            JSON.stringify(s.safe_metadata),
          ],
        )
      ).rows[0];
      const id =
        inserted?.id ??
        (
          await client.query<{ id: string }>(
            "select id from calibration_snapshots where slot=$1 and content_hash=$2",
            [s.slot, s.content_hash],
          )
        ).rows[0]!.id;
      await client.query(
        `insert into calibration_run_snapshots(calibration_run_id,snapshot_id,slot,pipeline_run_id,final_document_version_id,export_id,pipeline_outcome) values($1,$2,$3,$4,$5,$6,$7) on conflict(calibration_run_id,slot) do nothing`,
        [
          runId,
          id,
          s.slot,
          binding.pipeline_run_id,
          binding.final_document_version_id,
          binding.export_id,
          binding.pipeline_outcome,
        ],
      );
      await client.query("commit");
      return { id, snapshot: s, binding };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async getSnapshots(id: string): Promise<StoredSnapshot[]> {
    const rows = (
      await this.pool.query<any>(
        `select s.*,rs.pipeline_run_id,rs.final_document_version_id,rs.export_id,rs.pipeline_outcome from calibration_run_snapshots rs join calibration_snapshots s on s.id=rs.snapshot_id where rs.calibration_run_id=$1 order by rs.slot`,
        [id],
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      snapshot: CalibrationSnapshotSchema.parse({
        slot: r.slot,
        url: r.url,
        canonical_url: r.canonical_url,
        http_status: r.http_status,
        retrieved_at: r.retrieved_at.toISOString(),
        title: r.title,
        meta_description: r.meta_description,
        published_time: r.published_time.toISOString(),
        article_markdown: r.article_markdown,
        content_hash: r.content_hash,
        safe_metadata: r.safe_metadata,
      }),
      binding: {
        pipeline_run_id: r.pipeline_run_id,
        final_document_version_id: r.final_document_version_id,
        export_id: r.export_id,
        pipeline_outcome: r.pipeline_outcome,
      },
    }));
  }
  async saveResult(
    runId: string,
    lease: CalibrationLease,
    snapshotId: string,
    raw: CalibrationPostResult,
    hash: string,
  ) {
    const result = CalibrationPostResultSchema.parse(raw);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.fenced(client, runId, lease);
      await client.query(
        `insert into calibration_results(calibration_run_id,snapshot_id,slot,result_hash,report) values($1,$2,$3,$4,$5::jsonb) on conflict(calibration_run_id,slot) do nothing`,
        [runId, snapshotId, result.slot, hash, JSON.stringify(result)],
      );
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  async getResults(id: string) {
    const rows = (
      await this.pool.query<{ report: unknown }>(
        "select report from calibration_results where calibration_run_id=$1 order by slot",
        [id],
      )
    ).rows;
    if (!rows.length) await this.detail(id);
    return rows.map(({ report }) => CalibrationPostResultSchema.parse(report));
  }
  async saveCombined(
    id: string,
    lease: CalibrationLease,
    raw: CalibrationCombinedReport,
    hash: string,
  ) {
    const report = CalibrationCombinedReportSchema.parse(raw);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.fenced(client, id, lease);
      await client.query(
        "insert into calibration_reports(calibration_run_id,report_hash,report) values($1,$2,$3::jsonb) on conflict(calibration_run_id) do nothing",
        [id, hash, JSON.stringify(report)],
      );
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  async getCombined(id: string) {
    const row = (
      await this.pool.query<{ report: unknown }>(
        "select report from calibration_reports where calibration_run_id=$1",
        [id],
      )
    ).rows[0];
    if (!row) {
      await this.detail(id);
      throw new NotFoundError("Combined calibration report is not available.");
    }
    return CalibrationCombinedReportSchema.parse(row.report);
  }
  async createReferenceVersions(id: string) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const readiness = (
        await client.query<{
          status: string;
          snapshot_count: number;
          result_count: number;
          report_count: number;
          complete_binding_count: number;
        }>(
          `select r.status,
            (select count(*)::int from calibration_run_snapshots s where s.calibration_run_id=r.id) snapshot_count,
            (select count(*)::int from calibration_results x where x.calibration_run_id=r.id) result_count,
            (select count(*)::int from calibration_reports p where p.calibration_run_id=r.id) report_count,
            (select count(*)::int from calibration_run_snapshots s where s.calibration_run_id=r.id and s.pipeline_run_id is not null and s.final_document_version_id is not null and s.pipeline_outcome is not null) complete_binding_count
          from calibration_runs r where r.id=$1 for update`,
          [id],
        )
      ).rows[0];
      if (!readiness) throw new NotFoundError("Calibration run was not found.");
      if (
        readiness.status !== "succeeded" ||
        readiness.snapshot_count !== 2 ||
        readiness.result_count !== 2 ||
        readiness.report_count !== 1 ||
        readiness.complete_binding_count !== 2
      )
        throw new ConflictError("Calibration run is not complete enough for reference proposals.");
      const results = (
        await client.query<{ report: unknown }>(
          "select report from calibration_results where calibration_run_id=$1 order by slot",
          [id],
        )
      ).rows.map(({ report }) => CalibrationPostResultSchema.parse(report));
      const repeatedAmbiguities = new Map<string, Set<number>>();
      for (const result of results) {
        for (const observation of result.observations) {
          if (observation.classification !== "missing_or_ambiguous_reference_guidance") continue;
          const slots = repeatedAmbiguities.get(observation.dimension) ?? new Set<number>();
          slots.add(result.slot);
          repeatedAmbiguities.set(observation.dimension, slots);
        }
      }
      const crossPostProposals = [...repeatedAmbiguities.entries()]
        .filter(([, slots]) => slots.size === 2)
        .map(([dimension]) => ({
          reference_kind:
            dimension === "attribution" || dimension === "factual_figures"
              ? ("fact_checking_rules" as const)
              : ("pipeline_workflow" as const),
          rationale: `Both calibration posts show missing or ambiguous ${dimension.replaceAll("_", " ")} guidance. This proposal records the evidence without weakening deterministic rules.`,
          proposed_markdown: `## Calibration clarification: ${dimension.replaceAll("_", " ")}\n\nEvidence from both provisional calibration posts requires editorial clarification. Keep provenance and designer attribution hard flagged, keep unresolved claims unverified, and do not introduce numeric keyword thresholds.`,
        }));
      if (!crossPostProposals.length)
        throw new ConflictError(
          "Calibration produced no repeated evidence for a reference proposal.",
        );
      const created: Array<{
        reference_version_id: string;
        editorial_status: "pending_editorial_approval";
      }> = [];
      for (const proposal of crossPostProposals) {
        const document = (
          await client.query<{ id: string }>(
            "select id from reference_documents where kind=$1 for update",
            [proposal.reference_kind],
          )
        ).rows[0];
        if (!document) throw new ConflictError("Reference slot is unavailable.");
        const hash = (await import("node:crypto"))
          .createHash("sha256")
          .update(proposal.proposed_markdown)
          .digest("hex");
        const prior = (
          await client.query<{ reference_version_id: string }>(
            "select reference_version_id from calibration_reference_proposals where calibration_run_id=$1 and proposal_hash=$2",
            [id, hash],
          )
        ).rows[0];
        let versionId = prior?.reference_version_id;
        if (!versionId) {
          versionId = (
            await client.query<{ id: string }>(
              `insert into reference_versions(reference_document_id,version,body_markdown,content_hash,size_bytes,editorial_status) select $1,coalesce(max(version),0)+1,$2,$3,$4,'pending_editorial_approval' from reference_versions where reference_document_id=$1 returning id`,
              [
                document.id,
                proposal.proposed_markdown,
                hash,
                Buffer.byteLength(proposal.proposed_markdown),
              ],
            )
          ).rows[0]!.id;
          await client.query(
            "insert into calibration_reference_proposals(calibration_run_id,reference_document_id,reference_version_id,proposal_hash) values($1,$2,$3,$4) on conflict(calibration_run_id,proposal_hash) do nothing",
            [id, document.id, versionId, hash],
          );
        }
        created.push({
          reference_version_id: versionId,
          editorial_status: "pending_editorial_approval",
        });
      }
      await client.query("commit");
      return created;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
}
