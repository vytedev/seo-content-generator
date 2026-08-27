import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ExportRenderInputSchema,
  ExportRenderResultSchema,
  GoogleDocsExportSchema,
  renderExport,
  type ExportRenderInput,
  type ExportRenderResult,
  type GoogleDocsAdapter,
  type GoogleDocsExport,
} from "../../shared/export.js";
import { canonicalHash, contentHash } from "../../shared/milestone-two.js";
import { CoherenceResponseSchema } from "../../shared/milestone-four.js";
import { logger } from "../logger.js";
import {
  DeterministicManifestSchema,
  DeterministicRunResultSchema,
  deterministicHash,
  validateDeterministicBaseline,
  validateDeterministicManifest,
} from "../../shared/deterministic-run.js";

export interface DurableExportRequest {
  run_id: string;
  step_execution_id: string;
  fencing_token: string;
  document_version_id: string;
  idempotency_key: string;
  render_input: ExportRenderInput;
  rendered: ExportRenderResult;
}

function exportFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/not connected|expired|access required|stored google connection/i.test(message))
    return "google_connection";
  if (/idempotency conflict/i.test(message)) return "idempotency_conflict";
  if (/fencing token/i.test(message)) return "stale_fence";
  if (/final blocker gate/i.test(message)) return "final_gate";
  // Post-batch structural verification, not an API rejection.
  if (/google docs export structure mismatch/i.test(message)) return "google_structure";
  if (/template/i.test(message)) return "template_integrity";
  if (/manifest|hash|reconstruct|stored bytes|document version/i.test(message))
    return "export_integrity";
  if (/google docs export failed/i.test(message)) return "google_api";
  return "internal_preflight";
}

interface Operation {
  id: string;
  input_hash: string;
  provider_idempotency_key: string;
  status: "pending" | "succeeded" | "failed";
  external_document_id: string | null;
  external_url: string | null;
}

/** Durable export lifecycle. No external API is called while a database transaction is open. */
export class PostgresGoogleDocsExportService {
  constructor(
    private readonly pool: Pool,
    private readonly adapter: GoogleDocsAdapter,
  ) {}

  async export(input: DurableExportRequest): Promise<GoogleDocsExport> {
    let stage = "input_validation";
    const renderInput = ExportRenderInputSchema.parse(input.render_input);
    let rendered = ExportRenderResultSchema.parse(input.rendered);
    const reconstructed = renderExport(renderInput);
    if (
      reconstructed.render_hash !== rendered.render_hash ||
      reconstructed.content_hash !== rendered.content_hash
    ) {
      throw new Error("Rendered export does not exactly reconstruct from immutable inputs");
    }
    if (contentHash(rendered.markdown) !== rendered.content_hash) {
      throw new Error("Rendered export hash does not match stored bytes");
    }

    const lockClient = await this.pool.connect();
    const lockIdentity = `${input.run_id}:${input.document_version_id}:google_docs`;
    try {
      await lockClient.query("select pg_advisory_lock(hashtextextended($1,0))", [lockIdentity]);
      stage = "preflight_reservation";
      const reservation = await this.reserve(lockClient, input, rendered, renderInput);
      const operation = reservation.operation;
      rendered = reservation.rendered;
      if (operation.status === "succeeded") {
        return GoogleDocsExportSchema.parse({
          external_document_id: operation.external_document_id,
          external_url: operation.external_url,
          replayed: true,
        });
      }

      try {
        // Deliberately outside a transaction. This key is canonical across request-key retries.
        stage = "google_provider";
        const created = operation.external_document_id
          ? GoogleDocsExportSchema.parse({
              external_document_id: operation.external_document_id,
              external_url: operation.external_url,
              replayed: true,
            })
          : GoogleDocsExportSchema.parse(
              await this.adapter.export(operation.provider_idempotency_key, rendered),
            );
        stage = "external_identity_checkpoint";
        await this.recordExternalIdentity(lockClient, operation.id, created);
        stage = "final_persistence";
        return await this.finalise(lockClient, operation, input, rendered, created);
      } catch (error) {
        await this.recordFailure(lockClient, operation.id, error);
        throw error;
      }
    } catch (error) {
      logger.warn("google_docs_export.failed", {
        run_id: input.run_id,
        document_version_id: input.document_version_id,
        stage,
        category: exportFailureCategory(error),
      });
      throw error;
    } finally {
      await lockClient.query("select pg_advisory_unlock(hashtextextended($1,0))", [lockIdentity]);
      lockClient.release();
    }
  }

