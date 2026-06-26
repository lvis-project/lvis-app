/**
 * Executor → EffectLedger → audit-grade effect shadow (Phases 1-2, observability).
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
  effects: Array<{ kind: string; effect: "read" | "write"; target?: string }>,
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

function effectShadowRows(auditDir: string): Array<Record<string, unknown>> {
  const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  const rows: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of readFileSync(join(auditDir, f), "utf-8").trim().split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as AuditEntry;
      const out = entry.output ?? "";
      if (out.includes("effect-shadow")) rows.push(JSON.parse(out) as Record<string, unknown>);
    }
  }
  return rows;
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
});
