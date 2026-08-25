import { Client } from "pg";
import { generateReferenceSeedSql } from "../src/db/reference-seed.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to seed local reference slots");
}

const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query(generateReferenceSeedSql());
  const result = await client.query<{ kind: string; mapping_count: string }>(`
    SELECT document.kind::text AS kind, count(mapping.step)::text AS mapping_count
    FROM reference_documents document
    LEFT JOIN substep_reference_map mapping ON mapping.reference_document_id = document.id
    GROUP BY document.kind
    ORDER BY document.kind
  `);
  await client.query("COMMIT");
  console.log(JSON.stringify({ referenceSlots: result.rows }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
