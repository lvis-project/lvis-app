/**
 * #885 (b4) — MCP↔plugin permission-parity REGRESSION LOCK.
 *
 * Locks the ratified reality that external MCP-server tools (`source:"mcp"`,
 * `mcp-tool-adapter.ts`) and in-process plugin loopback tools (`source:"plugin"`,
 * `plugin-tool-from-mcp.ts`) are registered into the one §6.4 ToolRegistry and
 * driven through the SINGLE `ToolExecutor.executeOne` pipeline, converging at the
 * same ordered chokepoints — Layer-1 deny, ApprovalGate, audit, effect-ledger —
 * so a future refactor cannot silently give the two sources divergent treatment.
 *
 * Harness reuse (no new harness invented):
 *   - reviewer/approval wiring from `executor-reviewer-explicit-retry.test.ts`
 *     (`makePermissionManager(dir, classifySpy)` + `setMode("auto")` +
 *     `setInteractiveAutoApprove("low")` + the mock `ApprovalGate`).
 *   - audit/effect-shadow reading from `executor-effect-ledger.test.ts`
 *     (`effectShadowRows(auditDir)` over the dedicated shadow channel; the
 *     "external MCP invocation records hostObservable:false" case is the direct
 *     precedent this generalizes into a PAIRED mcp-vs-plugin traversal).
 *   - HMAC permission-audit chain reading from `executor-audit-chain.test.ts`
 *     (`setupPermissionAuditChain` → `getPermissionAuditLogFile()`) for the
 *     layer/decision/category evidence.
 *
 * ── FINDING encoded here (see the "reviewer auto-approve lane is trust-gated"
 * case): the plan's u4 §1.2 assertion (2) expected `classify` to be called for
 * BOTH sources and the reviewer input to "differ ONLY in source". That is NOT the
 * post-a4 reality. `PermissionManager.categoryBasedDecision` short-circuits every
 * LOW-trust (MCP) invocation with a bare `ask` and NO `reviewer.route`
 * (`permission-manager.ts` — "LOW trust (MCP): always ask …"), so an MCP tool is
 * categorically EXCLUDED from the foreground-auto reviewer AUTO-APPROVE lane and
 * escalates DIRECTLY to the ApprovalGate, while a MEDIUM-trust plugin enters the
 * lane (classify runs) and, on a non-LOW verdict, escalates to the SAME gate.
 * This is the intended security consequence of the sanctioned trust-tier
 * divergence (a low-trust foreign peer is never auto-approved) — both sources
 * still CONVERGE at the ApprovalGate — but it is an input-DRIVEN path fork, not
 * the "input-only, identical path" the plan describes. The test locks the real
 * invariant (gate convergence + trust-gated lane) rather than forcing the plan's
 * inaccurate claim to pass.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLogger, type AuditEntry } from "../../audit/audit-logger.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor, type ToolCallMeta, type ToolExecutorCallbacks } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { makePermissionManager } from "./executor-reviewer-fixtures.js";

// ── Fixtures — two tools identical in name/schema/handler, differing ONLY in
//    source identity (the whole point: any pipeline-step difference must reduce
//    to the sanctioned source-identity inputs, nothing else). Registered in
//    SEPARATE registries (so the shared tool NAME never collides), driven by
//    separate executors that share ONE permission manager + ApprovalGate +
//    AuditLogger, so any divergence surfaces as an assertion delta.
const PROBE = "parity_probe";
const SCHEMA = { type: "object", properties: { payload: { type: "string" } } } as const;
const INPUT = { payload: "send release notice" } as const;
const SECRET = "aa".repeat(32);

function pluginRegistry(executeSpy: ReturnType<typeof vi.fn>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: PROBE,
    description: "network parity probe",
    source: "plugin",
    pluginId: "parity-plugin",
    category: "network",
    jsonSchema: SCHEMA,
    execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
  }));
  return registry;
}

function mcpRegistry(executeSpy: ReturnType<typeof vi.fn>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: PROBE,
    description: "network parity probe",
    source: "mcp",
    mcpServerId: "parity-srv",
    category: "network",
    jsonSchema: SCHEMA,
    execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
  }));
  return registry;
}

// ── Audit readers ────────────────────────────────────────────────────────────
/** All rows across `.jsonl` files in `dir` whose name ends with `suffix`. */
function rowsFromChannel(dir: string, suffix: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(suffix))) {
    for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return rows;
}

