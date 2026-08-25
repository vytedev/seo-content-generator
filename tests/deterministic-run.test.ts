import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_BUILD_ID,
  DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V1,
  DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V1,
  DETERMINISTIC_RULE_DESCRIPTORS_HASH_V1,
  DETERMINISTIC_RULE_INVENTORY,
  DETERMINISTIC_RULE_INVENTORY_V1,
  DeterministicManifestMismatchError,
  assertDeterministicBuildId,
  compareDeterministicResults,
  createDeterministicManifest,
  deterministicHash,
  runVersionedDeterministicChecks,
  validateDeterministicBaseline,
  validateDeterministicManifest,
} from "../src/shared/deterministic-run.js";
import { runDeterministicChecks } from "../src/shared/checker/rules.js";
import { CHECKER_REGISTRY } from "../src/shared/checker/registry.js";

const input = {
  primary_keyword: "designer chair",
  related_keywords: ["modern seating"],
  body_markdown: "# Designer chair\n\nShort.\n\n## Conclusion\n\nChoose carefully.",
  on_page: {
    meta_title: "Designer chair",
    meta_description: "Short",
    og_title: "Designer chair",
    og_description: "Short",
    slug: "designer-chair",
    images: [],
    faqs: [],
  },
  internal_origins: ["https://www.mobelaris.com"],
  verified_internal_links: [],
};
const handoff = {
  plane_ticket: "MM03-01",
  primary_keyword: "designer chair",
  related_keywords: ["modern seating"],
  page_type: "blog" as const,
  word_count_target: 1200,
  locales_for_translation: [],
};
const document = { id: "doc-1", content_hash: "a".repeat(64) };
const manifest = () => {
  const fixtureContent = { internal_origins: input.internal_origins, link_verification: [] };
  return createDeterministicManifest({
    run_id: "run-1",
    document,
    handoff,
    checker_input: input,
    fixture: {
      source_identity: "fixture://v1",
      content_hash: deterministicHash(fixtureContent),
      content: fixtureContent,
    },
    internal_links_artifact: {
      artifact_id: "links-1",
      content_hash: deterministicHash("[]"),
      body_text: "[]",
      body: [],
      metadata_artifact_id: null,
      metadata_content_hash: null,
      metadata_body_text: null,
      metadata: null,
    },
    references: [
      {
        kind: "guide",
        version_id: "ref-1",
        immutable_pointer: "db://ref-1",
        content: "guide",
        content_hash: deterministicHash("guide"),
        executable: false,
      },
    ],
    producing_execution_id: "execution-1",
    executed_at: "2026-01-01T00:00:00.000Z",
  });
};

