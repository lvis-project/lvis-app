import "../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "../components/StatusBar.js";
import type { PersistentItem, ToastItem } from "../hooks/use-status-bar.js";

function persistent(overrides: Partial<PersistentItem> = {}): PersistentItem {
  return {
    id: "routine:next",
    severity: "info",
    label: "다음 루틴",
    value: "04:42 KST",
    ...overrides,
  };
}

function toast(overrides: Partial<ToastItem> = {}): ToastItem {
  return {
    id: "toast:1",
    severity: "info",
    message: "agent-hub 설치 중…",
    expiresAt: Date.now() + 5000,
    ...overrides,
  };
}

describe("StatusBar", () => {
  it("renders the LVIS placeholder when there are no persistent items", () => {
    render(<StatusBar persistent={[]} toasts={[]} />);
    expect(screen.getByText("LVIS")).toBeInTheDocument();
  });

  it("renders persistent items with label and value", () => {
    render(<StatusBar persistent={[persistent()]} toasts={[]} />);
    expect(screen.getByText("다음 루틴")).toBeInTheDocument();
    expect(screen.getByText("04:42 KST")).toBeInTheDocument();
  });

  it("renders toast messages on the right slot", () => {
    render(<StatusBar persistent={[]} toasts={[toast(), toast({ id: "toast:2", message: "agent-hub 설치 완료", severity: "success" })]} />);
    expect(screen.getByText("agent-hub 설치 중…")).toBeInTheDocument();
    expect(screen.getByText("agent-hub 설치 완료")).toBeInTheDocument();
  });

  it("caps visible toasts at 3 even if more are queued", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      toast({ id: `toast:${i}`, message: `msg-${i}` }),
    );
    render(<StatusBar persistent={[]} toasts={many} />);
    // Only the last 3 (latest) should be rendered.
    expect(screen.queryByText("msg-0")).not.toBeInTheDocument();
    expect(screen.queryByText("msg-2")).not.toBeInTheDocument();
    expect(screen.getByText("msg-3")).toBeInTheDocument();
    expect(screen.getByText("msg-4")).toBeInTheDocument();
    expect(screen.getByText("msg-5")).toBeInTheDocument();
  });

  it("uses role=status with aria-live=polite for screen-reader updates", () => {
    const { container } = render(<StatusBar persistent={[]} toasts={[]} />);
    // Query the footer directly — rendering surfaces it with role="status".
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer).toHaveAttribute("role", "status");
    expect(footer).toHaveAttribute("aria-live", "polite");
  });
});