/** HMAC-chained permission-audit rows (decision / category / denyReasons[].layer). */
function permissionAuditRows(dir: string): Array<Record<string, unknown>> {
  return rowsFromChannel(dir, ".permission-audit.jsonl");
}

/** Telemetry `tool_call` rows (source / trust) — the trust-tier divergence lives here. */
function toolCallTelemetry(dir: string): Array<{ name: string; source?: string; trust?: string }> {
  const out: Array<{ name: string; source?: string; trust?: string }> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        continue;
      }
      if (entry.type !== "tool_call" || !entry.toolCalls) continue;
      for (const tc of entry.toolCalls) out.push({ name: tc.name, source: tc.source, trust: tc.trust });
    }
  }
  return out;
}

/** Effect-shadow rows — same reader shape as `executor-effect-ledger.test.ts`. */
function effectShadowRows(dir: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf-8").trim().split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as AuditEntry;
      const out = entry.output ?? "";
      if (out.includes("effect-shadow")) rows.push(JSON.parse(out) as Record<string, unknown>);
    }
  }
  return rows;
}

// ── Paired traversal driver ──────────────────────────────────────────────────
interface ParityRun {
  dir: string;
  auditDir: string;
  classifySpy: ReturnType<typeof vi.fn>;
  gate: { requestAndWait: ReturnType<typeof vi.fn> };
  pluginResult: { is_error?: boolean; content: string };
  mcpResult: { is_error?: boolean; content: string };
  pluginExecuted: ReturnType<typeof vi.fn>;
  mcpExecuted: ReturnType<typeof vi.fn>;
  metas: ToolCallMeta[];
  cleanup: () => void;
}

/** Run the SAME network probe as plugin and as mcp through ONE shared permission
 *  manager + ApprovalGate + AuditLogger. `deny` adds a source-agnostic Layer-1
 *  deny rule that must catch BOTH. */
async function runParityPair(opts: { deny?: boolean } = {}): Promise<ParityRun> {
  const dir = mkdtempSync(join(tmpdir(), "lvis-parity-"));
  const auditDir = mkdtempSync(join(tmpdir(), "lvis-parity-audit-"));

  const classifySpy = vi.fn(() => ({ level: "medium" as const, reason: "needs confirm" }));
  const permMgr = makePermissionManager(dir, classifySpy);
  permMgr.setMode("auto");
  if (opts.deny) await permMgr.addAlwaysDeniedPersist(PROBE);

  const gate = {
    requestAndWait: vi.fn(async (req: { id: string }) => ({ requestId: req.id, choice: "allow-once" as const })),
  };
  const auditLogger = new AuditLogger(auditDir);
  auditLogger.setupPermissionAuditChain(SECRET);

  const metas: ToolCallMeta[] = [];
  const callbacks: ToolExecutorCallbacks = {
    onToolEnd: (_name, _result, _isError, meta) => { metas.push(meta); },
  };

  const pluginExecuted = vi.fn(async () => "plugin-ok");
  const mcpExecuted = vi.fn(async () => "mcp-ok");

  const pluginExecutor = new ToolExecutor(
    pluginRegistry(pluginExecuted), undefined, permMgr, undefined, gate as never, undefined, auditLogger,
  );
  const mcpExecutor = new ToolExecutor(
    mcpRegistry(mcpExecuted), undefined, permMgr, undefined, gate as never, undefined, auditLogger,
  );

  const pluginResult = (await pluginExecutor.executeAll(
    [{ id: "tu-plugin", name: PROBE, input: { ...INPUT } }],
    { sessionId: "sess-plugin", permissionContext: { trustOrigin: "user-keyboard" }, callbacks },
  ))[0];
  const mcpResult = (await mcpExecutor.executeAll(
    [{ id: "tu-mcp", name: PROBE, input: { ...INPUT } }],
    { sessionId: "sess-mcp", permissionContext: { trustOrigin: "user-keyboard" }, callbacks },
  ))[0];

  return {
    dir, auditDir, classifySpy, gate, pluginResult, mcpResult,
    pluginExecuted, mcpExecuted, metas,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(auditDir, { recursive: true, force: true });
    },
  };
}

