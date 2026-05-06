import "../setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDebugStreamEnv = process.env.VITE_DEBUG_STREAM;

function setRendererDebugFlag(value: boolean, overrides?: { isDev?: boolean; enableDevConsole?: boolean }) {
  const current = window.lvis;
  window.lvis = {
    ...(current ?? {}),
    env: {
      isDev: overrides?.isDev ?? current?.env?.isDev ?? false,
      enableDevConsole: overrides?.enableDevConsole ?? current?.env?.enableDevConsole ?? false,
      debugStream: value,
    },
  } as typeof window.lvis;
}

describe("debug-stream", () => {
  beforeEach(() => {
    setRendererDebugFlag(false);
    delete process.env.VITE_DEBUG_STREAM;
  });

  afterEach(() => {
    if (originalDebugStreamEnv === undefined) {
      delete process.env.VITE_DEBUG_STREAM;
    } else {
      process.env.VITE_DEBUG_STREAM = originalDebugStreamEnv;
    }
  });

  it("enables renderer logging from the preload bridge", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { debugLog, isDebugStreamEnabled } = await import("../../../src/lib/debug-stream.js");

    setRendererDebugFlag(true);

    expect(isDebugStreamEnabled()).toBe(true);
    debugLog("stream", "hello");
    expect(spy).toHaveBeenCalledWith("[lvis-debug:stream]", "hello");

    spy.mockRestore();
  });

  it("keeps logging disabled when neither preload nor env enables it", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { debugLog, isDebugStreamEnabled } = await import("../../../src/lib/debug-stream.js");

    expect(isDebugStreamEnabled()).toBe(false);
    debugLog("stream", "hello");
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
