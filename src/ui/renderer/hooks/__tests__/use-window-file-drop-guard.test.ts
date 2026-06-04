import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useWindowFileDropGuard } from "../use-window-file-drop-guard.js";

// Unmount each rendered hook between tests so its window listeners detach —
// otherwise leftover guards from prior tests would fire on later dispatches.
afterEach(() => cleanup());

/**
 * Regression coverage for the file-drop navigation guard (replaces the coverage
 * that lived in the deleted DropZoneOverlay.test.tsx). This hook is the primary
 * protection against a dropped file navigating the renderer to its file:// URL.
 */
function fireDrag(type: "dragover" | "drop", dataTransfer: Partial<DataTransfer> | null): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer, configurable: true });
  window.dispatchEvent(event);
  return event;
}

function dt(types: string[], fileCount = 0): Partial<DataTransfer> {
  return { types: types as unknown as DataTransfer["types"], files: { length: fileCount } as FileList };
}

describe("useWindowFileDropGuard", () => {
  it("preventDefault on dragover when types includes 'Files'", () => {
    renderHook(() => useWindowFileDropGuard());
    const e = fireDrag("dragover", dt(["Files"]));
    expect(e.defaultPrevented).toBe(true);
  });

  it("preventDefault on drop when types includes 'Files'", () => {
    renderHook(() => useWindowFileDropGuard());
    const e = fireDrag("drop", dt(["Files"]));
    expect(e.defaultPrevented).toBe(true);
  });

  it("preventDefault on drop when files are present even without the 'Files' type", () => {
    renderHook(() => useWindowFileDropGuard());
    const e = fireDrag("drop", dt([], 1));
    expect(e.defaultPrevented).toBe(true);
  });

  it("does NOT preventDefault for a non-file drag (text selection / in-app DnD)", () => {
    renderHook(() => useWindowFileDropGuard());
    const e = fireDrag("drop", dt(["text/plain"], 0));
    expect(e.defaultPrevented).toBe(false);
  });

  it("tolerates a missing dataTransfer", () => {
    renderHook(() => useWindowFileDropGuard());
    const e = fireDrag("dragover", null);
    expect(e.defaultPrevented).toBe(false);
  });

  it("detaches its window listeners on unmount", () => {
    const { unmount } = renderHook(() => useWindowFileDropGuard());
    unmount();
    const e = fireDrag("drop", dt(["Files"]));
    expect(e.defaultPrevented).toBe(false);
  });
});
