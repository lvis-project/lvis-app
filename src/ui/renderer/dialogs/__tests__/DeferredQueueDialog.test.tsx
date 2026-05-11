// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeferredQueueDialog } from "../DeferredQueueDialog.js";

function installDeferredApi(pending = 1) {
  const entries = Array.from({ length: pending }, (_, index) => ({
    id: `dq-${index + 1}`,
    ts: "2026-05-11T09:00:00.000Z",
    toolName: "write_file",
    source: "builtin",
    category: "write",
    inputSummary: '{"path":"<redacted>"}',
    verdict: { level: "high", reason: "outside allowed directory" },
    status: "pending",
  }));
  const permission = {
    deferredList: vi.fn(async () => ({ ok: true, total: entries.length, pending: entries })),
    deferredResolve: vi.fn(async () => ({ ok: true })),
    onDeferredPending: vi.fn(() => () => {}),
  };
  (window as unknown as { lvis: unknown }).lvis = { permission };
  return permission;
}

beforeEach(() => {
  delete (window as unknown as { lvis?: unknown }).lvis;
});

describe("DeferredQueueDialog", () => {
  it("renders pending deferred approvals only when explicitly opened", async () => {
    const permission = installDeferredApi();

    const { rerender } = render(<DeferredQueueDialog open={false} onOpenChange={() => {}} />);
    expect(screen.queryByTestId("deferred-queue-dialog")).toBeNull();
    expect(permission.deferredList).not.toHaveBeenCalled();

    rerender(<DeferredQueueDialog open onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("deferred-queue-dialog")).toBeTruthy();
      expect(screen.getAllByText("write_file").length).toBeGreaterThan(0);
    });
  });

  it("surfaces an empty queue state after manual open", async () => {
    installDeferredApi(0);

    render(<DeferredQueueDialog open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("deferred-queue-empty")).toBeTruthy();
    });
  });

  it("resolves approvals from the modal", async () => {
    const permission = installDeferredApi();

    render(<DeferredQueueDialog open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getAllByText("write_file").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByText("허용"));

    await waitFor(() => {
      expect(permission.deferredResolve).toHaveBeenCalledWith("dq-1", "approved");
    });
  });

  it("offers an explicit close action", async () => {
    installDeferredApi(0);
    const onOpenChange = vi.fn();

    render(<DeferredQueueDialog open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText("닫기"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
