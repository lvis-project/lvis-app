// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEdgeResize } from "../use-edge-resize.js";

/** Minimal PointerEvent-shaped object accepted by the hook's onPointerDown. */
function makePointerDownEvent(clientX: number, currentTarget: Partial<Element> = {}) {
  return {
    preventDefault: vi.fn(),
    clientX,
    pointerId: 1,
    currentTarget: { setPointerCapture: vi.fn(), ...currentTarget },
  } as unknown as React.PointerEvent;
}

function makeKeyEvent(key: string) {
  return { key, preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
}

function dispatchWindowPointerMove(clientX: number) {
  window.dispatchEvent(new MouseEvent("pointermove", { clientX } as MouseEventInit) as unknown as PointerEvent);
}
function dispatchWindowPointerUp() {
  window.dispatchEvent(new MouseEvent("pointerup") as unknown as PointerEvent);
}

describe("useEdgeResize", () => {
  it("edge=end: dragging right grows the panel (bar sits on the panel's trailing/right side)", () => {
    const onWidthChange = vi.fn();
    const onWidthCommit = vi.fn();
    const { result } = renderHook(() =>
      useEdgeResize({ width: 232, edge: "end", onWidthChange, onWidthCommit, min: 200, max: 480 }),
    );

    act(() => {
      result.current.onPointerDown(makePointerDownEvent(100));
    });
    act(() => {
      dispatchWindowPointerMove(140); // +40px right
    });
    expect(onWidthChange).toHaveBeenLastCalledWith(272);

    act(() => {
      dispatchWindowPointerUp();
    });
    expect(onWidthCommit).toHaveBeenCalledWith(272);
  });

  it("edge=start: dragging LEFT grows the panel (bar sits on the panel's leading/left side, e.g. a right-docked panel)", () => {
    const onWidthChange = vi.fn();
    const onWidthCommit = vi.fn();
    const { result } = renderHook(() =>
      useEdgeResize({ width: 448, edge: "start", onWidthChange, onWidthCommit, min: 448, max: 1200 }),
    );

    act(() => {
      result.current.onPointerDown(makePointerDownEvent(500));
    });
    act(() => {
      dispatchWindowPointerMove(460); // -40px (moved left) → widens
    });
    expect(onWidthChange).toHaveBeenLastCalledWith(488);

    act(() => {
      dispatchWindowPointerUp();
    });
    expect(onWidthCommit).toHaveBeenCalledWith(488);
  });

  it("clamps drag output to [min, max]", () => {
    const onWidthChange = vi.fn();
    const onWidthCommit = vi.fn();
    const { result } = renderHook(() =>
      useEdgeResize({ width: 232, edge: "end", onWidthChange, onWidthCommit, min: 200, max: 480 }),
    );

    act(() => {
      result.current.onPointerDown(makePointerDownEvent(0));
    });
    act(() => {
      dispatchWindowPointerMove(-10_000); // far past min
    });
    expect(onWidthChange).toHaveBeenLastCalledWith(200);

    act(() => {
      dispatchWindowPointerMove(10_000); // far past max
    });
    expect(onWidthChange).toHaveBeenLastCalledWith(480);
  });

  it("resolves a function max at call time (dynamic viewport-based bound)", () => {
    const onWidthChange = vi.fn();
    const onWidthCommit = vi.fn();
    let dynamicMax = 900;
    const { result } = renderHook(() =>
      useEdgeResize({ width: 448, edge: "start", onWidthChange, onWidthCommit, min: 448, max: () => dynamicMax }),
    );
    expect(result.current.resolveMax()).toBe(900);
    dynamicMax = 600;
    expect(result.current.resolveMax()).toBe(600);
  });

  it("keyboard: arrow direction always matches the visual edge regardless of drag-delta sign convention", () => {
    const onWidthChange = vi.fn();
    const onWidthCommitEnd = vi.fn();
    const endResult = renderHook(() =>
      useEdgeResize({ width: 232, edge: "end", onWidthChange, onWidthCommit: onWidthCommitEnd, min: 200, max: 480, keyStep: 16 }),
    ).result;
    act(() => endResult.current.onKeyDown(makeKeyEvent("ArrowRight")));
    expect(onWidthCommitEnd).toHaveBeenCalledWith(248); // grows

    const onWidthCommitStart = vi.fn();
    const startResult = renderHook(() =>
      useEdgeResize({ width: 448, edge: "start", onWidthChange, onWidthCommit: onWidthCommitStart, min: 448, max: 1200, keyStep: 16 }),
    ).result;
    act(() => startResult.current.onKeyDown(makeKeyEvent("ArrowLeft")));
    expect(onWidthCommitStart).toHaveBeenCalledWith(464); // grows (mirrors ArrowRight for edge=end)
  });

  it("Home/End jump to min/max", () => {
    const onWidthChange = vi.fn();
    const onWidthCommit = vi.fn();
    const { result } = renderHook(() =>
      useEdgeResize({ width: 300, edge: "end", onWidthChange, onWidthCommit, min: 200, max: 480 }),
    );
    act(() => result.current.onKeyDown(makeKeyEvent("Home")));
    expect(onWidthCommit).toHaveBeenLastCalledWith(200);
    act(() => result.current.onKeyDown(makeKeyEvent("End")));
    expect(onWidthCommit).toHaveBeenLastCalledWith(480);
  });

  it("makeResetHandler commits the clamped reset width (double-click / Enter reset)", () => {
    const onWidthChange = vi.fn();
    const onWidthCommit = vi.fn();
    const { result } = renderHook(() =>
      useEdgeResize({ width: 300, edge: "end", onWidthChange, onWidthCommit, min: 200, max: 480 }),
    );
    const handler = result.current.makeResetHandler(232);
    act(() => handler({ preventDefault: vi.fn() } as unknown as React.MouseEvent));
    expect(onWidthCommit).toHaveBeenCalledWith(232);
  });

  it("applies the live width directly to the given element ref during drag (rAF-coalesced, no React re-render needed)", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    try {
      const el = document.createElement("div");
      const applyElementRef = { current: el };
      const onWidthChange = vi.fn();
      const onWidthCommit = vi.fn();
      const { result } = renderHook(() =>
        useEdgeResize({ width: 232, edge: "end", onWidthChange, onWidthCommit, min: 200, max: 480, applyElementRef }),
      );
      act(() => result.current.onPointerDown(makePointerDownEvent(100)));
      act(() => dispatchWindowPointerMove(150));
      expect(el.style.width).toBe("282px");
      act(() => dispatchWindowPointerUp());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
