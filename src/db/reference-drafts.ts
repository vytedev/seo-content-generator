import type { ReferenceDocumentKind } from "./reference-seed.js";

export interface TaskDerivedReferenceDraft {
  readonly kind: ReferenceDocumentKind;
  readonly file: string;
  readonly contentHash: string;
  readonly version: number;
  readonly status: "pending_editorial_approval";
  readonly mayActivateLocally: true;
  readonly productionApproved: false;
}

/**
 * Local files derived only from MM03-01. They may be activated only as a provisional local baseline while their
 * editorial status remains pending. They are never production-approved by activation.
 */
export const TASK_DERIVED_REFERENCE_DRAFTS = [
  {
    kind: "blog_writing_guide",
    file: "references/drafts/blog-writing-guide.md",
    contentHash: "6a80cf7a8cd4f64b9ad67e648fb3cce2a98f5e8d9b324aad0bec5dd069143f3c",
    version: 1,
    status: "pending_editorial_approval",
    mayActivateLocally: true,
    productionApproved: false,
  },
  {
    kind: "writer_submission_sample",
    file: "references/drafts/writer-submission-sample.md",
    contentHash: "c4e73031e2721c5450a258503ff3ee28a6110b35de5dffe97fe713d6f57b066c",
    version: 1,
    status: "pending_editorial_approval",
    mayActivateLocally: true,
    productionApproved: false,
  },
  {
    kind: "internal_linking_guidelines",
    file: "references/drafts/internal-linking-guidelines.md",
    contentHash: "979a802d9ad2c53e9cd91baaea56ccbcf092dfaef8ed2e98994bc7f21beb20ab",
    version: 1,
    status: "pending_editorial_approval",
    mayActivateLocally: true,
    productionApproved: false,
  },
  {
    kind: "fact_checking_rules",
    file: "references/drafts/fact-checking-rules.md",
    contentHash: "c257cd35e20526b8a7f08d5b2e0f38f7f46b1586134dd3376bfecd86f2d1dd71",
    version: 1,
    status: "pending_editorial_approval",
    mayActivateLocally: true,
    productionApproved: false,
  },
  {
    kind: "keyword_placement_guidelines",
    file: "references/drafts/keyword-placement-guidelines.md",
    contentHash: "0d12db27ff5ba2d5c99432cab96fc8f091258c344d9303a9bff86073fd2edf1e",
    version: 2,
    status: "pending_editorial_approval",
    mayActivateLocally: true,
    productionApproved: false,
  },
  {
    kind: "pipeline_workflow",
    file: "references/drafts/pipeline-workflow.md",
    contentHash: "97fe5c229a20c6334f4b6a4663bd3a59c8a48c49ecef1cb2763c6e537792fb00",
    version: 1,
    status: "pending_editorial_approval",
    mayActivateLocally: true,
    productionApproved: false,
  },
] as const satisfies readonly TaskDerivedReferenceDraft[];
