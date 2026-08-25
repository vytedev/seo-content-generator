import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WritingGuides } from "../src/client/features/reference/WritingGuides.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const versions = [
  {
    kind: "blog_writing_guide",
    title: "Blog content writing guide",
    version_id: "11111111-1111-1111-1111-111111111111",
    version: 1,
    editorial_status: "approved",
    attestation_state: "trusted_verified",
    effective_approval_status: "trusted_verified_active",
    attestation_id: "22222222-2222-2222-2222-222222222222",
    recorder_identity: "local operator",
    approver_identity: "Aaron Smith",
    evidence_reference: "Slack thread #123",
    note: null,
    attested_at: "2026-01-05T12:00:00.000Z",
    active: true,
    provisional_local: false,
  },
  {
    kind: "writer_submission_sample",
    title: "Writer submission sample",
    version_id: "33333333-3333-3333-3333-333333333333",
    version: 2,
    editorial_status: "pending_editorial_approval",
    attestation_state: "pending_unverified",
    effective_approval_status: "not_approved",
    attestation_id: "44444444-4444-4444-4444-444444444444",
    recorder_identity: "local operator",
    approver_identity: "Aaron Smith",
    evidence_reference: "Email dated 2026-01-04",
    note: null,
    attested_at: "2026-01-04T09:00:00.000Z",
    active: false,
    provisional_local: false,
  },
  {
    kind: "keyword_placement_guidelines",
    title: "Keyword placement guidelines",
    version_id: "55555555-5555-5555-5555-555555555555",
    version: 1,
    editorial_status: "pending_editorial_approval",
    attestation_state: "none",
    effective_approval_status: "provisional_local_active",
    attestation_id: null,
    recorder_identity: null,
    approver_identity: null,
    evidence_reference: null,
    note: null,
    attested_at: null,
    active: true,
    provisional_local: true,
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows truthful, plain-language approval status for each document", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ versions }));
  render(<WritingGuides />);

  expect(await screen.findByText("Blog content writing guide")).toBeInTheDocument();
  expect(screen.getByText("Approved (verified)")).toBeInTheDocument();
  expect(screen.getByText("Approval recorded, awaiting verification")).toBeInTheDocument();
  expect(screen.getByText("Provisional for local work only")).toBeInTheDocument();
});

it("never implies Aaron approved something merely because his name is the claimed approver", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ versions }));
  render(<WritingGuides />);

  await screen.findByText("Writer submission sample");
  const pendingItem = screen.getByText("Writer submission sample").closest("li")!;
  await user.click(within(pendingItem).getByRole("button", { name: "View history" }));

  // The claimed approver name is visible in the read-only detail...
  expect(within(pendingItem).getByText("Aaron Smith")).toBeInTheDocument();
  // ...but the status right beside it (both in the row summary and its history entry)
  // stays "awaiting verification", never "Approved".
  expect(
    within(pendingItem).getAllByText("Approval recorded, awaiting verification"),
  ).not.toHaveLength(0);
  expect(within(pendingItem).queryByText(/^Approved/)).not.toBeInTheDocument();
});

it("expands a version to show recorded attestation detail, and collapses again", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ versions }));
  render(<WritingGuides />);

  await screen.findByText("Blog content writing guide");
  const approvedItem = screen.getByText("Blog content writing guide").closest("li")!;
  const toggle = within(approvedItem).getByRole("button", { name: "View history" });
  await user.click(toggle);

  expect(within(approvedItem).getByText("Slack thread #123")).toBeInTheDocument();
  expect(toggle).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("button", { name: "Hide history" }));
  expect(within(approvedItem).queryByText("Slack thread #123")).not.toBeInTheDocument();
});

it("shows an explicit not-yet-approved note for a version with no attestation at all", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ versions }));
  render(<WritingGuides />);

  await screen.findByText("Keyword placement guidelines");
  const provisionalItem = screen.getByText("Keyword placement guidelines").closest("li")!;
  await user.click(within(provisionalItem).getByRole("button", { name: "View history" }));
  expect(
    within(provisionalItem).getByText("No approval has been recorded for this version yet."),
  ).toBeInTheDocument();
});

it("announces a safe error when the guides cannot be loaded", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    jsonResponse({ error: { message: "The writing guides could not be loaded." } }, 500),
  );
  render(<WritingGuides />);

  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("The writing guides could not be loaded."),
  );
});
