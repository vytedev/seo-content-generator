import { describe, expect, it } from "vitest";
import { friendlyFailure } from "../src/client/features/runs/failure-copy.js";

const combined = (value: ReturnType<typeof friendlyFailure>) => Object.values(value).join(" ");

describe("friendlyFailure", () => {
  it("explains a first invalid AI response and allows one safe retry", () => {
    const failure = friendlyFailure(
      "review_information_gain",
      "Review provider returned unparseable output after 2 attempts",
      1,
    );
    expect(failure.title).toBe("The review could not be completed");
    expect(failure.protection).toBe("No findings from that response were saved.");
    expect(failure.action).toContain("try once more");
    expect(failure.latestTry).toContain("asked the AI twice");
    expect(combined(failure)).not.toMatch(/unparseable|JSON Schema|payload|HTTP status/i);
  });

  it("discourages repeated retries and protects the original during revision", () => {
    const failure = friendlyFailure(
      "revision_pass",
      "Revision provider returned unparseable output after 2 attempts",
      5,
    );
    expect(failure.title).toBe("The article could not be safely revised");
    expect(failure.protection).toBe("The original article remains unchanged.");
    expect(failure.action).toContain("Do not keep retrying with the same setup");
  });

  it.each([
    ["Draft provider request failed at network level", "The AI service could not be reached"],
    ["Draft provider request timed out", "The AI took too long to respond"],
    ["Draft provider request failed with HTTP 401", "The AI connection needs attention"],
    ["Draft provider request failed with HTTP 402", "The AI account cannot process this request"],
    ["Draft provider request failed with HTTP 403", "The AI service refused the request"],
    ["Draft provider request failed with HTTP 404", "The selected AI model is unavailable"],
    ["Draft provider request failed with HTTP 429", "The AI service is temporarily busy"],
    ["Draft provider request failed with HTTP 503", "The AI service is temporarily unavailable"],
  ])("translates %s into friendly guidance", (error, title) => {
    const failure = friendlyFailure("draft", error, 1);
    expect(failure.title).toBe(title);
    expect(failure.action).toBeTruthy();
    expect(failure.protection).toMatch(/safely stored|remain safely stored/i);
    expect(combined(failure)).not.toContain(error);
  });

  it("explains durable revision lockout without suggesting another identical retry", () => {
    const failure = friendlyFailure(
      "revision_pass",
      "Revision provider is locked after 2 failed executions (malformed_response); use a different provider/model or contract version before resuming",
      3,
    );
    expect(failure.title).toBe("This revision setup is paused");
    expect(failure.protection).toContain("did not call the AI again");
    expect(failure.action).toContain("different AI provider or model");
    expect(failure.action).toContain("new prompt or planning contract version");
    expect(failure.action).toContain("Changing only the access key will not unlock");
  });

  it("distinguishes Step 1.12 preflight, template, coherence and Google failures", () => {
    const coherence = friendlyFailure(
      "final_coherence_export",
      "STEP_1_12_FAILED;stage=coherence_eligibility;category=coherence_eligibility;reason=disallowed_field",
      2,
    );
    expect(coherence.title).toBe("The final coherence review needs attention");
    expect(coherence.protection).toContain("Google Docs was not contacted");

    const template = friendlyFailure(
      "final_coherence_export",
      "STEP_1_12_FAILED;stage=export_context;category=template_integrity",
      1,
    );
    expect(template.title).toBe("The export templates need attention");
    expect(template.action).toContain("content-template versions");

    const preflight = friendlyFailure(
      "final_coherence_export",
      "STEP_1_12_FAILED;stage=export_render;category=export_integrity",
      1,
    );
    expect(preflight.title).toBe("The final export preparation needs attention");
    expect(preflight.protection).toContain("Google Docs was not contacted");

    const google = friendlyFailure(
      "final_coherence_export",
      "STEP_1_12_FAILED;stage=google_docs_export;category=google_api",
      1,
    );
    expect(google.title).toBe("The Google Doc could not be created");
    expect(google.action).toContain("Docs and Drive APIs");

    const connection = friendlyFailure(
      "final_coherence_export",
      "STEP_1_12_FAILED;stage=google_docs_export;category=google_connection",
      1,
    );
    expect(connection.title).toBe("The Google Doc could not be created");
    expect(connection.action).toContain("Google is connected");

    // Google accepted the write and only the read-back verification failed, so
    // the operator must not be sent to reconnect a working connection.
    const structure = friendlyFailure(
      "final_coherence_export",
      "STEP_1_12_FAILED;stage=docs_read_after_update;category=google_structure",
      1,
    );
    // An unproven historical repair is still a structural failure: truthful,
    // and never advising a Google reconnection.
    for (const reason of [
      "historical_table_repair_not_proven",
      "historical_table_repair_verification_failed",
    ]) {
      const repair = friendlyFailure(
        "final_coherence_export",
        `STEP_1_12_FAILED;stage=docs_historical_table_repair;category=google_structure;reason=${reason}`,
        1,
      );
      expect(repair.title).toBe("The exported document could not be verified");
      expect(repair.action).not.toMatch(/Check that Google is connected/);
    }

    expect(structure.title).toBe("The exported document could not be verified");
    expect(structure.action).toContain("does not need reconnecting");
    expect(structure.action).not.toMatch(/Check that Google is connected/);
    expect(structure.protection).toContain("no duplicate document");

    const conflict = friendlyFailure(
      "final_coherence_export",
      "STEP_1_12_FAILED;stage=google_docs_export;category=idempotency_conflict;reason=reserved_document_not_exact_prefix",
      1,
    );
    expect(conflict.title).toBe("The reserved Google document needs technical review");
    expect(conflict.explanation).toContain("could not prove");
    expect(conflict.protection).toContain("not overwritten");
    expect(conflict.action).toContain("technical owner");
    expect(conflict.action).toContain("Do not retry or reconnect Google");
    expect(conflict.action).not.toContain("Resume safely");

    const stageOnly = friendlyFailure(
      "final_coherence_export",
      "STEP_1_12_FAILED;stage=google_docs_export;category=export",
      1,
    );
    expect(stageOnly.title).toBe("The final step could not be completed");
    expect(stageOnly.action).not.toContain("Google is connected");
  });

  it("does not blame Google for a legacy redacted Step 1.12 failure", () => {
    const failure = friendlyFailure(
      "final_coherence_export",
      "Pipeline operation failed safely",
      18,
    );
    expect(failure.title).toBe("The final step could not be completed");
    expect(failure.explanation).toContain("does not prove that Google Docs was contacted");
  });
});
