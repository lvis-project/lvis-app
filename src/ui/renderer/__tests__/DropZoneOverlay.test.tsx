/**
 * D7 — DropZoneOverlay renderer test.
 *
 * Verifies:
 * 1. Overlay is hidden initially.
 * 2. Overlay appears on dragenter with Files type.
 * 3. On drop with file paths, api.fileScanPaths is called with correct paths.
 * 4. Toast message is shown after successful scan result.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { DropZoneOverlay } from "../components/DropZoneOverlay.js";

// ─── Mock window.lvisApi ────────────────────────────────────────────────────

const mockFileScanPaths = vi.fn(async (_paths: string[]) => ({ ok: true, indexed: 2, failed: 0 }));

beforeEach(() => {
  Object.defineProperty(window, "lvisApi", {
    value: { fileScanPaths: mockFileScanPaths },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  // Remove lvisApi
  Object.defineProperty(window, "lvisApi", { value: undefined, writable: true, configurable: true });
});

// ─── Helper: fire drag events ────────────────────────────────────────────────

function fireDragEvent(type: string, extra: Partial<DragEventInit> = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      dropEffect: "none",
      files: extra.dataTransfer?.files ?? [],
      ...extra.dataTransfer,
    },
  });
  window.dispatchEvent(event);
  return event;
}

describe("DropZoneOverlay", () => {
  it("renders nothing initially (no overlay, no toast)", () => {
    const { container } = render(<DropZoneOverlay />);
    expect(container.querySelector("[style*='position: fixed']")).toBeNull();
  });

  it("shows overlay on dragenter with Files type", async () => {
    const { getByText } = render(<DropZoneOverlay />);
    act(() => { fireDragEvent("dragenter"); });
    expect(getByText("파일을 드롭하여 인덱싱")).toBeDefined();
  });

  it("calls fileScanPaths with file paths on drop", async () => {
    render(<DropZoneOverlay />);
    act(() => { fireDragEvent("dragenter"); });

    // Simulate drop with a file that has .path property (Electron renderer)
    const mockFile = Object.assign(new File([""], "test.pdf"), { path: "/tmp/test.pdf" });
    const fileList = { 0: mockFile, length: 1, [Symbol.iterator]: function*() { yield mockFile; } };

    await act(async () => {
      const dropEvent = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(dropEvent, "dataTransfer", {
        value: { types: ["Files"], files: fileList },
      });
      window.dispatchEvent(dropEvent);
      // Allow async handler to resolve
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFileScanPaths).toHaveBeenCalledWith(["/tmp/test.pdf"]);
  });

  it("shows success toast after scan result", async () => {
    const { getByText } = render(<DropZoneOverlay />);
    act(() => { fireDragEvent("dragenter"); });

    const mockFile = Object.assign(new File([""], "doc.pdf"), { path: "/tmp/doc.pdf" });
    const fileList = { 0: mockFile, length: 1 };

    await act(async () => {
      const dropEvent = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(dropEvent, "dataTransfer", {
        value: { types: ["Files"], files: fileList },
      });
      window.dispatchEvent(dropEvent);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByText("2개 파일 인덱싱 완료")).toBeDefined();
  });
});
