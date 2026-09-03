// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePermissionSignals } from "../use-permission-signals.js";
import type { PermissionReviewSuggestionPayload } from "../../../../shared/permissions-events.js";

/**
 * The reviewer suggestion is held state, not a toast: its surface is an
 * approval card, which may well not be on screen when the host raises it.
 * These cover what the hook owns — the hold, the enable sequence, the inline
 * failure, and the dismiss — independently of any card drawing it.
 */
function permissionApi(overrides: {
  reviewerDispatch?: ReturnType<typeof vi.fn>;
  setMode?: ReturnType<typeof vi.fn>;
} = {}) {
  let suggestionHandler: ((p: PermissionReviewSuggestionPayload) => void) | null = null;
  const permission = {
    onUserApprovalHit: vi.fn(() => () => undefined),
    onReviewSuggestion: vi.fn((cb: (p: PermissionReviewSuggestionPayload) => void) => {
      suggestionHandler = cb;
      return () => {
        suggestionHandler = null;
      };
    }),
    reviewerDispatch: overrides.reviewerDispatch ?? vi.fn(async () => ({ ok: true })),
    setMode: overrides.setMode ?? vi.fn(async () => ({ ok: true, mode: "auto" })),
  };
  window.lvisApi = { permission } as unknown as typeof window.lvisApi;
  return {
    permission,
    fire: (payload: Partial<PermissionReviewSuggestionPayload> = {}) => {
      if (!suggestionHandler) throw new Error("review suggestion handler not registered");
      suggestionHandler({
        reason: "repeat-allow",
        allowCount: 3,
        allowAlwaysCount: 0,
        threshold: 3,
        windowMs: 300_000,
        ...payload,
      });
    },
  };
}

describe("usePermissionSignals — reviewer suggestion", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("holds the suggestion for as long as it takes a card to appear", async () => {
    // No display timer: the band's only surface is an approval card, and the
    // host can raise the suggestion while none is up. Expiring it in that gap
    // would spend the whole tracker cooldown on a band nobody ever saw.
    vi.useFakeTimers();
    const { permission, fire } = permissionApi();
    const { result } = renderHook(() => usePermissionSignals());
    // Subscription happens in the mount effect, which `renderHook` already
    // flushed — a `waitFor` here would spin against the faked clock.
    expect(permission.onReviewSuggestion).toHaveBeenCalled();

    act(() => fire());
    expect(result.current.reviewerSuggestion).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    expect(result.current.reviewerSuggestion?.reason).toBe("repeat-allow");
  });

  it("carries the host's own reason and window to the band", async () => {
    const { permission, fire } = permissionApi();
    const { result } = renderHook(() => usePermissionSignals());
    await waitFor(() => expect(permission.onReviewSuggestion).toHaveBeenCalled());

    act(() => fire({ reason: "allow-always", allowCount: 1, allowAlwaysCount: 1 }));
    expect(result.current.reviewerSuggestion).toMatchObject({
      reason: "allow-always",
      allowCount: 1,
      windowMs: 300_000,
      busy: false,
    });
  });

  it("enables the reviewer before switching the mode that relies on it", async () => {
    // Order is the whole safety of the gesture: `auto` mode with no reviewer
    // configured would auto-approve through nothing at all.
    const { permission, fire } = permissionApi();
    const { result } = renderHook(() => usePermissionSignals());
    await waitFor(() => expect(permission.onReviewSuggestion).toHaveBeenCalled());
    act(() => fire());

    await act(async () => {
      result.current.reviewerSuggestion?.onEnable();
    });

    expect(permission.reviewerDispatch).toHaveBeenNthCalledWith(1, "mode llm");
    expect(permission.reviewerDispatch).toHaveBeenNthCalledWith(2, "interactive low");
    expect(permission.setMode).toHaveBeenCalledWith("auto");
    expect(permission.reviewerDispatch.mock.invocationCallOrder[1]).toBeLessThan(
      permission.setMode.mock.invocationCallOrder[0],
    );
    expect(result.current.reviewerSuggestion).toBeNull();
  });

  it("keeps the band up with the failure on it when enabling does not take", async () => {
    // A silent failure would leave the user believing the reviewer is on while
    // every later ask still lands on them by hand.
    const reviewerDispatch = vi.fn(async () => ({ ok: false, error: "reviewer key missing" }));
    const { permission, fire } = permissionApi({ reviewerDispatch });
    const { result } = renderHook(() => usePermissionSignals());
    await waitFor(() => expect(permission.onReviewSuggestion).toHaveBeenCalled());
    act(() => fire());

    await act(async () => {
      result.current.reviewerSuggestion?.onEnable();
    });

    expect(permission.setMode).not.toHaveBeenCalled();
    expect(result.current.reviewerSuggestion?.busy).toBe(false);
    expect(result.current.reviewerSuggestion?.error).toContain("reviewer key missing");
  });

  it("clears the suggestion on dismiss without touching permission settings", async () => {
    const { permission, fire } = permissionApi();
    const { result } = renderHook(() => usePermissionSignals());
    await waitFor(() => expect(permission.onReviewSuggestion).toHaveBeenCalled());
    act(() => fire());

    act(() => result.current.reviewerSuggestion?.onDismiss());

    expect(result.current.reviewerSuggestion).toBeNull();
    expect(permission.reviewerDispatch).not.toHaveBeenCalled();
    expect(permission.setMode).not.toHaveBeenCalled();
  });

  it("drops a suggestion whose metrics are not numbers it can render", async () => {
    const { permission, fire } = permissionApi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result } = renderHook(() => usePermissionSignals());
    await waitFor(() => expect(permission.onReviewSuggestion).toHaveBeenCalled());

    act(() => fire({ allowCount: Number.NaN }));

    expect(result.current.reviewerSuggestion).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
