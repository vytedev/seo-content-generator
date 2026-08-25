import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsConnection } from "../src/client/features/runs/GoogleDocsConnection.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Google Docs connection control", () => {
  it("is explicitly unavailable until configured", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ configured: false, connected: false, connected_at: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<GoogleDocsConnection />);
    expect(
      await screen.findByText("Connection unavailable until Google OAuth is configured locally."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect Google" })).not.toBeInTheDocument();
  });

  it("offers the server-side OAuth start route when configured", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ configured: true, connected: false, connected_at: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<GoogleDocsConnection />);
    expect(await screen.findByRole("link", { name: "Connect Google" })).toHaveAttribute(
      "href",
      "/api/integrations/google/connect",
    );
  });

  it("announces an error while retaining the disconnect control", async () => {
    window.history.replaceState({}, "", "/");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            configured: true,
            connected: true,
            connected_at: "2026-08-20T10:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const user = userEvent.setup();
    render(<GoogleDocsConnection />);
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Google could not be disconnected.");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });
});
