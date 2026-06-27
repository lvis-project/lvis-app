/**
 * executor-plugin-read-relaxation.test.ts — effect-boundary pre-exec relaxation.
 *
 * The FINAL phase of the host-classify completion: when `hostClassifiesRisk` is
 * ON, a FIRST-PARTY PLUGIN tool in a FOREGROUND context no longer runs the
 * pre-exec blocking approval lane. Instead it EXECUTES under effect-boundary
 * gating (the merged effect-boundary gate is the only gate):
 *   • a plugin tool that performs NO mutating host-mediated effect runs to
 *     completion with ZERO modals;
 *   • a plugin tool that reaches a host-mediated WRITE chokepoint trips the
 *     effect-gate AT THE MUTATION (deny → tool error, mutation not performed).
 *
 * Scope locked here (each is a separate cluster-review concern):
 *   • SANDBOX-ACTIVE COUPLING → the relaxation requires the OS sandbox to be
 *     ACTIVE (it relies on the effect-boundary, which only contains off-hostApi
 *     mutations under the sandbox). Sandbox active → relax; sandbox inactive
 *     (degraded / off) → the pre-exec ask stands (known-safe fallback).
 *   • FLAG OFF (default) → full pre-exec ask, byte-for-byte unchanged.
 *   • PLUGIN ONLY → MCP + builtin keep the pre-exec ask (not relaxed).
 *   • FOREGROUND ONLY → a headless plugin tool keeps the existing headless lane.
 *   • DENY STILL WINS → a standing deny rule / a prior user deny-always still
 *     blocks under relaxation (it is a `deny`, never an `ask`).
 *   • PERM-HOOK PRESERVED → an operator `perm-*.sh` deny still fires on the
 *     relaxed path and blocks the tool fail-closed (the relaxation runs the perm
 *     hook BEFORE finalizing the allow).
 *   • LAYER ≤ 2 HARD GATES NOT RELAXED → global strict mode (layer 2) still shows
 *     the pre-exec ask (the relaxation floor is layer ≥ 3).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ApprovalGate, ApprovalDecision, ApprovalRequest, ApprovalChoice } from "../../permissions/approval-gate.js";
import {
  gateMutatingEffect,
  __resetEffectGrantsForTest,
} from "../../permissions/effect-enforcement.js";

// ─── Helpers ─────────────────────────────────────────

function userPermissionContext(
  overrides: Partial<import("../executor.js").ToolPermissionContext> = {},
): import("../executor.js").ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

/** A stub ApprovalGate that records every request and answers with a fixed choice. */
function makeGate(choice: ApprovalChoice): {
  gate: ApprovalGate;
  requests: Array<Omit<ApprovalRequest, "requireExplicit">>;
} {
  const requests: Array<Omit<ApprovalRequest, "requireExplicit">> = [];
  const gate = {
    requestAndWait: async (
      req: Omit<ApprovalRequest, "requireExplicit">,
    ): Promise<ApprovalDecision> => {
      requests.push(req);
      return { requestId: req.id, choice };
    },
  } as unknown as ApprovalGate;
  return { gate, requests };
}

/**
 * A plugin tool whose execute does NO host-mediated effect (a "read" under the
 * effect boundary). Declared category is irrelevant to the relaxation — what
 * matters is that the pre-exec decision is an `ask`; with the flag ON the host
 * inspector raises an evidence-free plugin call to `write` → `ask`, and with
 * the flag OFF we declare `write` so the pre-exec ask is shown for the
 * byte-for-byte lock.
 */
function makePluginNoEffectTool(spy: { ran: boolean }): Tool {
  return createDynamicTool({
    name: "plugin_noeffect",
    description: "A plugin tool that performs no host-mediated effect.",
    source: "plugin",
    pluginId: "p-read",
    category: "write",
    pathFields: [],
    isReadOnly: () => false,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      spy.ran = true;
      return { output: "noeffect-ok", isError: false };
    },
  });
}