describe("versioned deterministic runner", () => {
  it("asserts canonical build identity and complete descriptors", () => {
    expect(assertDeterministicBuildId()).toBeUndefined();
    expect(DETERMINISTIC_BUILD_ID).toBe(
      "9da8aadc50849eeac929789cdfbe1ebfad83b944bc53a49bb98e975036408d70",
    );
    expect(DETERMINISTIC_RULE_DESCRIPTORS_HASH_V1).toBe(
      "72c368a93c53adc1dcf502babb8ed8f8b0a4a8075a02b323af78a21dd61b7980",
    );
    expect(DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V1).toBe(
      "443a945e0c35d8b704e4fa220806b7ea41abb651c7f5d75bf5386df7dd1fecaa",
    );
    expect(deterministicHash(DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V1)).toBe(
      DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V1,
    );
    expect(DETERMINISTIC_RULE_INVENTORY_V1.every((r) => r.applicability && r.parameters)).toBe(
      true,
    );
  });
  it("validates embedded snapshots without comparing to a mutable global", () => {
    const value = manifest();
    expect(validateDeterministicManifest(value, { run_id: "run-1", handoff })).toEqual(value);
    const changed = structuredClone(value);
    changed.references[0]!.content = "changed";
    expect(() => validateDeterministicManifest(changed, { run_id: "run-1" })).toThrowError(
      DeterministicManifestMismatchError,
    );
  });
  it("normalises malformed rehashed artefact JSON to the typed mismatch", () => {
    const changed = structuredClone(manifest());
    changed.frozen_context.internal_links_artifact.body_text = "[malformed";
    changed.frozen_context.internal_links_artifact.content_hash = deterministicHash("[malformed");
    changed.frozen_context_hash = deterministicHash(changed.frozen_context);
    changed.shortlist_hash = deterministicHash(changed.frozen_context.internal_links_artifact);
    const { manifest_hash: _, ...core } = changed;
    changed.manifest_hash = deterministicHash(core);
    expect(() => validateDeterministicManifest(changed, { run_id: "run-1" })).toThrowError(
      DeterministicManifestMismatchError,
    );
  });
  it("normalises Zod, lineage and config failures to the typed mismatch", () => {
    for (const changed of [
      { nope: true },
      { ...manifest(), config_hash: "c".repeat(64) },
      { ...manifest(), run_id: "other" },
    ]) {
      try {
        validateDeterministicManifest(changed, { run_id: "run-1" });
        throw new Error("expected");
      } catch (error) {
        expect(error).toMatchObject({ code: "DETERMINISTIC_MANIFEST_MISMATCH" });
      }
    }
  });
  it("keeps public current and registered v1 behaviour identical over the corpus", () => {
    const bodies = [
      input.body_markdown,
      "",
      "Plain prose without headings.",
      "# Color overview\n\nAlways modern modern modern modern.",
    ];
    const faqSets = [[], [{ question: "What?", answer: "short" }]];
    const imageSets = [[], [{ alt: "", filename: "chair.jpg" }]];
    const keywordSets = [["modern seating"], ["modern seating", "compact chair"]];
    const corpus = bodies.flatMap((body_markdown) =>
      faqSets.flatMap((faqs) =>
        imageSets.flatMap((images) =>
          keywordSets.map((related_keywords) => ({
            ...input,
            body_markdown,
            related_keywords,
            on_page: { ...input.on_page, faqs, images },
          })),
        ),
      ),
    );
    for (const candidate of corpus)
      expect(runDeterministicChecks(candidate)).toEqual(
        CHECKER_REGISTRY["1.0.0"]!.run(candidate).findings,
      );
  });
  it("reports every inventory rule exactly once and no outside runtime rule", () => {
    const value = manifest();
    const first = runVersionedDeterministicChecks(input, document, value);
    const second = runVersionedDeterministicChecks(input, document, value);
    expect(first).toEqual(second);
    expect(first.rule_evaluations.map((e) => e.rule_id)).toEqual(
      DETERMINISTIC_RULE_INVENTORY.map((r) => r.id),
    );
    expect(new Set(first.rule_evaluations.map((e) => e.rule_id)).size).toBe(
      first.rule_evaluations.length,
    );
    expect(
      first.findings.every((f) => DETERMINISTIC_RULE_INVENTORY.some((r) => r.id === f.rule)),
    ).toBe(true);
    expect(first.rule_evaluations.find((e) => e.rule_id === "structure.heading_levels")).toEqual({
      rule_id: "structure.heading_levels",
      status: "evaluated",
    });
    expect(first.rule_evaluations.find((e) => e.rule_id === "structure.faq_answer_length")).toEqual(
      {
        rule_id: "structure.faq_answer_length",
        status: "skipped",
        reason: "no_faqs",
      },
    );
    expect(validateDeterministicBaseline(value, first)).toEqual(first);
  });
  it("records conditional skips from actual input conditions", () => {
    const result = CHECKER_REGISTRY["1.0.0"]!.run({ ...input, body_markdown: "" });
    expect(result.evaluations.filter((e) => e.status === "skipped")).toEqual(
      expect.arrayContaining([
        { rule_id: "structure.heading_levels", status: "skipped", reason: "no_headings" },
        {
          rule_id: "style.vague_heading_provisional",
          status: "skipped",
          reason: "no_headings",
        },
        {
          rule_id: "style.repeated_adjective",
          status: "skipped",
          reason: "no_paragraph_or_list_prose",
        },
        { rule_id: "structure.faq_answer_length", status: "skipped", reason: "no_faqs" },
      ]),
    );
    expect(result.evaluations).toHaveLength(DETERMINISTIC_RULE_INVENTORY_V1.length);
    expect(new Set(result.evaluations.map((e) => e.rule_id)).size).toBe(result.evaluations.length);
  });
  it("verifies baseline result/findings/config/manifest hashes and links", () => {
    const value = manifest(),
      result = runVersionedDeterministicChecks(input, document, value);
    for (const changed of [
      { ...result, findings_hash: "c".repeat(64) },
      { ...result, result_hash: "c".repeat(64) },
      { ...result, document_id: "other" },
    ])
      expect(() => validateDeterministicBaseline(value, changed)).toThrowError(
        DeterministicManifestMismatchError,
      );
  });
  it("compares duplicate insertion/removal and reorder by semantic occurrence", () => {
    const base = runVersionedDeterministicChecks(input, document, manifest()).findings;
    const duplicate = { ...base[0]!, location: { ...base[0]!.location, line_start: 999 } };
    expect(compareDeterministicResults(base, [...base, duplicate]).introduced).toEqual([
      `${duplicate.id}#2`,
    ]);
    expect(compareDeterministicResults([...base, duplicate], base).resolved).toEqual([
      `${duplicate.id}#2`,
    ]);
    expect(compareDeterministicResults(base, [...base].reverse()).introduced).toEqual([]);
  });
  it("keeps same-subject identity across prose edits; identical same-path subjects remain ambiguous", () => {
    const a = runVersionedDeterministicChecks(
      {
        ...input,
        body_markdown: "# Designer chair\n\nAlways short.\n\n## Conclusion\n\nChoose carefully.",
      },
      document,
      manifest(),
    ).findings;
    const b = runVersionedDeterministicChecks(
      {
        ...input,
        body_markdown:
          "# Designer chair\n\nAlways edited prose.\n\n## Conclusion\n\nChoose carefully.",
      },
      document,
      manifest(),
    ).findings;
    const aid = a.find((f) => f.rule === "style.banned_phrase_provisional")!.id;
    expect(b.find((f) => f.rule === "style.banned_phrase_provisional")!.id).toBe(aid);
  });
  it("uses canonical SHA-256", () =>
    expect(deterministicHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ));
});
