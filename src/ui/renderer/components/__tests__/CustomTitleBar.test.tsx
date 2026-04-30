// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CustomTitleBar } from "../CustomTitleBar.js";

// ─── Window bridge mocks ──────────────────────────────────────────────────

const mockMinimize = vi.fn().mockResolvedValue(undefined);
const mockToggleMaximize = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockSyncTheme = vi.fn().mockResolvedValue(undefined);

let maxListener: ((maximized: boolean) => void) | null = null;
let fullscreenListener: ((fs: boolean) => void) | null = null;

const mockOnMaximizedChanged = vi.fn((handler: (m: boolean) => void) => {
  maxListener = handler;
  return () => { maxListener = null; };
});
const mockOnFullscreenChanged = vi.fn((handler: (fs: boolean) => void) => {
  fullscreenListener = handler;
  return () => { fullscreenListener = null; };
});

function setupBridges(isDarwin: boolean) {
  (window as unknown as Record<string, unknown>).lvisPlatform = { isDarwin };
  (window as unknown as Record<string, unknown>).lvisWindow = {
    minimize: mockMinimize,
    toggleMaximize: mockToggleMaximize,
    close: mockClose,
    syncTitleBarTheme: mockSyncTheme,
    onMaximizedChanged: mockOnMaximizedChanged,
    onFullscreenChanged: mockOnFullscreenChanged,
  };
}

function teardownBridges() {
  delete (window as unknown as Record<string, unknown>).lvisPlatform;
  delete (window as unknown as Record<string, unknown>).lvisWindow;
  maxListener = null;
  fullscreenListener = null;
}

describe("CustomTitleBar", () => {
  afterEach(() => {
    teardownBridges();
    vi.clearAllMocks();
  });

  describe("macOS (isDarwin=true)", () => {
    beforeEach(() => setupBridges(true));

    it("renders a drag-only darwin band", () => {
      const { getByTestId, queryByTestId } = render(<CustomTitleBar />);
      expect(getByTestId("custom-titlebar-darwin")).toBeTruthy();
      expect(queryByTestId("custom-titlebar")).toBeNull();
    });

    it("does not render minimize/maximize/close buttons", () => {
      const { queryByTestId } = render(<CustomTitleBar />);
      expect(queryByTestId("titlebar-minimize")).toBeNull();
      expect(queryByTestId("titlebar-maximize")).toBeNull();
      expect(queryByTestId("titlebar-close")).toBeNull();
    });
  });

  describe("Win/Linux (isDarwin=false)", () => {
    beforeEach(() => setupBridges(false));

    it("renders the full control bar", () => {
      const { getByTestId, queryByTestId } = render(<CustomTitleBar />);
      expect(getByTestId("custom-titlebar")).toBeTruthy();
      expect(queryByTestId("custom-titlebar-darwin")).toBeNull();
    });

    it("renders minimize, maximize, and close buttons", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      expect(getByTestId("titlebar-minimize")).toBeTruthy();
      expect(getByTestId("titlebar-maximize")).toBeTruthy();
      expect(getByTestId("titlebar-close")).toBeTruthy();
    });

    it("clicking minimize calls window:minimize IPC", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      fireEvent.click(getByTestId("titlebar-minimize"));
      expect(mockMinimize).toHaveBeenCalledTimes(1);
    });

    it("clicking maximize calls window:toggleMaximize IPC", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      fireEvent.click(getByTestId("titlebar-maximize"));
      expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
    });

    it("clicking close calls window:close IPC", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      fireEvent.click(getByTestId("titlebar-close"));
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("double-clicking drag band calls window:toggleMaximize IPC", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      fireEvent.doubleClick(getByTestId("custom-titlebar"));
      expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
    });

    it("hides entirely when fullscreen event fires", async () => {
      const { queryByTestId } = render(<CustomTitleBar />);
      expect(queryByTestId("custom-titlebar")).toBeTruthy();
      // Simulate fullscreen broadcast from main process
      fullscreenListener?.(true);
      // Re-render happens via state update — query again
      await new Promise((r) => setTimeout(r, 0));
      expect(queryByTestId("custom-titlebar")).toBeNull();
    });

    it("maximize icon toggles when maximized event fires", async () => {
      const { getByTestId } = render(<CustomTitleBar />);
      // Not maximized initially — Maximize2 icon (title = 최대화)
      expect(getByTestId("titlebar-maximize").title).toBe("최대화");
      maxListener?.(true);
      await new Promise((r) => setTimeout(r, 0));
      // After maximized — Minimize2 icon (title = 이전 크기로)
      expect(getByTestId("titlebar-maximize").title).toBe("이전 크기로");
    });
  });

  describe("missing bridge (non-Electron environment)", () => {
    it("renders nothing if lvisPlatform is absent", () => {
      delete (window as unknown as Record<string, unknown>).lvisPlatform;
      const { container } = render(<CustomTitleBar />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
