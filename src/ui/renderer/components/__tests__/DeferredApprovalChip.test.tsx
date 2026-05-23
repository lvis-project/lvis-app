// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DeferredApprovalChip } from "../DeferredApprovalChip.js";
import type { DeferredQueueEntry } from "../../types.js";

function makeEntry(overrides: Partial<DeferredQueueEntry> = {}): DeferredQueueEntry {
  return {
    id: "id-1",
    ts: "2026-05-13T13:00:00.000Z",
    toolName: "fs_write",
    source: "builtin",
    category: "write",
    inputSummary: '{"path":"<redacted>"}',
    verdict: { level: "high", reason: "write outside allowed dirs" },
    status: "pending",
    ...overrides,
  };
}

function installApi(pending: DeferredQueueEntry[]) {
  const deferredList = vi.fn(async () => ({
    ok: true as const,
    pending,
    total: pending.length,
  }));
  const deferredResolve = vi.fn(async () => ({
    ok: true as const,
    entry: pending[0]!,
  }));
  const onDeferredPending = vi.fn(() => () => undefined);
  (globalThis as unknown as { window: { lvis: unknown } }).window.lvis = {
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

describe("DeferredApprovalChip", () => {
  it("renders nothing when draft text has no intent", async () => {
    installApi([makeEntry()]);
    let container: HTMLElement;
    await act(async () => {
      const r = render(<DeferredApprovalChip draftText="random question about something" />);
      container = r.container;
    });
    expect(container!.querySelector('[data-testid="deferred-approval-chip"]')).toBeNull();
  });

  it("renders nothing when intent matches but the queue is empty", async () => {
    installApi([]);
    let container: HTMLElement;
    await act(async () => {
      const r = render(<DeferredApprovalChip draftText="허용해 주세요" />);
      container = r.container;
    });
    expect(container!.querySelector('[data-testid="deferred-approval-chip"]')).toBeNull();
  });

  it("renders nothing when multiple entries pend (ambiguous target)", async () => {
    installApi([makeEntry({ id: "a" }), makeEntry({ id: "b", toolName: "bash" })]);
    let container: HTMLElement;
    await act(async () => {
      const r = render(<DeferredApprovalChip draftText="허용" />);
      container = r.container;
    });
    expect(container!.querySelector('[data-testid="deferred-approval-chip"]')).toBeNull();
  });

  it("renders chip + approve button for an approve intent against a single pending entry", async () => {
    installApi([makeEntry({ toolName: "bash" })]);
    await act(async () => {
      render(<DeferredApprovalChip draftText="OK 허용해줘" />);
    });
    expect(screen.getByTestId("deferred-approval-chip")).toBeTruthy();
    expect(screen.getByText(/'bash' 실행을 허용할까요\?/)).toBeTruthy();
    expect(screen.getByTestId("deferred-approval-chip-action").textContent).toContain("허용");
    expect(screen.getByRole("button", { name: /기본 도구 'bash' 실행을 허용/ })).toBeTruthy();
  });

  it("dispatches deferredResolve with approvalSource='natural-language' on click", async () => {
    const api = installApi([makeEntry({ id: "queue-42", toolName: "bash" })]);
    await act(async () => {
      render(<DeferredApprovalChip draftText="허용해 주세요" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("deferred-approval-chip-action"));
    });
    expect(api.deferredResolve).toHaveBeenCalledTimes(1);
    const [id, decision, reason, source] = api.deferredResolve.mock.calls[0]!;
    expect(id).toBe("queue-42");
    expect(decision).toBe("approved");
    // Round-3 critic MAJOR — `reason` is a static provenance string,
    // NOT the matched phrase. The matched phrase is user-typed and
    // must not land in HMAC-chained audit storage. The
    // `approvalSource: "natural-language"` field is the SOT for
    // provenance.
    expect(reason).toBe("natural-language chip click");
    expect(source).toBe("natural-language");
  });

  it("lets the user dismiss the current natural-language suggestion without resolving it", async () => {
    const api = installApi([makeEntry({ id: "queue-dismiss", toolName: "bash" })]);
    const { rerender } = render(<DeferredApprovalChip draftText="허용해 주세요" />);

    expect(await screen.findByTestId("deferred-approval-chip")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("deferred-approval-chip-dismiss"));
    });

    expect(screen.queryByTestId("deferred-approval-chip")).toBeNull();
    expect(api.deferredResolve).not.toHaveBeenCalled();

    await act(async () => {
      rerender(<DeferredApprovalChip draftText="취소해줘" />);
    });
    expect(screen.getByTestId("deferred-approval-chip")).toBeTruthy();
  });

  it("dispatches rejected when the intent is reject", async () => {
    const api = installApi([makeEntry({ id: "queue-99" })]);
    await act(async () => {
      render(<DeferredApprovalChip draftText="취소해줘" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("deferred-approval-chip-action"));
    });
    const [, decision, , source] = api.deferredResolve.mock.calls[0]!;
    expect(decision).toBe("rejected");
    expect(source).toBe("natural-language");
  });

  it("does NOT auto-resolve when the negation modifies the approve verb (#690 safety)", async () => {
    const api = installApi([makeEntry()]);
    await act(async () => {
      render(<DeferredApprovalChip draftText="허용 안 함" />);
    });
    expect(api.deferredResolve).not.toHaveBeenCalled();
  });

  it("stays hidden when deferredList throws during mount refresh (round-3 test-engineer MAJOR-2)", async () => {
    const deferredList = vi.fn(async () => {
      throw new Error("ipc disconnected");
    });
    const deferredResolve = vi.fn(async () => ({ ok: true as const }));
    const onDeferredPending = vi.fn(() => () => undefined);
    (globalThis as unknown as { window: { lvis: unknown } }).window.lvis = {
      permission: { deferredList, deferredResolve, onDeferredPending },
    };
    let container: HTMLElement;
    await act(async () => {
      const r = render(<DeferredApprovalChip draftText="허용해 주세요" />);
      container = r.container;
    });
    // Production contract: a failing deferredList() must NOT crash and
    // must NOT render the chip. The catch{} branch keeps `pending`
    // empty, which falls through the `pending.length !== 1` guard.
    expect(container!.querySelector('[data-testid="deferred-approval-chip"]')).toBeNull();
    expect(deferredResolve).not.toHaveBeenCalled();
  });

  it("renders nothing when window.lvis is absent (round-3 test-engineer MINOR)", async () => {
    delete (window as unknown as { lvis?: unknown }).lvis;
    let container: HTMLElement;
    await act(async () => {
      const r = render(<DeferredApprovalChip draftText="허용" />);
      container = r.container;
    });
    expect(container!.querySelector('[data-testid="deferred-approval-chip"]')).toBeNull();
  });

  it("re-fetches pending queue at click time and aborts when the entry was swapped (round-1 security MAJOR-1)", async () => {
    const initial = [makeEntry({ id: "queue-1", toolName: "bash" })];
    const afterSwap = [makeEntry({ id: "queue-2", toolName: "shell" })];
    let callCount = 0;
    const deferredList = vi.fn(async () => {
      callCount += 1;
      // First call (mount refresh) returns initial; later calls return swap.
      return { ok: true as const, pending: callCount === 1 ? initial : afterSwap, total: 1 };
    });
    const deferredResolve = vi.fn(async () => ({ ok: true as const, entry: initial[0]! }));
    const onDeferredPending = vi.fn(() => () => undefined);
    (globalThis as unknown as { window: { lvis: unknown } }).window.lvis = {
      permission: { deferredList, deferredResolve, onDeferredPending },
    };
    await act(async () => {
      render(<DeferredApprovalChip draftText="허용해 주세요" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("deferred-approval-chip-action"));
    });
    // resolve MUST NOT have been called — TOCTOU re-check aborted the action.
    expect(deferredResolve).not.toHaveBeenCalled();
    expect(screen.getByTestId("deferred-approval-chip-error").textContent).toContain(
      "다른 요청이 추가",
    );
  });

  it("surfaces the entry source label so plugin-deferred entries are distinguishable (round-1 architect MAJOR-2)", async () => {
    installApi([makeEntry({ source: "plugin", toolName: "work_assistant_email_scan" })]);
    await act(async () => {
      render(<DeferredApprovalChip draftText="허용해 주세요" />);
    });
    const chip = screen.getByTestId("deferred-approval-chip");
    // Round-5 UX MAJOR — visible badge text is now Korean ("플러그인")
    // to match the aria-label. Aria-label still asserted for SR
    // semantics.
    expect(chip.textContent).toContain("플러그인");
    expect(chip.querySelector('[aria-label="플러그인 도구"]')).toBeTruthy();
    expect(chip.textContent).toContain("work_assistant_email_scan");
    expect(chip.getAttribute("data-target-source")).toBe("plugin");
    expect(
      screen.getByRole("button", {
        name: /플러그인 도구 'work_assistant_email_scan' 실행을 허용/,
      }),
    ).toBeTruthy();
  });

  it("surfaces the resolve error inline when the IPC call fails", async () => {
    const pending = [makeEntry()];
    const deferredList = vi.fn(async () => ({ ok: true as const, pending, total: 1 }));
    const deferredResolve = vi.fn(async () => ({ ok: false as const, error: "not-found" }));
    const onDeferredPending = vi.fn(() => () => undefined);
    (globalThis as unknown as { window: { lvis: unknown } }).window.lvis = {
      permission: { deferredList, deferredResolve, onDeferredPending },
    };
    await act(async () => {
      render(<DeferredApprovalChip draftText="허용" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("deferred-approval-chip-action"));
    });
    // Round-6 UX MINOR — raw IPC error tokens like "not-found" no longer
    // leak into UI; user sees a sanitized Korean message instead.
    expect(screen.getByTestId("deferred-approval-chip-error").textContent).toContain(
      "요청 처리 중 오류",
    );
  });
});
