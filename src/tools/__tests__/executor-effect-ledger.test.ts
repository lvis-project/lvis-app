/**
 * Executor → EffectLedger → shadow reconciliation effect shadow (Phases 1-2, observability).
 *
 * End-to-end proof of the host-owned read/write signal threading:
 *   - the executor binds a fresh per-invocation ledger around Step 6 (execute);
 *   - effects recorded by the in-invocation code (here, a fake plugin handler
 *     standing in for the hostApi closures) land on THAT ledger;
 *   - after execute() returns, an `effect-shadow` record is written to the
 *     AuditLogger (temp dir) with the host-OBSERVED `hasMutatingEffect`.
 *
 * The decisive scenario: a tool that DECLARES `read` but performs a host-observed
 * WRITE is recorded as `hasMutatingEffect:true` — exactly the divergence the
 * effect-boundary model exists to surface. This changes NO permission decision
 * (both tools execute identically); it only records the signal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { AuditLogger, type AuditEntry } from "../../audit/audit-logger.js";
import { recordEffect } from "../../permissions/effect-ledger.js";
import { recordChokepoint } from "../../permissions/effect-ledger.js";
import type { ChokepointKind } from "../../permissions/effect-kind.js";
import { createPluginStorage } from "../../plugins/storage.js";
import {
  runWithInvocationOrigin,
  currentInvocationOrigin,
  type InvocationOrigin,
} from "../../plugins/runtime/origin-chain.js";

function userPermissionContext(): import("../executor.js").ToolPermissionContext {
  return { trustOrigin: "user-keyboard" };
}

/**
 * A plugin tool that DECLARES `read` but, in its handler, performs the given
 * host-mediated effects via `recordEffect` — exactly what the hostApi closures
 * do inside a real in-process plugin handler.
 */
function makePluginTool(
  name: string,
  effects: Array<{ kind: ChokepointKind; effect: "read" | "write"; target?: string }>,
) {
  return createDynamicTool({
    name,
    description: `plugin tool ${name}`,
    source: "plugin",
    pluginId: "lvis-plugin-x",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      for (const e of effects) recordEffect(e);
      return { output: "ok", isError: false };
    },
  });
}

/** Rows of a given shadow `event` ("effect-shadow" | "risk-shadow") across all channels. */
function shadowRows(auditDir: string, event: string): Array<Record<string, unknown>> {
  const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  const rows: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of readFileSync(join(auditDir, f), "utf-8").trim().split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as AuditEntry;
      const out = entry.output ?? "";
      if (out.includes(event)) rows.push(JSON.parse(out) as Record<string, unknown>);
    }
  }
  return rows;
}

function effectShadowRows(auditDir: string): Array<Record<string, unknown>> {
  return shadowRows(auditDir, "effect-shadow");
}

