import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, buttonVariants } from "../src/client/components/ui/button.js";

function tokensCss(): string {
  return readFileSync(resolve(process.cwd(), "src/client/styles/tokens.css"), "utf8");
}

function colourToken(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokensCss());
  if (!match?.[1]) throw new Error(`--color-${name} is not defined in tokens.css`);
  return match[1].toLowerCase();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

afterEach(cleanup);

describe("application button variants", () => {
  it("ships the approved shared palette with the storefront white-on-orange exception", () => {
    expect(colourToken("action")).toBe("#ff9800");
    expect(colourToken("action-hover")).toBe("#e08700");
    expect(colourToken("action-active")).toBe("#c77700");
    expect(colourToken("ink")).toBe("#4a4a4a");
    expect(colourToken("muted")).toBe("#4b5563");
    expect(colourToken("on-action")).toBe("#ffffff");

    // Decision 62ecc1bf: storefront-matching white on exact #FF9800 is a
    // recorded operator-accepted contrast exception (≈2.2:1, below WCAG AA).
    // Assert it stays exact and explicit rather than accidentally passing.
    for (const state of ["action", "action-hover", "action-active"]) {
      const ratio = contrastRatio(colourToken("on-action"), colourToken(state));
      expect(ratio).toBeLessThan(4.5);
      expect(ratio).toBeGreaterThan(1.5);
    }
  });

  it("styles every non-destructive variant from shared orange tokens", () => {
    expect(buttonVariants({ variant: "default" })).toMatch(
      /bg-action.*text-on-action.*hover:bg-action-hover.*active:bg-action-active/,
    );
    expect(buttonVariants({ variant: "outline" })).toMatch(
      /border-action.*text-action-link.*hover:bg-action-tint/,
    );
    expect(buttonVariants({ variant: "ghost" })).toMatch(/text-action-link.*hover:bg-action-tint/);
    expect(buttonVariants({ variant: "link" })).toMatch(
      /text-action-link.*hover:text-action-link-hover/,
    );
    expect(buttonVariants({ variant: "destructive" })).toContain("bg-destructive/10");
  });

  it("keeps white on the default variant only and preserves radius, focus, disabled, and loading", () => {
    // White content is sanctioned on the solid default variant alone.
    expect(buttonVariants({ variant: "default" })).toMatch(/text-on-action/);
    for (const variant of ["secondary", "outline", "ghost", "link"] as const) {
      expect(buttonVariants({ variant })).not.toMatch(/text-(white|paper|on-action)/);
      expect(buttonVariants({ variant })).toContain("text-action-link");
      expect(buttonVariants({ variant })).toContain("rounded-md");
      expect(buttonVariants({ variant })).toContain("focus-visible:ring-3");
      expect(buttonVariants({ variant })).toContain("disabled:opacity-50");
    }

    render(<Button loading>Saving…</Button>);
    const button = screen.getByRole("button", { name: "Saving…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});
