import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBadge } from "../src/client/components/StatusBadge.js";

afterEach(cleanup);

describe("StatusBadge", () => {
  it("renders Succeeded in the success colour, matching its dot", () => {
    render(<StatusBadge status="succeeded" />);
    expect(screen.getByText("Succeeded")).toHaveClass("text-success");
  });

  it("renders Running in the info colour, matching its dot", () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText("Running")).toHaveClass("text-info");
  });

  it("renders Waiting in the warning colour, matching its dot", () => {
    render(<StatusBadge status="waiting" />);
    expect(screen.getByText("Waiting")).toHaveClass("text-warning");
  });

  it("renders Failed states (retry available, blocked) in the danger colour, matching the icon", () => {
    render(<StatusBadge status="retryable_failed" />);
    expect(screen.getByText("Retry available")).toHaveClass("text-danger");
    cleanup();

    render(<StatusBadge status="blocked" />);
    expect(screen.getByText("Blocked")).toHaveClass("text-danger");
    cleanup();

    render(<StatusBadge status="failed" />);
    expect(screen.getByText("Failed")).toHaveClass("text-danger");
  });

  it("renders Queued and Cancelled in the muted colour, matching their dot", () => {
    render(<StatusBadge status="queued" />);
    expect(screen.getByText("Queued")).toHaveClass("text-muted");
    cleanup();

    render(<StatusBadge status="cancelled" />);
    expect(screen.getByText("Cancelled")).toHaveClass("text-muted");
  });
});
