import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginScreen } from "../src/client/features/auth/LoginScreen.js";

/** WCAG 2.1 relative luminance of an #rrggbb colour. */
function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2.1 contrast ratio between two #rrggbb colours. */
function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Read the shipped stylesheet rather than restating hexes here, so the contrast
 * guarantee below cannot silently drift from the tokens actually in use.
 */
function colourToken(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokensCss());
  if (!match?.[1]) throw new Error(`--color-${name} is not defined in tokens.css`);
  return match[1];
}

/** Resolved from the project root: under jsdom, import.meta.url is an http URL. */
function tokensCss(): string {
  return readFileSync(resolve(process.cwd(), "src/client/styles/tokens.css"), "utf8");
}

/** A `--radius-*` token in rem, so radius relationships can be asserted numerically. */
function radiusToken(name: string): number {
  const match = new RegExp(`--radius-${name}:\\s*([0-9.]+)rem`).exec(tokensCss());
  if (!match?.[1]) throw new Error(`--radius-${name} is not defined in tokens.css`);
  return Number.parseFloat(match[1]);
}

const operator = {
  id: "local-operator",
  display_name: "Aaron",
  email: "aaron@mobelaris.com",
  account_type: "Local operator",
};

function sessionResponse(status = 200) {
  return new Response(
    JSON.stringify({
      authenticated: true,
      operator,
      csrf_token: "a".repeat(32),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function errorResponse(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LoginScreen", () => {
  it("has one semantic main/heading/form structure with labelled, autocompleted fields", () => {
    render(<LoginScreen onAuthenticated={() => undefined} />);

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Operator sign in" })).toBeInTheDocument();
    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("autocomplete", "username");
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toHaveAttribute("type", "password");
  });

  it("renders the editorial image decoratively, with empty alt text and no accessible name", () => {
    const { container } = render(<LoginScreen onAuthenticated={() => undefined} />);

    const editorial = container.querySelector<HTMLImageElement>('img[alt=""]');
    expect(editorial).not.toBeNull();
    expect(editorial!.getAttribute("src")).toContain("login-editorial");
    expect(editorial!.className).toContain("object-cover");
    // Decorative: it must never be exposed as a named image to assistive tech.
    expect(screen.queryByRole("img", { name: /editorial|login|sign/i })).not.toBeInTheDocument();
  });

  it("uses the storefront white-on-orange primary button by recorded exception", () => {
    const onOrange = colourToken("on-action");

    expect(onOrange.toLowerCase()).toBe("#ffffff");
    // Decision 62ecc1bf: white on exact #FF9800 is accepted below AA.
    expect(contrastRatio(onOrange, colourToken("action"))).toBeLessThan(4.5);
    expect(tokensCss()).not.toMatch(/--color-login-/);
  });

  it("inherits the application-wide default button variant with no login colour override", () => {
    render(<LoginScreen onAuthenticated={() => undefined} />);

    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit.className).toContain("bg-action");
    expect(submit.className).toContain("text-on-action");
    expect(submit.className).toContain("hover:bg-action-hover");
    expect(submit.className).not.toMatch(/login-orange|text-white/);
    // Focus, disabled and loading affordances stay on the shared variant.
    expect(submit.className).toContain("focus-visible:ring-3");
    expect(submit.className).toContain("disabled:opacity-50");
  });

  it("uses the roomier responsive login geometry and login-only radius exception", () => {
    const { container } = render(<LoginScreen onAuthenticated={() => undefined} />);

    const heading = screen.getByRole("heading", { level: 1, name: "Operator sign in" });
    const section = heading.closest("section")!;
    const editorial = container.querySelector<HTMLImageElement>('img[alt=""]')!;
    const surface = editorial.closest<HTMLElement>("[class*='rounded-login-surface']")!;
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    const visibility = screen.getByRole("button", { name: "Show password" });
    const submit = screen.getByRole("button", { name: "Sign in" });

    expect(section.className).toContain("max-w-sm");
    expect(section.className).toContain("md:max-w-5xl");
    expect(surface.className).toContain("md:min-h-[32rem]");
    expect(surface.className).toContain("overflow-hidden");
    expect(surface.className).toContain("rounded-login-surface");
    expect(editorial.className).not.toMatch(/rounded/);

    for (const field of [email, password]) {
      expect(field.className).toContain("h-12");
      expect(field.className).toContain("rounded-login-field");
      expect(field.className).not.toContain("rounded-full");
      expect(field.className).toContain("border");
      expect(field.className).toContain("focus-visible:ring-3");
      expect(field.className).toContain("disabled:bg-subtle");
      expect(field.className).toContain("aria-invalid:ring-3");
    }
    expect(email).toHaveAttribute("autocomplete", "username");
    expect(password).toHaveAttribute("autocomplete", "current-password");

    expect(visibility.className).toContain("w-12");
    expect(visibility.className).toContain("rounded-r-login-field");
    expect(visibility.className).not.toContain("rounded-full");
    expect(visibility.className).toContain("focus-visible:ring-3");
    expect(submit.className).toContain("h-12");
    expect(submit.className).toContain("rounded-login-control");
    expect(submit.className).not.toContain("rounded-full");
    expect(submit.className).toContain("focus-visible:ring-3");

    expect(radiusToken("login-surface")).toBe(0.75);
    expect(radiusToken("login-field")).toBe(0.75);
    expect(radiusToken("login-control")).toBe(0.375);
    expect(radiusToken("control")).toBe(0.125);
  });

  it("keeps the form usable on mobile, where the decorative image column is hidden", () => {
    const { container } = render(<LoginScreen onAuthenticated={() => undefined} />);

    // The image column is display-hidden below `md`, so the form must not depend on it.
    const imageColumn = container.querySelector('img[alt=""]')?.parentElement;
    expect(imageColumn?.className).toContain("hidden");
    expect(imageColumn?.className).toContain("md:block");
    const section = screen.getByRole("heading", { name: "Operator sign in" }).closest("section")!;
    expect(section.className).toContain("w-full");
    expect(section.className).toContain("max-w-sm");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("offers no registration, recovery, social-login or legal-agreement affordances", () => {
    render(<LoginScreen onAuthenticated={() => undefined} />);

    for (const forbidden of [
      /apple/i,
      /google/i,
      /meta|facebook/i,
      /or continue with/i,
      /forgot/i,
      /don.t have an account/i,
      /sign up/i,
      /create account/i,
      /register/i,
      /terms of service/i,
      /privacy policy/i,
    ]) {
      expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
    }
    // Exactly one submit action, and no role selector.
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: /role/i })).not.toBeInTheDocument();
  });

  it("toggles password visibility with an accessible, updating control name", async () => {
    const user = userEvent.setup();
    render(<LoginScreen onAuthenticated={() => undefined} />);

    const toggle = screen.getByRole("button", { name: "Show password" });
    await user.click(toggle);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();
  });

  it("disables sign in until both fields are filled, then shows the busy state", async () => {
    let resolveResponse!: (value: Response) => void;
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
    render(<LoginScreen onAuthenticated={() => undefined} />);

    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "aaron@mobelaris.com" },
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    resolveResponse(sessionResponse());
  });

  it("shows a non-error message when provided, and lets a submit error take priority over it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errorResponse(401, "INVALID_CREDENTIALS", "x")),
    );
    const user = userEvent.setup();
    render(
      <LoginScreen
        message="Your session expired. Sign in again to continue."
        onAuthenticated={() => undefined}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Your session expired");

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "aaron@mobelaris.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "The email or password is incorrect.",
    );
  });

  it("gives the same safe message for an invalid identifier and an invalid password alike", async () => {
    for (const email of ["unknown@mobelaris.com", "aaron@mobelaris.com"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(errorResponse(401, "INVALID_CREDENTIALS", "irrelevant detail")),
      );
      const user = userEvent.setup();
      render(<LoginScreen onAuthenticated={() => undefined} />);
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "The email or password is incorrect.",
      );
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it("shows the throttled message on a 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errorResponse(429, "RATE_LIMITED", "too many attempts")),
    );
    const user = userEvent.setup();
    render(<LoginScreen onAuthenticated={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "aaron@mobelaris.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Too many sign-in attempts. Wait a few minutes before trying again.",
    );
  });

  it("shows a server-unavailable message for any other failure, without leaking detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network detail nobody should see")),
    );
    const user = userEvent.setup();
    render(<LoginScreen onAuthenticated={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "aaron@mobelaris.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The private workspace is temporarily unavailable. Try again shortly.",
    );
  });

  it("calls onAuthenticated with the parsed session on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sessionResponse()));
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();
    render(<LoginScreen onAuthenticated={onAuthenticated} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "aaron@mobelaris.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(onAuthenticated).toHaveBeenCalledWith(
        expect.objectContaining({ operator: expect.objectContaining({ display_name: "Aaron" }) }),
      ),
    );
  });
});
