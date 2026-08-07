/**
 * Producer-driven pin for the host-risk category channel.
 *
 * `inspectHostRisk` is a CONSUMER: something else builds its `HostRiskSignals`
 * and something else uses the `ToolCategory` it returns. Its own unit tests hand
 * it a literal, so they stay green even if no production path ever calls it —
 * which is exactly how the signals it used to accept (`pathFields`,
 * `allowedDirectories`) sat inert until the containment answer they fed was
 * found to be discarded.
 *
 * This file therefore drives the REAL producer, `resolveEnforcedCategory`, with
 * a `Tool` built by the REAL production adapter (`mcpToolToPluginTool`, the
 * plugin-loopback reverse projection) and asserts the consumer's output on the
 * far side. The load-bearing case picks an input where the host-derived category
 * DIFFERS from the declared one, so the assertion is satisfiable only if the
 * producer actually reached the inspector — deleting the `inspectHostRisk(...)`
 * call site turns it red rather than leaving it green.
 */
import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AuditEntry, AuditLogger } from "../../../audit/audit-logger.js";
import { mcpToolToPluginTool } from "../../../mcp/plugin-tool-from-mcp.js";
import { resolveEnforcedCategory } from "../risk-classification.js";

const TMP = realpathSync(tmpdir());

/**
 * Capture the shadow channel. The AuditLogger is injected into
 * `resolveEnforcedCategory` by design (the module owns no global state), so a
 * capturing sink observes the real record without a temp LVIS_HOME or a write
 * queue to drain.
 */
function shadowSink(): { logger: AuditLogger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const logger = {
    logShadow(entry: AuditEntry): void {
      records.push(JSON.parse(entry.output ?? "{}") as Record<string, unknown>);
    },
  } as unknown as AuditLogger;
  return { logger, records };
}

/**
 * A plugin tool as PRODUCTION builds it: `mcpToolToPluginTool` is the loopback
 * reverse projection every first-party plugin tool goes through, so `source`,
 * `category` and `pathFields` here are the values the real registry holds — not
 * a combination hand-picked to make an assertion pass.
 */
function productionPluginTool() {
  return mcpToolToPluginTool(
    "lvis-plugin-fixture",
    {
      name: "fixture_run",
      description: "fixture plugin tool",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      _meta: {
        "lvisai/pathFields": ["path"],
        ui: { visibility: ["model"] },
      },
    },
    async () => ({ text: "ok" }),
  );
}

describe("resolveEnforcedCategory — producer → inspectHostRisk → enforced category", () => {
  it("the production adapter declares the write baseline the inspector must re-derive", () => {
    const tool = productionPluginTool();
    expect(tool.source).toBe("plugin");
    expect(tool.category).toBe("write");
  });

  it("enforces the HOST-derived category, not the declared one", () => {
    const { logger, records } = shadowSink();
    const tool = productionPluginTool();

    const enforced = resolveEnforcedCategory({
      tool,
      declaredCategory: tool.category,
      finalInput: { command: "ls -la /tmp" },
      correlationId: "corr-read",
      hostClassifiesRisk: true,
      auditLogger: logger,
    });

    // Declared is "write"; only a real call into the inspector yields "read".
    expect(enforced).toBe("read");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      toolName: "fixture_run",
      source: "plugin",
      declaredCategory: "write",
      hostDerivedCategory: "read",
      diverged: true,
      enforced: true,
    });
  });

  it("still shadow-logs the host-derived category when enforcement is off", () => {
    const { logger, records } = shadowSink();
    const tool = productionPluginTool();

    const enforced = resolveEnforcedCategory({
      tool,
      declaredCategory: tool.category,
      finalInput: { command: "ls -la /tmp" },
      correlationId: "corr-shadow",
      hostClassifiesRisk: false,
      auditLogger: logger,
    });

    expect(enforced).toBe("write"); // declared wins when the flag is off
    expect(records[0]).toMatchObject({ hostDerivedCategory: "read", enforced: false });
  });

  it("keeps every filesystem-shaped call write-equivalent without a scope input", () => {
    // These are the two inputs the removed containment branch existed to tell
    // apart: one escaping any plausible Layer-1 scope, one inside the workspace.
    // Both were "write" before the branch was deleted and both are "write" now —
    // that equivalence is the whole behavioural claim of this change.
    const { logger, records } = shadowSink();
    const tool = productionPluginTool();

    for (const [correlationId, path] of [
      ["corr-escape", "/etc/passwd"],
      ["corr-inside", `${TMP}/workspace/note.md`],
    ] as const) {
      expect(
        resolveEnforcedCategory({
          tool,
          declaredCategory: tool.category,
          finalInput: { path },
          correlationId,
          hostClassifiesRisk: true,
          auditLogger: logger,
        }),
      ).toBe("write");
    }

    expect(records.map((r) => r.hostDerivedCategory)).toEqual(["write", "write"]);
    expect(records.map((r) => r.diverged)).toEqual([false, false]);
  });

  it("classifies a foreign MCP peer as network through the producer", () => {
    const { logger, records } = shadowSink();
    const tool = { ...productionPluginTool(), source: "mcp" as const };

    const enforced = resolveEnforcedCategory({
      tool,
      declaredCategory: "write",
      finalInput: { command: "ls -la /tmp" },
      correlationId: "corr-mcp",
      hostClassifiesRisk: true,
      auditLogger: logger,
    });

    // Foreign peers never classify DOWN on the strength of their args.
    expect(enforced).toBe("network");
    expect(records[0]).toMatchObject({ hostDerivedCategory: "network", diverged: true });
  });
});
