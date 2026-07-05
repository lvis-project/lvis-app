import { describe, it, expect, vi, afterEach } from "vitest";
import {
  probeOllamaAvailable,
  _setOllamaAvailableOverrideForTest,
} from "../ollama-probe.js";

afterEach(() => {
  _setOllamaAvailableOverrideForTest(undefined);
  vi.unstubAllGlobals();
});

describe("probeOllamaAvailable", () => {
  it("returns true when the local server answers with a 2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    expect(await probeOllamaAvailable()).toBe(true);
  });

  it("returns false on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    expect(await probeOllamaAvailable()).toBe(false);
  });

  it("returns false when the connection is refused (no server listening)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:11434");
      }),
    );
    expect(await probeOllamaAvailable()).toBe(false);
  });

  it("never throws — a rejected fetch resolves to false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    await expect(probeOllamaAvailable()).resolves.toBe(false);
  });

  it("honors the test seam override without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    _setOllamaAvailableOverrideForTest(true);
    expect(await probeOllamaAvailable()).toBe(true);
    _setOllamaAvailableOverrideForTest(false);
    expect(await probeOllamaAvailable()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
