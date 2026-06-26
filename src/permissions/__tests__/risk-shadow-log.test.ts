/**
 * Risk + effect shadow-log emission tests (host-classifies-risk shadow mode).
 *
 * The shadow log is the audit-grade reconciliation dataset that must pass
 * before effect-boundary gating is enabled. These tests pin:
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
  // Only `.log` is exercised by the shadow path — a structural stand-in keeps
  // the unit tests off the filesystem.
  const logger = { log: (e: AuditEntry) => entries.push(e) } as unknown as AuditLogger;
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
      { toolName: "t", source: "mcp", declaredCategory: "network", hostDerivedCategory: "network", enforced: false },
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
        hostObservedEffect: {
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
      hasMutatingEffect: false,
    });
  });

  it("records a mutating invocation as hasMutatingEffect=true with the effects list", () => {
    const { entries, logger } = collectingAudit();
    emitEffectShadowLog(
      {
        toolName: "lvis-plugin-x_write",
        source: "plugin",
        pluginId: "lvis-plugin-x",
        declaredCategory: "read",
        hostObservedEffect: {
          hasMutatingEffect: true,
          effects: [
            { kind: "config.set", effect: "write", target: "k" },
            { kind: "hostFetch", effect: "write", target: "api.example.com/x" },
          ],
        },
      },
      logger,
    );
    const p = payload(entries[0]);
    expect(p.hasMutatingEffect).toBe(true);
    expect(p.effects).toEqual([
      { kind: "config.set", effect: "write", target: "k" },
      { kind: "hostFetch", effect: "write", target: "api.example.com/x" },
    ]);
  });
});

describe("shadow log — audit-grade sink (temp LVIS_HOME)", () => {
  let auditDir: string;
  afterEach(() => {
    if (auditDir) rmSync(auditDir, { recursive: true, force: true });
  });

  it("lands the effect summary record in a JSONL audit file", () => {
    auditDir = mkdtempSync(join(tmpdir(), "lvis-shadow-audit-"));
    const logger = new AuditLogger(auditDir);
    emitEffectShadowLog(
      {
        toolName: "lvis-plugin-x_write",
        source: "plugin",
        pluginId: "lvis-plugin-x",
        declaredCategory: "read",
        hostObservedEffect: {
          hasMutatingEffect: true,
          effects: [{ kind: "config.set", effect: "write", target: "k" }],
        },
      },
      logger,
    );
    const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    const lines = readFileSync(join(auditDir, files[0]), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AuditEntry);
    const effectRow = lines.find((e) => (e.output ?? "").includes("effect-shadow"));
    expect(effectRow).toBeDefined();
    const p = payload(effectRow!);
    expect(p.event).toBe("effect-shadow");
    expect(p.hasMutatingEffect).toBe(true);
    expect(p.pluginId).toBe("lvis-plugin-x");
  });
});
