import { describe, expect, it, vi } from "vitest";
import { ingestHandoff } from "../src/shared/milestone-two.js";
import {
  renderExport,
  type ExportRenderInput,
  type GoogleDocsOperation,
} from "../src/shared/export.js";
import { runDeterministicChecksV2 } from "../src/shared/checker/v2/rules.js";
import type { CheckerInput } from "../src/shared/checker/contracts.js";
import { DETERMINISTIC_CHECKER_VERSION_V2 } from "../src/shared/deterministic-run.js";
import { MilestoneTwoOrchestrator, MockLinkDiscoverer } from "../src/server/orchestrator.js";
import { MilestoneThreeOrchestrator } from "../src/server/milestone-three-orchestrator.js";
import { MilestoneFourOrchestrator } from "../src/server/milestone-four-orchestrator.js";
import { InMemoryMilestoneRepository } from "../src/server/persistence/memory-repository.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { MockReviewProvider } from "../src/server/providers/review-provider.js";
import {
  MockCoherenceProvider,
  MockRevisionProvider,
} from "../src/server/providers/milestone-four-providers.js";
import {
  MockGoogleDocsAdapter,
  RealGoogleDocsAdapter,
} from "../src/server/providers/google-docs.js";
import type { GoogleOAuthClient } from "../src/server/providers/google-oauth.js";

const link = {
  url: "https://www.mobelaris.com/en/designer-dining-chairs",
  title: "Designer dining chairs",
  relevance: 1,
};
const handoff = {
  plane_ticket: "MOB-SYNTHETIC-V2",
  primary_keyword: "designer dining chairs",
  related_keywords: ["modern dining chairs"],
  page_type: "blog" as const,
  word_count_target: 900,
  locales_for_translation: [],
};
const fixture = {
  internal_origins: ["https://www.mobelaris.com"],
  link_verification: [
    { url: link.url, status: 200 as const, hierarchy: "product" as const, hierarchy_rank: 4 },
  ],
};
const answer = (topic: string) =>
  `${topic} is the main point. Check the known ${topic.toLocaleLowerCase("en-GB")} facts. Compare them with your room and daily use. Keep facts with no proof marked unverified. Read the approved care guide. Choose only when the evidence gives a clear answer to your needs.`;
const faqs = [
  {
    question: "What seat height suits designer dining chairs?",
    answer: answer("Designer dining chair seat height"),
  },
  {
    question: "How much clearance should I allow around a dining table?",
    answer: answer("Dining table clearance"),
  },
  {
    question: "Can modern dining chairs work with a traditional wooden table?",
    answer: answer("Modern chairs with a traditional wooden table"),
  },
  {
    question: "Are upholstered chairs suitable for everyday use?",
    answer: answer("Upholstered chairs for everyday use"),
  },
];
const longCell =
  "This long fact-table cell keeps Unicode and UK punctuation — including ‘quoted guidance’, en dashes, and centimetres. It stays wholly inside its own native Google Docs table cell after export, even though the cell has far more text than each nearby cell.";
