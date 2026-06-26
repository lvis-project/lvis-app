/**
 * Risk + effect shadow-log emission tests (host-classifies-risk shadow mode).
 *
 * The shadow log is the (plain, non-HMAC) shadow reconciliation dataset that
 * must pass before effect-boundary gating is enabled. These tests pin:
 *   (a) every CATEGORY emission carries the declared vs host-derived pair and
 *       a correctly derived `diverged` flag;
 *   (b) every EFFECT emission carries the declared category + host-observed
 *       effect summary + `hasMutatingEffect`;
 *   (c) both sink to the AuditLogger (queryable ~/.lvis/audit/*.jsonl), not
 *       process stdout;
 *   (d) both perform NO enforcement (pure side-effect — emission only);
 *   (e) the effect record actually lands in the audit file (temp LVIS_HOME).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitRiskShadowLog, emitEffectShadowLog } from "../reviewer/risk-shadow-log.js";
import { AuditLogger, type AuditEntry } from "../../audit/audit-logger.js";

function collectingAudit(): { entries: AuditEntry[]; logger: AuditLogger } {
  const entries: AuditEntry[] = [];
  // Only `.logShadow` (the DEDICATED shadow channel) is exercised by the shadow
  // path — a structural stand-in keeps the unit tests off the filesystem. A `log`
  // stub is included to PROVE the shadow path never touches the canonical
  // telemetry channel.
  const logger = {
    logShadow: (e: AuditEntry) => entries.push(e),
    log: () => {
      throw new Error("shadow path must use logShadow, not the canonical telemetry channel");
    },
  } as unknown as AuditLogger;
  return { entries, logger };
}

/** Parse the structured payload the shadow path packs into `output`. */
function payload(entry: AuditEntry): Record<string, unknown> {
  return JSON.parse(entry.output ?? "{}") as Record<string, unknown>;
}

describe("emitRiskShadowLog — category shadow", () => {
  it("emits the declared vs host-derived pair with diverged=false when equal", () => {
    const { entries, logger } = collectingAudit();
    emitRiskShadowLog(
      {
        toolName: "files_read",
        source: "plugin",
        pluginId: "lvis-plugin-x",
        declaredCategory: "read",
        hostDerivedCategory: "read",
        enforced: false,
        correlationId: "corr-cat-1",
      },
      logger,
    );
    expect(entries).toHaveLength(1);
    expect(payload(entries[0])).toMatchObject({
      event: "risk-shadow",
      toolName: "files_read",
      source: "plugin",
      pluginId: "lvis-plugin-x",
      declaredCategory: "read",
      hostDerivedCategory: "read",
      diverged: false,
      enforced: false,
      correlationId: "corr-cat-1",
    });
  });

  it("sets diverged=true when declared and host-derived disagree", () => {
    const { entries, logger } = collectingAudit();
    emitRiskShadowLog(
      {
        toolName: "rogue_tool",
        source: "plugin",
        declaredCategory: "read",
        hostDerivedCategory: "write",
        enforced: false,
        correlationId: "corr-cat-2",
      },
      logger,
    );
    const p = payload(entries[0]);
    expect(p.diverged).toBe(true);
    expect(p.declaredCategory).toBe("read");
    expect(p.hostDerivedCategory).toBe("write");
  });

  it("omits pluginId when absent (builtin/mcp tools)", () => {
    const { entries, logger } = collectingAudit();
    emitRiskShadowLog(
      {
        toolName: "bash",
        source: "builtin",
        declaredCategory: "shell",
        hostDerivedCategory: "shell",
        enforced: true,
        correlationId: "corr-cat-3",
      },
      logger,
    );
    const p = payload(entries[0]);
    expect("pluginId" in p).toBe(false);
    expect(p.enforced).toBe(true);
  });

  it("returns void — it is a pure side-effect sink that cannot alter a decision", () => {
    const { logger } = collectingAudit();
    const result = emitRiskShadowLog(
      { toolName: "t", source: "mcp", declaredCategory: "network", hostDerivedCategory: "network", enforced: false, correlationId: "corr-cat-4" },
      logger,
    );
    expect(result).toBeUndefined();
  });
});

