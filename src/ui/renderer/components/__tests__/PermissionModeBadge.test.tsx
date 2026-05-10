// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PermissionModeBadge } from "../permissions/PermissionModeBadge.js";

beforeEach(() => {
  delete (window as unknown as { lvis?: unknown }).lvis;
});

describe("PermissionModeBadge", () => {
  it("renders the explicit unknown mode prop without invoking a fetcher", async () => {
    // Description aligned with setup: caller passes `mode="unknown"`
    // explicitly, exercising the prop-override branch (no fetch / no
    // subscribe). The original copy claimed "no mode override" which
    // contradicted the `mode="unknown"` prop being supplied.
    let component: ReturnType<typeof render>;
    await act(async () => {
      component = render(<PermissionModeBadge mode="unknown" />);
    });
    const badge = component!.getByTestId("permission-mode-badge");
    expect(badge.getAttribute("data-mode")).toBe("unknown");
  });

  it("renders the mode prop override", () => {
    const { getByTestId } = render(<PermissionModeBadge mode="strict" />);
    const badge = getByTestId("permission-mode-badge");
    expect(badge.getAttribute("data-mode")).toBe("strict");
    expect(badge.textContent).toContain("전체 물어보기");
  });

  it("calls fetcher and reflects 'auto' on mount", async () => {
    const fetcher = vi.fn(async () => ({ mode: "auto" }));
    await act(async () => {
      render(<PermissionModeBadge fetcher={fetcher} />);
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("auto");
      expect(badge.textContent).toContain("자동 검증");
      expect(badge.textContent).not.toContain("LLM");
      expect(badge.getAttribute("aria-label")).toContain("백그라운드 리뷰어");
    });
    expect(fetcher).toHaveBeenCalled();
  });

  it("calls fetcher and reflects 'allow' on mount", async () => {
    const fetcher = vi.fn(async () => ({ mode: "allow" }));
    await act(async () => {
      render(<PermissionModeBadge fetcher={fetcher} />);
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("allow");
      expect(badge.textContent).toContain("외부경로 승인");
    });
  });

  it("surfaces deferred approvals in the header badge", async () => {
    const deferredFetcher = vi.fn(async () => ({
      ok: true,
      pending: [{ id: "p1" }, { id: "p2" }],
    }));
    await act(async () => {
      render(<PermissionModeBadge mode="auto" deferredFetcher={deferredFetcher} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("permission-pending-badge").textContent).toContain("승인 2");
    });
    const badge = screen.getByTestId("permission-mode-badge");
    expect(badge.getAttribute("aria-label")).toContain("대기 승인 2건");
  });

  it("subscribes to deferred approval changes", async () => {
    let capturedHandler: ((summary: { pending: number }) => void) | null = null;
    const deferredSubscriber = vi.fn((handler) => {
      capturedHandler = handler;
      return () => {};
    });
    await act(async () => {
      render(
        <PermissionModeBadge
          mode="default"
          deferredFetcher={async () => ({ ok: true, pending: [] })}
          deferredSubscriber={deferredSubscriber}
        />,
      );
    });

    await act(async () => {
      capturedHandler!({ pending: 3 });
    });

    await waitFor(() => {
      expect(screen.getByTestId("permission-pending-badge").textContent).toContain("승인 3");
    });
  });

  it("normalizes invalid mode strings to unknown", async () => {
    const fetcher = vi.fn(async () => ({ mode: "yolo" }));
    await act(async () => {
      render(<PermissionModeBadge fetcher={fetcher} />);
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("unknown");
    });
  });

  it("subscribes to mode-change events and updates", async () => {
    const fetcher = vi.fn(async () => ({ mode: "default" }));
    let capturedHandler: ((m: "default" | "strict" | "auto" | "allow" | "unknown") => void) | null = null;
    const subscribe = vi.fn((handler) => {
      capturedHandler = handler;
      return () => {};
    });
    await act(async () => {
      render(<PermissionModeBadge fetcher={fetcher} subscribe={subscribe} />);
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("default");
    });
    // Simulate /permission mode strict --durable being applied
    await act(async () => {
      capturedHandler!("strict");
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("strict");
    });
  });

  it("invokes onClick handler", async () => {
    const onClick = vi.fn();
    await act(async () => {
      render(<PermissionModeBadge mode="auto" onClick={onClick} />);
    });
    fireEvent.click(screen.getByTestId("permission-mode-badge"));
    expect(onClick).toHaveBeenCalled();
  });

  it("falls back to 'unknown' when fetcher rejects", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ipc unavailable");
    });
    await act(async () => {
      render(<PermissionModeBadge fetcher={fetcher} />);
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("unknown");
    });
  });

  it("shows description in title attribute (tooltip)", () => {
    const { getByTestId } = render(<PermissionModeBadge mode="strict" />);
    const badge = getByTestId("permission-mode-badge");
    expect(badge.getAttribute("title")).toContain("전체 물어보기");
  });
});
