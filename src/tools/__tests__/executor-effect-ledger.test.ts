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
import type { ChokepointKind } from "../../permissions/effect-kind.js";

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
