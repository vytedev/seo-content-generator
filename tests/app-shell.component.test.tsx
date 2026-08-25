import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App.js";

// This Node runtime's built-in `localStorage` global is not functional in the
// jsdom test environment, independent of the app; substitute a real in-memory
// Storage implementation so persistence behaviour is deterministic here.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const DESKTOP_WIDTH = 1024;
const MOBILE_WIDTH = 390;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
  setViewportWidth(DESKTOP_WIDTH);
  // The Blog Post landing screen loads the run list on mount; every shell
  // test is happy with an empty list (start state).
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ runs: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setViewportWidth(DESKTOP_WIDTH);
});

describe("AppSidebar desktop", () => {
  it("renders expanded with the two navigation groups and marks the active screen", async () => {
    render(<App authMode="test-bypass" />);

    const logos = await screen.findAllByRole("img", { name: "Mobelaris" });
    expect(logos.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("SEO Production")).toBeInTheDocument();

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    const blogPost = screen.getByRole("button", { name: "Blog post" });
    expect(blogPost).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Writing guides" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check a draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calibration" })).toBeInTheDocument();
  });

  it("collapses to an icon rail via a keyboard-accessible dedicated control, keeping full accessible names and navigation", async () => {
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    const collapseControl = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapseControl).toHaveAttribute("aria-expanded", "true");

    collapseControl.focus();
    await user.keyboard("{Enter}");

    const expandControl = await screen.findByRole("button", { name: "Expand sidebar" });
    expect(expandControl).toHaveAttribute("aria-expanded", "false");

    // Nav items keep their full accessible name while collapsed — never icon-only.
    const guidesNav = screen.getByRole("button", { name: "Writing guides" });
    expect(guidesNav).toBeInTheDocument();
    await user.click(guidesNav);
    expect(await screen.findByRole("heading", { name: "Writing guides" })).toBeInTheDocument();
  });

  it("persists the collapsed preference across a reload", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App authMode="test-bypass" />);
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    unmount();

    render(<App authMode="test-bypass" />);
    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("shows the full logo when expanded and the compact mark when collapsed, both aspect-ratio preserved", async () => {
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    const bySrc = () =>
      screen.getAllByRole("img", { name: "Mobelaris" }).map((img) => img.getAttribute("src") ?? "");

    // Exactly one Mobelaris mark on screen at a time — the sidebar's own,
    // never duplicated elsewhere in the shell (e.g. the header toolbar).
    expect(screen.getAllByRole("img", { name: "Mobelaris" })).toHaveLength(1);
    expect(bySrc().some((src) => src.includes("LOGO-MOBELARIS_Final"))).toBe(true);
    for (const img of screen.getAllByRole("img", { name: "Mobelaris" })) {
      expect(img).toHaveAttribute("width");
      expect(img).toHaveAttribute("height");
    }

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    await screen.findByRole("button", { name: "Expand sidebar" });

    // Collapsed: still exactly one mark, now the compact logo.
    expect(screen.getAllByRole("img", { name: "Mobelaris" })).toHaveLength(1);
    expect(bySrc().every((src) => src.includes("Mobelaris-Logo-M"))).toBe(true);
  });

  it("does not communicate sidebar state by icon alone", async () => {
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    const control = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(control).toHaveAccessibleName("Collapse sidebar");
    await user.click(control);
    const toggled = await screen.findByRole("button", { name: "Expand sidebar" });
    expect(toggled).toHaveAccessibleName("Expand sidebar");
    expect(toggled).toHaveAttribute("aria-expanded", "false");
  });
});

describe("AppSidebar navigation", () => {
  it("lands on the Blog Post screen with the accessible handoff intake", async () => {
    render(<App authMode="test-bypass" />);
    expect(await screen.findByRole("heading", { name: "Blog post" })).toBeInTheDocument();
    expect(screen.getByLabelText("Handoff JSON")).toBeInTheDocument();
  });
});

describe("AppSidebar account menu", () => {
  it("shows the configured operator and only the supported sign-out action", async () => {
    const user = userEvent.setup();
    render(<App authMode="test-bypass" />);

    const trigger = screen.getByRole("button", { name: /Aaron/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getByText("Local operator")).toBeInTheDocument();

    await user.click(trigger);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Settings/ })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

describe("AppSidebar mobile", () => {
  it("opens the drawer from a clearly labelled trigger, traps focus inside it, and Escape returns focus to the trigger", async () => {
    const user = userEvent.setup();
    setViewportWidth(MOBILE_WIDTH);
    render(<App authMode="test-bypass" />);

    const trigger = await screen.findByRole("button", { name: "Menu" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    // Radix marks the rest of the page aria-hidden while the dialog is open
    // (background interaction is blocked), so the trigger itself is
    // unreachable by role until the dialog closes — only its own content is.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const toolsNav = await screen.findByRole("button", { name: "Check a draft" });
    expect(toolsNav).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const reopenedTrigger = screen.getByRole("button", { name: "Menu" });
    expect(reopenedTrigger).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(reopenedTrigger).toHaveFocus());
  });

  it("closes the drawer and navigates when a destination is selected", async () => {
    const user = userEvent.setup();
    setViewportWidth(MOBILE_WIDTH);
    render(<App authMode="test-bypass" />);

    await user.click(await screen.findByRole("button", { name: "Menu" }));
    await user.click(await screen.findByRole("button", { name: "Check a draft" }));

    expect(await screen.findByRole("heading", { name: "Check a draft" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Menu" })).toBeInTheDocument();
  });
});
