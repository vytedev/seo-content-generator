import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { FindingsReview } from "../src/client/features/findings/FindingsReview.js";
import {
  findingCategories,
  findingCategoryLabels,
} from "../src/client/features/findings/finding-category-labels.js";

const findings = [
  {
    id: "finding-1",
    run_id: "run-local-1",
    document_version_id: "version-1",
    step_execution_id: "execution-1",
    step: "review_fact_checking",
    stable_key: "fact.provenance",
    category: "fact_checking",
    rule_reference: "fact.provenance_required",
    severity: "blocker",
    location: { field: "body_markdown", section: "Origins", line_start: 12 },
    issue: "Designer attribution has no source.",
    evidence: "The draft names a designer without supporting evidence.",
    suggested_fix: "Verify the attribution against an approved source.",
    hard_flag: true,
    disposition: null,
    rationale: null,
    evidence_sources: [
      {
        url: "https://www.mobelaris.com/products/chair",
        extraction_method: "product_json_ld+visible_labelled",
        retrieved_at: "2025-01-02T03:04:05.000Z",
        content_hash: "a".repeat(64),
        evidence_hash: "b".repeat(64),
        excerpt: "height: 80 cm",
        selection_reason: "Exact product identifier match.",
      },
    ],
  },
  {
    id: "finding-2",
    run_id: "run-local-1",
    document_version_id: "version-1",
    step_execution_id: "execution-2",
    step: "review_writing_style",
    stable_key: "style.wordy",
    category: "writing_style",
    rule_reference: "style.conciseness",
    severity: "warning",
    location: { field: "body_markdown", section: "Choosing well", line_start: 28 },
    issue: "This sentence is unnecessarily long.",
    suggested_fix: "Shorten the sentence while preserving meaning.",
    hard_flag: false,
    disposition: null,
    rationale: null,
  },
] as const;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("wraps long unbroken finding metadata and prose inside responsive review rows", async () => {
  const longText = "unbroken".repeat(80);
  const longFinding = {
    ...findings[0],
    id: longText,
    category: "content",
    rule_reference: longText,
    issue: longText,
    evidence: longText,
    suggested_fix: longText,
    location: { field: longText, section: longText, line_start: 12 },
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ findings: [longFinding] }));
  const { container } = render(<FindingsReview runId={longText} />);

  const rule = await screen.findByText(longText, { selector: "code" });
  const row = rule.closest("li");
  expect(container.firstElementChild).toHaveClass("min-w-0", "max-w-full");
  expect(rule).toHaveClass("min-w-0", "[overflow-wrap:anywhere]");
  expect(row).toHaveClass("min-w-0", "max-w-full");
});

it("shows exhaustive labels while filtering with unchanged category machine values", async () => {
  const user = userEvent.setup();
  expect(Object.keys(findingCategoryLabels)).toEqual(findingCategories);
  const categoryFindings = findingCategories.map((category, index) => ({
    ...findings[0],
    id: `finding-category-${index}`,
    step_execution_id: `execution-category-${index}`,
    stable_key: `category.${index}`,
    category,
    severity: "warning" as const,
    rule_reference: `category.rule.${index}`,
    issue: `Finding ${index + 1}: ${findingCategoryLabels[category]}`,
    evidence: undefined,
    hard_flag: false,
  }));
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ findings: categoryFindings }));
  render(<FindingsReview runId="run-categories" />);

  const categoryTrigger = await screen.findByRole("combobox", { name: "Category" });
  expect(categoryTrigger).toHaveTextContent("All categories");

  const severityTrigger = screen.getByRole("combobox", { name: "Severity" });
  await user.click(severityTrigger);
  for (const label of ["All severities", "Blocker", "Warning", "Information"])
    expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
  expect(document.querySelector('[data-slot="select-scroll-up-button"]')).toBeNull();
  expect(document.querySelector('[data-slot="select-scroll-down-button"]')).toBeNull();
  await user.keyboard("{Escape}");
  expect(severityTrigger).toHaveFocus();

  const dispositionTrigger = screen.getByRole("combobox", { name: "Disposition" });
  await user.click(dispositionTrigger);
  for (const label of ["All dispositions", "Pending", "Accepted", "Rejected"])
    expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(dispositionTrigger).toHaveFocus();

  await user.click(categoryTrigger);
  for (const category of findingCategories)
    expect(
      screen.getByRole("option", { name: findingCategoryLabels[category] }),
    ).toBeInTheDocument();
  expect(screen.queryByText("fact_advisory")).not.toBeInTheDocument();
  expect(screen.queryByText("link_conversion")).not.toBeInTheDocument();

  const content = document.querySelector<HTMLElement>('[data-slot="select-content"]');
  expect(content).toHaveClass("overflow-hidden");
  expect(content).not.toHaveClass("overflow-y-auto");
  expect(document.querySelector('[data-slot="select-scroll-up-button"]')).toBeNull();
  expect(document.querySelector('[data-slot="select-scroll-down-button"]')).toBeNull();

  await user.click(screen.getByRole("option", { name: "Fact advisory" }));
  expect(categoryTrigger).toHaveTextContent("Fact advisory");
  expect(screen.getByText("Finding 4: Fact advisory")).toBeInTheDocument();
  expect(screen.queryByText("Finding 10: Link and conversion")).not.toBeInTheDocument();

  await user.click(categoryTrigger);
  await user.click(screen.getByRole("option", { name: "Link and conversion" }));
  expect(categoryTrigger).toHaveTextContent("Link and conversion");
  expect(screen.getByText("Finding 10: Link and conversion")).toBeInTheDocument();
  expect(screen.queryByText("Finding 4: Fact advisory")).not.toBeInTheDocument();

  await user.click(categoryTrigger);
  await user.click(screen.getByRole("option", { name: "All categories" }));
  expect(categoryTrigger).toHaveTextContent("All categories");
  expect(screen.getAllByLabelText(/^Select finding:/)).toHaveLength(findingCategories.length);

  categoryTrigger.focus();
  await user.keyboard(" ");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await user.keyboard("w");
  await user.keyboard("{Enter}");
  expect(categoryTrigger).toHaveTextContent("Writing style");
  expect(screen.getByText("Finding 15: Writing style")).toBeInTheDocument();
});