describe("emitEffectShadowLog — effect shadow", () => {
  it("records a read-only invocation as hasMutatingEffect=false", () => {
    const { entries, logger } = collectingAudit();
    emitEffectShadowLog(
      {
        toolName: "lvis-plugin-x_read",
        source: "plugin",
        pluginId: "lvis-plugin-x",
        declaredCategory: "read",
        hostObservable: true,
        hostObservedEffect: {
          correlationId: "corr-eff-1",
          hasMutatingEffect: false,
          effects: [{ kind: "config.get", effect: "read", target: "k" }],
        },
      },
      logger,
    );
    expect(payload(entries[0])).toMatchObject({
      event: "effect-shadow",
      toolName: "lvis-plugin-x_read",
      source: "plugin",
      pluginId: "lvis-plugin-x",
      declaredCategory: "read",
      hostObservable: true,
      hasMutatingEffect: false,
      correlationId: "corr-eff-1",
    });
  });

  it("records hostObservable=false for an external MCP tool with an empty ledger (NOT a confirmed read)", () => {
    const { entries, logger } = collectingAudit();
    emitEffectShadowLog(
      {
        toolName: "remote_mcp_tool",
        source: "mcp",
        declaredCategory: "read",
        hostObservable: false,
        hostObservedEffect: {
          correlationId: "corr-eff-mcp",
          hasMutatingEffect: false,
          effects: [],
        },
      },
      logger,
    );
    const p = payload(entries[0]);
    // Empty ledger + hostObservable:false ⇒ a later read-recognition gate must
    // NOT auto-relax this to read; it must fail closed.
    expect(p.hostObservable).toBe(false);
    expect(p.hasMutatingEffect).toBe(false);
    expect(p.effects).toEqual([]);
  });

  it("records a mutating invocation as hasMutatingEffect=true with the effects list", () => {
    const { entries, logger } = collectingAudit();
    emitEffectShadowLog(
      {
        toolName: "lvis-plugin-x_write",
        source: "plugin",
        pluginId: "lvis-plugin-x",
        declaredCategory: "read",
        hostObservable: true,
        hostObservedEffect: {
          correlationId: "corr-eff-2",
          hasMutatingEffect: true,
          effects: [
            { kind: "config.set", effect: "write", target: "k" },
            { kind: "hostFetch", effect: "write", target: "https://api.example.com" },
          ],
        },
      },
      logger,
    );
    const p = payload(entries[0]);
    expect(p.hasMutatingEffect).toBe(true);
    expect(p.correlationId).toBe("corr-eff-2");
    expect(p.effects).toEqual([
      { kind: "config.set", effect: "write", target: "k" },
      { kind: "hostFetch", effect: "write", target: "https://api.example.com" },
    ]);
  });
});

describe("shadow log — dedicated shadow channel sink (temp LVIS_HOME)", () => {
  let auditDir: string;
  afterEach(() => {
    if (auditDir) rmSync(auditDir, { recursive: true, force: true });
  });

  it("lands the effect record in the DEDICATED permission-shadow channel, NOT the telemetry channel", () => {
    auditDir = mkdtempSync(join(tmpdir(), "lvis-shadow-audit-"));
    const logger = new AuditLogger(auditDir);
    // Write a real telemetry row first so we can prove channel separation.
    logger.log({ timestamp: new Date().toISOString(), sessionId: "s", type: "turn", input: "hi", output: "yo" });
    emitEffectShadowLog(
      {
        toolName: "lvis-plugin-x_write",
        source: "plugin",
        pluginId: "lvis-plugin-x",
        declaredCategory: "read",
        hostObservable: true,
        hostObservedEffect: {
          correlationId: "corr-sink",
          hasMutatingEffect: true,
          effects: [{ kind: "config.set", effect: "write", target: "k" }],
        },
      },
      logger,
    );
    // The shadow record lands in `<date>.permission-shadow.jsonl`.
    const shadowFiles = readdirSync(auditDir).filter((f) => f.endsWith(".permission-shadow.jsonl"));
    expect(shadowFiles.length).toBe(1);
    const shadowLines = readFileSync(join(auditDir, shadowFiles[0]), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AuditEntry);
    const effectRow = shadowLines.find((e) => (e.output ?? "").includes("effect-shadow"));
    expect(effectRow).toBeDefined();
    const p = payload(effectRow!);
    expect(p.event).toBe("effect-shadow");
    expect(p.hasMutatingEffect).toBe(true);
    expect(p.pluginId).toBe("lvis-plugin-x");
    expect(p.correlationId).toBe("corr-sink");

    // The canonical telemetry channel (`<date>.jsonl`, NO channel infix) holds
    // ONLY the turn telemetry — no shadow pollution.
    const telemetryFiles = readdirSync(auditDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    expect(telemetryFiles.length).toBe(1);
    const telemetryText = readFileSync(join(auditDir, telemetryFiles[0]), "utf-8");
    expect(telemetryText).not.toContain("effect-shadow");
    expect(telemetryText).toContain("\"type\":\"turn\"");
  });
});
