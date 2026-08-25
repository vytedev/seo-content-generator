import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlogPostsTable } from "../src/client/features/blog-post/BlogPostsTable.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function summary(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-1",
    plane_ticket: "MOB-001",
    primary_keyword: "wishbone chair",
    status: "running",
    current_step: "draft",
    created_at: "2026-08-22T10:00:00.000Z",
    updated_at: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

function page(runs: unknown[], pagination: Record<string, unknown> = {}, filter = "all") {
  return {
    runs,
    pagination: {
      page: 1,
      limit: 10,
      total_items: runs.length,
      total_pages: runs.length > 0 ? 1 : 0,
      has_previous: false,
      has_next: false,
      ...pagination,
    },
    filter,
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Records every run-list URL the table requests, in order. */
function stub(handler: (url: string) => unknown) {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? "");
    urls.push(url);
    return json(handler(url));
  });
  return urls;
}

describe("Blog posts table", () => {
  it("names the section for its full contents, not only resumable work", async () => {
    stub(() => page([summary()]));
    render(<BlogPostsTable onOpenRun={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "Blog posts" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Track current work, review runs that need attention, and reopen finished exports.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Pick up where you left off")).not.toBeInTheDocument();
  });

  it("renders a semantic table with the agreed columns and friendly values", async () => {
    stub(() => page([summary()]));
    render(<BlogPostsTable onOpenRun={() => undefined} />);

    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Keyword", "Ticket", "Current stage", "Started", "Status", "Action"]);
    // Sentence case, and the canonical stage label rather than a raw step id.
    expect(within(table).getByText("Wishbone chair")).toBeInTheDocument();
    expect(within(table).getByText("MOB-001")).toBeInTheDocument();
    expect(within(table).getByText("1.3 · Draft")).toBeInTheDocument();
    expect(within(table).queryByText("draft")).not.toBeInTheDocument();
    expect(within(table).getByText("22 Aug 2026")).toBeInTheDocument();
  });

  it("requests the first page of a new filter from the server", async () => {
    const urls = stub(() => page([summary()], { total_items: 30, total_pages: 3, has_next: true }));
    const user = userEvent.setup();
    render(<BlogPostsTable onOpenRun={() => undefined} />);
    await screen.findByRole("table");

    // Move off page 1 first, so the reset is observable.
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(urls.at(-1)).toContain("page=2"));

    await user.click(screen.getByRole("combobox", { name: "Filter blog posts" }));
    await user.click(screen.getByRole("option", { name: "Needs attention" }));

    await waitFor(() => {
      expect(urls.at(-1)).toContain("filter=needs_attention");
      // A new filter always starts at its own first page.
      expect(urls.at(-1)).toContain("page=1");
    });
  });

  it("pages through history on the server", async () => {
    const urls = stub((url) =>
      url.includes("page=2")
        ? page([summary({ run_id: "run-2", plane_ticket: "MOB-002" })], {
            page: 2,
            limit: 1,
            total_items: 2,
            total_pages: 2,
            has_previous: true,
            has_next: false,
          })
        : page([summary()], { limit: 1, total_items: 2, total_pages: 2, has_next: true }),
    );
    const user = userEvent.setup();
    render(<BlogPostsTable onOpenRun={() => undefined} />);
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    // Scoped to the table: the card layout for narrow screens renders the same
    // rows, and jsdom applies no CSS to hide either one.
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getByText("MOB-002")).toBeInTheDocument(),
    );
    expect(urls.at(-1)).toContain("page=2");
    expect(
      await screen.findByText(/Showing 2–2 of 2 blog posts · Page 2 of 2/),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeDisabled());
  });

  it("never lets a slow earlier response replace a newer one", async () => {
    const held: { release?: () => void } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? "");
      if (url.includes("filter=all")) {
        // The initial request finishes only after the newer one has landed.
        await new Promise<void>((resolve) => {
          held.release = resolve;
        });
        return json(page([summary({ plane_ticket: "STALE-001" })]));
      }
      return json(page([summary({ run_id: "run-9", plane_ticket: "FRESH-001" })]));
    });
    const user = userEvent.setup();
    render(<BlogPostsTable onOpenRun={() => undefined} />);

    await user.click(screen.getByRole("combobox", { name: "Filter blog posts" }));
    await user.click(screen.getByRole("option", { name: "Cancelled" }));
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getByText("FRESH-001")).toBeInTheDocument(),
    );

    held.release?.();
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getByText("FRESH-001")).toBeInTheDocument(),
    );
    expect(screen.queryAllByText("STALE-001")).toHaveLength(0);
  });

  it("names each action for the state the operator will find", async () => {
    const expected: Array<[string, string]> = [
      ["queued", "Continue"],
      ["running", "Continue"],
      ["waiting", "Review"],
      ["retryable_failed", "Open retry"],
      ["blocked", "Review issue"],
      ["succeeded", "View result"],
      ["cancelled", "View details"],
    ];
    stub(() =>
      page(
        expected.map(([status], index) =>
          summary({
            run_id: `run-${index}`,
            plane_ticket: `MOB-${index}`,
            primary_keyword: `keyword ${index}`,
            status,
            current_step: status === "queued" ? null : "draft",
          }),
        ),
      ),
    );
    render(<BlogPostsTable onOpenRun={() => undefined} />);

    const table = await screen.findByRole("table");
    for (const [index, [status, label]] of expected.entries()) {
      // The accessible name leads with the visible label and adds the keyword,
      // so a list of buttons is not seven indistinguishable "Continue"s.
      const button = within(table).getByRole("button", {
        name: `${label}: Keyword ${index}`,
      });
      expect(button.textContent, status).toBe(label);
    }
  });

  it("opens a run without retrying, exporting or changing anything", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? "");
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      return json(page([summary({ run_id: "run-42", status: "retryable_failed" })]));
    });
    const onOpenRun = vi.fn();
    const user = userEvent.setup();
    render(<BlogPostsTable onOpenRun={onOpenRun} />);
    const table = await screen.findByRole("table");

    await user.click(within(table).getByRole("button", { name: /^Open retry/ }));
    expect(onOpenRun).toHaveBeenCalledWith("run-42");
    // Opening a run is a read: the table itself never mutates a run.
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => /retry|resume|export|cancel/.test(call.url))).toBe(false);
  });

  it("reports the result range as well as the page position", async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      summary({ run_id: `run-${index}`, plane_ticket: `MOB-${index}` }),
    );
    const urls = stub((url) =>
      url.includes("page=2")
        ? page(rows, {
            page: 2,
            limit: 10,
            total_items: 42,
            total_pages: 5,
            has_previous: true,
            has_next: true,
          })
        : page(rows, { total_items: 42, total_pages: 5, has_next: true }),
    );
    const user = userEvent.setup();
    render(<BlogPostsTable onOpenRun={() => undefined} />);

    expect(
      await screen.findByText(/Showing 1–10 of 42 blog posts · Page 1 of 5/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(urls.at(-1)).toContain("page=2"));
    expect(
      await screen.findByText(/Showing 11–20 of 42 blog posts · Page 2 of 5/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("reports a short final page honestly", async () => {
    stub(() =>
      page([summary()], {
        page: 5,
        limit: 10,
        total_items: 41,
        total_pages: 5,
        has_previous: true,
        has_next: false,
      }),
    );
    render(<BlogPostsTable onOpenRun={() => undefined} />);

    expect(
      await screen.findByText(/Showing 41–41 of 41 blog posts · Page 5 of 5/),
    ).toBeInTheDocument();
  });

  it("keeps the current rows visible while the next page loads", async () => {
    const held: { release?: () => void } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? "");
      if (url.includes("page=2")) {
        await new Promise<void>((resolve) => {
          held.release = resolve;
        });
        return json(
          page([summary({ run_id: "run-2", plane_ticket: "MOB-002" })], {
            page: 2,
            limit: 1,
            total_items: 2,
            total_pages: 2,
            has_previous: true,
          }),
        );
      }
      return json(page([summary()], { limit: 1, total_items: 2, total_pages: 2, has_next: true }));
    });
    const user = userEvent.setup();
    render(<BlogPostsTable onOpenRun={() => undefined} />);
    const table = await screen.findByRole("table");

    await user.click(screen.getByRole("button", { name: "Next" }));
    // Mid-flight: the table the operator was reading is still there, and the
    // controls are disabled so a second click cannot race the first.
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeDisabled());
    expect(within(table).getByText("MOB-001")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading blog posts")).toBeInTheDocument();

    held.release?.();
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getByText("MOB-002")).toBeInTheDocument(),
    );
  });

  it("refreshes the current page when the pipeline moves, without losing the operator's place", async () => {
    const urls = stub(() =>
      page([summary()], { limit: 1, total_items: 2, total_pages: 2, has_next: true }),
    );
    const user = userEvent.setup();
    const { rerender } = render(<BlogPostsTable onOpenRun={() => undefined} refreshToken={0} />);
    await screen.findByRole("table");

    await user.click(screen.getByRole("combobox", { name: "Filter blog posts" }));
    await user.click(screen.getByRole("option", { name: "In progress" }));
    await waitFor(() => expect(urls.at(-1)).toContain("filter=in_progress"));

    rerender(<BlogPostsTable onOpenRun={() => undefined} refreshToken={1} />);
    await waitFor(() => expect(urls).toHaveLength(3));
    // The refresh re-requests what is on screen; it does not reset the filter.
    expect(urls.at(-1)).toContain("filter=in_progress");
    expect(urls.at(-1)).toContain("page=1");
  });

  it("explains an empty result for the chosen filter", async () => {
    stub(() => page([]));
    render(<BlogPostsTable onOpenRun={() => undefined} />);

    expect(
      await screen.findByText("No blog posts yet. Start one with a handoff above."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("reports a failure without pretending the history is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Blog posts could not be loaded." } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<BlogPostsTable onOpenRun={() => undefined} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Blog posts could not be loaded.");
  });
});
