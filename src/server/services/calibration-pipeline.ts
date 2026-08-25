import type { Pool } from "pg";
import { CALIBRATION_POSTS, type CalibrationSnapshot } from "../../shared/contracts/calibration.js";
import type { StructuredDraft } from "../../shared/milestone-two.js";
import type { DeterministicFixture } from "../../shared/milestone-three.js";
import { ingestHandoff } from "../../shared/milestone-two.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../pipeline/milestone-two.js";
import { MilestoneThreeOrchestrator } from "../pipeline/milestone-three.js";
import { MilestoneFourOrchestrator } from "../pipeline/milestone-four.js";
import { MockDraftProvider } from "../providers/draft-provider.js";
import { MockReviewProvider } from "../providers/review-provider.js";
import {
  MockCoherenceProvider,
  MockRevisionProvider,
} from "../providers/milestone-four-providers.js";
import { MockGoogleDocsAdapter } from "../providers/google-docs.js";
import { PostgresGoogleDocsExportService } from "./export-service.js";
import type { PostgresMilestoneRepository } from "../repositories/postgres-repository.js";
import type { GeneratedCalibrationDocument } from "./calibration-engine.js";

const filler =
  "Use documented records to compare form, finish, comfort, placement and care. Keep unsupported details clearly unverified and choose according to the room and intended use.";
const faqAnswer = (subject: string) =>
  `Start with ${subject}, then compare the available documented construction, finish, comfort and care information. Consider the room, intended use and maintenance needs before deciding. Do not infer dimensions, prices, provenance or designer attribution when an authoritative source is unavailable; record those details as unverified instead.`;

function pinnedDraft(slot: 1 | 2): StructuredDraft {
  const post = CALIBRATION_POSTS[slot - 1]!;
  const keyword = post.primary_keyword;
  return {
    title: `${post.generated_title}: Practical Advice`.slice(0, 60).padEnd(55, " Guide"),
    slug: `calibration-${slot}-${keyword.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`,
    meta_description:
      `Use this practical guide to compare ${keyword} by form, finish, comfort, placement and care using documented details rather than unsupported claims.`
        .slice(0, 155)
        .padEnd(150, "."),
    og_title: post.generated_title,
    og_description: "Independent calibration guide",
    images: [
      {
        alt: post.generated_title,
        filename: `calibration-${slot}.jpg`,
        placement: { marker: `calibration-${slot}` },
      },
    ],
    faqs: ["construction and finish", "comfort and placement", "care and evidence"].map(
      (subject) => ({ question: `How should I compare ${subject}?`, answer: faqAnswer(subject) }),
    ),
    markdown: [
      `# ${keyword}: an independent buying guide`,
      `${keyword} decisions become clearer when you compare documented construction, finish, comfort, placement and care. This independent guide avoids copying published material and does not infer prices, dimensions, provenance or attribution. It helps readers evaluate options against their room, intended use and maintenance needs while unsupported details remain explicitly unverified.`,
      "## Key Takeaways",
      "- Compare documented construction and finish.",
      "- Match comfort and scale to intended use.",
      "- Keep unsupported details unverified.",
      `## Comparing ${keyword}`,
      `${filler} A [documented furniture collection](https://www.mobelaris.com/en/chair) can provide a verified route for further comparison.`,
      `> ${filler}`,
      `## Using a ${post.related_keyword}`,
      `${post.related_keyword} research should remain natural and useful. ${Array.from({ length: 18 }, () => filler).join(" ")}`,
      "## Conclusion",
      `${keyword} choices should begin with documented evidence and practical fit. ${filler}`,
    ].join("\n\n"),
    claims: [],
  };
}

export interface CalibrationPipelineRunner {
  execute(
    calibrationRunId: string,
    snapshot: CalibrationSnapshot,
  ): Promise<GeneratedCalibrationDocument>;
}

