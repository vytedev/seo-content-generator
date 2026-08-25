import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NewRun } from "../src/client/features/runs/NewRun.js";

const handoff = JSON.stringify({
  plane_ticket: "MOB-123",
  primary_keyword: "chairs",
  related_keywords: ["seating"],
  page_type: "blog",
  word_count_target: 900,
  locales_for_translation: [],
  client_insights: "Compact homes",
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps long generated IDs and form content inside the handoff surface", () => {
  const { container } = render(<NewRun onOpenRun={() => undefined} />);

  expect(container.firstElementChild).toHaveClass("min-w-0", "max-w-full");
  expect(screen.getByLabelText("Idempotency key")).toHaveClass("min-w-0");
  expect(screen.getByLabelText("Handoff JSON")).toHaveClass("min-w-0");
});

it("shows linked syntax errors and preserves/regenerates idempotency keys correctly", async () => {
  const user = userEvent.setup();
  render(<NewRun onOpenRun={() => undefined} />);
  const input = screen.getByLabelText("Handoff JSON");
  const key = screen.getByLabelText("Idempotency key") as HTMLInputElement;
  const initial = key.value;
  fireEvent.change(input, { target: { value: "{" } });
  await user.click(screen.getByRole("button", { name: "Start blog post" }));
  expect(await screen.findByText("Enter valid JSON.")).toBeInTheDocument();
  expect(key.value).toBe(initial);
  fireEvent.change(input, { target: { value: "{x" } });
  expect(key.value).not.toBe(initial);
});

it("rejects oversized files before reading and links the cleared file error", async () => {
  const user = userEvent.setup();
  const text = vi.fn().mockResolvedValue(handoff);
  const file = new File(["x"], "handoff.json", { type: "application/json" });
  Object.defineProperty(file, "size", { value: 100 * 1024 + 1 });
  Object.defineProperty(file, "text", { value: text });
  render(<NewRun onOpenRun={() => undefined} />);
  const control = screen.getByLabelText("Local JSON file") as HTMLInputElement;
  await user.upload(control, file);
  expect(await screen.findByText(/no larger than 100KB/)).toBeInTheDocument();
  expect(control).toHaveAttribute("aria-invalid", "true");
  expect(control.getAttribute("aria-describedby")).toContain("file-error");
  expect(control.files).toHaveLength(0);
  expect(text).not.toHaveBeenCalled();
});

it("keeps the submitted payload visible while busy and renders every warning", async () => {
  let resolveResponse!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    ),
  );
  const user = userEvent.setup();
  render(<NewRun onOpenRun={() => undefined} />);
  const input = screen.getByLabelText("Handoff JSON") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: handoff } });
  await user.click(screen.getByRole("button", { name: "Start blog post" }));
  expect(input).toBeDisabled();
  expect(screen.getByLabelText("Local JSON file")).toBeDisabled();
  resolveResponse({
    ok: true,
    json: async () => ({
      run_id: "run-warnings",
      input_hash: "a".repeat(64),
      handoff: JSON.parse(handoff),
      warnings: [
        { code: "serp_composition_mismatch", message: "Commercial composition." },
        { code: "serp_probe_failed", message: "Probe failed safely." },
      ],
    }),
  });
  expect(
    await screen.findByText("Blog post started with 2 non-blocking warnings."),
  ).toBeInTheDocument();
  expect(screen.getByText(/Commercial composition/)).toBeInTheDocument();
  expect(screen.getByText(/Probe failed safely/)).toBeInTheDocument();
  expect(input).toHaveValue(handoff);
});

it("creates a run with no warnings and goes straight to production, with no extra click", async () => {
  const open = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        run_id: "run-1",
        input_hash: "a".repeat(64),
        handoff: JSON.parse(handoff),
        warnings: [],
      }),
    }),
  );
  const user = userEvent.setup();
  render(<NewRun onOpenRun={open} />);
  fireEvent.change(screen.getByLabelText("Handoff JSON"), { target: { value: handoff } });
  await user.click(screen.getByRole("button", { name: "Start blog post" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("run-1"));
  expect(screen.queryByRole("button", { name: "View progress" })).not.toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
});

it("stops for a deliberate click when the ingest returns a non-blocking warning", async () => {
  const open = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        run_id: "run-warned",
        input_hash: "a".repeat(64),
        handoff: JSON.parse(handoff),
        warnings: [{ code: "serp_composition_mismatch", message: "Commercial composition." }],
      }),
    }),
  );
  const user = userEvent.setup();
  render(<NewRun onOpenRun={open} />);
  fireEvent.change(screen.getByLabelText("Handoff JSON"), { target: { value: handoff } });
  await user.click(screen.getByRole("button", { name: "Start blog post" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Blog post started with 1 non-blocking warning.",
  );
  expect(open).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "View progress" }));
  expect(open).toHaveBeenCalledWith("run-warned");
});