describe("executor effect ledger — host-observed read/write shadow", () => {
  let auditDir: string;
  let auditLogger: AuditLogger;

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), "lvis-effect-ledger-"));
    auditLogger = new AuditLogger(auditDir);
  });
  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
  });

  function newExecutor(registry: ToolRegistry): ToolExecutor {
    return new ToolExecutor(registry, undefined, undefined, undefined, undefined, undefined, auditLogger);
  }

  it("a read-only plugin invocation → hasMutatingEffect:false", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makePluginTool("lvis-plugin-x_readonly", [
        { kind: "config.get", effect: "read", target: "k" },
        { kind: "getSecret", effect: "read" },
      ]),
    );
    const results = await newExecutor(registry).executeAll(
      [{ id: "tu-ro", name: "lvis-plugin-x_readonly", input: {} }],
      { sessionId: "sess-ro", permissionContext: userPermissionContext() },
    );
    // Success path omits `is_error` (only set when true).
    expect(results[0].is_error).toBeFalsy();
    expect(results[0].content).toBe("ok");

    const rows = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_readonly");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "effect-shadow",
      source: "plugin",
      pluginId: "lvis-plugin-x",
      declaredCategory: "read",
      hasMutatingEffect: false,
    });
  });

  it("a declared-read plugin invocation that mutates → hasMutatingEffect:true", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makePluginTool("lvis-plugin-x_mutating", [
        { kind: "config.get", effect: "read", target: "k" },
        { kind: "config.set", effect: "write", target: "k" },
      ]),
    );
    const results = await newExecutor(registry).executeAll(
      [{ id: "tu-mut", name: "lvis-plugin-x_mutating", input: {} }],
      { sessionId: "sess-mut", permissionContext: userPermissionContext() },
    );
    // Success path omits `is_error` (only set when true).
    expect(results[0].is_error).toBeFalsy();
    expect(results[0].content).toBe("ok");

    const rows = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_mutating");
    expect(rows).toHaveLength(1);
    expect(rows[0].hasMutatingEffect).toBe(true);
    // The declared category stays "read" — the host caught the divergence.
    expect(rows[0].declaredCategory).toBe("read");
  });

  it("each invocation gets a FRESH ledger — no cross-invocation leak", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makePluginTool("lvis-plugin-x_mutating2", [{ kind: "config.set", effect: "write" }]),
    );
    registry.register(
      makePluginTool("lvis-plugin-x_readonly2", [{ kind: "config.get", effect: "read" }]),
    );
    const executor = newExecutor(registry);
    // Run the mutating tool first, then the read-only tool. If the ledger leaked,
    // the read-only invocation would inherit the prior write.
    await executor.executeAll(
      [{ id: "tu-1", name: "lvis-plugin-x_mutating2", input: {} }],
      { sessionId: "sess-1", permissionContext: userPermissionContext() },
    );
    await executor.executeAll(
      [{ id: "tu-2", name: "lvis-plugin-x_readonly2", input: {} }],
      { sessionId: "sess-2", permissionContext: userPermissionContext() },
    );
    const mut = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_mutating2");
    const ro = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_readonly2");
    expect(mut[0].hasMutatingEffect).toBe(true);
    expect(ro[0].hasMutatingEffect).toBe(false);
  });

  it("a read-declared wrapper that callTool→mutating-tool ⇒ outer hasMutatingEffect:true", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makePluginTool("lvis-plugin-x_inner_mut", [{ kind: "config.set", effect: "write", target: "k" }]),
    );
    let executorRef!: ToolExecutor;
    const wrapper = createDynamicTool({
      name: "lvis-plugin-x_wrapper",
      description: "read-declared wrapper delegating a mutation via callTool",
      source: "plugin",
      pluginId: "lvis-plugin-x",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => {
        // Stand in for ctx.callTool(M): the hostApi closure records a nested READ
        // marker on the outer ledger, then re-enters the SAME executor for the
        // inner mutating tool from within the wrapper's (outer) ledger scope.
        recordEffect({ kind: "callTool", effect: "read", target: "lvis-plugin-x_inner_mut" });
        await executorRef.executeAll(
          [{ id: "tu-inner", name: "lvis-plugin-x_inner_mut", input: {} }],
          { sessionId: "sess-inner", permissionContext: userPermissionContext() },
        );
        return { output: "ok", isError: false };
      },
    });
    registry.register(wrapper);
    executorRef = newExecutor(registry);
    await executorRef.executeAll(
      [{ id: "tu-wrap", name: "lvis-plugin-x_wrapper", input: {} }],
      { sessionId: "sess-wrap", permissionContext: userPermissionContext() },
    );

    const wrapRows = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_wrapper");
    expect(wrapRows).toHaveLength(1);
    // The wrapper's OWN ledger surfaces the delegated mutation via callTool-child —
    // without this propagation a later read-recognition gate would treat the
    // wrapper as a safe read (fail-permissive).
    expect(wrapRows[0].hasMutatingEffect).toBe(true);
    expect(wrapRows[0].effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "callTool-child", effect: "write", target: "lvis-plugin-x_inner_mut" }),
      ]),
    );
    // The inner tool's own shadow is also mutating.
    const innerRows = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_inner_mut");
    expect(innerRows[0].hasMutatingEffect).toBe(true);
  });

  it("the category shadow + effect shadow for ONE invocation share a correlationId", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makePluginTool("lvis-plugin-x_corr", [{ kind: "config.get", effect: "read", target: "k" }]),
    );
    await newExecutor(registry).executeAll(
      [{ id: "tu-corr", name: "lvis-plugin-x_corr", input: {} }],
      { sessionId: "sess-corr", permissionContext: userPermissionContext() },
    );
    const cat = shadowRows(auditDir, "risk-shadow").filter((r) => r.toolName === "lvis-plugin-x_corr");
    const eff = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_corr");
    expect(cat).toHaveLength(1);
    expect(eff).toHaveLength(1);
    // The id is present (non-empty) in BOTH emitted rows ...
    expect(typeof cat[0].correlationId).toBe("string");
    expect((cat[0].correlationId as string).length).toBeGreaterThan(0);
    // ... and identical, so the pre-exec category shadow and the post-exec effect
    // shadow JOIN on a single key.
    expect(cat[0].correlationId).toBe(eff[0].correlationId);
  });

  it("a plugin tool that mutates ONLY via ctx.storage.writeJson ⇒ hasMutatingEffect:true (not a confirmed read)", async () => {
    // Round-2 MAJOR regression — before the storage chokepoints were
    // instrumented, a plugin tool whose only side effect was a real
    // `storage.writeJson(...)` recorded `hostObservable:true, hasMutatingEffect:false`
    // = a CONFIRMED host-observed read, a fail-open seed for the future
    // read-recognition gate. This drives the REAL PluginStorage (not recordEffect)
    // so the instrumentation living inside the storage methods is exercised.
    const storageDir = mkdtempSync(join(tmpdir(), "lvis-eff-storage-"));
    try {
      const registry = new ToolRegistry();
      registry.register(
        createDynamicTool({
          name: "lvis-plugin-x_storage_mut",
          description: "plugin tool that mutates only via storage.writeJson",
          source: "plugin",
          pluginId: "lvis-plugin-x",
          category: "read",
          isReadOnly: () => true,
          jsonSchema: { type: "object", properties: {} },
          execute: async () => {
            // The ambient per-invocation ledger (bound by the executor) attributes
            // this storage write — the same AsyncLocalStorage mechanism the real
            // hostApi closures rely on.
            const storage = createPluginStorage("lvis-plugin-x", storageDir);
            await storage.writeJson("data.json", { mutated: true });
            return { output: "ok", isError: false };
          },
        }),
      );
      const results = await newExecutor(registry).executeAll(
        [{ id: "tu-storage", name: "lvis-plugin-x_storage_mut", input: {} }],
        { sessionId: "sess-storage", permissionContext: userPermissionContext() },
      );
      expect(results[0].is_error).toBeFalsy();

      const rows = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_storage_mut");
      expect(rows).toHaveLength(1);
      // hostObservable:true is now HONEST — the storage mutation was recorded.
      expect(rows[0].hostObservable).toBe(true);
      expect(rows[0].hasMutatingEffect).toBe(true);
      expect(rows[0].effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "storageWrite", effect: "write", target: "data.json" }),
        ]),
      );
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it("destructive clearAuthPartition-class chokepoint ⇒ hasMutatingEffect:true (not a confirmed read)", async () => {
    // Companion to the storage regression — proves the other newly instrumented
    // host-mediated mutating chokepoints flip the read/write bit too. Driven via
    // recordChokepoint (the exact call the hostApi closure makes) since
    // clearAuthPartition needs a live Electron session to drive end-to-end.
    const registry = new ToolRegistry();
    registry.register(
      createDynamicTool({
        name: "lvis-plugin-x_clearauth_mut",
        description: "declared-read plugin tool that wipes an auth partition",
        source: "plugin",
        pluginId: "lvis-plugin-x",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => {
          recordChokepoint("clearAuthPartition", "persist:plugin-auth:lvis-plugin-x");
          return { output: "ok", isError: false };
        },
      }),
    );
    await newExecutor(registry).executeAll(
      [{ id: "tu-clearauth", name: "lvis-plugin-x_clearauth_mut", input: {} }],
      { sessionId: "sess-clearauth", permissionContext: userPermissionContext() },
    );
    const rows = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_clearauth_mut");
    expect(rows).toHaveLength(1);
    expect(rows[0].hasMutatingEffect).toBe(true);
    expect(rows[0].effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "clearAuthPartition", effect: "write" }),
      ]),
    );
  });

  it("read-declared wrapper → REAL loopback invoker → mutating inner ⇒ outer hasMutatingEffect:true", async () => {
    // Round-2 MINOR 1 — the existing wrapper test calls `executorRef.executeAll`
    // DIRECTLY inside the wrapper's own (sync) async context, so it never
    // exercises the production `ctx.callTool` → loopback invoker path: a fresh
    // `runWithInvocationOrigin` async frame plus the indirection through the
    // invoker ref. If THAT frame ever broke the AsyncLocalStorage chain, the inner
    // `executeOne` would read `currentEffectLedger() === undefined`, the
    // callTool-child propagation would silently no-op (fail-permissive), and the
    // green directly-driven test would not catch it. This drives the real
    // indirection and couples origin-chain + effect-ledger propagation: the inner
    // tool asserts it still sees the propagated invocation origin AND the outer
    // ledger surfaces the delegated mutation.
    let innerObservedOrigin: InvocationOrigin | undefined;
    const registry = new ToolRegistry();
    registry.register(
      createDynamicTool({
        name: "lvis-plugin-x_inner_mut_real",
        description: "inner mutating tool reached through the real loopback invoker",
        source: "plugin",
        pluginId: "lvis-plugin-x",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => {
          // The SAME async chain carries BOTH the origin-chain frame and the
          // effect-ledger frame — capturing the origin here couples the two: if
          // the chain broke, this would be undefined AND the ledger propagation
          // below would fail.
          innerObservedOrigin = currentInvocationOrigin();
          recordEffect({ kind: "config.set", effect: "write", target: "k" });
          return { output: "inner-ok", isError: false };
        },
      }),
    );

    let executorRef!: ToolExecutor;

    // Faithful reproduction of boot.ts `invokePluginTool`: the REAL loopback
    // invoker enters a fresh `runWithInvocationOrigin` frame and re-enters the
    // SAME executor via executeAll.
    const invoker = async (
      toolName: string,
      payload: unknown,
      ctx: { origin: InvocationOrigin; parentOrigin?: InvocationOrigin },
    ): Promise<string> => {
      return runWithInvocationOrigin(ctx.origin, ctx.parentOrigin, async () => {
        const [result] = await executorRef.executeAll(
          [{ id: "tu-inner-real", name: toolName, input: (payload ?? {}) as Record<string, unknown> }],
          { sessionId: "sess-inner-real", permissionContext: userPermissionContext() },
        );
        if (!result) throw new Error("no inner result");
        if (result.is_error) throw new Error(result.content);
        return result.content;
      });
    };

    // Faithful reproduction of the hostApi.callTool closure (plugin-runtime.ts):
    // record the nested READ marker on the OUTER ledger, capture the parent
    // origin, then delegate through the real invoker.
    const ctxCallTool = async (toolName: string, payload?: unknown): Promise<string> => {
      recordChokepoint("callTool", toolName);
      const parentOrigin = currentInvocationOrigin();
      return invoker(toolName, payload, {
        origin: "plugin",
        ...(parentOrigin ? { parentOrigin } : {}),
      });
    };

    registry.register(
      createDynamicTool({
        name: "lvis-plugin-x_wrapper_real",
        description: "read-declared wrapper delegating a mutation via the REAL ctx.callTool path",
        source: "plugin",
        pluginId: "lvis-plugin-x",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => {
          await ctxCallTool("lvis-plugin-x_inner_mut_real", {});
          return { output: "ok", isError: false };
        },
      }),
    );
    executorRef = newExecutor(registry);
    await executorRef.executeAll(
      [{ id: "tu-wrap-real", name: "lvis-plugin-x_wrapper_real", input: {} }],
      { sessionId: "sess-wrap-real", permissionContext: userPermissionContext() },
    );

    // Origin-chain propagation survived the real invoker frame ...
    expect(innerObservedOrigin).toBe("plugin");
    // ... and so did effect-ledger propagation: the outer wrapper ledger surfaces
    // the delegated mutation through the same intact async chain.
    const wrapRows = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_wrapper_real");
    expect(wrapRows).toHaveLength(1);
    expect(wrapRows[0].hasMutatingEffect).toBe(true);
    expect(wrapRows[0].effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "callTool-child", effect: "write", target: "lvis-plugin-x_inner_mut_real" }),
      ]),
    );
    // The inner tool's own shadow is mutating too.
    const innerRows = effectShadowRows(auditDir).filter((r) => r.toolName === "lvis-plugin-x_inner_mut_real");
    expect(innerRows[0].hasMutatingEffect).toBe(true);
  });

  it("an external MCP invocation records hostObservable:false (not a confirmed read)", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createDynamicTool({
        name: "remote_mcp_tool",
        description: "external mcp tool — effects not host-mediated",
        source: "mcp",
        mcpServerId: "srv-x",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        // No recordEffect calls — an MCP tool runs out-of-process and never reaches
        // the instrumented host closures, so its ledger is empty.
        execute: async () => ({ output: "ok", isError: false }),
      }),
    );
    await newExecutor(registry).executeAll(
      [{ id: "tu-mcp", name: "remote_mcp_tool", input: {} }],
      { sessionId: "sess-mcp", permissionContext: userPermissionContext() },
    );
    const rows = effectShadowRows(auditDir).filter((r) => r.toolName === "remote_mcp_tool");
    expect(rows).toHaveLength(1);
    // An empty ledger alone is indistinguishable from a confirmed read; the
    // hostObservable:false marker is what lets a later read-recognition gate fail
    // CLOSED instead of auto-relaxing an unobservable MCP tool to read.
    expect(rows[0].hostObservable).toBe(false);
    expect(rows[0].hasMutatingEffect).toBe(false);
    expect(rows[0].effects).toEqual([]);
  });
});
