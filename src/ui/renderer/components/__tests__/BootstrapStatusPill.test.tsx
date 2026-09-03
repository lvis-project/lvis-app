// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { BootstrapStatusPill } from "../BootstrapStatusPill.js";
import type { BootstrapStatusEvent } from "../../hooks/use-bootstrap-status.js";

describe("BootstrapStatusPill", () => {
  afterEach(() => cleanup());

  it("renders nothing before the host reports anything", () => {
    renderPill(null);
    expect(screen.queryByTestId("bootstrap-status-pill")).toBeNull();
  });

  it("renders nothing for a clean completion — the launch most users get", () => {
    renderPill({ phase: "complete", installed: ["meeting"], failed: [] });
    expect(screen.queryByTestId("bootstrap-status-pill")).toBeNull();
  });

  it("reports the install in progress with nothing to click", () => {
    renderPill({ phase: "start" });
    const pill = screen.getByTestId("bootstrap-status-pill");
    expect(pill.textContent).toContain("플러그인 설치 중");
    expect(pill.getAttribute("title")).toContain("매니지드 플러그인 설치 중");
    expect(pill.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the in-progress pill hoverable and focusable so its tooltip still opens", () => {
    const onRetry = vi.fn();
    renderPill({ phase: "start" }, { onRetry });
    const pill = screen.getByTestId("bootstrap-status-pill");

    // A native `disabled` button takes `pointer-events: none` from the button
    // base and leaves the tab order, so neither pointer nor keyboard could
    // reach what the pill only says in its tooltip.
    expect((pill as HTMLButtonElement).disabled).toBe(false);

    fireEvent.focus(pill);
    expect(screen.getByRole("tooltip").textContent).toContain("매니지드 플러그인 설치 중");

    pill.click();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("announces which plugin failed instead of leaving it in the hover text", () => {
    renderPill({
      phase: "complete",
      installed: [],
      failed: [{ id: "meeting", error: "tarball 404" }],
    });

    const label = screen.getByTestId("bootstrap-status-pill").getAttribute("aria-label");
    expect(label).toContain("플러그인 부트스트랩 다시 시도");
    expect(label).toContain("meeting");
    expect(label).toContain("tarball 404");
  });

  it("retries the bootstrap when the error pill is clicked", () => {
    const onRetry = vi.fn();
    renderPill({ phase: "error", message: "registry unreachable" }, { onRetry });

    const pill = screen.getByTestId("bootstrap-status-pill");
    expect(pill.textContent).toContain("부트스트랩 실패");
    expect(pill.getAttribute("title")).toContain("registry unreachable");

    pill.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("retries the bootstrap when a plugin failed to install, and names it on hover", () => {
    const onRetry = vi.fn();
    renderPill(
      { phase: "complete", installed: [], failed: [{ id: "meeting", error: "tarball 404" }] },
      { onRetry },
    );

    const pill = screen.getByTestId("bootstrap-status-pill");
    expect(pill.textContent).toContain("플러그인 설치 실패");
    expect(pill.getAttribute("title")).toContain("meeting");
    expect(pill.getAttribute("title")).toContain("tarball 404");

    pill.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("counts the failures instead of listing them when more than one failed", () => {
    renderPill({
      phase: "complete",
      installed: [],
      failed: [{ id: "meeting", error: "a" }, { id: "local-indexer", error: "b" }],
    });

    expect(screen.getByTestId("bootstrap-status-pill").getAttribute("title")).toContain(
      "2개 플러그인 설치 실패",
    );
  });

  it("dismisses a failure report from the control beside the pill", () => {
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    renderPill({ phase: "error", message: "registry unreachable" }, { onDismiss, onRetry });

    screen.getByTestId("bootstrap-status-dismiss").click();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("dismisses the skipped-bootstrap report from the pill itself", () => {
    const onDismiss = vi.fn();
    renderPill(
      { phase: "complete", installed: [], failed: [], skippedReason: "marketplace not configured" },
      { onDismiss },
    );

    const pill = screen.getByTestId("bootstrap-status-pill");
    expect(pill.textContent).toContain("부트스트랩 건너뜀");
    expect(pill.getAttribute("title")).toContain("marketplace not configured");
    // Nothing to retry — a skip is a decision, not a failure.
    expect(screen.queryByTestId("bootstrap-status-dismiss")).toBeNull();

    pill.click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

function renderPill(
  status: BootstrapStatusEvent | null,
  handlers: { onDismiss?: () => void; onRetry?: () => void } = {},
) {
  return render(
    <TooltipProvider>
      <BootstrapStatusPill
        status={status}
        onDismiss={handlers.onDismiss ?? vi.fn()}
        onRetry={handlers.onRetry ?? vi.fn()}
      />
    </TooltipProvider>,
  );
}
