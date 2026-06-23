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
  // wb-final removed the LVIS brand mark from app chrome. The empty status bar
  // renders no brand logo/text — only a zero-footprint spacer that keeps the
  // flex layout stable until the first persistent item arrives.
  it("renders no LVIS brand placeholder when there are no persistent items", () => {
    render(<StatusBar persistent={[]} visibleToast={null} />);
    expect(screen.queryByText("LVIS")).toBeNull();
    expect(screen.queryByRole("img", { name: "LVIS" })).toBeNull();
  });

  it("still renders the status-bar container when empty", () => {
    render(<StatusBar persistent={[]} visibleToast={null} />);
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
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

  it("renders a dot-only persistent item with severity color + top tooltip trigger", () => {
    const onlineItem: PersistentItem = {
      id: "health:services",
      severity: "success",
      dot: true,
      a11yLabel: "LLM: online, Market: online",
      tooltip: "LLM: online\nMarket: online",
    };
    const { container, rerender } = render(
      <StatusBar persistent={[onlineItem]} visibleToast={null} />,
    );
    expect(screen.queryByText("Market")).toBeNull();
    expect(screen.getByText("LLM: online, Market: online")).toBeInTheDocument();
    const dot = container.querySelector(
      '[data-testid="status-bar-dot-health:services"]',
    );
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain("bg-success");
    const wrapper = [...container.querySelectorAll("[title]")]
      .find((el) => el.getAttribute("title") === "LLM: online\nMarket: online");
    expect(wrapper).not.toBeNull();

    // Flip offline — dot turns destructive, a11y text swaps.
    const offlineItem: PersistentItem = {
      ...onlineItem,
      severity: "error",
      a11yLabel: "LLM: offline, Market: online",
      tooltip: "LLM: offline\nMarket: online",
    };
    rerender(<StatusBar persistent={[offlineItem]} visibleToast={null} />);
    const dotOffline = container.querySelector(
      '[data-testid="status-bar-dot-health:services"]',
    );
    expect(dotOffline?.className).toContain("bg-destructive");
    expect(screen.getByText("LLM: offline, Market: online")).toBeInTheDocument();
  });

  it("joins the combined health dot directly before the LLM provider label", () => {
    const pingItem: PersistentItem = {
      id: "health:services",
      severity: "success",
      dot: true,
      a11yLabel: "LLM: online, Market: online",
      tooltip: "LLM: online\nMarket: online",
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
    const dot = container.querySelector('[data-testid="status-bar-dot-health:services"]');
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
