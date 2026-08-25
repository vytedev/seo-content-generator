import type { PipelineStepId } from "../shared/pipeline.js";

export const REFERENCE_DOCUMENT_KINDS = [
  "blog_writing_guide",
  "writer_submission_sample",
  "keyword_placement_guidelines",
  "internal_linking_guidelines",
  "fact_checking_rules",
  "pipeline_workflow",
] as const;

export type ReferenceDocumentKind = (typeof REFERENCE_DOCUMENT_KINDS)[number];

export interface ReferenceDocumentSlot {
  readonly kind: ReferenceDocumentKind;
  readonly title: string;
  readonly steps: readonly PipelineStepId[];
}

/**
 * Metadata-only slots for MM03-01. Reference bodies and active versions must be
 * supplied separately after the source documents are approved.
 */
export const REFERENCE_DOCUMENT_SEED_MANIFEST = [
  {
    kind: "blog_writing_guide",
    title: "Blog writing guide",
    steps: ["draft", "review_writing_style"],
  },
  {
    kind: "writer_submission_sample",
    title: "Writer submission sample",
    steps: ["draft", "final_coherence_export"],
  },
  {
    kind: "keyword_placement_guidelines",
    title: "Keyword placement guidelines",
    steps: ["draft", "automated_checks", "automated_checks_rerun"],
  },
  {
    kind: "internal_linking_guidelines",
    title: "Internal linking guidelines",
    steps: ["internal_link_discovery", "draft", "review_link_conversion"],
  },
  {
    kind: "fact_checking_rules",
    title: "Fact checking rules",
    steps: ["review_fact_checking", "final_coherence_export"],
  },
  {
    kind: "pipeline_workflow",
    title: "Pipeline workflow",
    // Only steps responsible for pipeline intake, operator routing, or final
    // coherence/return routing load this document.
    steps: ["ingest_handoff", "findings_review", "final_coherence_export"],
  },
] as const satisfies readonly ReferenceDocumentSlot[];

export interface CalibrationUrlSlot {
  readonly slot: "calibration_url_1" | "calibration_url_2";
  readonly url: null;
}

/** URL values intentionally remain unset until real calibration URLs are supplied. */
export const CALIBRATION_URL_SLOT_MANIFEST = [
  { slot: "calibration_url_1", url: null },
  { slot: "calibration_url_2", url: null },
] as const satisfies readonly CalibrationUrlSlot[];

const quoteSql = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Produces framework-neutral, idempotent PostgreSQL for slot metadata and step
 * mappings only. It never writes reference_versions or reference_activations.
 */
export function generateReferenceSeedSql(
  manifest: readonly ReferenceDocumentSlot[] = REFERENCE_DOCUMENT_SEED_MANIFEST,
): string {
  const documents = manifest
    .map(({ kind, title }) => `  (${quoteSql(kind)}::reference_document_kind, ${quoteSql(title)})`)
    .join(",\n");
  const mappings = manifest
    .flatMap(({ kind, steps }) =>
      steps.map(
        (step) =>
          `  (${quoteSql(kind)}::reference_document_kind, ${quoteSql(step)}::pipeline_step)`,
      ),
    )
    .join(",\n");

  return `-- MM03-01 metadata-only reference seed. No document content or activation is created.\nWITH document_seed(kind, title) AS (\n  VALUES\n${documents}\n)\nINSERT INTO reference_documents (kind, title)\nSELECT kind, title FROM document_seed\nON CONFLICT (kind) DO UPDATE SET title = EXCLUDED.title;\n\nWITH mapping_seed(kind, step) AS (\n  VALUES\n${mappings}\n)\nINSERT INTO substep_reference_map (reference_document_id, step)\nSELECT document.id, seed.step\nFROM mapping_seed seed\nJOIN reference_documents document ON document.kind = seed.kind\nON CONFLICT (reference_document_id, step) DO NOTHING;\n\nWITH mapping_seed(kind, step) AS (\n  VALUES\n${mappings}\n)\nDELETE FROM substep_reference_map mapping\nUSING reference_documents document\nWHERE mapping.reference_document_id = document.id\n  AND NOT EXISTS (\n    SELECT 1 FROM mapping_seed seed\n    WHERE seed.kind = document.kind AND seed.step = mapping.step\n  );\n`;
}
