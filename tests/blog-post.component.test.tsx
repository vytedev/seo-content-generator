import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App.js";
import { PIPELINE_STEPS } from "../src/shared/pipeline.js";

const hash = "a".repeat(64);

function detail(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-m4-1",
    status: "running",
    current_step: "revision_pass",
    updated_at: new Date().toISOString(),
    coherence_return_cycles: 1,
    steps: PIPELINE_STEPS.slice(0, 10).map((step, index) => ({
      id: `attempt-${index}`,
      step: step.id,
      number: step.number,
      name: step.name,
      attempt: 1,
      status: index < 9 ? "succeeded" : "running",
      error: null,
    })),
    current_document: {
      version: {
        id: "version-2",
        run_id: "run-m4-1",
        artifact_id: "artifact-2",
        parent_id: "version-1",
        revision: 2,
        content_hash: hash,
      },
      artifact: {
        id: "artifact-2",
        run_id: "run-m4-1",
        step_execution_id: "attempt-9",
        parent_id: "artifact-1",
        kind: "revision",
        media_type: "text/markdown",
        body_text: "# Designer chair guide",
        content_hash: hash,
      },
      draft: {
        title: "Designer chair guide",
        slug: "designer-chair-guide",
        meta_description: "A practical guide to choosing a designer chair.",
        og_title: "Designer chair guide",
        og_description: "A practical guide to choosing a designer chair.",
        images: [],
        faqs: [],
        markdown: "# Choosing a chair\n\nA readable current revision.",
        claims: [],
      },
    },
    counts: { warnings: 2, unverified: 1, hard_flags: 1, rejected_findings: 3 },
    usage: { input_units: 1200, output_units: 500, cost_micros: 23500 },
    export: { status: "not_started", external_url: null },
    can_retry: true,
    blocked_for_operator: false,
    block_reason: "unknown",
    block_counts: { deterministic_blockers: 0, coherence_blockers: 0 },
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-m4-1",
    plane_ticket: "MOB-001",
    primary_keyword: "designer chairs",
    status: "running",
    current_step: "revision_pass",
    created_at: "2026-01-02T10:00:00.000Z",
    updated_at: "2026-01-02T10:00:00.000Z",
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stubs fetch so the run list resolves to `list` and run detail to `runDetail()`. */
/** The paginated shape /api/runs now returns; navigation reads only `runs`. */
function runsResponse(list: unknown) {
  const runs = ((list as { runs?: unknown[] })?.runs ?? []) as unknown[];
  return response({
    runs,
    pagination: {
      page: 1,
      limit: 50,
      total_items: runs.length,
      total_pages: runs.length > 0 ? 1 : 0,
      has_previous: false,
      has_next: false,
    },
    filter: "all",
  });
}

function stubFetch(list: unknown, runDetail: () => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? "");
    if (url.includes("/api/runs?")) return runsResponse(list);
    return response(runDetail());
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/?run=run-m4-1");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("Blog Post page", () => {
  it("defaults a normal load to 01 Handoff even when unfinished runs exist", async () => {
    window.history.replaceState(null, "", "/");
    const fetchMock = stubFetch({ runs: [summary()] }, detail);
    render(<App authMode="test-bypass" />);

    expect(await screen.findByRole("heading", { name: "Blog post" })).toBeInTheDocument();
    expect(screen.getByLabelText("Handoff JSON")).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Blog post workflow" })).getAllByRole(
        "listitem",
      )[0],
    ).toHaveAttribute("aria-current", "step");
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/api/runs/run-m4-1")),
    ).toBe(false);
  });

  it("reopens the exact run from the URL and resumes safely", async () => {
    const running = {
      runs: [summary({ run_id: "run-done", status: "succeeded", current_step: null }), summary()],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? "");
      if (url.includes("/api/runs?")) return runsResponse(running);
      if (url.includes("/resume") && init?.method === "POST") {
        return response(detail({ status: "succeeded", current_step: null }));
      }
      return response(detail());
    });
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    const rail = await screen.findByRole("navigation", { name: "Twelve-step pipeline" });
    const items = within(rail).getAllByRole("listitem");
    expect(items).toHaveLength(12);
    expect(items[0]).toHaveTextContent("1.1Ingest handoff");
    expect(items[11]).toHaveTextContent("1.12Final coherence review and export");
    expect(screen.getByRole("heading", { name: "Designer chair guide" })).toBeInTheDocument();
    expect(screen.getByText("Open Graph:")).toBeInTheDocument();
    // The currently-running step's elapsed-time text matches its status colour (info/blue).
    expect(screen.getByText(/Running for/)).toHaveClass("text-info");

    await user.click(screen.getByRole("button", { name: "Resume safely" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-m4-1/milestone-four/resume", {
        method: "POST",
      }),
    );
  });

  it("resumes milestone-two steps through the milestone-two endpoint", async () => {
    const fetchMock = stubFetch(
      { runs: [summary({ status: "retryable_failed", current_step: "draft" })] },
      () => detail({ status: "retryable_failed", current_step: "draft" }),
    );
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    await user.click(await screen.findByRole("button", { name: "Resume safely" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-m4-1/milestone-two/resume", {
        method: "POST",
      }),
    );
  });

  it("shows Step 1.2 source health and retries discovery on the same run with refresh", async () => {
    const blocked = detail({
      status: "retryable_failed",
      current_step: "internal_link_discovery",
      current_document: null,
      link_discovery: {
        shortlist: [],
        metadata: {
          availability: "available",
          eligibility: "blocked",
          reason: "editorial_only",
          providerStatus: { sitemap: "available", gsc: "not_connected" },
          counts: {
            ghost_collected: 0,
            sitemap_collected: 4,
            gsc_collected: 0,
            deduplicated: 4,
            commercial: 0,
            editorial: 4,
            verification_attempted: 0,
            direct_200: 0,
            rejected_non_200: 0,
            unresolved: 0,
            shortlisted: 0,
          },
          cache: { state: "miss", retrieved_at: null, expires_at: null },
          identity: {
            query_hash: hash,
            config_hash: hash,
            origin_policy_hash: hash,
            request_hash: hash,
          },
        },
      },
      steps: [
        {
          id: "link-attempt",
          step: "internal_link_discovery",
          number: "1.2",
          name: "Internal link discovery",
          attempt: 1,
          status: "retryable_failed",
          error:
            "Link discovery blocked: the sources returned editorial pages only. Sitemap available; Search Console not_connected.",
        },
      ],
    });
    const fetchMock = stubFetch(
      { runs: [summary({ status: "retryable_failed", current_step: "internal_link_discovery" })] },
      () => blocked,
    );
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    expect(
      await screen.findByRole("heading", { name: "No commercial link candidates were found" }),
    ).toBeInTheDocument();
    const context = screen.getByRole("complementary", { name: "Run context" });
    expect(within(context).getByText("Public sitemap")).toBeInTheDocument();
    expect(within(context).getByText("available")).toBeInTheDocument();
    expect(within(context).getByText("not connected")).toBeInTheDocument();
    expect(within(context).getByText("0 / 4")).toBeInTheDocument();
    await user.click(within(context).getByRole("button", { name: "Retry link discovery" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-m4-1/milestone-two/resume",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ refresh_link_discovery: true }),
        }),
      ),
    );
  });

  it("shows persisted local bypass evidence in run detail", async () => {
    const bypassed = detail({
      link_discovery: {
        shortlist: [],
        metadata: {
          availability: "unavailable",
          eligibility: "blocked",
          reason: "source_unavailable",
          providerStatus: { sitemap: "not_configured", gsc: "not_configured" },
          counts: {
            ghost_collected: 0,
            sitemap_collected: 0,
            gsc_collected: 0,
            deduplicated: 0,
            commercial: 0,
            editorial: 0,
            verification_attempted: 0,
            direct_200: 0,
            rejected_non_200: 0,
            unresolved: 0,
            shortlisted: 0,
          },
          cache: { state: "miss", retrieved_at: null, expires_at: null },
          identity: {
            query_hash: hash,
            config_hash: hash,
            origin_policy_hash: hash,
            request_hash: hash,
          },
          bypass: {
            enabled: true,
            used: true,
            reason: "local_unverified_link_testing",
          },
        },
      },
    });
    stubFetch({ runs: [summary()] }, () => bypassed);
    render(<App authMode="test-bypass" />);
    const context = await screen.findByRole("complementary", { name: "Run context" });
    expect(within(context).getByText("Local bypass")).toBeInTheDocument();
    expect(within(context).getByText("Used · unverified link testing")).toBeInTheDocument();
  });

  it("shows a persisted safe provider error returned by resume without a hard refresh", async () => {
    const initial = detail({
      status: "retryable_failed",
      current_step: "automated_checks",
      updated_at: "2026-01-02T10:00:00.000Z",
      steps: [
        {
          id: "attempt-before",
          step: "automated_checks",
          number: "1.4",
          name: "Automated checks",
          attempt: 1,
          status: "retryable_failed",
          error: "Temporary failure",
        },
      ],
    });
    const persisted = detail({
      status: "retryable_failed",
      current_step: "review_writing_style",
      updated_at: "2026-01-02T10:01:00.000Z",
      steps: [
        {
          id: "attempt-checks",
          step: "automated_checks",
          number: "1.4",
          name: "Automated checks",
          attempt: 2,
          status: "succeeded",
          error: null,
        },
        {
          id: "attempt-review",
          step: "review_writing_style",
          number: "1.5",
          name: "Writing style review",
          attempt: 1,
          status: "retryable_failed",
          error: "Review provider HTTP 403",
        },
      ],
    });
    let current = initial;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? "");
      if (url.includes("/api/runs?"))
        return runsResponse({
          runs: [summary({ status: "retryable_failed", current_step: "automated_checks" })],
        });
      if (url.includes("/resume") && init?.method === "POST") {
        current = persisted;
        return response(persisted);
      }
      return response(current);
    });
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    await user.click(await screen.findByRole("button", { name: "Resume safely" }));

    expect(
      await screen.findByRole("heading", { name: "The AI service refused the request" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/reached the AI service/)).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 403/)).not.toBeInTheDocument();
  });

  it("polls immediately during a pending resume so status changes need no hard refresh", async () => {
    let resolveResume!: (value: Response) => void;
    const resumeResponse = new Promise<Response>((resolve) => {
      resolveResume = resolve;
    });
    let detailReads = 0;
    const failed = detail({
      status: "retryable_failed",
      current_step: "automated_checks",
      updated_at: "2026-01-02T10:00:00.000Z",
    });
    const running = detail({
      status: "running",
      current_step: "review_writing_style",
      updated_at: "2026-01-02T10:01:00.000Z",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? "");
      if (url.includes("/api/runs?"))
        return runsResponse({
          runs: [summary({ status: "retryable_failed", current_step: "automated_checks" })],
        });
      if (url.includes("/resume") && init?.method === "POST") return resumeResponse;
      detailReads += 1;
      return response(detailReads === 1 ? failed : running);
    });
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    const context = await screen.findByRole("complementary", { name: "Run context" });
    expect(within(context).getByText("Retry available")).toBeInTheDocument();
    await user.click(within(context).getByRole("button", { name: "Resume safely" }));

    await waitFor(() => expect(within(context).getByText("Running")).toBeInTheDocument());
    expect(detailReads).toBeGreaterThan(1);
    resolveResume(response(running));
  });

  it("derives the needs-decision state from a waiting run, opening the findings screen automatically", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? "");
      if (url.includes("/api/runs?")) {
        return runsResponse({
          runs: [summary({ status: "waiting", current_step: "findings_review" })],
        });
      }
      if (url.endsWith("/findings")) {
        return response({
          findings: [
            {
              id: "finding-1",
              run_id: "run-m4-1",
              document_version_id: "version-2",
              step_execution_id: "execution-1",
              step: "review_writing_style",
              stable_key: "style.wordy",
              category: "Writing style",
              rule_reference: "style.conciseness",
              severity: "warning",
              location: { field: "body_markdown", line_start: 4 },
              issue: "This sentence is unnecessarily long.",
              suggested_fix: "Shorten the sentence.",
              disposition: null,
            },
          ],
        });
      }
      return response(detail({ status: "waiting", current_step: "findings_review" }));
    });
    render(<App authMode="test-bypass" />);

    // Reaching "waiting" pauses the pipeline for a decision, so the findings
    // screen opens on its own — no click required.
    expect(await screen.findByRole("heading", { name: "Needs your decision" })).toBeInTheDocument();
    expect(await screen.findByText("This sentence is unnecessarily long.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Apply decisions and continue" }),
    ).not.toBeInTheDocument();
    // Continuation is part of the disposition submit request; there is no
    // second-click milestone-four action on this screen.
  });

  it("lets the workflow breadcrumb navigate between the production workspace and the findings screen", async () => {
    stubFetch({ runs: [summary({ status: "waiting", current_step: "findings_review" })] }, () =>
      detail({ status: "waiting", current_step: "findings_review" }),
    );
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    // The findings screen opens automatically on reaching "waiting".
    expect(await screen.findByRole("heading", { name: "Needs your decision" })).toBeInTheDocument();
    const breadcrumb = screen.getByRole("navigation", { name: "Blog post workflow" });

    await user.click(within(breadcrumb).getByRole("button", { name: /02.*Production/ }));
    expect(
      await screen.findByRole("navigation", { name: "Twelve-step pipeline" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Needs your decision" })).not.toBeInTheDocument();

    await user.click(within(breadcrumb).getByRole("button", { name: /03.*Decision/ }));
    expect(await screen.findByRole("heading", { name: "Needs your decision" })).toBeInTheDocument();
  });

  it("lets the breadcrumb jump straight to an existing run from the start screen", async () => {
    stubFetch({ runs: [summary()] }, detail);
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    await screen.findByRole("navigation", { name: "Twelve-step pipeline" });
    await user.click(screen.getByRole("button", { name: "Start another blog post" }));
    await screen.findByLabelText("Handoff JSON");

    const breadcrumb = screen.getByRole("navigation", { name: "Blog post workflow" });
    const productionItem = within(breadcrumb).getByRole("button", { name: /02.*Production/ });
    await user.click(productionItem);

    expect(
      await screen.findByRole("navigation", { name: "Twelve-step pipeline" }),
    ).toBeInTheDocument();
  });

  it("renders a markdown heading that isn't followed by a blank line, without a stray #", async () => {
    stubFetch({ runs: [summary()] }, () =>
      detail({
        current_document: {
          ...(detail() as { current_document: Record<string, unknown> }).current_document,
          draft: {
            ...(detail() as { current_document: { draft: Record<string, unknown> } })
              .current_document.draft,
            markdown: "# A tight heading\nThe very next line, no blank line first.",
          },
        },
      }),
    );
    render(<App authMode="test-bypass" />);

    expect(
      await screen.findByRole("heading", { name: "A tight heading", level: 4 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^#/)).not.toBeInTheDocument();
    expect(screen.getByText(/The very next line/)).toBeInTheDocument();
  });

  it("shows the done state with the success summary and export link", async () => {
    stubFetch({ runs: [summary({ status: "succeeded", current_step: null })] }, () =>
      detail({
        status: "succeeded",
        current_step: null,
        can_retry: false,
        export: {
          status: "succeeded",
          external_url: "https://docs.google.com/document/d/doc-1",
        },
      }),
    );
    render(<App authMode="test-bypass" />);

    expect(await screen.findByText(/0\.0235/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open exported document/ })).toHaveAttribute(
      "href",
      "https://docs.google.com/document/d/doc-1",
    );
    expect(screen.getByRole("button", { name: "Start another blog post" })).toBeInTheDocument();
  });

  it("shows the newest finished run when nothing is resumable, but offers Start another blog post", async () => {
    stubFetch(
      { runs: [summary({ run_id: "run-done", status: "succeeded", current_step: null })] },
      () =>
        detail({
          status: "succeeded",
          current_step: null,
          can_retry: false,
        }),
    );
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    expect(
      await screen.findByRole("button", { name: "Start another blog post" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start another blog post" }));
    expect(await screen.findByLabelText("Handoff JSON")).toBeInTheDocument();
  });

  it("explains the blocked cycle cap and does not offer automatic actions", async () => {
    stubFetch(
      { runs: [summary({ status: "blocked", current_step: "final_coherence_export" })] },
      () =>
        detail({
          status: "blocked",
          current_step: "final_coherence_export",
          coherence_return_cycles: 2,
          blocked_for_operator: true,
          block_reason: "coherence_cycle_cap",
          block_counts: { deterministic_blockers: 0, coherence_blockers: 2 },
          export: { status: "failed", external_url: null },
        }),
    );
    render(<App authMode="test-bypass" />);

    expect(
      await screen.findByRole("heading", { name: "Operator action required" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/final check still found 2 issues/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume safely" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry export" })).not.toBeInTheDocument();
  });

  it("shows the exact automatic deterministic-repair running copy", async () => {
    stubFetch({ runs: [summary()] }, () =>
      detail({
        status: "running",
        current_step: "revision_pass",
        deterministic_repair_cycles: 2,
      }),
    );
    render(<App authMode="test-bypass" />);

    expect(
      await screen.findByText("Automatically correcting required checks — cycle 2 of 2"),
    ).toHaveAttribute("role", "status");
  });

  it("identifies a Step 1.11 deterministic block with exact remaining details", async () => {
    stubFetch(
      { runs: [summary({ status: "blocked", current_step: "final_coherence_export" })] },
      () =>
        detail({
          status: "blocked",
          current_step: "final_coherence_export",
          coherence_return_cycles: 0,
          deterministic_repair_cycles: 2,
          blocked_for_operator: true,
          block_reason: "deterministic_blockers",
          block_counts: { deterministic_blockers: 1, coherence_blockers: 0 },
          deterministic_blocker_details: [
            {
              rule_reference: "links.internal_product_link",
              location: { field: "body_markdown", line_start: 12, line_end: 14 },
              issue: "The required product link is missing.",
              suggested_fix: "Restore the verified product link in this paragraph.",
            },
          ],
        }),
    );
    render(<App authMode="test-bypass" />);

    expect(await screen.findByText(/1 item still needs fixing/)).toBeInTheDocument();
    expect(screen.getByText(/stopped safely before the final check/)).toBeInTheDocument();
    expect(screen.getByText("The required product link is missing.")).toBeInTheDocument();
    expect(screen.getByText(/body_markdown, lines 12–14/)).toBeInTheDocument();
    expect(
      screen.getByText(/Restore the verified product link in this paragraph/),
    ).toBeInTheDocument();
    expect(screen.getByText(/no Google Doc was created/)).toBeInTheDocument();
    expect(screen.queryByText(/two return cycles/)).not.toBeInTheDocument();
  });

  it("requires explicit confirmation before the one exceptional correction", async () => {
    stubFetch(
      { runs: [summary({ status: "blocked", current_step: "automated_checks_rerun" })] },
      () =>
        detail({
          status: "blocked",
          current_step: "automated_checks_rerun",
          deterministic_repair_cycles: 2,
          blocked_for_operator: true,
          block_reason: "deterministic_blockers",
          block_counts: { deterministic_blockers: 1, coherence_blockers: 0 },
          exceptional_correction: { available: true, authorised: false, requires_ai: true },
          deterministic_blocker_details: [
            {
              rule_reference: "style.readability_grade_8",
              location: { field: "body_markdown", line_start: 7, line_end: 7 },
              issue: "Readability exceeds Grade 8.",
              suggested_fix: "Simplify this paragraph.",
            },
          ],
        }),
    );
    render(<App authMode="test-bypass" />);

    expect(await screen.findByRole("heading", { name: "What to do next" })).toBeInTheDocument();
    expect(screen.getByText("Review the item listed above.")).toBeInTheDocument();
    expect(screen.getByText("Tick the confirmation box below.")).toBeInTheDocument();
    const button = screen.getByRole("button", {
      name: "Fix this item and continue",
    });
    expect(button).toBeDisabled();
    expect(screen.getByText(/small amount of AI credit/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /I understand this may use a small amount of AI credit/,
      }),
    );
    expect(button).toBeEnabled();
    expect(screen.getByText(/may make one AI request/)).toBeInTheDocument();
    expect(screen.getByText(/earlier review choices will not change/)).toBeInTheDocument();
    const block = screen.getByRole("region", { name: "Operator action required" });
    expect(block).toHaveAttribute("tabindex", "-1");
    expect(block).toHaveClass("scroll-mt-20");
  });

  it("uses the persisted reason even when independently calculated counts are ambiguous", async () => {
    stubFetch(
      { runs: [summary({ status: "blocked", current_step: "final_coherence_export" })] },
      () =>
        detail({
          status: "blocked",
          current_step: "final_coherence_export",
          blocked_for_operator: true,
          block_reason: "deterministic_blockers",
          block_counts: { deterministic_blockers: 0, coherence_blockers: 3 },
        }),
    );
    render(<App authMode="test-bypass" />);

    expect(await screen.findByText(/0 items still need fixing/)).toBeInTheDocument();
    expect(screen.queryByText(/after two return cycles/)).not.toBeInTheDocument();
  });

  it("offers the narrow deterministic recovery action with exact guidance", async () => {
    stubFetch(
      { runs: [summary({ status: "blocked", current_step: "automated_checks_rerun" })] },
      () =>
        detail({
          status: "blocked",
          current_step: "automated_checks_rerun",
          blocked_for_operator: true,
          can_recover_deterministic_block: true,
          block_reason: "deterministic_blockers",
          deterministic_repair_cycles: 0,
          block_counts: { deterministic_blockers: 1, coherence_blockers: 0 },
        }),
    );
    render(<App authMode="test-bypass" />);

    expect(
      await screen.findByRole("button", { name: "Resume required correction" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Step 1.9 remains frozen/)).toBeInTheDocument();
  });

  it("uses cautious guidance when a historical row has no persisted block reason", async () => {
    stubFetch(
      { runs: [summary({ status: "blocked", current_step: "final_coherence_export" })] },
      () =>
        detail({
          status: "blocked",
          current_step: "final_coherence_export",
          blocked_for_operator: true,
          block_reason: "unknown",
        }),
    );
    render(<App authMode="test-bypass" />);

    expect(await screen.findByText(/saved history does not explain why/)).toBeInTheDocument();
  });

  it("marks legacy placeholder on-page data instead of presenting it as real values", async () => {
    const base = detail() as {
      current_document: { draft: Record<string, unknown>; [key: string]: unknown };
    };
    stubFetch({ runs: [summary()] }, () =>
      detail({
        current_document: {
          ...base.current_document,
          draft: {
            ...base.current_document.draft,
            og_title: "Legacy draft field unavailable",
            og_description: "Legacy draft field unavailable",
          },
          legacy_derived_fields: ["og_title", "og_description", "images", "faqs"],
        },
      }),
    );
    render(<App authMode="test-bypass" />);

    expect(await screen.findByText(/placeholders only/)).toBeInTheDocument();
    expect(screen.getByText(/Open Graph:/).closest("p")).toHaveTextContent(
      "Legacy draft field unavailable",
    );
  });

  it("contains arbitrary unbroken document and export text without widening the page", async () => {
    const longText = "unbroken".repeat(20);
    const base = detail() as {
      current_document: { draft: Record<string, unknown>; [key: string]: unknown };
    };
    stubFetch(
      {
        runs: [
          summary({
            primary_keyword: longText,
            status: "succeeded",
            current_step: null,
          }),
        ],
      },
      () =>
        detail({
          status: "succeeded",
          current_step: null,
          can_retry: false,
          export: { status: "succeeded", external_url: `https://example.test/${longText}` },
          current_document: {
            ...base.current_document,
            draft: {
              ...base.current_document.draft,
              title: longText,
              slug: longText,
              meta_description: longText,
              og_title: longText,
              og_description: longText,
              markdown: `# ${longText}\n\n${longText}`,
            },
          },
        }),
    );
    render(<App authMode="test-bypass" />);

    const pageHeading = await screen.findByRole("heading", { level: 1 });
    const documentHeading = await screen.findByRole("heading", { name: longText, level: 3 });
    const article = screen.getByRole("article", { name: "Current document" });
    const context = screen.getByRole("complementary", { name: "Run context" });
    const workflow = screen.getByRole("navigation", { name: "Blog post workflow" });
    const exportLink = screen.getByRole("link", { name: /Open exported document/ });

    expect(pageHeading).toHaveClass("[overflow-wrap:anywhere]");
    expect(documentHeading).toHaveClass("[overflow-wrap:anywhere]");
    expect(article).toHaveClass("min-w-0");
    expect(context).toHaveClass("min-w-0", "max-w-full");
    expect(workflow).toHaveClass("max-w-full", "overflow-x-auto");
    expect(exportLink).toHaveClass("max-w-full", "[overflow-wrap:anywhere]");
  });

  it("uses responsive stacking semantics and labelled context regions", async () => {
    stubFetch({ runs: [summary()] }, detail);
    render(<App authMode="test-bypass" />);

    expect(await screen.findByRole("article", { name: "Current document" })).toHaveClass("min-w-0");
    expect(screen.getByRole("complementary", { name: "Run context" })).toHaveClass(
      "min-w-0",
      "max-w-full",
    );
  });

  it("shows a shaped loading skeleton for the initial run fetch, then replaces it with real content", async () => {
    let resolveDetail: (value: Response) => void = () => {};
    const detailPromise = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? "");
      if (url.includes("/api/runs?")) return runsResponse({ runs: [summary()] });
      return detailPromise;
    });
    render(<App authMode="test-bypass" />);

    expect(await screen.findByText("Loading your blog post…")).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Twelve-step pipeline" }),
    ).not.toBeInTheDocument();

    resolveDetail(response(detail()));

    expect(
      await screen.findByRole("navigation", { name: "Twelve-step pipeline" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading your blog post…")).not.toBeInTheDocument();
  });

  it("never re-shows the loading skeleton during a quiet 5-second poll of a running blog post", async () => {
    stubFetch({ runs: [summary()] }, detail);
    render(<App authMode="test-bypass" />);

    expect(
      await screen.findByRole("navigation", { name: "Twelve-step pipeline" }),
    ).toBeInTheDocument();

    // Advance exactly one 5s poll tick. Fake timers are scoped tightly to this one
    // `act` call so they can't interfere with any other test's real-timer-based
    // `findBy`/`waitFor` polling.
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    vi.useRealTimers();

    expect(screen.queryByText("Loading your blog post…")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Twelve-step pipeline" })).toBeInTheDocument();
  });

  it("shows an accessible progress-strip summary of pipeline completion", async () => {
    stubFetch({ runs: [summary()] }, detail);
    render(<App authMode="test-bypass" />);

    await screen.findByRole("navigation", { name: "Twelve-step pipeline" });
    expect(
      screen.getByRole("img", { name: "9 of 12 steps complete; Revision pass running." }),
    ).toBeInTheDocument();
  });

  it("shows the compact production metadata row and the plain completion-summary rows", async () => {
    stubFetch({ runs: [summary({ status: "succeeded", current_step: null })] }, () =>
      detail({ status: "succeeded", current_step: null, can_retry: false }),
    );
    render(<App authMode="test-bypass" />);

    await screen.findByRole("navigation", { name: "Twelve-step pipeline" });
    expect(screen.getByText(/quality score/i).parentElement).toHaveTextContent("94%");
    expect(screen.getByText(/cost/i).parentElement).toHaveTextContent(/0\.0235/);
    expect(screen.getByText("Model tokens (in / out)").parentElement).toHaveTextContent(
      "1,200 / 500",
    );
    expect(screen.getByText("Warnings").parentElement).toHaveTextContent("2");
    expect(screen.getByText("Claims needing review").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Rejected suggestions").parentElement).toHaveTextContent("3");
  });

  it("hides technical reference IDs until the operator expands the disclosure", async () => {
    stubFetch({ runs: [summary({ status: "succeeded", current_step: null })] }, () =>
      detail({ status: "succeeded", current_step: null, can_retry: false }),
    );
    render(<App authMode="test-bypass" />);

    await screen.findByRole("navigation", { name: "Twelve-step pipeline" });
    const toggle = screen.getByText("Show reference IDs for support");
    const disclosure = toggle.closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
    await userEvent.click(toggle);
    expect(await screen.findByText("Draft version")).toBeInTheDocument();
    expect(screen.getByText("Revised from")).toBeInTheDocument();
    expect(screen.getByText("Stored file")).toBeInTheDocument();
    expect(screen.getByText("Checksum")).toBeInTheDocument();
  });

  it("offers a calm retry affordance when the blog post fails to load, and retries the fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? "");
      if (url.includes("/api/runs?")) return runsResponse({ runs: [summary()] });
      return response({ error: { message: "Could not reach the server." } }, 500);
    });
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    expect(await screen.findByText("Could not reach the server.")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "Try again" });

    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? "");
      if (url.includes("/api/runs?")) return runsResponse({ runs: [summary()] });
      return response(detail());
    });
    await user.click(retryButton);

    expect(
      await screen.findByRole("navigation", { name: "Twelve-step pipeline" }),
    ).toBeInTheDocument();
  });
});
