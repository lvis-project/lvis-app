import "../../../../../test/renderer/setup.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeContextMenuAction } from "../../../../shared/native-context-menu.js";
import { useNativeContextMenu } from "../use-native-context-menu.js";

let actionHandler: ((action: NativeContextMenuAction) => void) | null = null;
const showNativeContextMenu = vi.fn(async () => ({ ok: true as const }));

function contextEvent(target: HTMLElement) {
  return {
    currentTarget: target,
    clientX: 17,
    clientY: 29,
    preventDefault: vi.fn(),
  };
}

describe("useNativeContextMenu", () => {
  beforeEach(() => {
    actionHandler = null;
    showNativeContextMenu.mockClear();
    vi.stubGlobal("lvis", {
      ui: {
        showNativeContextMenu,
        onNativeContextMenuAction: (handler: (action: NativeContextMenuAction) => void) => {
          actionHandler = handler;
          return () => {
            if (actionHandler === handler) actionHandler = null;
          };
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("runs a pending handler only for its matching request id and consumes it once", async () => {
    const copy = vi.fn();
    const target = document.createElement("div");
    const event = contextEvent(target);
    const { result } = renderHook(() => useNativeContextMenu());

    act(() => {
      expect(result.current(event as never, "message", { "message.copy": copy })).toBe(true);
    });
    await waitFor(() => expect(showNativeContextMenu).toHaveBeenCalledOnce());
    const requestId = showNativeContextMenu.mock.calls[0]?.[0].requestId;
    expect(requestId).toEqual(expect.any(String));
    expect(event.preventDefault).toHaveBeenCalledOnce();

    act(() => actionHandler?.({ requestId: "stale-request", command: "message.copy" }));
    expect(copy).not.toHaveBeenCalled();

    act(() => actionHandler?.({ requestId, command: "message.copy" }));
    act(() => actionHandler?.({ requestId, command: "message.copy" }));
    expect(copy).toHaveBeenCalledOnce();
  });

  it("yields only when the current target intersects the active selection", async () => {
    const target = document.createElement("div");
    const event = contextEvent(target);
    const intersectsNode = vi.fn(() => true);
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "selected",
      getRangeAt: () => ({ intersectsNode }),
    } as unknown as Selection);
    const { result } = renderHook(() => useNativeContextMenu());

    act(() => {
      expect(result.current(event as never, "message", { "message.copy": vi.fn() })).toBe(false);
    });
    expect(intersectsNode).toHaveBeenCalledWith(target);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(showNativeContextMenu).not.toHaveBeenCalled();

    intersectsNode.mockReturnValue(false);
    act(() => {
      expect(result.current(event as never, "message", { "message.copy": vi.fn() })).toBe(true);
    });
    await waitFor(() => expect(showNativeContextMenu).toHaveBeenCalledOnce());
  });
});