export class PostgresCalibrationPipelineRunner implements CalibrationPipelineRunner {
  constructor(
    private readonly pool: Pool,
    private readonly repository: PostgresMilestoneRepository,
  ) {}
  async execute(
    calibrationRunId: string,
    snapshot: CalibrationSnapshot,
  ): Promise<GeneratedCalibrationDocument> {
    const post = CALIBRATION_POSTS[snapshot.slot - 1]!;
    const handoff = {
      plane_ticket: `MM03-01-CAL-${snapshot.slot}`,
      primary_keyword: post.primary_keyword,
      related_keywords: [post.related_keyword],
      page_type: "blog" as const,
      word_count_target: post.word_count_target,
      locales_for_translation: [],
      notes:
        "Pinned independent calibration input; published snapshot is comparison evidence only.",
    };
    const link = {
      url: "https://www.mobelaris.com/en/chair",
      title: "Documented furniture collection",
      relevance: 1,
    };
    const fixture: DeterministicFixture = {
      internal_origins: ["https://www.mobelaris.com"],
      link_verification: [{ url: link.url, status: 200, hierarchy: "product", hierarchy_rank: 4 }],
    };
    const ingest = await ingestHandoff(
      handoff,
      `calibration:${calibrationRunId}:slot:${snapshot.slot}`,
      this.repository,
    );
    await new MilestoneTwoOrchestrator(
      this.repository,
      new MockLinkDiscoverer([link]),
      new MockDraftProvider(
        `calibration-draft-v1-slot-${snapshot.slot}`,
        pinnedDraft(snapshot.slot),
      ),
    ).run(ingest.run_id, `calibration-${calibrationRunId}`);
    await new MilestoneThreeOrchestrator(
      this.repository,
      fixture,
      new MockReviewProvider("calibration-review-v1"),
    ).run(ingest.run_id, `calibration-${calibrationRunId}`);
    const current = await this.repository.getDraft(ingest.run_id);
    if (!current) throw new Error("CALIBRATION_PIPELINE_DOCUMENT_MISSING");
    const findings = (
      await this.repository.listFindings(ingest.run_id, { disposition: "pending" })
    ).filter((finding) => finding.document_version_id === current.version.id);
    if ((await this.repository.stepWaiting(ingest.run_id, "findings_review")) && findings.length)
      await this.repository.submitDispositions(ingest.run_id, {
        document_version_id: current.version.id,
        idempotency_key: `calibration-${calibrationRunId}-${snapshot.slot}`,
        dispositions: findings.map((finding) => ({
          finding_id: finding.id,
          decision: "accepted" as const,
          rationale: "Calibration policy CAL-ACCEPT-ALL-V1",
        })),
      });
    const m4 = new MilestoneFourOrchestrator(
      this.repository,
      fixture,
      new MockRevisionProvider("calibration-revision-v1"),
      new MockCoherenceProvider("calibration-coherence-v1"),
      new PostgresGoogleDocsExportService(this.pool, new MockGoogleDocsAdapter()),
    );
    await m4.run(ingest.run_id, `calibration-${calibrationRunId}`);
    const detail = await this.repository.getRunDetail(ingest.run_id);
    const final = await this.repository.getDraft(ingest.run_id);
    if (!final) throw new Error("CALIBRATION_PIPELINE_DOCUMENT_MISSING");
    const exported = (
      await this.pool.query<{ id: string }>(
        "select id from exports where run_id=$1 and document_version_id=$2 and status='succeeded'",
        [ingest.run_id, final.version.id],
      )
    ).rows[0];
    return {
      pipeline_run_id: ingest.run_id,
      final_document_version_id: final.version.id,
      export_id: exported?.id ?? null,
      pipeline_outcome: detail.status === "succeeded" ? "succeeded" : "blocked",
      draft: final.draft,
      handoff,
      fixture: {
        internal_origins: fixture.internal_origins,
        verified_internal_links: fixture.link_verification,
      },
    };
  }
}
