import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    render(<StatusBar persistent={[]} visibleToast={null} />);
    expect(screen.getByText("LVIS")).toBeInTheDocument();
  });

  it("marks the placeholder logo as decorative so LVIS is announced once", () => {
    render(<StatusBar persistent={[]} visibleToast={null} />);
    expect(screen.queryByRole("img", { name: "LVIS" })).toBeNull();
  });

  it("renders persistent items with label and value", () => {
    render(<StatusBar persistent={[persistent()]} visibleToast={null} />);
    expect(screen.getByText("다음 루틴")).toBeInTheDocument();
    expect(screen.getByText("04:42 KST")).toBeInTheDocument();
  });

  it("renders only the visible toast message on the right slot", () => {
    const t1 = toast({ id: "toast:1", message: "agent-hub 설치 중…" });
    const t2 = toast({ id: "toast:2", message: "agent-hub 설치 완료", severity: "success" });
    // Only visibleToast (t1) is shown; t2 contributes to pendingCount only.
    render(<StatusBar persistent={[]} visibleToast={t1} pendingCount={1} />);
    expect(screen.getByText("agent-hub 설치 중…")).toBeInTheDocument();
    expect(screen.queryByText("agent-hub 설치 완료")).not.toBeInTheDocument();
    // pending badge shows +1
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("shows no toast when visibleToast is null", () => {
    render(<StatusBar persistent={[]} visibleToast={null} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows no pending badge when pendingCount is 0", () => {
    render(<StatusBar persistent={[]} visibleToast={toast()} pendingCount={0} />);
    expect(screen.queryByText(/\+\d/)).not.toBeInTheDocument();
  });

  it("shows pending badge with correct count", () => {
    render(<StatusBar persistent={[]} visibleToast={toast()} pendingCount={2} />);
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("invokes onToastClick when a notification toast is clicked (#260 M2)", () => {
    const onToastClick = vi.fn();
    const notif: ToastItem = toast({
      id: "toast:n",
      message: "질문이 도착했습니다: 진행 상태?",
      severity: "info",
      notification: { kind: "ask-user", contextRef: { questionId: "q-9" } },
    });
    render(<StatusBar persistent={[]} visibleToast={notif} onToastClick={onToastClick} />);
    const btn = screen.getByRole("button", {
      name: /질문이 도착했습니다/,
    });
    fireEvent.click(btn);
    expect(onToastClick).toHaveBeenCalledTimes(1);
    expect(onToastClick).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "toast:n",
        notification: expect.objectContaining({
          kind: "ask-user",
          contextRef: expect.objectContaining({ questionId: "q-9" }),
        }),
      }),
    );
  });

  it("renders non-notification toasts as plain spans (no click handler)", () => {
    const onToastClick = vi.fn();
    render(
      <StatusBar
        persistent={[]}
        visibleToast={toast({ id: "toast:i", message: "agent-hub 설치 완료", severity: "success" })}
        onToastClick={onToastClick}
      />,
    );
    // Plain producer toasts have no role=button, so clicking the text doesn't invoke the handler.
    expect(screen.queryByRole("button")).toBeNull();
    expect(onToastClick).not.toHaveBeenCalled();
  });

  it("renders a clickable persistent item as a button and invokes onClick (PR-X1)", () => {
    const onClick = vi.fn();
    render(
      <StatusBar
        persistent={[persistent({ id: "vendor:llm", label: "🟧", value: "Claude · sonnet-4-6", onClick })]}
        visibleToast={null}
      />,
    );
    const btn = screen.getByRole("button", { name: /Claude · sonnet-4-6/ });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a persistent item without onClick as a plain span", () => {
    render(
      <StatusBar
        persistent={[persistent({ id: "vendor:llm", label: "🟧", value: "Claude · sonnet-4-6" })]}
        visibleToast={null}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Claude · sonnet-4-6")).toBeInTheDocument();
  });

  it("renders a dot-only persistent item with severity color + tooltip (marketplace)", () => {
    // Marketplace online — green dot, English tooltip, no visible 마켓 text.
    const onlineItem: PersistentItem = {
      id: "marketplace:online",
      severity: "success",
      dot: true,
      a11yLabel: "Marketplace: Online",
      tooltip: "Marketplace: Online",
    };
    const { container, rerender } = render(
      <StatusBar persistent={[onlineItem]} visibleToast={null} />,
    );
    // No "마켓" text — only the colored dot + sr-only a11y label.
    expect(screen.queryByText("마켓")).toBeNull();
    expect(screen.getByText("Marketplace: Online")).toBeInTheDocument();
    const dot = container.querySelector(
      '[data-testid="status-bar-dot-marketplace:online"]',
    );
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain("bg-success");
    // Tooltip wires through to `title` on the wrapping span.
    const wrapper = container.querySelector('[title="Marketplace: Online"]');
    expect(wrapper).not.toBeNull();

    // Flip offline — dot turns destructive, tooltip swaps.
    const offlineItem: PersistentItem = {
      ...onlineItem,
      severity: "error",
      a11yLabel: "Marketplace: Offline",
      tooltip: "Marketplace: Offline",
    };
    rerender(<StatusBar persistent={[offlineItem]} visibleToast={null} />);
    const dotOffline = container.querySelector(
      '[data-testid="status-bar-dot-marketplace:online"]',
    );
    expect(dotOffline?.className).toContain("bg-destructive");
    expect(screen.getByText("Marketplace: Offline")).toBeInTheDocument();
  });

  it("joins the AI provider ping dot directly before the LLM provider label", () => {
    const pingItem: PersistentItem = {
      id: "provider:llm-ping",
      severity: "success",
      dot: true,
      a11yLabel: "AI provider: Connected",
      tooltip: "AI provider: Connected",
    };
    const { container } = render(
      <StatusBar
        persistent={[
          pingItem,
          persistent({ id: "vendor:llm", label: "🔷", value: "Azure · gpt-4o" }),
        ]}
        visibleToast={null}
      />,
    );
    expect(container.querySelector('[data-testid="status-bar"]')?.textContent).not.toContain("|");
    const dot = container.querySelector('[data-testid="status-bar-dot-provider:llm-ping"]');
    expect(dot?.className).toContain("bg-success");
    expect(screen.getByText("Azure · gpt-4o")).toBeInTheDocument();
  });

  it("uses role=status with aria-live=polite for screen-reader updates", () => {
    const { container } = render(<StatusBar persistent={[]} visibleToast={null} />);
    // Query the footer directly — rendering surfaces it with role="status".
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer).toHaveAttribute("role", "status");
    expect(footer).toHaveAttribute("aria-live", "polite");
  });
});
