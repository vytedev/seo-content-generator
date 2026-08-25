import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  LOCAL_BASELINE_STATUS,
  PROVISIONAL_CALIBRATION_POSTS,
  TASK_DERIVED_REFERENCE_DRAFTS,
} from "../src/db/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to import the local baseline");

const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
  await client.query("BEGIN");

  for (const draft of TASK_DERIVED_REFERENCE_DRAFTS) {
    const body = await readFile(new URL(`../${draft.file}`, import.meta.url), "utf8");
    const contentHash = createHash("sha256").update(body).digest("hex");
    if (contentHash !== draft.contentHash) {
      throw new Error(`Draft hash differs from the DB allow-list: ${draft.kind}`);
    }
    const sizeBytes = Buffer.byteLength(body, "utf8");
    const documentResult = await client.query<{ id: string }>(
      "SELECT id FROM reference_documents WHERE kind = $1::reference_document_kind",
      [draft.kind],
    );
    const documentId = documentResult.rows[0]?.id;
    if (!documentId) throw new Error(`Reference slot is missing: ${draft.kind}`);

    const existing = await client.query<{
      id: string;
      content_hash: string;
      editorial_status: string;
    }>(
      "SELECT id, content_hash, editorial_status FROM reference_versions WHERE reference_document_id = $1 AND version = $2",
      [documentId, draft.version],
    );
    if (
      existing.rows.length > 0 &&
      (existing.rows[0]?.content_hash !== contentHash ||
        existing.rows[0]?.editorial_status !== LOCAL_BASELINE_STATUS)
    ) {
      throw new Error(
        `Immutable version ${draft.version} or editorial status conflict for ${draft.kind}`,
      );
    }

    const versionResult = existing.rows.length
      ? existing
      : await client.query<{ id: string; content_hash: string; editorial_status: string }>(
          `INSERT INTO reference_versions
            (reference_document_id, version, body_markdown, content_hash, size_bytes, editorial_status)
           VALUES ($1, $2, $3, $4, $5, $6::editorial_status)
           RETURNING id, content_hash, editorial_status`,
          [documentId, draft.version, body, contentHash, sizeBytes, LOCAL_BASELINE_STATUS],
        );
    const versionId = versionResult.rows[0]?.id;
    if (!versionId) throw new Error(`Version import failed: ${draft.kind}`);

    await client.query(
      `INSERT INTO reference_activations (reference_document_id, reference_version_id, provisional_local)
       VALUES ($1, $2, true)
       ON CONFLICT (reference_document_id) DO UPDATE
       SET reference_version_id = EXCLUDED.reference_version_id,
           provisional_local = true, activated_at = now()`,
      [documentId, versionId],
    );
  }

  for (const post of PROVISIONAL_CALIBRATION_POSTS) {
    const existing = await client.query<{
      url: string;
      canonical_url: string;
      title: string;
      http_status: number;
      selection_reason: string;
      status: string;
    }>(
      `SELECT url, canonical_url, title, http_status, selection_reason, status
       FROM calibration_posts WHERE slot = $1`,
      [post.slot],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (
        row?.url !== post.url ||
        row.canonical_url !== post.canonicalUrl ||
        row.title !== post.title ||
        row.http_status !== post.httpStatus ||
        row.selection_reason !== post.selectionReason ||
        row.status !== post.status
      ) {
        throw new Error(`Calibration slot conflict: ${post.slot}`);
      }
      continue;
    }

    await client.query(
      `INSERT INTO calibration_posts
        (slot, url, canonical_url, title, http_status, selection_reason, status, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::calibration_status, now())`,
      [
        post.slot,
        post.url,
        post.canonicalUrl,
        post.title,
        post.httpStatus,
        post.selectionReason,
        post.status,
      ],
    );
  }

  await client.query("COMMIT");
  console.log(
    JSON.stringify(
      {
        importedReferenceVersions: TASK_DERIVED_REFERENCE_DRAFTS.length,
        editorialStatus: LOCAL_BASELINE_STATUS,
        localActivations: TASK_DERIVED_REFERENCE_DRAFTS.length,
        calibrationPosts: PROVISIONAL_CALIBRATION_POSTS.length,
        productionApproved: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
