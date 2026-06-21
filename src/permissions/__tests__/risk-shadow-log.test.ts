/**
 * Risk shadow-log emission tests (host-classifies-risk shadow mode).
 *
 * The shadow log is the reconciliation gate that must pass before the
 * `hostClassifiesRisk` flag is flipped. These tests pin:
 *   (a) every emission carries the declared vs host-derived pair;
 *   (b) `diverged` is derived correctly (declared !== hostDerived);
 *   (c) the log performs NO enforcement (pure side-effect — emission only).
 *
 * In test mode `createLogger().info(obj, msg)` delegates to `console.log`
 * (see src/lib/logger.ts), so the structured record is the second argument.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { emitRiskShadowLog } from "../reviewer/risk-shadow-log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function lastRecord(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  expect(call).toBeDefined();
  // logger console shim: console.log(`${prefix} ${msg}`, obj, ...)
  return call![1] as Record<string, unknown>;
}

describe("emitRiskShadowLog", () => {
  it("emits the declared vs host-derived pair with diverged=false when equal", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitRiskShadowLog({
      toolName: "files_read",
      source: "plugin",
      pluginId: "lvis-plugin-x",
      declaredCategory: "read",
      hostDerivedCategory: "read",
      enforced: false,
    });
    const rec = lastRecord(spy);
    expect(rec).toMatchObject({
      event: "risk-shadow",
      toolName: "files_read",
      source: "plugin",
      pluginId: "lvis-plugin-x",
      declaredCategory: "read",
      hostDerivedCategory: "read",
      diverged: false,
      enforced: false,
    });
  });

  it("sets diverged=true when declared and host-derived disagree", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitRiskShadowLog({
      toolName: "rogue_tool",
      source: "plugin",
      declaredCategory: "read",
      hostDerivedCategory: "write",
      enforced: false,
    });
    const rec = lastRecord(spy);
    expect(rec.diverged).toBe(true);
    expect(rec.declaredCategory).toBe("read");
    expect(rec.hostDerivedCategory).toBe("write");
  });

  it("omits pluginId when absent (builtin/mcp tools)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitRiskShadowLog({
      toolName: "bash",
      source: "builtin",
      declaredCategory: "shell",
      hostDerivedCategory: "shell",
      enforced: true,
    });
    const rec = lastRecord(spy);
    expect("pluginId" in rec).toBe(false);
    expect(rec.enforced).toBe(true);
  });

  it("returns void — it is a pure side-effect sink that cannot alter a decision", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = emitRiskShadowLog({
      toolName: "t",
      source: "mcp",
      declaredCategory: "network",
      hostDerivedCategory: "network",
      enforced: false,
    });
    expect(result).toBeUndefined();
  });
});