/** Gate-request subset that MUST be byte-identical across sources (everything
 *  except non-deterministic ids, the sanctioned `source`, and the reviewer-lane
 *  consequence fields `reviewerVerdict`/`reason`). */
function stableGateReq(req: Record<string, unknown>): Record<string, unknown> {
  const { source: _s, ...evaluationContext } = (req.evaluationContext ?? {}) as Record<string, unknown>;
  return {
    category: req.category,
    toolName: req.toolName,
    toolCategory: req.toolCategory,
    args: req.args,
    isReadOnly: req.isReadOnly,
    mode: req.mode,
    sensitivePathPattern: req.sensitivePathPattern,
    trustOrigin: req.trustOrigin,
    sandboxCapability: req.sandboxCapability,
    evaluationContext,
  };
}

describe("ToolExecutor MCP↔plugin permission parity (regression lock)", () => {
  // ── STEP 1 — Layer-1 deny: source-agnostic, short-circuits before reviewer +
  //    gate for BOTH. (u4 §1.2 assertion 1.)
  it("Layer-1 deny — both sources denied identically at layer 1 before any reviewer/gate step", async () => {
    const run = await runParityPair({ deny: true });
    try {
      // Both fail closed.
      expect(run.pluginResult.is_error).toBe(true);
      expect(run.mcpResult.is_error).toBe(true);

      // Evidence emitted only after the Layer-1 evaluation: the HMAC audit deny
      // rows. Exactly one deny per invocation, BOTH at layer 1, equal category.
      const denyRows = permissionAuditRows(run.auditDir).filter((r) => r.decision === "deny");
      expect(denyRows).toHaveLength(2);
      const bySource = (s: string) => denyRows.find((r) => r.source === s)!;
      const pluginDeny = bySource("plugin");
      const mcpDeny = bySource("mcp");
      expect(pluginDeny).toBeDefined();
      expect(mcpDeny).toBeDefined();
      for (const row of [pluginDeny, mcpDeny]) {
        expect((row.denyReasons as Array<{ layer: number }>)[0].layer).toBe(1);
        expect(row.category).toBe("network");
      }

      // Cardinality: Layer-1 deny precedes the reviewer + gate steps for BOTH,
      // so neither is reached and the tool never executes.
      expect(run.classifySpy).not.toHaveBeenCalled();
      expect(run.gate.requestAndWait).not.toHaveBeenCalled();
      expect(run.pluginExecuted).not.toHaveBeenCalled();
      expect(run.mcpExecuted).not.toHaveBeenCalled();
      expect(effectShadowRows(run.auditDir)).toHaveLength(0);
    } finally {
      run.cleanup();
    }
  });

  // ── STEP 3 — ApprovalGate: the TRUE shared chokepoint. Both sources converge
  //    at requestAndWait with a request that is byte-identical except the
  //    sanctioned `source` (+ its reviewer-lane consequence fields).
  //    (u4 §1.2 assertion 3.)
  it("approval gate — both sources converge at the identical ApprovalGate request except source", async () => {
    const run = await runParityPair();
    try {
      // Both approved (allow-once) → both executed.
      expect(run.pluginResult.is_error).toBeFalsy();
      expect(run.mcpResult.is_error).toBeFalsy();
      expect(run.pluginExecuted).toHaveBeenCalledTimes(1);
      expect(run.mcpExecuted).toHaveBeenCalledTimes(1);

      // Exactly one gate request per invocation — same cardinality.
      expect(run.gate.requestAndWait).toHaveBeenCalledTimes(2);
      const reqs = run.gate.requestAndWait.mock.calls.map((c) => c[0] as Record<string, unknown>);
      const pluginReq = reqs.find((r) => r.source === "plugin")!;
      const mcpReq = reqs.find((r) => r.source === "mcp")!;
      expect(pluginReq).toBeDefined();
      expect(mcpReq).toBeDefined();

      // The request the user sees is identical except the sanctioned source axis.
      expect(pluginReq.source).toBe("plugin");
      expect(mcpReq.source).toBe("mcp");
      expect(stableGateReq(pluginReq)).toEqual(stableGateReq(mcpReq));
      // ...and the ONLY residual difference in evaluationContext is `source`.
      expect((pluginReq.evaluationContext as Record<string, unknown>).source).toBe("plugin");
      expect((mcpReq.evaluationContext as Record<string, unknown>).source).toBe("mcp");

      // Sanctioned reviewer-lane CONSEQUENCE (see the trust-gated case): the
      // plugin request carries the reviewer verdict it earned in the auto-approve
      // lane; the MCP request never entered that lane, so it has none.
      expect(pluginReq.reviewerVerdict).toMatchObject({ level: "medium" });
      expect(mcpReq.reviewerVerdict).toBeUndefined();
    } finally {
      run.cleanup();
    }
  });

  // ── STEP 2 (CORRECTED) — reviewer AUTO-APPROVE lane is TRUST-GATED, not
  //    identical-for-both. Plugin (medium) enters it (classify runs); MCP (low)
  //    is categorically excluded and escalates straight to the gate. Both still
  //    converge at the gate (proved above). This locks the security property that
  //    an external low-trust MCP tool is NEVER silently auto-approved.
  //    (Supersedes the plan's u4 §1.2 assertion 2 — see file header FINDING.)
  it("reviewer auto-approve lane is trust-gated — plugin classified, MCP excluded, both still reach the gate", async () => {
    const run = await runParityPair();
    try {
      // classify fires for the plugin lane ONLY — never for the MCP lane.
      expect(run.classifySpy).toHaveBeenCalledTimes(1);
      const classifiedSources = run.classifySpy.mock.calls.map((c) => (c[0] as { source: string }).source);
      expect(classifiedSources).toEqual(["plugin"]);

      // The single plugin reviewer input carries the host-derived source-identity
      // inputs: `source:"plugin"` + `ownerPluginSandboxRoot` (the plugin's own
      // sandbox namespace root, host-COMPUTED from the trusted pluginId — NOT a
      // §1.2.1-enumerated field; see the file header). An MCP tool has no such
      // root, which is exactly why the low-trust lane is skipped.
      const pluginCtx = run.classifySpy.mock.calls[0][0] as Record<string, unknown>;
      expect(pluginCtx.source).toBe("plugin");
      expect(pluginCtx.category).toBe("network");
      expect(typeof pluginCtx.ownerPluginSandboxRoot).toBe("string");
      expect(pluginCtx.ownerPluginSandboxRoot as string).toContain("parity-plugin");

      // Convergence still holds: BOTH reached the gate (cardinality parity of the
      // shared chokepoint even though the pre-gate lane forks on trust).
      expect(run.gate.requestAndWait).toHaveBeenCalledTimes(2);
    } finally {
      run.cleanup();
    }
  });

  // ── STEPS 4 + 5 + 6 — audit + effect-ledger parity, and the FULL sanctioned
  //    divergence set. One audit row + one effect-shadow row per invocation;
  //    every difference reduces to the enumerated host-derived source-identity
  //    fields and nothing outside them. (u4 §1.2 assertions 4, 5, 6.)
  it("audit + effect-ledger — one row per invocation, diverging only in the sanctioned host-derived fields", async () => {
    const run = await runParityPair();
    try {
      // STEP 4 — permission-audit: exactly one ALLOW row per invocation, equal
      // decision + category shape, differing only in source.
      const allowRows = permissionAuditRows(run.auditDir).filter((r) => r.decision === "allow");
      expect(allowRows).toHaveLength(2);
      const auditBySource = (s: string) => allowRows.find((r) => r.source === s)!;
      expect(auditBySource("plugin")).toBeDefined();
      expect(auditBySource("mcp")).toBeDefined();
      for (const row of allowRows) {
        expect(row.decision).toBe("allow");
        expect(row.category).toBe("network");
      }

      // STEP 4 — sanctioned TRUST-TIER divergence (audited on every telemetry
      // row): plugin=medium, mcp=low.
      const telemetry = toolCallTelemetry(run.auditDir).filter((t) => t.name === PROBE);
      const pluginTel = telemetry.find((t) => t.source === "plugin")!;
      const mcpTel = telemetry.find((t) => t.source === "mcp")!;
      expect(pluginTel.trust).toBe("medium");
      expect(mcpTel.trust).toBe("low");

      // Sanctioned IDENTITY-FIELD divergence carried on `meta` (executor.ts
      // §meta assignment): pluginId vs mcpServerId, mutually exclusive.
      const metaBySource = (s: string) => run.metas.find((m) => m.source === s)!;
      const pluginMeta = metaBySource("plugin");
      const mcpMeta = metaBySource("mcp");
      expect(pluginMeta.pluginId).toBe("parity-plugin");
      expect(pluginMeta.mcpServerId).toBeUndefined();
      expect(mcpMeta.mcpServerId).toBe("parity-srv");
      expect(mcpMeta.pluginId).toBeUndefined();

      // STEP 5 — effect-ledger: exactly one effect-shadow row per invocation,
      // each with a non-empty correlationId. The rows differ ONLY in the
      // sanctioned fields: source, the identity field (pluginId present for the
      // plugin, absent for mcp), and effect observability (hostObservable
      // plugin=true / mcp=false). declaredCategory + hasMutatingEffect + effects
      // are EQUAL — same pipeline effect-boundary treatment.
      const shadows = effectShadowRows(run.auditDir).filter((r) => r.toolName === PROBE);
      expect(shadows).toHaveLength(2);
      const shadowBySource = (s: string) => shadows.find((r) => r.source === s)!;
      const pluginShadow = shadowBySource("plugin");
      const mcpShadow = shadowBySource("mcp");

      for (const row of [pluginShadow, mcpShadow]) {
        expect(typeof row.correlationId).toBe("string");
        expect((row.correlationId as string).length).toBeGreaterThan(0);
        expect(row.declaredCategory).toBe("network");
        expect(row.hasMutatingEffect).toBe(false);
        expect(row.effects).toEqual([]);
      }
      // Sanctioned effect-observability divergence.
      expect(pluginShadow.hostObservable).toBe(true);
      expect(mcpShadow.hostObservable).toBe(false);
      // Sanctioned identity divergence in the shadow record.
      expect(pluginShadow.pluginId).toBe("parity-plugin");
      expect(mcpShadow.pluginId).toBeUndefined();

      // STEP 6 — the divergence is EXACTLY the enumerated set and nothing else:
      // strip every sanctioned host-derived field and the two effect-shadow rows
      // are byte-identical.
      const stripSanctioned = (r: Record<string, unknown>): Record<string, unknown> => {
        const { source: _s, pluginId: _p, hostObservable: _h, correlationId: _c, ...rest } = r;
        return rest;
      };
      expect(stripSanctioned(pluginShadow)).toEqual(stripSanctioned(mcpShadow));
    } finally {
      run.cleanup();
    }
  });
});
