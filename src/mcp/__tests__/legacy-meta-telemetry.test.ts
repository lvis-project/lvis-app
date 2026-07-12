/**
 * The legacy-`_meta` observability helper — the thing that makes the dual-read's
 * removal gate decidable (see CHANGELOG). Pins that a legacy hit is logged, and
 * logged ONCE per (plugin, key) per process, so the signal is "which plugins are
 * still legacy", not per-call noise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeLegacyMetaKey,
  __resetLegacyMetaTelemetryForTests,
} from "../legacy-meta-telemetry.js";
import { createLogger } from "../../lib/logger.js";

vi.mock("../../lib/logger.js", () => {
  const warn = vi.fn();
  return { createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
});

const warn = (createLogger("legacy-meta") as unknown as { warn: ReturnType<typeof vi.fn> }).warn;

afterEach(() => {
  __resetLegacyMetaTelemetryForTests();
  warn.mockClear();
});

describe("observeLegacyMetaKey", () => {
  it("warns on a legacy hit, naming the plugin and the key", () => {
    observeLegacyMetaKey("com.example.notes", "pathFields");
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("com.example.notes");
    expect(msg).toContain("xyz.lvis/pathFields");
    expect(msg).toContain("lvisai/pathFields");
  });

  it("dedups: the same (plugin, key) logs once, not per call", () => {
    observeLegacyMetaKey("p", "pathFields");
    observeLegacyMetaKey("p", "pathFields");
    observeLegacyMetaKey("p", "pathFields");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("distinguishes plugins and keys — each distinct pair logs once", () => {
    observeLegacyMetaKey("p", "pathFields");
    observeLegacyMetaKey("p", "rawResult");
    observeLegacyMetaKey("q", "pathFields");
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
