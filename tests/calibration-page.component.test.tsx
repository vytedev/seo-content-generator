import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App.js";
import { CALIBRATION_POSTS } from "../src/shared/contracts/calibration.js";

const id = "11111111-1111-4111-8111-111111111111";
const pipelineId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const hash = "a".repeat(64);
const now = "2025-05-19T10:00:00.000Z";
const dimensions = [
  "structure",
  "direct_answer",
  "takeaways",
  "heading_hierarchy",
  "keyword_placement_non_numeric_concentration",
  "readability",
  "faq",
  "internal_links",
  "information_gain",
  "factual_figures",
  "product_claims",
  "attribution",
  "on_page_metadata",
  "coherence",
] as const;

function run(status = "succeeded") {
  return {
    id,
    idempotency_key: "calibration-1",
    input_hash: hash,
    status,
    checkpoint: status === "succeeded" ? "combined" : "post_1",
    error: status === "retryable_failed" ? "CALIBRATION_OPERATION_FAILED" : null,
    lease_owner: null,
    lease_expires_at: null,
    snapshot_count: status === "succeeded" ? 2 : 1,
    result_count: status === "succeeded" ? 2 : 1,
    has_combined_report: status === "succeeded",
    created_at: now,
    updated_at: now,
  };
}
function result(slot: 1 | 2) {
  return {
    slot,
    snapshot_hash: hash,
    pipeline_run_id: pipelineId,
    final_document_version_id: documentId,
    export_id: null,
    pipeline_outcome: "succeeded",
    pipeline_outcome_code: "PIPELINE_EXPORTED",
    handoff: {
      plane_ticket: `CAL-${slot}`,
      primary_keyword: "chair guide",
      related_keywords: ["modern chair"],
      page_type: "blog",
      word_count_target: 900,
      locales_for_translation: [],
    },
    generated_content_hash: hash,
    generated_markdown:
      "# Generated chair guide\n\nA concise generated comparison with useful editorial detail.",
    generated_on_page: {
      meta_title: "Chair guide",
      meta_description: "Compare chairs",
      slug: "chair-guide",
      faqs: [],
    },
    published_findings: [],
    generated_findings: [],
    observations: dimensions.map((dimension) => ({
      dimension,
      classification: "expected_editorial_difference",
      summary: `${dimension} comparison`,
      metrics: {
        published: { count: 2 },
        generated: { count: 3 },
        published_rule_ids: [],
        generated_rule_ids: [],
      },
      evidence: [
        {
          source: "published_snapshot",
          citation: "Published paragraph 1",
          excerpt: "Published evidence",
        },
        {
          source: "generated_pipeline",
          citation: "Generated paragraph 1",
          excerpt: "Generated evidence",
        },
      ],
      recommendation: `Review ${dimension} guidance.`,
    })),
    proposed_reference_changes: [],
  };
}
function report() {
  return {
    calibration_run_id: id,
    snapshot_hashes: [hash, hash],
    result_hashes: [hash, hash],
    classification_counts: {
      true_pipeline_false_positive: 0,
      true_pipeline_false_negative: 0,
      expected_editorial_difference: 28,
      missing_or_ambiguous_reference_guidance: 0,
      mock_provider_limitation: 0,
      recommended_rule_or_reference_adjustment: 0,
    },
    shared_recommendations: ["Retain evidence requirements."],
    rule_weakening_prohibited: true,
    provenance_remains_hard_flagged: true,
    unresolved_claims_remain_unverified: true,
    generated_at: now,
  };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
async function openCalibration(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Calibration" }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Calibration page", () => {
  it("lists, starts idempotently and loads a run", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      // The Blog Post landing screen makes two run-list calls: one for
      // navigation and one for the history table.
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response({ runs: [run()] }))
      .mockResolvedValueOnce(response(run("queued")))
      .mockResolvedValueOnce(response(run()));
    render(<App authMode="test-bypass" />);
    await openCalibration(user);
    const runSelect = await screen.findByRole("combobox", { name: "Run" });
    await waitFor(() => expect(runSelect).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start calibration →" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => url === "/api/calibrations" && (init as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
    const [, init] = fetchMock.mock.calls.find(
      ([url, options]) =>
        url === "/api/calibrations" && (options as RequestInit)?.method === "POST",
    )!;
    // The generated key still travels to the existing API unchanged.
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      idempotency_key: expect.stringMatching(/^calibration-[0-9a-f-]{36}$/),
    });
    await user.click(runSelect);
    await user.click(screen.getByRole("option", { name: new RegExp(id) }));
    await user.click(screen.getByRole("button", { name: "Load run" }));
    expect(await screen.findByRole("heading", { name: "Calibration run" })).toBeInTheDocument();
  });

  it("resumes a retryable run", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      // The Blog Post landing screen makes two run-list calls: one for
      // navigation and one for the history table.
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response({ runs: [run("retryable_failed")] }))
      .mockResolvedValueOnce(response(run("retryable_failed")))
      .mockResolvedValueOnce(response(run("comparing")));
    render(<App authMode="test-bypass" />);
    await openCalibration(user);
    const runSelect = await screen.findByRole("combobox", { name: "Run" });
    await waitFor(() => expect(runSelect).toBeEnabled());
    await user.click(runSelect);
    await user.click(screen.getByRole("option", { name: new RegExp(id) }));
    await user.click(screen.getByRole("button", { name: "Load run" }));
    await user.click(await screen.findByRole("button", { name: "Resume retryable run" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(`/api/calibrations/${id}/resume`, {
        method: "POST",
      }),
    );
  });

  it("loads both results and the report, then confirms inactive proposal versions inline", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      // The Blog Post landing screen makes two run-list calls: one for
      // navigation and one for the history table.
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response({ runs: [run()] }))
      .mockResolvedValueOnce(response(run()))
      .mockResolvedValueOnce(response({ results: [result(1), result(2)] }))
      .mockResolvedValueOnce(response(report()))
      .mockResolvedValueOnce(
        response(
          {
            versions: [
              { reference_version_id: versionId, editorial_status: "pending_editorial_approval" },
            ],
          },
          201,
        ),
      );
    render(<App authMode="test-bypass" />);
    await openCalibration(user);
    const runSelect = await screen.findByRole("combobox", { name: "Run" });
    await waitFor(() => expect(runSelect).toBeEnabled());
    await user.click(runSelect);
    await user.click(screen.getByRole("option", { name: new RegExp(id) }));
    await user.click(screen.getByRole("button", { name: "Load run" }));
    await user.click(await screen.findByRole("button", { name: "Load comparison report" }));
    expect(await screen.findByRole("heading", { name: "Post comparison" })).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(within(screen.getAllByRole("table")[0]!).getAllByRole("row")).toHaveLength(15);
    expect(screen.getByText("Hard safety invariants remain active")).toBeInTheDocument();
    expect(screen.getByText(CALIBRATION_POSTS[0].url)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create proposal versions" }));
    expect(screen.getByText("Create proposal versions now?")).toBeInTheDocument();
    expect(screen.getByText(/does not activate them/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm creation" }));
    expect(await screen.findByText(/Pending editorial approval/)).toBeInTheDocument();
  });

  it("generates the key on load and shows it read-only", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response({ runs: [] }));
    render(<App authMode="test-bypass" />);
    await openCalibration(user);
    await screen.findByText(/No calibration runs yet/);

    // Nothing to fill in: the operator is told the key is handled for them.
    expect(
      screen.getByText("A unique key is created automatically to prevent duplicate runs."),
    ).toBeInTheDocument();
    const key = screen.getByLabelText("Idempotency key") as HTMLInputElement;
    expect(key.value).toMatch(/^calibration-[0-9a-f-]{36}$/);
    // Editing it could only produce a duplicate run, so it is not editable.
    expect(key).toHaveAttribute("readonly");
  });

  it("copies the key without letting it be edited", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response({ runs: [] }));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<App authMode="test-bypass" />);
    await openCalibration(user);
    await screen.findByText(/No calibration runs yet/);

    const key = screen.getByLabelText("Idempotency key") as HTMLInputElement;
    const generated = key.value;
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(generated);
    // The label confirms the copy rather than a competing live region.
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

    // Typing into it changes nothing.
    await user.type(key, "tampered");
    expect(key.value).toBe(generated);
  });

  it("reuses the same key until a run starts, then generates a new one", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response({ runs: [] }))
      // The first start fails, so the same key must be offered again: retrying
      // must replay the same run rather than starting a second one.
      .mockResolvedValueOnce(response({ error: { message: "upstream" } }, 500))
      .mockResolvedValueOnce(response(run("queued")));
    render(<App authMode="test-bypass" />);
    await openCalibration(user);
    await screen.findByText(/No calibration runs yet/);
    const key = screen.getByLabelText("Idempotency key") as HTMLInputElement;
    const original = key.value;

    // Counted by endpoint, not by call index: other screens also fetch.
    const starts = () =>
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/calibrations" && (init as RequestInit)?.method === "POST",
      );
    await user.click(screen.getByRole("button", { name: "Start calibration →" }));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(key.value).toBe(original);

    await user.click(screen.getByRole("button", { name: "Start calibration →" }));
    await waitFor(() => expect(starts()).toHaveLength(2));
    const bodies = starts().map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)).idempotency_key,
    );
    expect(bodies[0]).toBe(original);
    expect(bodies[1]).toBe(original);

    // The run now exists, so a further calibration is a deliberate new one.
    await waitFor(() => expect(key.value).not.toBe(original));
    expect(key.value).toMatch(/^calibration-[0-9a-f-]{36}$/);
  });

  it("announces checker-only database unavailability", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      response(
        {
          error: {
            message:
              "Calibration needs the local database service. Check a draft is still available without it.",
          },
        },
        503,
      ),
    );
    render(<App authMode="test-bypass" />);
    await openCalibration(user);
    expect(await screen.findByRole("status")).toHaveTextContent("Check a draft is still available");
    expect(screen.getByRole("main")).toHaveAccessibleName("Calibration");
  });
});