const draft = {
  title: "Designer Dining Chairs: A Complete UK Buying Guide",
  meta_title: "Designer Dining Chairs: A Practical UK Home Buying Guide",
  slug: "designer-dining-chairs-buying-guide",
  meta_description:
    "Compare designer dining chairs for UK homes, with practical advice on proportions, materials, finishes, comfort, care and room planning before you buy.",
  og_title: "Designer Dining Chairs for Contemporary UK Homes",
  og_description: "Original social copy for a practical UK chair guide.",
  images: [
    {
      alt: "Oak dining chair beside a British dining table",
      filename: "designer-dining-chair.jpg",
      placement: { marker: "designer-dining-chair" },
    },
  ],
  faqs,
  markdown: [
    "# Designer Dining Chairs: A Complete UK Buying Guide",
    "",
    "<!-- MOBELARIS_IMAGE:designer-dining-chair -->",
    "",
    "Designer dining chairs can bring comfort, scale and style to a room. Start with the table size and clear floor space. Then check the known facts about each chair. Compare the finish and care needs. Use this [designer dining chair](https://www.mobelaris.com/en/designer-dining-chairs) range only after those checks suit your home.",
    "",
    "## Key Takeaways",
    "",
    "- Measure the table and clear floor space.",
    "- Compare documented materials and finishes.",
    "- Keep unsupported figures marked unverified.",
    "",
    "## Designer dining chairs: a native list test",
    "",
    "- Start with the room’s proportions.  ",
    "  Keep the route around the table clear.",
    "  - Check the narrowest walkway.",
    "  - Note nearby doors and radiators.",
    "- Compare upholstery and timber. Modern dining chairs can work with either.",
    "",
    "1. Record the table height.  ",
    "   Keep the measurement in centimetres.",
    "   1. Recheck it before ordering.",
    "2. Review the documented care advice.",
    "",
    "> Good evidence supports a calm decision — it never needs invented certainty.",
    "",
    "## Fact table",
    "",
    "| Fact | Evidence status |",
    "| --- | --- |",
    `| Long-cell containment | ${longCell} |`,
    "| Designer attribution | Unverified unless an approved source is attached. |",
    "",
    "## Conclusion",
    "",
    "Choose chairs whose verified proportions, finish and care needs suit the room.",
  ].join("\n"),
  claims: [],
};

const acceptedFinding = {
  stable_key: "synthetic-social-tone",
  category: "writing_style",
  rule_reference: "style.tone_consistency",
  severity: "warning" as const,
  location: { field: "og_description" },
  issue: "The social description can match the practical article more closely.",
  suggested_fix: "Use the concise approved practical wording.",
};
const rejectedFinding = {
  stable_key: "synthetic-optional-example",
  category: "writing_style",
  rule_reference: "style.optional_example",
  severity: "warning" as const,
  location: { field: "body_markdown", section: "A native list test" },
  issue: "An additional example could be included.",
  suggested_fix: "Add another optional room example.",
};

function checkerInput(overrides: Partial<CheckerInput["on_page"]> = {}): CheckerInput {
  return {
    primary_keyword: handoff.primary_keyword,
    related_keywords: handoff.related_keywords,
    internal_origins: fixture.internal_origins,
    verified_internal_links: fixture.link_verification,
    body_markdown: draft.markdown,
    on_page: {
      meta_title: draft.meta_title,
      meta_description: draft.meta_description,
      og_title: draft.og_title,
      og_description: draft.og_description,
      slug: draft.slug,
      images: draft.images.map(({ alt, filename }) => ({ alt, filename })),
      faqs,
      ...overrides,
    },
  } as CheckerInput;
}

function tableEnd(requests: Array<Record<string, any>>, tableRequest: Record<string, any>) {
  const start = tableRequest.insertTable.location.index as number;
  const rows = tableRequest.insertTable.rows as number;
  const columns = tableRequest.insertTable.columns as number;
  const cellIndexes = new Set(
    Array.from({ length: rows }, (_, row) =>
      Array.from(
        { length: columns },
        (_, column) => start + 4 + row * (2 * columns + 1) + 2 * column,
      ),
    ).flat(),
  );
  const cellTextLength = requests
    .filter((request) => cellIndexes.has(request.insertText?.location?.index))
    .reduce((total, request) => total + String(request.insertText.text).length, 0);
  return start + 2 * rows * columns + rows + 2 + cellTextLength;
}