  private async reserve(
    client: PoolClient,
    input: DurableExportRequest,
    rendered: ExportRenderResult,
    renderInput: ExportRenderInput,
  ): Promise<{ operation: Operation; rendered: ExportRenderResult }> {
    await client.query("begin");
    try {
      const document = await client.query<{
        content_hash: string;
        body_text: string;
        plane_ticket: string;
      }>(
        `select d.content_hash,a.body_text,r.plane_ticket
         from document_versions d
         join artifacts a on a.id=d.artifact_id and a.run_id=d.run_id
         join runs r on r.id=d.run_id
         where d.id=$1 and d.run_id=$2
         for update of r`,
        [input.document_version_id, input.run_id],
      );
      const documentRow = document.rows[0];
      if (!documentRow) throw new Error("Document version does not belong to run");
      const storedDraft = JSON.parse(documentRow.body_text) as {
        title?: unknown;
        markdown?: unknown;
      };
      if (
        storedDraft.title !== rendered.title ||
        typeof storedDraft.markdown !== "string" ||
        !rendered.markdown.includes(storedDraft.markdown)
      ) {
        throw new Error("Rendered export does not match the selected document version");
      }
      const templateRows = await client.query<{
        id: string;
        template_id: string;
        version: string;
        status: string;
        body: unknown;
        content_hash: string;
      }>(
        `select id,template_id,version,status,body,content_hash from content_templates
         where (id=$1 and template_id=$2 and version=$3) or (id=$4 and template_id=$5 and version=$6)`,
        [
          renderInput.writer_template!.row_id,
          renderInput.writer_template!.template_id,
          renderInput.writer_template!.version,
          renderInput.schema_template!.row_id,
          renderInput.schema_template!.registry_id,
          renderInput.schema_template!.version,
        ],
      );
      const persistedTemplates = new Map(templateRows.rows.map((row) => [row.id, row]));
      for (const template of [renderInput.writer_template!, renderInput.schema_template!]) {
        const row = persistedTemplates.get(template.row_id);
        if (
          !row ||
          row.status !== template.status ||
          row.content_hash !== template.body_hash ||
          row.content_hash !== contentHash(JSON.stringify(row.body)) ||
          (row.status === "approved") !== (template.policy === "authorised")
        )
          throw new Error("Export content template does not match the exact persisted row");
      }
      const gate = await client.query<{
        manifest: unknown;
        baseline_result: unknown;
        rerun_result: unknown;
        rerun_result_hash: string;
        baseline_manifest_hash: string;
        retained_blockers: number;
        introduced_blockers: number;
        coherence_complete: boolean;
        coherence_response: unknown;
        coherence_response_hash: string | null;
        coherence_blockers: number;
      }>(
        `select m.manifest,m.result baseline_result,d.result rerun_result,
           d.result_hash rerun_result_hash,d.baseline_manifest_hash,
           d.retained_blockers,d.introduced_blockers,
           exists(
             select 1 from coherence_checkpoints c
             join provider_operations p on p.operation_id=c.operation_id
               and p.run_id=c.run_id and p.document_version_id=c.document_version_id
               and p.step_execution_id=c.producing_step_execution_id
               and p.operation='final_coherence_export' and p.content_hash=c.response_hash
             join step_executions producer on producer.id=c.producing_step_execution_id
               and producer.run_id=c.run_id and producer.step='final_coherence_export'
             join step_executions current_execution on current_execution.id=$3
               and current_execution.run_id=c.run_id
               and current_execution.step='final_coherence_export'
               and current_execution.status='running'
               and current_execution.lease_token=$4
               and current_execution.lease_expires_at>clock_timestamp()
             join runs current_run on current_run.id=c.run_id
               and current_run.current_step='final_coherence_export'
               and current_run.status='running'
             where c.run_id=d.run_id and c.document_version_id=d.document_version_id
               and c.status='checkpointed'
               and c.response is not null and c.response_hash is not null
               and not exists(
                 select 1 from step_executions newer
                 where newer.run_id=current_execution.run_id
                   and newer.step='final_coherence_export'
                   and newer.attempt>current_execution.attempt
               )
               and not exists(
                 select 1 from jsonb_array_elements(coalesce(c.response->'findings','[]'::jsonb)) finding
                 where finding->>'severity'='blocker'
               )
               and (
                 c.producing_step_execution_id=$3
                 or exists(
                   select 1 from coherence_recoveries recovery
                   where recovery.operation_id=c.operation_id
                     and recovery.run_id=c.run_id
                     and recovery.document_version_id=c.document_version_id
                     and recovery.producing_step_execution_id=c.producing_step_execution_id
                     and recovery.recovery_step_execution_id=current_execution.id
                     and recovery.outcome='export'
                 )
               )
           ) coherence_complete,
           (select c.response from coherence_checkpoints c
             where c.run_id=d.run_id and c.document_version_id=d.document_version_id
               and c.status='checkpointed' and (
                 c.producing_step_execution_id=$3 or exists(
                   select 1 from coherence_recoveries recovery
                   where recovery.operation_id=c.operation_id and recovery.run_id=c.run_id
                     and recovery.document_version_id=c.document_version_id
                     and recovery.producing_step_execution_id=c.producing_step_execution_id
                     and recovery.recovery_step_execution_id=$3 and recovery.outcome='export'
                 )
               )) coherence_response,
           (select c.response_hash from coherence_checkpoints c
             where c.run_id=d.run_id and c.document_version_id=d.document_version_id
               and c.status='checkpointed' and (
                 c.producing_step_execution_id=$3 or exists(
                   select 1 from coherence_recoveries recovery
                   where recovery.operation_id=c.operation_id and recovery.run_id=c.run_id
                     and recovery.document_version_id=c.document_version_id
                     and recovery.producing_step_execution_id=c.producing_step_execution_id
                     and recovery.recovery_step_execution_id=$3 and recovery.outcome='export'
                 )
               )) coherence_response_hash,
           (select count(*)::int from findings f
             join step_executions e on e.id=f.step_execution_id and e.run_id=f.run_id
             where f.run_id=d.run_id and f.document_version_id=d.document_version_id
               and f.severity='blocker' and e.step='final_coherence_export') coherence_blockers
         from deterministic_reruns d join deterministic_manifests m on m.run_id=d.run_id
         where d.run_id=$1 and d.document_version_id=$2
           and d.document_version_id=(
             select current_document.id from document_versions current_document
             where current_document.run_id=d.run_id order by current_document.revision desc limit 1
           )`,
        [input.run_id, input.document_version_id, input.step_execution_id, input.fencing_token],
      );
      const finalGate = gate.rows[0];
      if (!finalGate) throw new Error("Final blocker gate does not permit export");
      const manifest = validateDeterministicManifest(
        DeterministicManifestSchema.parse(finalGate.manifest),
        { run_id: input.run_id },
      );
      validateDeterministicBaseline(manifest, finalGate.baseline_result);
      const rerun = DeterministicRunResultSchema.parse(finalGate.rerun_result);
      const parsedCoherenceResponse = CoherenceResponseSchema.safeParse(
        finalGate.coherence_response,
      );
      const coherenceResponseValid =
        parsedCoherenceResponse.success &&
        finalGate.coherence_response_hash === canonicalHash(parsedCoherenceResponse.data) &&
        parsedCoherenceResponse.data.findings.every((finding) => finding.severity !== "blocker");
      const { result_hash: _, ...rerunCore } = rerun;
      const rerunValid =
        rerun.result_hash === deterministicHash(rerunCore) &&
        rerun.result_hash === finalGate.rerun_result_hash &&
        rerun.findings_hash === deterministicHash(rerun.findings) &&
        rerun.baseline_manifest_hash === manifest.manifest_hash &&
        finalGate.baseline_manifest_hash === manifest.manifest_hash &&
        rerun.config_hash === manifest.config_hash &&
        rerun.document_id === input.document_version_id &&
        rerun.document_hash === documentRow.content_hash;
      if (
        !rerunValid ||
        !coherenceResponseValid ||
        !finalGate.coherence_complete ||
        finalGate.coherence_blockers > 0 ||
        finalGate.retained_blockers > 0 ||
        finalGate.introduced_blockers > 0
      )
        throw new Error("Final blocker gate does not permit export");
      const exactLineage = await client.query(
        `select jsonb_build_object(
        'handoff',r.handoff,'run_created_at',r.created_at,'document',jsonb_build_object('id',d.id,'artifact_id',d.artifact_id,'parent_id',d.parent_id,'revision',d.revision,'content_hash',d.content_hash),
        'artifact',jsonb_build_object('id',a.id,'parent_id',a.parent_id,'step_execution_id',a.step_execution_id,'kind',a.kind,'media_type',a.media_type,'content_hash',a.content_hash),
        'rerun',jsonb_build_object('step_execution_id',dr.step_execution_id,'baseline_manifest_hash',dr.baseline_manifest_hash,'result_hash',dr.result_hash,'result',dr.result),
        'coherence',jsonb_build_object('operation_id',cc.operation_id,'producing_step_execution_id',cc.producing_step_execution_id,'request_hash',cc.request_hash,'response_hash',cc.response_hash,'response',cc.response,
          'request',(select body_text::jsonb from artifacts where run_id=r.id and step_execution_id=cc.producing_step_execution_id and kind='coherence_request' limit 1))
        ) value from runs r join document_versions d on d.id=$2 and d.run_id=r.id join artifacts a on a.id=d.artifact_id and a.run_id=d.run_id join deterministic_reruns dr on dr.run_id=d.run_id and dr.document_version_id=d.id join coherence_checkpoints cc on cc.run_id=d.run_id and cc.document_version_id=d.id where r.id=$1`,
        [input.run_id, input.document_version_id],
      );
      const exportManifest = {
        version: "2.0.0",
        run_id: input.run_id,
        document_version_id: input.document_version_id,
        exact_lineage: exactLineage.rows[0]?.value,
        render_input: renderInput,
        writer_template: renderInput.writer_template,
        schema_template: renderInput.schema_template,
        link_artifact: {
          artifact_id: manifest.frozen_context.internal_links_artifact.artifact_id,
          content_hash: manifest.frozen_context.internal_links_artifact.content_hash,
        },
        claim_source_identities: renderInput.claims,
        rejected_disposition_identities: renderInput.rejected_findings,
        export_date: renderInput.export_date,
        coherence_operation: `${input.run_id}:${input.document_version_id}`,
        rerun_hash: rerun.result_hash,
        render_hash: rendered.render_hash,
        content_hash: rendered.content_hash,
      };
      const manifestHash = contentHash(JSON.stringify(exportManifest));
      await client.query(
        `insert into export_manifests(run_id,document_version_id,step_execution_id,manifest_hash,manifest,render_hash,render_content_hash)
        values($1,$2,$3,$4,$5::jsonb,$6,$7) on conflict(run_id,document_version_id) do nothing`,
        [
          input.run_id,
          input.document_version_id,
          input.step_execution_id,
          manifestHash,
          JSON.stringify(exportManifest),
          rendered.render_hash,
          rendered.content_hash,
        ],
      );
      const frozen = await client.query<{ manifest_hash: string; manifest: any }>(
        `select manifest_hash,manifest from export_manifests where run_id=$1 and document_version_id=$2`,
        [input.run_id, input.document_version_id],
      );
      if (frozen.rows[0]?.manifest_hash !== manifestHash)
        throw new Error("Immutable export manifest conflict");
      rendered = renderExport(ExportRenderInputSchema.parse(frozen.rows[0]!.manifest.render_input));
      if (rendered.render_hash !== frozen.rows[0]!.manifest.render_hash)
        throw new Error("Frozen export manifest render hash mismatch");
      const inputHash = this.exportInputHash(
        documentRow.content_hash,
        rendered.content_hash,
        rendered.render_hash,
      );
      const existing = await client.query<Operation>(
        `select id,input_hash,provider_idempotency_key,status,external_document_id,external_url
         from export_operations where run_id=$1 and document_version_id=$2 and destination='google_docs' for update`,
        [input.run_id, input.document_version_id],
      );
      let operation = existing.rows[0];
      if (operation) {
        if (operation.input_hash !== inputHash) throw new Error("Export idempotency conflict");
        if (operation.status !== "succeeded") {
          await this.assertFinalFence(client, input);
          if (operation.status === "failed") {
            await client.query(
              `update export_operations set status='pending',last_error=null,updated_at=clock_timestamp()
               where id=$1`,
              [operation.id],
            );
            operation = { ...operation, status: "pending" };
          }
        }
        await client.query("commit");
        return { operation, rendered };
      }

      await this.assertFinalFence(client, input);
      const providerKey = createHash("sha256")
        .update(`google_docs:${input.run_id}:${input.document_version_id}`)
        .digest("hex");
      operation = (
        await client.query<Operation>(
          `insert into export_operations(run_id,document_version_id,destination,idempotency_key,
             provider_idempotency_key,input_hash,status)
           values($1,$2,'google_docs',$3,$4,$5,'pending')
           returning id,input_hash,provider_idempotency_key,status,external_document_id,external_url`,
          [input.run_id, input.document_version_id, input.idempotency_key, providerKey, inputHash],
        )
      ).rows[0]!;
      await client.query("commit");
      return { operation, rendered };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  private async recordExternalIdentity(
    client: PoolClient,
    operationId: string,
    created: GoogleDocsExport,
  ): Promise<void> {
    await client.query("begin");
    try {
      await client.query(
        `update export_operations set external_document_id=$2,external_url=$3,updated_at=clock_timestamp()
         where id=$1 and status='pending'`,
        [operationId, created.external_document_id, created.external_url],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  private async recordFailure(
    client: PoolClient,
    operationId: string,
    error: unknown,
  ): Promise<void> {
    const message =
      error instanceof Error && error.message.includes("idempotency conflict")
        ? "EXPORT_IDEMPOTENCY_CONFLICT"
        : "EXPORT_PROVIDER_FAILED";
    await client.query(
      `update export_operations set status='failed',last_error=$2,updated_at=clock_timestamp()
       where id=$1 and status<>'succeeded'`,
      [operationId, message.slice(0, 2000)],
    );
  }

  private async finalise(
    client: PoolClient,
    operation: Operation,
    input: DurableExportRequest,
    rendered: ExportRenderResult,
    created: GoogleDocsExport,
  ): Promise<GoogleDocsExport> {
    await client.query("begin");
    try {
      const current = (
        await client.query<Operation>(
          `select id,input_hash,provider_idempotency_key,status,external_document_id,external_url
           from export_operations where id=$1 for update`,
          [operation.id],
        )
      ).rows[0];
      if (!current) throw new Error("Export operation disappeared");
      if (current.status === "succeeded") {
        await client.query("commit");
        return GoogleDocsExportSchema.parse({
          external_document_id: current.external_document_id,
          external_url: current.external_url,
          replayed: true,
        });
      }
      await this.assertFinalFence(client, input);
      const artifactId = randomUUID();
      await client.query(
        `insert into artifacts(id,run_id,step_execution_id,kind,media_type,body_text,content_hash,size_bytes)
         values($1,$2,$3,'google_docs_export','text/markdown',$4,$5,$6)`,
        [
          artifactId,
          input.run_id,
          input.step_execution_id,
          rendered.markdown,
          rendered.content_hash,
          Buffer.byteLength(rendered.markdown),
        ],
      );
      await client.query(
        `insert into exports(run_id,step_execution_id,document_version_id,export_artifact_id,idempotency_key,input_hash,
          destination,external_document_id,external_url,status,response)
         values($1,$2,$3,$4,$5,$6,'google_docs',$7,$8,'succeeded',$9::jsonb)`,
        [
          input.run_id,
          input.step_execution_id,
          input.document_version_id,
          artifactId,
          input.idempotency_key,
          operation.input_hash,
          created.external_document_id,
          created.external_url,
          JSON.stringify(created),
        ],
      );
      await client.query(
        `update export_operations set status='succeeded',external_document_id=$2,external_url=$3,
         last_error=null,updated_at=clock_timestamp() where id=$1`,
        [operation.id, created.external_document_id, created.external_url],
      );
      await client.query("commit");
      return GoogleDocsExportSchema.parse({ ...created, replayed: false });
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  private async assertFinalFence(client: PoolClient, input: DurableExportRequest): Promise<void> {
    const fence = await client.query(
      `select 1 from step_executions where id=$1 and run_id=$2 and step='final_coherence_export'
       and status='running' and lease_token=$3 and lease_expires_at>clock_timestamp() for update`,
      [input.step_execution_id, input.run_id, input.fencing_token],
    );
    if (!fence.rows[0]) throw new Error("Stale or wrong final export fencing token");
  }

  private exportInputHash(documentHash: string, artifactHash: string, _renderHash: string): string {
    // Must match the database invariant; render identity is independently frozen in export_manifests.
    return createHash("sha256").update(`${documentHash}:${artifactHash}:google_docs`).digest("hex");
  }
}
