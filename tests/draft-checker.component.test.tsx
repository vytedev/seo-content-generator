import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App.js";

// The Blog Post landing screen fetches the run list on mount; every checker
// test is happy with an empty list so navigation starts from a clean slate.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          runs: [],
          pagination: {
            page: 1,
            limit: 10,
            total_items: 0,
            total_pages: 0,
            has_previous: false,
            has_next: false,
          },
          filter: "all",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openChecker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Check a draft" }));
}

/** The collapsible sections are details/summary, so match the summary itself. */
function disclosure(title: string): HTMLElement {
  const heading = screen
    .getAllByText(new RegExp(`^${title}`))
    .find((node) => node.closest("summary"));
  if (!heading) throw new Error(`No disclosure titled ${title}`);
  return heading.closest("summary")!;
}

describe("Draft checker screen", () => {
  it("submits from the end of the form, after the optional sections", async () => {
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);
    await openChecker(user);

    const submit = screen.getByRole("button", { name: "Run checks →" });
    const bodyMarkdown = screen.getByLabelText("Body markdown");
    const internalLinks = disclosure("Internal links");

    // DOCUMENT_POSITION_FOLLOWING: the button comes after both the draft body
    // and the last optional section, rather than interrupting the form.
    for (const earlier of [bodyMarkdown, internalLinks])
      expect(earlier.compareDocumentPosition(submit)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("introduces the optional sections with a short explanation", async () => {
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);
    await openChecker(user);

    const message = screen.getByText("Optional details — add these for a complete check.");
    const onPage = disclosure("More on-page elements");
    expect(message.compareDocumentPosition(onPage)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps the submit button full width only on small screens", async () => {
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);
    await openChecker(user);

    const submit = screen.getByRole("button", { name: "Run checks →" });
    expect(submit.className).toContain("w-full");
    expect(submit.className).toContain("sm:w-auto");
  });

  it("uses the shared accessible textarea composition with content-specific sizing", async () => {
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);
    await openChecker(user);

    const metaDescription = screen.getByLabelText("Meta description");
    const bodyMarkdown = screen.getByLabelText("Body markdown");

    for (const textarea of [metaDescription, bodyMarkdown]) {
      expect(textarea.tagName).toBe("TEXTAREA");
      expect(textarea).toHaveAttribute("data-slot", "textarea");
      expect(textarea.className).toContain("rounded-field");
      expect(textarea.className).toContain("border");
      expect(textarea.className).toContain("bg-paper");
      expect(textarea.className).toContain("px-3");
      expect(textarea.className).toContain("resize-y");
      expect(textarea.className).toContain("focus-visible:ring-3");
      expect(textarea.className).not.toContain("rounded-full");
      expect(textarea.closest('[data-slot="field"]')).toHaveClass("min-w-0");
    }

    expect(metaDescription.className).toContain("min-h-24");
    expect(metaDescription.className).not.toContain("font-mono");
    expect(metaDescription.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
    expect(screen.getByText("0/155")).toHaveAttribute("id", expect.stringMatching(/-count$/));
    expect(
      screen.getByText("Summarise the draft for search results in 150–155 characters."),
    ).toHaveAttribute("id", expect.stringMatching(/-description$/));

    expect(bodyMarkdown.className).toContain("min-h-[14rem]");
    expect(bodyMarkdown.className).toContain("lg:min-h-[18rem]");
    expect(bodyMarkdown.className).toContain("font-mono");
    const bodyDescription = screen.getByText(
      "Paste the complete article in Markdown. The checker reads it without rewriting it.",
    );
    expect(bodyMarkdown.getAttribute("aria-describedby")?.split(" ")).toContain(bodyDescription.id);
  });

  it("aligns the accessible on-page disclosure in a responsive top-aligned grid", async () => {
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);
    await openChecker(user);

    const disclosure = screen.getByText("More on-page elements").closest("summary")!;
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure.className).toContain("items-center");
    expect(disclosure.className).toContain("focus-visible:ring-3");

    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const contentId = disclosure.getAttribute("aria-controls")!;
    const content = document.getElementById(contentId)!;
    expect(content).toHaveAttribute("role", "region");
    expect(content).toHaveAttribute("aria-labelledby", disclosure.id);

    const grid = screen.getByTestId("on-page-elements-grid");
    expect(grid.className).toContain("items-start");
    expect(grid.className).toContain("md:grid-cols-2");
    expect(grid.className).toContain("gap-x-4");
    expect(grid.className).toContain("gap-y-5");
    expect(grid.className).not.toMatch(/absolute|-m[trblxy]?-|items-(center|end)/);

    const title = screen.getByLabelText("OG title");
    const description = screen.getByLabelText("OG description");
    const slug = screen.getByLabelText("Slug");
    const titleField = title.closest('[data-slot="field"]')!;
    const descriptionField = description.closest('[data-slot="field"]')!;
    const slugField = slug.closest('[data-slot="field"]')!;

    expect(Array.from(grid.children)).toEqual([titleField, descriptionField, slugField]);
    expect(slugField.className).toContain("md:col-span-2");
    expect(title).toHaveAttribute("data-slot", "input");
    expect(description).toHaveAttribute("data-slot", "textarea");
    expect(description.className).toContain("min-h-24");
    expect(description.className).toContain("rounded-field");
    expect(description.className).toContain("resize-y");
    expect(description.className).toContain("focus-visible:ring-3");
    expect(description.className).not.toMatch(/h-\[|absolute|-m[trblxy]?-/);
    expect(slug).toHaveAttribute("data-slot", "input");
    expect(titleField.className).toContain("gap-1.5");
    expect(descriptionField.className).toContain("gap-1.5");

    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
  });

  it("updates character counts and adds structured rows", async () => {
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);
    await openChecker(user);

    await user.type(screen.getByLabelText(/^Meta title/), "A calm editorial title");
    expect(screen.getByText("22/60")).toBeInTheDocument();

    await user.click(screen.getByText("FAQs"));
    await user.click(screen.getByRole("button", { name: "+ Add FAQ" }));
    const firstQuestion = screen.getByLabelText("FAQ 1 question");
    const secondQuestion = screen.getByLabelText("FAQ 2 question");
    expect(secondQuestion).toBeInTheDocument();
    expect(firstQuestion.id).toBeTruthy();
    expect(secondQuestion.id).toBeTruthy();
    expect(firstQuestion.id).not.toBe(secondQuestion.id);
    expect(screen.getByRole("button", { name: "Remove FAQ 2" })).toBeInTheDocument();
  });

  it("associates local validation with controls and summary links without making a request", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<App authMode="test-bypass" />);
    await openChecker(user);

    await user.click(screen.getByRole("button", { name: "Run checks →" }));

    expect(screen.getByRole("alert")).toHaveAccessibleName("Review the checker input");
    const primary = screen.getByLabelText(/Primary keyword/);
    const error = screen.getAllByText("Enter a primary keyword.").at(-1)!;
    expect(primary).toHaveAttribute("aria-invalid", "true");
    expect(primary.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    expect(screen.getByRole("link", { name: "Enter a primary keyword." })).toHaveAttribute(
      "href",
      `#${primary.id}`,
    );
    expect(primary.closest('[data-slot="field"]')).toHaveAttribute("data-invalid", "true");
    // No checker request was made — the only fetch is the landing run list.
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/runs?"))).toBe(true);
  });

  it("keeps repeated control IDs stable after deletion and strips local IDs from the payload", async () => {
    const user = userEvent.setup();
    // A fresh Response per call — bodies are single-use and the Blog Post
    // landing screen consumes the first one.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ findings: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    render(<App authMode="test-bypass" />);
    await openChecker(user);

    await user.click(screen.getByText("Images"));
    await user.click(screen.getByRole("button", { name: "+ Add image" }));
    await user.type(screen.getByLabelText("Image 1 alt text"), "first");
    await user.type(screen.getByLabelText("Image 2 alt text"), "second");
    const secondImageId = screen.getByLabelText("Image 2 alt text").id;
    await user.click(screen.getByRole("button", { name: "Remove image 1" }));
    expect(screen.getByLabelText("Image 1 alt text")).toHaveAttribute("id", secondImageId);

    await user.click(screen.getByText("FAQs"));
    await user.click(screen.getByRole("button", { name: "+ Add FAQ" }));
    const secondFaqId = screen.getByLabelText("FAQ 2 question").id;
    await user.click(screen.getByRole("button", { name: "Remove FAQ 1" }));
    expect(screen.getByLabelText("FAQ 1 question")).toHaveAttribute("id", secondFaqId);

    await user.click(screen.getByText("Internal links"));
    const hierarchy = screen.getByRole("combobox", { name: "Hierarchy" });
    expect(hierarchy).toHaveAttribute("data-slot", "select-trigger");
    await user.click(hierarchy);
    await user.click(screen.getByRole("option", { name: "Product" }));
    expect(hierarchy).toHaveTextContent("Product");
    await user.click(screen.getByRole("button", { name: "+ Add link" }));
    await user.type(screen.getByLabelText("Entry 1 URL"), "https://www.mobelaris.com/old");
    await user.type(screen.getByLabelText("Entry 2 URL"), "https://www.mobelaris.com/new");
    const secondLinkId = screen.getByLabelText("Entry 2 URL").id;
    await user.click(screen.getByRole("button", { name: "Remove link 1" }));
    expect(screen.getByLabelText("Entry 1 URL")).toHaveAttribute("id", secondLinkId);

    await user.type(screen.getByLabelText(/Primary keyword/), "sofas");
    await user.type(screen.getByLabelText(/Related keywords/), "modern seating");
    await user.click(screen.getByRole("button", { name: "Run checks →" }));
    const checkerCalls = fetchMock.mock.calls.filter(([url]) => String(url) === "/api/checker");
    await waitFor(() => expect(checkerCalls).toHaveLength(1));
    const payload = JSON.parse(String(checkerCalls[0]?.[1]?.body));
    expect(payload.on_page.images).toEqual([{ alt: "second", filename: "" }]);
    expect(payload.on_page.faqs).toEqual([{ question: "", answer: "" }]);
    expect(payload.verified_internal_links).toEqual([
      {
        url: "https://www.mobelaris.com/new",
        status: 200,
        hierarchy: "collection",
        hierarchy_rank: 1,
      },
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/\"id\"/);
  });

  it("posts checker input and renders compact structured findings", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            findings: [
              {
                id: "det_12345678",
                rule: "style.british_english_provisional",
                severity: "warning",
                location: { field: "body_markdown", line_start: 2 },
                issue: "US spelling appears in the draft.",
                suggested_fix: "Use British English spelling.",
                provisional: true,
              },
            ],
            summary: { blocker: 0, warning: 1, info: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    render(<App authMode="test-bypass" />);
    await openChecker(user);

    await user.type(screen.getByLabelText(/Primary keyword/), "sofas");
    await user.type(screen.getByLabelText(/Related keywords/), "modern seating");
    await user.click(screen.getByRole("button", { name: "Run checks →" }));

    await waitFor(() =>
      expect(screen.getByText("US spelling appears in the draft.")).toBeInTheDocument(),
    );
    expect(screen.getByText("style.british_english_provisional")).toBeInTheDocument();
    expect(screen.getByText("Provisional")).toBeInTheDocument();
    expect(screen.getByText("1 Warning")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Checks complete. 1 finding.");
  });

  it("shows the passing empty state when checks return no findings", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ findings: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    render(<App authMode="test-bypass" />);
    await openChecker(user);

    await user.type(screen.getByLabelText(/Primary keyword/), "sofas");
    await user.type(screen.getByLabelText(/Related keywords/), "modern seating");
    await user.click(screen.getByRole("button", { name: "Run checks →" }));

    await waitFor(() =>
      expect(screen.getByText("No findings — the draft passed every check.")).toBeInTheDocument(),
    );
  });
});