/**
 * A plugin tool whose execute REACHES a host-mediated WRITE chokepoint via
 * {@link gateMutatingEffect}, exactly as a real per-plugin hostApi closure does
 * (it reads the ambient effect-gate context the executor binds around execute).
 * The `mutated` flag flips ONLY past the gate, so a denied effect leaves it false.
 */
function makePluginWriteTool(
  gate: ApprovalGate,
  flagEnabled: () => boolean,
  state: { mutated: boolean },
): Tool {
  return createDynamicTool({
    name: "plugin_writer",
    description: "A plugin tool that performs a host-mediated write.",
    source: "plugin",
    pluginId: "p-write",
    category: "write",
    pathFields: [],
    isReadOnly: () => false,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      await gateMutatingEffect({
        pluginId: "p-write",
        methodPath: "storage.write",
        effect: "write",
        target: "a.txt",
        approvalGate: gate,
        flagEnabled,
      });
      state.mutated = true; // only reached if the effect-gate ALLOWS
      return { output: "writer-ok", isError: false };
    },
  });
}

/**
 * A plugin tool whose execute reaches the host-mediated `openExternalUrl` WRITE
 * chokepoint (an egress/exfil-class action). `openExternalUrl` is now EFFECT-GATED
 * (moved out of ENFORCEMENT_EXCLUSIONS), so under the flag the pre-exec ask is
 * relaxed but the effect-gate fires AT the open; `opened` flips only past the gate.
 */
function makePluginOpenUrlTool(
  gate: ApprovalGate,
  flagEnabled: () => boolean,
  state: { opened: boolean },
): Tool {
  return createDynamicTool({
    name: "plugin_opener",
    description: "A plugin tool that opens an external URL.",
    source: "plugin",
    pluginId: "p-open",
    category: "write",
    pathFields: [],
    isReadOnly: () => false,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      await gateMutatingEffect({
        pluginId: "p-open",
        methodPath: "openExternalUrl",
        effect: "write",
        target: "https://evil.example",
        approvalGate: gate,
        flagEnabled,
      });
      state.opened = true; // only reached if the effect-gate ALLOWS
      return { output: "opener-ok", isError: false };
    },
  });
}

function makeMcpTool(spy: { ran: boolean }): Tool {
  return createDynamicTool({
    name: "mcp_tool",
    description: "An external MCP tool.",
    source: "mcp",
    mcpServerId: "srv-1",
    category: "network",
    pathFields: [],
    isReadOnly: () => false,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      spy.ran = true;
      return { output: "mcp-ok", isError: false };
    },
  });
}

function makeBuiltinWriteTool(spy: { ran: boolean }): Tool {
  return createDynamicTool({
    name: "builtin_write",
    description: "A builtin write tool.",
    source: "builtin",
    category: "write",
    pathFields: [],
    isReadOnly: () => false,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      spy.ran = true;
      return { output: "builtin-ok", isError: false };
    },
  });
}

function makeExecutor(
  tool: Tool,
  gate: ApprovalGate,
  flagEnabled: () => boolean,
  permMgr = new PermissionManager("/tmp/nonexistent-permissions.json"),
  scriptHookManager?: import("../../hooks/script-hook-manager.js").ScriptHookManager,
  // Sandbox-active interlock (default ACTIVE — the macOS live-verified state).
  // The relaxation requires BOTH the flag AND the sandbox active; existing
  // relaxation assertions run with the sandbox active. The coupling tests below
  // pass `() => false` to assert the degraded/sandbox-off fallback.
  sandboxActive: () => boolean = () => true,
): { executor: ToolExecutor; permMgr: PermissionManager } {
  const registry = new ToolRegistry();
  registry.register(tool);
  const executor = new ToolExecutor(
    registry,
    undefined,
    permMgr,
    undefined,
    gate,
    scriptHookManager,
    undefined,
    flagEnabled,
    sandboxActive,
  );
  return { executor, permMgr };
}

