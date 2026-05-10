// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { DeferredQueuePanel } from "../permissions/DeferredQueuePanel.js";

interface DeferredEntry {
  id: string;
  ts: string;
  toolName: string;
  source: "builtin" | "plugin" | "mcp";
  category: "read" | "write" | "shell" | "network" | "meta";
  inputSummary: string;
  verdict: { level: "low" | "medium" | "high"; reason: string };
  status: "pending" | "approved" | "rejected";
}

function makeEntry(overrides: Partial<DeferredEntry> = {}): DeferredEntry {
  return {
    id: "id-1",
    ts: "2026-05-09T13:00:00.000Z",
    toolName: "fs_write",
    source: "builtin",
    category: "write",
    inputSummary: '{"path":"<redacted>"}',
    verdict: { level: "high", reason: "write outside allowed dirs" },
    status: "pending",
    ...overrides,
  };
}

function installApi(opts: {
  entries: DeferredEntry[];
  listResult?: { ok: true; pending: DeferredEntry[]; total: number } | { ok: false; error: string };
  listRejects?: Error;
  resolveResult?: { ok: true; entry: DeferredEntry } | { ok: false; error: string };
  resolveRejects?: Error;
}) {
  const deferredList = vi.fn(async () => {
    if (opts.listRejects) throw opts.listRejects;
    return opts.listResult ?? {
      ok: true as const,
      pending: opts.entries,
      total: opts.entries.length,
    };
  });
  const deferredResolve = vi.fn(async () => {
    if (opts.resolveRejects) throw opts.resolveRejects;
    return opts.resolveResult ?? { ok: true as const, entry: opts.entries[0] };
  });
  const onDeferredPending = vi.fn(() => () => {
    /* unsubscribe noop */
  });
  (globalThis as unknown as { window: typeof window }).window.lvis = {
    permission: {
      deferredList,
      deferredResolve,
      onDeferredPending,
    },
  };
  return { deferredList, deferredResolve, onDeferredPending };
}

beforeEach(() => {
  delete (window as unknown as { lvis?: unknown }).lvis;
});

describe("DeferredQueuePanel", () => {
  it("renders nothing when queue is empty", async () => {
    installApi({ entries: [] });
    let container: HTMLElement;
    await act(async () => {
      const r = render(<DeferredQueuePanel />);
      container = r.container;
    });
    expect(container!.querySelector('[data-testid="deferred-queue-panel"]')).toBeNull();
  });

  it("renders initial deferredList failure even when queue is empty", async () => {
    installApi({
      entries: [],
      listResult: { ok: false, error: "deferred-list unavailable" },
    });
    await act(async () => {
      render(<DeferredQueuePanel />);
    });
    expect(screen.getByTestId("deferred-queue-panel")).toBeTruthy();
    expect(screen.getByText("deferred-list unavailable")).toBeTruthy();
  });

  it("renders pending entries on mount", async () => {
    installApi({ entries: [makeEntry()] });
    await act(async () => {
      render(<DeferredQueuePanel />);
    });
    expect(screen.getByTestId("deferred-queue-panel")).toBeTruthy();
    expect(screen.getByText("fs_write")).toBeTruthy();
    expect(screen.getByText(/write outside allowed dirs/)).toBeTruthy();
  });

  it("resolve('approved') invokes IPC then refreshes", async () => {
    const api = installApi({
      entries: [makeEntry({ id: "abc-123" })],
    });
    await act(async () => {
      render(<DeferredQueuePanel />);
    });
    const button = screen.getByText("승인");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(api.deferredResolve).toHaveBeenCalledWith("abc-123", "approved");
    // After click: deferredList re-fetched (initial + post-action)
    expect(api.deferredList.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("resolve('rejected') uses 거부 button", async () => {
    const api = installApi({
      entries: [makeEntry({ id: "xyz-789" })],
    });
    await act(async () => {
      render(<DeferredQueuePanel />);
    });
    const button = screen.getByText("거부");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(api.deferredResolve).toHaveBeenCalledWith("xyz-789", "rejected");
  });

  it("subscribes to deferred-pending event", async () => {
    const api = installApi({ entries: [makeEntry()] });
    await act(async () => {
      render(<DeferredQueuePanel />);
    });
    expect(api.onDeferredPending).toHaveBeenCalled();
  });

  it("renders multiple entries with stable testids", async () => {
    installApi({
      entries: [
        makeEntry({ id: "a" }),
        makeEntry({ id: "b", toolName: "shell_run", category: "shell" }),
      ],
    });
    await act(async () => {
      render(<DeferredQueuePanel />);
    });
    expect(screen.getByTestId("deferred-entry-a")).toBeTruthy();
    expect(screen.getByTestId("deferred-entry-b")).toBeTruthy();
    expect(screen.getByText("shell_run")).toBeTruthy();
  });

  it("surfaces deferredResolve rejection and still refreshes", async () => {
    const api = installApi({
      entries: [makeEntry({ id: "err-1" })],
      resolveRejects: new Error("resolve failed"),
    });
    await act(async () => {
      render(<DeferredQueuePanel />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText("승인"));
    });
    expect(api.deferredResolve).toHaveBeenCalledWith("err-1", "approved");
    expect(api.deferredList.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("resolve failed")).toBeTruthy();
  });
});
