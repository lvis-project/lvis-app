/**
 * Unit tests for lifecycle-log.ts:
 * 1. Phase constant shape consistency (all values match naming convention)
 * 2. plog() forwards the correct structured object + phase field to the logger
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PluginPhase, plog } from "../lifecycle-log.js";

// ─── Phase constant shape ─────────────────────────────────────────────────────

describe("PluginPhase constants", () => {
  it("all values start with 'lifecycle:'", () => {
    for (const [key, value] of Object.entries(PluginPhase)) {
      expect(value, `PluginPhase.${key}`).toMatch(/^lifecycle:/);
    }
  });

  it("has at least 30 distinct entries", () => {
    const values = Object.values(PluginPhase);
    expect(values.length).toBeGreaterThanOrEqual(30);
    // All values unique
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("covers all lifecycle areas: discovery, validation, load, register, start, invoke, event, webview, restart, stop, capability", () => {
    const areas = [
      "lifecycle:discovery:",
      "lifecycle:validation:",
      "lifecycle:load:",
      "lifecycle:register:",
      "lifecycle:start:",
      "lifecycle:invoke:",
      "lifecycle:event:",
      "lifecycle:webview:",
      "lifecycle:restart:",
      "lifecycle:stop:",
      "lifecycle:capability:",
    ];
    const values = Object.values(PluginPhase) as string[];
    for (const area of areas) {
      const hasArea = values.some((v) => v.startsWith(area));
      expect(hasArea, `no phase for area ${area}`).toBe(true);
    }
  });

  it("restart area records stop failure and reload/start outcomes", () => {
    const values = Object.values(PluginPhase) as string[];
    const restartPhases = values.filter((v) => v.startsWith("lifecycle:restart:"));
    const requiredSuffixes = ["stop:fail", "reload:ok", "reload:fail", "start:ok", "start:fail"];
    for (const suffix of requiredSuffixes) {
      const hasPhase = restartPhases.some((v) => v.endsWith(suffix));
      expect(hasPhase, `missing restart phase ending with :${suffix}`).toBe(true);
    }
  });
});

// ─── plog() wiring ────────────────────────────────────────────────────────────

describe("plog()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes pluginId, phase, and message through to the logger", () => {
    // In test mode, createLogger delegates to console — log[level](ctx, msg) →
    // console.log(prefix + msg, ctx). Assert the context object (2nd arg) carries
    // pluginId and phase, not just that the message appears somewhere.
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    plog("debug", { pluginId: "test-plugin", phase: PluginPhase.LOAD_START }, "loading plugin");
    expect(consoleSpy).toHaveBeenCalled();
    const callArgs = consoleSpy.mock.calls[0];
    // callArgs[0] = "[plugin-lifecycle] loading plugin" (prefix + msg)
    // callArgs[1] = ctx object { pluginId, phase, ... }
    expect(callArgs[0]).toContain("loading plugin");
    const ctx = callArgs[1] as Record<string, unknown>;
    expect(ctx).toMatchObject({ pluginId: "test-plugin", phase: PluginPhase.LOAD_START });
  });

  it("routes error level through console.error", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    plog("error", { pluginId: "test-plugin", phase: PluginPhase.LOAD_FAIL, reason: "import", err: new Error("bad") }, "import failed");
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("routes warn level through console.warn", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    plog("warn", { pluginId: "test-plugin", phase: PluginPhase.REGISTER_TOOL_SKIP, toolName: "my_tool", reason: "missing_handler" }, "tool disabled — missing handler");
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("routes info level through console.log (test mode maps info→log)", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    plog("info", { pluginId: "test-plugin", phase: PluginPhase.RESTART_REQUEST }, "restart requested");
    expect(consoleSpy).toHaveBeenCalled();
    const argsFlat = consoleSpy.mock.calls[0].join(" ");
    expect(argsFlat).toContain("restart requested");
  });
});