/**
 * A minimal ScriptHookManager stub whose PermissionRequest (`perm-*.sh`) dispatch
 * always DENIES — models an operator deny policy encoded in a `perm-*.sh` hook.
 * Only `runPermissionRequest` is stubbed: the relaxed-path perm-hook preservation
 * fires it BEFORE finalizing the allow and (on deny) returns the tool error before
 * any `pre`/`post` dispatch, so no other method is reached.
 */
function makeDenyPermHookManager(
  calls: { permRan: boolean },
): import("../../hooks/script-hook-manager.js").ScriptHookManager {
  return {
    runPermissionRequest: async () => {
      calls.permRan = true;
      return { decision: "deny" as const, reason: "operator perm-*.sh deny", results: [] };
    },
  } as unknown as import("../../hooks/script-hook-manager.js").ScriptHookManager;
}

beforeEach(() => {
  __resetEffectGrantsForTest();
});

// ─── Tests ───────────────────────────────────────────

describe("plugin read-relaxation — FLAG OFF = byte-for-byte unchanged", () => {
  it("flag OFF + foreground + plugin tool → the FULL pre-exec ask is shown (relaxation inert)", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => false);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // The pre-exec tool-level modal fired (category "tool") and, on deny-once,
    // the tool NEVER executed — identical to today's behaviour.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — FLAG ON + foreground + plugin", () => {
  it("plugin tool with NO mutating effect → NO modal at all, executes to completion", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => true);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Pre-exec ask relaxed AND no host-mediated write effect → zero modals.
    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("noeffect-ok");
  });

  it("plugin tool that reaches a host WRITE chokepoint → NO pre-exec modal, but the effect-gate fires at the mutation (deny → tool error, mutation NOT performed)", async () => {
    const state = { mutated: false };
    const flagEnabled = (): boolean => true;
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginWriteTool(gate, flagEnabled, state),
      gate,
      flagEnabled,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_writer", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // EXACTLY ONE modal — the effect-gate (category "agent-action"), NOT the
    // pre-exec tool modal (category "tool"). The pre-exec ask was relaxed.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("agent-action");
    // Deny at the effect-gate → the impl past the gate never ran.
    expect(state.mutated).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("plugin tool that reaches a host WRITE chokepoint + ALLOW at the effect-gate → exactly one effect-gate modal, mutation proceeds", async () => {
    const state = { mutated: false };
    const flagEnabled = (): boolean => true;
    const { gate, requests } = makeGate("allow-once");
    const { executor } = makeExecutor(
      makePluginWriteTool(gate, flagEnabled, state),
      gate,
      flagEnabled,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_writer", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("agent-action");
    expect(state.mutated).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("writer-ok");
  });

  it("plugin tool that calls openExternalUrl (egress) → NO pre-exec modal, the effect-gate fires at the open; deny → URL NOT opened", async () => {
    const state = { opened: false };
    const flagEnabled = (): boolean => true;
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginOpenUrlTool(gate, flagEnabled, state),
      gate,
      flagEnabled,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_opener", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // openExternalUrl is now GATED (no longer an ENFORCEMENT_EXCLUSIONS member):
    // the pre-exec ask was relaxed (no "tool" modal), but the effect-gate fired
    // (category "agent-action") and, on deny, the browser was never opened.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("agent-action");
    expect(state.opened).toBe(false);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — NOT relaxed (scope guards)", () => {
  it("flag ON + source MCP → NOT relaxed: the pre-exec ask is shown (fail-closed for non-host-observable)", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(makeMcpTool(spy), gate, () => true);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "mcp_tool", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("flag ON + source builtin → NOT relaxed: the pre-exec ask is shown", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(makeBuiltinWriteTool(spy), gate, () => true);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "builtin_write", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("flag ON + HEADLESS plugin tool → NOT relaxed: kept on the existing headless lane (no reviewer → blocked, tool does not execute)", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    // No reviewer wired → the headless lane denies a mutating plugin tool
    // instead of relaxing it through to execution.
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => true);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext({ headless: true }) },
    );

    // Relaxation is foreground-only: in headless the tool is NOT allowed
    // through (it never executed), and no foreground modal was shown.
    expect(spy.ran).toBe(false);
    expect(requests).toHaveLength(0);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — explicit deny still wins", () => {
  it("flag ON + a standing DENY rule → blocked (never an ask; relaxation cannot fire)", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("allow-once");
    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.setRules([{ pattern: "plugin_noeffect", action: "deny" }]);
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => true, permMgr);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(spy.ran).toBe(false);
    expect(requests).toHaveLength(0); // a deny shows no modal — it is blocked outright
    expect(result.is_error).toBe(true);
  });

  it("flag ON + a PRIOR user deny-always (persisted) → still blocked under relaxation", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("allow-once");
    const dir = mkdtempSync(join(tmpdir(), "lvis-relax-deny-"));
    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    // Models the executor's deny-always handling — a prior user "deny always"
    // persists exactly this rule, which checkDetailed reads as a layer-1 deny.
    await permMgr.addAlwaysDeniedPersist("plugin_noeffect");
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => true, permMgr);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(spy.ran).toBe(false);
    expect(requests).toHaveLength(0);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — operator perm-*.sh deny hook is preserved on the relaxed path", () => {
  it("flag ON + foreground + plugin + a perm hook that DENIES → tool is BLOCKED (not relaxed-allowed), no modal", async () => {
    const spy = { ran: false };
    // allow-once so that if the perm hook were SKIPPED and the (non-existent)
    // pre-exec modal somehow fired, the tool would run — making a regression
    // visible. With the fix the perm hook denies first and the tool never runs.
    const { gate, requests } = makeGate("allow-once");
    const calls = { permRan: false };
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      makeDenyPermHookManager(calls),
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // The perm hook ran on the relaxed path and DENIED → fail-closed: tool blocked,
    // tool body never executed, and no approval modal was shown (the relaxation
    // path shows none; the perm-hook deny short-circuits before execution).
    expect(calls.permRan).toBe(true);
    expect(spy.ran).toBe(false);
    expect(requests).toHaveLength(0);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — coupled to the OS sandbox being ACTIVE", () => {
  it("flag ON + sandbox ACTIVE + foreground plugin ask → relaxed (NO modal, tool runs)", async () => {
    // The baseline coupling assertion: with the sandbox active (macOS), the
    // relaxation fires exactly as before — clean UX, unchanged.
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => true, // sandbox ACTIVE
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("noeffect-ok");
  });

  it("flag ON + sandbox INACTIVE + foreground plugin ask → NOT relaxed: the pre-exec ask is shown, tool NOT auto-allowed", async () => {
    // On a degraded / sandbox-off host the effect-boundary cannot contain the
    // off-hostApi mutation residual, so relaxing would be WEAKER than the
    // pre-exec ask. The coupling clause keeps the pre-exec approval ask:
    // on deny-once the tool never runs.
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => false, // sandbox INACTIVE (degraded / off)
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // The pre-exec tool-level modal fired (category "tool") and, on deny-once,
    // the tool NEVER executed — the known-safe fallback, identical to flag-OFF.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("flag OFF + sandbox INACTIVE → unchanged: the pre-exec ask is shown (relaxation inert regardless of sandbox)", async () => {
    // Flag-OFF behaviour is independent of the sandbox state — the relaxation
    // block is skipped entirely, so the full pre-exec ask stands.
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => false,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => false, // sandbox INACTIVE
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — layer ≤ 2 hard gates are NOT relaxed", () => {
  it("flag ON + foreground + plugin + global strict mode (layer 2) → the pre-exec ask is STILL shown, tool NOT relaxed", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    // Global strict mode is a layer-2 hard gate: checkDetailed returns
    // { decision: "ask", layer: 2 }. The relaxation floor is layer ≥ 3, so the
    // ask is NOT relaxed — the full pre-exec modal is shown exactly as today.
    // Guards against a future checkDetailed layer renumber silently widening the
    // relaxation past strict mode.
    permMgr.setMode("strict");
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => true, permMgr);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // The layer-2 strict ask survived the relaxation: the pre-exec tool modal
    // (category "tool") fired and, on deny-once, the tool never executed.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });
});