it("fails closed without displaying an unapproved raw category identifier", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    jsonResponse({
      findings: [{ ...findings[0], category: "unexpected_internal_value" }],
    }),
  );
  render(<FindingsReview runId="run-unsupported-category" />);

  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "A finding category has no approved operator-facing label.",
    ),
  );
  expect(screen.queryByText("unexpected_internal_value")).not.toBeInTheDocument();
});

it("shows the frozen review details, typed hard flag and explicit controls", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ findings }));
  render(<FindingsReview runId="run-local-1" />);

  expect(await screen.findByText("fact.provenance_required")).toBeInTheDocument();
  expect(screen.getByText("Step 1.7")).toBeInTheDocument();
  expect(screen.getByText("body_markdown · Origins · line 12")).toBeInTheDocument();
  expect(screen.getByText(/Hard flag/)).toBeInTheDocument();
  expect(screen.getByText("https://www.mobelaris.com/products/chair")).toBeInTheDocument();
  expect(screen.getByText("product_json_ld+visible_labelled")).toBeInTheDocument();
  expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
  expect(screen.getByText("b".repeat(64))).toBeInTheDocument();
  expect(screen.getByText("height: 80 cm")).toBeInTheDocument();
  expect(screen.getByText("Exact product identifier match.")).toBeInTheDocument();
  expect(
    screen.getByRole("group", { name: "Decision for: Designer attribution has no source." }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit decisions →" })).toBeDisabled();
});

it("accepts every pending finding independently of filters, allows rejects, and submits once", async () => {
  const user = userEvent.setup();
  const onSubmitted = vi.fn();
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(jsonResponse({ findings }))
    .mockResolvedValueOnce(
      jsonResponse({ completed: true, submitted: 2, continuation: "completed" }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        findings: findings.map((finding, index) => ({
          ...finding,
          disposition: index ? "rejected" : "accepted",
          rationale: index ? "Keep the original wording" : null,
        })),
      }),
    );
  render(<FindingsReview runId="run-local-1" onSubmitted={onSubmitted} />);
  await screen.findByText("fact.provenance_required");

  await user.click(screen.getByRole("combobox", { name: "Severity" }));
  await user.click(screen.getByRole("option", { name: "Warning" }));
  await user.click(screen.getByRole("button", { name: "Accept all pending" }));
  const warningGroup = screen.getByRole("group", {
    name: "Decision for: This sentence is unnecessarily long.",
  });
  await user.click(within(warningGroup).getByRole("button", { name: "Reject" }));
  await user.type(
    screen.getByLabelText("Rationale for: This sentence is unnecessarily long."),
    "Keep the original wording",
  );
  expect(screen.getByText(/0 pending · 1 accepted · 1 rejected/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Submit decisions →" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
    document_version_id: "version-1",
    idempotency_key: "findings-run-local-1-version-1",
    dispositions: [
      { finding_id: "finding-1", decision: "accepted" },
      {
        finding_id: "finding-2",
        decision: "rejected",
        rationale: "Keep the original wording",
      },
    ],
  });
  expect(onSubmitted).toHaveBeenCalledOnce();
});

it("undoes only staged decisions and never lets rationale imply a decision", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ findings }));
  render(<FindingsReview runId="run-local-1" />);
  await screen.findByText("fact.provenance_required");

  const rationale = screen.getByLabelText("Rationale for: Designer attribution has no source.");
  expect(rationale).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Accept all pending" }));
  expect(rationale).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Undo staged" }));
  expect(rationale).toBeDisabled();
  expect(screen.getByRole("button", { name: "Submit decisions →" })).toBeDisabled();
});

it("renders persisted decisions read-only on revisit", async () => {
  const recorded = findings.map((finding, index) => ({
    ...finding,
    disposition: index ? "rejected" : "accepted",
    rationale: index ? "Recorded context" : null,
  }));
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ findings: recorded }));
  render(<FindingsReview runId="run-local-1" />);
  await screen.findByText("fact.provenance_required");

  for (const group of screen.getAllByRole("group", { name: /Decision for:/ })) {
    expect(within(group).getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(within(group).getByRole("button", { name: "Reject" })).toBeDisabled();
  }
  expect(screen.getByDisplayValue("Recorded context")).toHaveAttribute("readonly");
});

it("shows loading, empty and error states with a live announcement", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    jsonResponse({ error: { message: "Run was not found." } }, 404),
  );
  render(<FindingsReview runId="missing" />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Run was not found."));
  expect(screen.getAllByText("Run was not found.")).toHaveLength(2);
});
