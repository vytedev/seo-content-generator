// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App.js";
import { AuthSessionSchema } from "../src/shared/contracts/auth.js";

const session = AuthSessionSchema.parse({
  authenticated: true,
  operator: {
    id: "local-operator",
    display_name: "Aaron",
    email: "aaron@example.test",
    account_type: "Local operator",
  },
  csrf_token: "c".repeat(43),
  expires_at: "2030-01-01T00:00:00.000Z",
});

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("single-operator authentication", () => {
  it("checks the session before showing private content, then renders the sign-in screen", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response({ error: { code: "AUTH_REQUIRED", message: "Authentication is required." } }, 401),
    );
    render(<App />);
    expect(screen.getByText("Opening the private workspace…")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Operator sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Blog post" })).not.toBeInTheDocument();
    expect(screen.queryByText(/create account/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /role/i })).not.toBeInTheDocument();
  });

  it("leaves the opening screen when the session request stalls", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    render(<App />);
    expect(screen.getByText("Opening the private workspace…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(screen.getByRole("heading", { name: "Operator sign in" })).toBeInTheDocument();
    expect(
      screen.getByText("The private workspace could not verify your session. Sign in to continue."),
    ).toBeInTheDocument();
  });

  it("supports password visibility and a successful sign in", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({ error: { code: "AUTH_REQUIRED", message: "Authentication is required." } }, 401),
      )
      .mockResolvedValueOnce(response(session))
      .mockResolvedValue(response({ runs: [] }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Operator sign in" });
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    await user.type(screen.getByLabelText("Email"), "aaron@example.test");
    await user.type(password, "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Aaron")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Blog post" })).toBeInTheDocument();
    const loginCall = fetcher.mock.calls[1];
    expect(loginCall?.[0]).toBe("/api/auth/login");
  });

  it("does not call a fresh anonymous visit an expired session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response({ error: { code: "AUTH_REQUIRED", message: "Authentication is required." } }, 401),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Operator sign in" });
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });

  it("uses a uniform invalid-credentials message", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({ error: { code: "AUTH_REQUIRED", message: "Authentication is required." } }, 401),
      )
      .mockResolvedValueOnce(
        response(
          {
            error: { code: "INVALID_CREDENTIALS", message: "The email or password is incorrect." },
          },
          401,
        ),
      );
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Operator sign in" });
    await user.type(screen.getByLabelText("Email"), "nobody@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("The email or password is incorrect.")).toBeInTheDocument();
  });

  it("shows a truthful warning when server-side sign out fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response({ error: { code: "INTERNAL_ERROR" } }, 500));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Aaron/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByText(/could not confirm sign-out/i)).toBeInTheDocument();
    expect(screen.queryByText("You have signed out safely.")).not.toBeInTheDocument();
  });

  it("signs out from the authenticated sidebar", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(session))
      // Navigation and the history table each request the run list.
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response({ runs: [] }))
      .mockResolvedValueOnce(response(null, 204));
    const user = userEvent.setup();
    render(<App />);
    const account = await screen.findByRole("button", { name: /Aaron/ });
    await user.click(account);
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Operator sign in" })).toBeInTheDocument(),
    );
    expect(screen.getByText("You have signed out safely.")).toBeInTheDocument();
  });
});
