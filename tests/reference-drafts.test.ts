import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REFERENCE_DOCUMENT_KINDS, TASK_DERIVED_REFERENCE_DRAFTS } from "../src/db/index.js";

describe("task-derived reference drafts", () => {
  it("covers exactly the six required reference slots", () => {
    expect(TASK_DERIVED_REFERENCE_DRAFTS).toHaveLength(6);
    expect(TASK_DERIVED_REFERENCE_DRAFTS.map(({ kind }) => kind).sort()).toEqual(
      [...REFERENCE_DOCUMENT_KINDS].sort(),
    );
  });

  it("pins each allowed local baseline to its exact repository content hash", () => {
    for (const draft of TASK_DERIVED_REFERENCE_DRAFTS) {
      const body = readFileSync(new URL(`../${draft.file}`, import.meta.url));
      expect(createHash("sha256").update(body).digest("hex")).toBe(draft.contentHash);
    }
  });

  it("versions the approved local keyword-guideline update without rewriting version one", () => {
    expect(
      TASK_DERIVED_REFERENCE_DRAFTS.find((draft) => draft.kind === "keyword_placement_guidelines")
        ?.version,
    ).toBe(2);
    expect(
      TASK_DERIVED_REFERENCE_DRAFTS.filter(
        (draft) => draft.kind !== "keyword_placement_guidelines",
      ).every((draft) => draft.version === 1),
    ).toBe(true);
  });

  it("keeps every local activation pending approval and not production-approved", () => {
    expect(
      TASK_DERIVED_REFERENCE_DRAFTS.every(
        ({ status, mayActivateLocally, productionApproved }) =>
          status === "pending_editorial_approval" &&
          mayActivateLocally === true &&
          productionApproved === false,
      ),
    ).toBe(true);
  });

  it("labels every draft and records unresolved details instead of hiding them", () => {
    for (const draft of TASK_DERIVED_REFERENCE_DRAFTS) {
      const body = readFileSync(new URL(`../${draft.file}`, import.meta.url), "utf8");
      expect(body).toContain("pending editorial approval");
    }

    const keywordDraft = readFileSync(
      new URL("../references/drafts/keyword-placement-guidelines.md", import.meta.url),
      "utf8",
    );
    expect(keywordDraft).toContain("four or more uses per 1,000 prose words");

    const sampleDraft = readFileSync(
      new URL("../references/drafts/writer-submission-sample.md", import.meta.url),
      "utf8",
    );
    expect(sampleDraft).toContain("not an approved writer submission sample");
  });
});
