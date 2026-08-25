import fs from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_DERIVED_REFERENCE_DRAFTS } from "../src/db/reference-drafts.js";
import { PostgresReferenceApprovalRepository } from "../src/server/repositories/reference-approval-repository.js";

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const admin = url ? new pg.Pool({ connectionString: url }) : null;
const databaseName = `reference_approval_${process.pid}_${Date.now()}`;
const quotedDatabase = `"${databaseName.replaceAll('"', '""')}"`;
let pool: pg.Pool | null = null;

async function applyMigration(target: pg.Pool, path: string) {
  const sql = fs.readFileSync(path, "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim())) {
    if (statement) await target.query(statement);
  }
}

integration("reference activation and listing truthfulness", () => {
  beforeAll(async () => {
    await admin!.query(`create database ${quotedDatabase}`);
    const migratedUrl = new URL(url!);
    migratedUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: migratedUrl.toString() });
    // Apply every migration, not a fixed prefix: the activation allowlist has
    // advanced since 0014 (keyword_placement_guidelines is now version 2), so a
    // pinned range tests a schema that no longer exists.
    const migrations = fs
      .readdirSync("drizzle")
      .filter((entry) => entry.endsWith(".sql"))
      .sort();
    for (const migration of migrations) await applyMigration(pool, `drizzle/${migration}`);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${quotedDatabase} with (force)`);
      await admin.end();
    }
  });

  it("rejects arbitrary pending baselines and activates every exact known baseline", async () => {
    await pool!.query(
      "insert into reference_documents(kind,title) select kind,kind::text from unnest(enum_range(null::reference_document_kind)) kind",
    );
    await pool!.query("begin");
    const arbitrary = await pool!.query<{ document_id: string; version_id: string }>(
      `with d as (select id from reference_documents where kind='blog_writing_guide'),
       v as (insert into reference_versions(reference_document_id,version,body_markdown,content_hash,size_bytes)
         select id,1,'arbitrary',repeat('f',64),9 from d returning id,reference_document_id)
       select reference_document_id document_id,id version_id from v`,
    );
    await expect(
      pool!.query(
        "insert into reference_activations(reference_document_id,reference_version_id,provisional_local) values($1,$2,true)",
        [arbitrary.rows[0]!.document_id, arbitrary.rows[0]!.version_id],
      ),
    ).rejects.toThrow(/exact task-derived local baseline/);

    await pool!.query("rollback");

    for (const draft of TASK_DERIVED_REFERENCE_DRAFTS) {
      const document = await pool!.query<{ id: string }>(
        "select id from reference_documents where kind=$1::reference_document_kind",
        [draft.kind],
      );
      const version = await pool!.query<{ id: string }>(
        `insert into reference_versions(reference_document_id,version,body_markdown,content_hash,size_bytes)
         values($1,$2,'known baseline',$3,14) returning id`,
        [document.rows[0]!.id, draft.version, draft.contentHash],
      );
      await pool!.query(
        "insert into reference_activations(reference_document_id,reference_version_id,provisional_local) values($1,$2,true)",
        [document.rows[0]!.id, version.rows[0]!.id],
      );
    }
    const count = await pool!.query<{ count: number }>(
      "select count(*)::int count from reference_activations where provisional_local",
    );
    expect(count.rows[0]!.count).toBe(6);
  });

  it("keeps editorial status separate from attestation and effective approval state", async () => {
    const document = await pool!.query<{ id: string }>(
      "select id from reference_documents where kind='blog_writing_guide'",
    );
    const replaced = await pool!.query<{ id: string }>(
      `insert into reference_versions(reference_document_id,version,body_markdown,content_hash,size_bytes,editorial_status)
       values($1,2,'replaced',repeat('a',64),8,'replaced') returning id`,
      [document.rows[0]!.id],
    );
    const approved = await pool!.query<{ id: string }>(
      `insert into reference_versions(reference_document_id,version,body_markdown,content_hash,size_bytes,editorial_status)
       values($1,3,'approved',repeat('b',64),8,'approved') returning id`,
      [document.rows[0]!.id],
    );
    const attestation = await pool!.query<{ id: string }>(
      `insert into reference_approval_attestations(reference_version_id,recorder_identity,approver_identity,evidence_reference)
       values($1,'local operator','External reviewer','evidence') returning id`,
      [approved.rows[0]!.id],
    );
    await pool!.query(
      `insert into reference_attestation_verifications(attestation_id,verifier_identity,authority_state,evidence_reference)
       values($1,'Trusted verifier','trusted_verified','verification evidence')`,
      [attestation.rows[0]!.id],
    );
    await pool!.query(
      "update reference_activations set reference_version_id=$1,provisional_local=false where reference_document_id=$2",
      [approved.rows[0]!.id, document.rows[0]!.id],
    );

    const listed = await new PostgresReferenceApprovalRepository(pool!).listVersions();
    const approvedRow = listed.versions.find((row) => row.version_id === approved.rows[0]!.id);
    const replacedRow = listed.versions.find((row) => row.version_id === replaced.rows[0]!.id);
    expect(approvedRow).toMatchObject({
      editorial_status: "approved",
      attestation_state: "trusted_verified",
      effective_approval_status: "trusted_verified_active",
    });
    expect(replacedRow).toMatchObject({
      editorial_status: "replaced",
      attestation_state: "none",
      effective_approval_status: "not_approved",
    });
  });
});
