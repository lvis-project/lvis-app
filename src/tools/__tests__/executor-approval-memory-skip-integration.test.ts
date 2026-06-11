/**
 * End-to-end integration coverage for the foreground modal-skip via
 * explicit-approval memory (Store B).
 *
 * Unlike the sibling unit suite (executor-approval-memory-skip.test.ts) these
 * tests do NOT stub `PermissionManager.checkDetailed` and do NOT mock the
 * user-approval store or the audit sink. They drive a REAL PermissionManager
 * plus the REAL user-approval store (isolated via LVIS_HOME) so the layer
 * contract is pinned end-to-end:
 *
 *   (a) a deny rule wins over a prior approval — Store B is never consulted
 *       (Layer 1 hard gate).
 *   (b) an overlay-trigger mutating ask + a prior approval still shows the
 *       modal — Store B is never consulted (Layer 2 hard gate). The global
 *       strict-mode variant is asserted the same way.
 *   (c) a persistent-scope approval recorded through the real store skips the
 *       modal on the next identical invocation (Layer 6 normal ask).
 *   (d) an approval recorded under one (trustOrigin, approvalCacheKey) does
 *       NOT match a lookup with a different key dimension — the modal is shown
 *       (the cache key dimensions are load-bearing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  recordApproval,
  __resetSessionStoreForTest,
} from "../../permissions/user-approval-store.js";
import { canonicalStringify } from "../../shared/canonical-json.js";

function userPermissionContext(
  overrides: Partial<import("../executor.js").ToolPermissionContext> = {},
): import("../executor.js").ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

function makeWriteTool(executeSpy: (input: unknown) => Promise<unknown>): Tool {
  return createDynamicTool({
    name: "write_probe",
    description: "write probe",
    source: "builtin",
    category: "write",
    pathFields: ["path"],
    jsonSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async (rawInput) => {
      const value = await executeSpy(rawInput);
      return { output: String(value), isError: false };
    },
  });
}

describe("ToolExecutor — Store B memory skip end-to-end (real PermissionManager + real store)", () => {
  let dir: string;
  let lvisHomeDir: string;
  let prevLvisHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lvis-memory-skip-e2e-"));
    lvisHomeDir = mkdtempSync(join(tmpdir(), "lvis-home-e2e-"));
    prevLvisHome = process.env.LVIS_HOME;
    process.env.LVIS_HOME = lvisHomeDir;
    __resetSessionStoreForTest();
  });

  afterEach(() => {
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
    __resetSessionStoreForTest();
    rmSync(dir, { recursive: true, force: true });
    rmSync(lvisHomeDir, { recursive: true, force: true });
  });

  it("(a) deny rule wins over a prior approval — Layer 1, Store B never consulted", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.setRules([{ pattern: "write_probe", action: "deny" }]);

    // A matching prior approval exists — it must be ignored under a deny.
    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "session", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard" },
    );

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-deny", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-deny",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    // Deny short-circuits at Layer 1 — the modal is never reached.
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("(b) overlay-trigger mutating ask + prior approval → modal shown — Layer 2 hard gate", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));

    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "session", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard" },
    );

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-overlay", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-overlay",
        // Overlay trigger forces a Layer 2 ask for mutating tools.
        overlayTriggerOrigin: "overlay:meeting-detection",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Layer 2 hard gate is never memory-skipped — modal shown, tool denied.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("(b') global strict mode + prior approval → modal shown — Layer 2 hard gate", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.setMode("strict");

    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "session", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard" },
    );

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-strict", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-strict",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("(c) persistent-scope approval recorded via the real store skips the modal on re-call", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteTool(executeSpy));

    // Default mode + builtin write → Layer 6 normal ask (no reviewer route),
    // which is the lane eligible for the Store B skip.
    const permMgr = new PermissionManager(join(dir, "permissions.json"));

    // Record a PERSISTENT approval for the exact tuple the executor will look up.
    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "persistent", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard" },
    );

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-persist", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-persist",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Memory hit — modal skipped, tool executed.
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBeUndefined();
  });

  it("(d) approval under a different (trustOrigin, approvalCacheKey) does NOT match — modal shown", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));

    // Recorded under approvalCacheKey "key-A". The invocation below carries no
    // approvalCacheKey and trustOrigin "user-keyboard", so the derived key
    // differs → lookup misses → modal shown.
    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      {
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        trustOrigin: "user-keyboard",
        approvalCacheKey: "key-A",
      },
    );

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      // No approvalCacheKey on this invocation → key mismatch vs the stored entry.
      [{ id: "tu-keymiss", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-keymiss",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Key dimensions are load-bearing — a mismatch is a miss → modal shown.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