describe("fresh synthetic deterministic-v2 run", () => {
  it("proves gates, immutable lineage and exact native mock export without network", async () => {
    const network = vi.fn(() => {
      throw new Error("Synthetic verification attempted network access");
    });
    vi.stubGlobal("fetch", network);
    try {
      const repository = new InMemoryMilestoneRepository();
      const run = await ingestHandoff(handoff, "synthetic-deterministic-v2", repository);
      await new MilestoneTwoOrchestrator(
        repository,
        new MockLinkDiscoverer([link]),
        new MockDraftProvider("synthetic-draft-v2", draft),
      ).run(run.run_id);
      await new MilestoneThreeOrchestrator(
        repository,
        fixture,
        new MockReviewProvider("synthetic-review-v2", {
          review_writing_style: [acceptedFinding, rejectedFinding],
        }),
      ).run(run.run_id);

      const manifest = await repository.getDeterministicManifest(run.run_id);
      expect(manifest.manifest.checker_version).toBe(DETERMINISTIC_CHECKER_VERSION_V2);
      const source = (await repository.getDraft(run.run_id))!;
      const sourceVersion = structuredClone(source.version);
      const sourceArtifact = structuredClone(source.artifact);
      const sourceDraft = structuredClone(source.draft);
      const findings = await repository.listFindings(run.run_id, {});
      await repository.submitDispositions(run.run_id, {
        document_version_id: source.version.id,
        idempotency_key: "synthetic-v2-dispositions",
        dispositions: findings.map((finding) => ({
          finding_id: finding.id,
          decision: finding.stable_key.endsWith(acceptedFinding.stable_key)
            ? "accepted"
            : "rejected",
          ...(finding.stable_key.endsWith(rejectedFinding.stable_key)
            ? { rationale: "The existing nested list already supplies enough practical detail." }
            : {}),
        })),
      });

      const exportCalls: Array<{
        render_input: ExportRenderInput;
        rendered: ReturnType<typeof renderExport>;
      }> = [];
      const exportService = {
        export: vi.fn(async (input: any) => {
          exportCalls.push(structuredClone(input));
          return repository.export(input);
        }),
      };
      await new MilestoneFourOrchestrator(
        repository,
        fixture,
        new MockRevisionProvider("synthetic-revision-v2", (request) => ({
          ...request.current_document,
          og_description:
            "A practical UK guide to choosing designer dining chairs with confidence.",
        })),
        new MockCoherenceProvider("synthetic-coherence-v2"),
        exportService as never,
      ).run(run.run_id);

      const current = (await repository.getDraft(run.run_id))!;
      expect(current.version.revision).toBeGreaterThan(sourceVersion.revision);
      const lineage = [current.version];
      while (lineage.at(-1)!.parent_id !== sourceVersion.id) {
        const parent = repository.documentVersions.find(
          (item) => item.id === lineage.at(-1)!.parent_id,
        );
        expect(parent).toBeDefined();
        lineage.push(parent!);
      }
      expect(lineage.map((item) => item.revision)).toEqual(
        Array.from(
          { length: current.version.revision - sourceVersion.revision },
          (_, index) => current.version.revision - index,
        ),
      );
      expect(repository.documentVersions.find((item) => item.id === sourceVersion.id)).toEqual(
        sourceVersion,
      );
      expect(repository.artifacts.find((item) => item.id === sourceArtifact.id)).toEqual(
        sourceArtifact,
      );
      expect(source.draft).toEqual(sourceDraft);
      const finalGate = await repository.getDeterministicGate(run.run_id, current.version.id);
      expect(finalGate).toMatchObject({
        exact_document_match: true,
        introduced_blockers: 0,
        retained_blockers: 0,
      });
      expect(repository.dispositions.some((item) => item.decision === "rejected")).toBe(true);
      expect(repository.exports).toHaveLength(1);

      const captured = exportCalls[0]!;
      const canonical = renderExport(captured.render_input);
      expect(captured.rendered).toEqual(canonical);
      expect(canonical.markdown).toContain("## Outstanding rejected findings");
      expect(canonical.markdown).toContain(rejectedFinding.issue);
      expect(canonical.markdown).toContain("room’s proportions");
      expect(canonical.markdown).toContain("‘quoted guidance’");
      expect(canonical.operations).toEqual(renderExport(captured.render_input).operations);
      expect(canonical.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "list_item", ordered: false, nesting_level: 1 }),
          expect.objectContaining({ type: "list_item", ordered: true, nesting_level: 1 }),
          expect.objectContaining({ type: "table", rows: expect.any(Array) }),
        ]),
      );
      expect(
        canonical.operations.some(
          (operation) => "text" in operation && operation.text.includes("\n"),
        ),
      ).toBe(true);

      const mockGoogle = new MockGoogleDocsAdapter();
      await expect(mockGoogle.export("synthetic-v2-export", canonical)).resolves.toMatchObject({
        replayed: false,
      });
      await expect(mockGoogle.export("synthetic-v2-export", canonical)).resolves.toMatchObject({
        replayed: true,
      });

      const adapter = new RealGoogleDocsAdapter(
        { accessToken: async () => "unused-local-token" } as GoogleOAuthClient,
        network as unknown as typeof fetch,
      );
      const requests = (adapter as any).nativeRequestsForOperations(
        canonical.operations,
        "",
        1,
      ) as Array<Record<string, any>>;
      const requestJson = JSON.stringify(requests);
      expect(requestJson).not.toMatch(/MOBELARIS_(?:LIST|EXPORT_COMPLETE)/);
      expect(requestJson).not.toContain("⁣");
      const textStyles = requests.filter((request) => request.updateTextStyle);
      expect(
        textStyles.some(
          (request) => request.updateTextStyle.textStyle.weightedFontFamily?.fontFamily === "Arial",
        ),
      ).toBe(true);
      expect(requests.some((request) => request.updateTableCellStyle)).toBe(true);
      expect(requests.some((request) => request.pinTableHeaderRows)).toBe(true);
      const longCellInsert = requests.find((request) =>
        String(request.insertText?.text ?? "").includes("long fact-table cell keeps Unicode"),
      );
      expect(longCellInsert).toBeDefined();
      const table = requests.find((request) => request.insertTable)!;
      const start = table.insertTable.location.index as number;
      const rows = table.insertTable.rows as number;
      const columns = table.insertTable.columns as number;
      const cellIndexes = new Set(
        Array.from({ length: rows }, (_, row) =>
          Array.from(
            { length: columns },
            (_, column) => start + 4 + row * (2 * columns + 1) + 2 * column,
          ),
        ).flat(),
      );
      const inserts = requests.filter((request) => request.insertText);
      const cellInserts = inserts.filter((request) =>
        cellIndexes.has(request.insertText.location.index),
      );
      const finalCellRequestPosition = inserts.lastIndexOf(cellInserts.at(-1)!);
      for (const following of inserts.slice(finalCellRequestPosition + 1))
        expect(following.insertText.location.index).toBeGreaterThanOrEqual(
          tableEnd(requests, table),
        );
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    [
      "dangling title",
      checkerInput({ meta_title: "Designer Dining Chairs: A Practical UK Buying Guide for" }),
      "on_page.title.complete",
      "on_page.meta_title",
    ],
    [
      "rotated FAQs",
      checkerInput({
        faqs: faqs.map((faq, index) => ({
          ...faq,
          answer: faqs[(index + 2) % faqs.length]!.answer,
        })),
      }),
      "structure.faq_pair_alignment",
      "on_page.faqs",
    ],
  ])(
    "blocks the %s variant before export with actionable findings",
    (_label, input, rule, field) => {
      const result = runDeterministicChecksV2(input as CheckerInput);
      const blockers = result.findings.filter((finding) => finding.rule === rule);
      expect(blockers.length).toBeGreaterThan(0);
      for (const finding of blockers) {
        expect(finding.severity).toBe("blocker");
        expect(finding.location.field).toContain(field as string);
        expect(finding.issue.length).toBeGreaterThan(10);
        expect(finding.suggested_fix.length).toBeGreaterThan(10);
      }
      const invalidDraft = {
        ...draft,
        meta_title: (input as CheckerInput).on_page.meta_title,
        faqs: (input as CheckerInput).on_page.faqs,
      };
      expect(() =>
        renderExport({
          plane_ticket: handoff.plane_ticket,
          draft: invalidDraft,
          primary_keyword: handoff.primary_keyword,
          related_keywords: handoff.related_keywords,
          page_type: handoff.page_type,
          locales_for_translation: [],
          export_date: "2026-08-24",
          internal_links: [link],
          writer_template: (repositoryTemplates as any).writer_template,
          schema_template: (repositoryTemplates as any).schema_template,
        }),
      ).toThrow(/integrity requires a controlled correction before export/);
    },
  );
});

const repositoryTemplates = await new InMemoryMilestoneRepository().getContentTemplates();
