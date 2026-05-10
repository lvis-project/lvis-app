/**
 * `/permission audit` + top-level slash dispatcher tests.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 7,
 * §3 Layer 8.
 *
 * Coverage:
 *   - parsePermissionAuditCommand: show / verify / --last variants.
 *   - parsePermissionModeCommand: durable flag + invalid mode.
 *   - parsePermissionHooksCommand: list / accept / disable.
 *   - dispatchPermissionSlash: trust-origin gate (user-keyboard vs other),
 *     leading-slash strip on plugin-emitted, durable mode → needsModal.
 *   - readRecentAuditEntries: returns newest-first across files.
 *   - verifyAllAuditFiles: detects tamper + seal mismatch.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchPermissionSlash,
  parsePermissionAuditCommand,
  parsePermissionHooksCommand,
  parsePermissionModeCommand,
  parsePermissionRulesCommand,
  stripLeadingSlash,
} from "../permission-slash.js";
import {
  readRecentAuditEntries,
  summarizeAuditDir,
  verifyAllAuditFiles,
} from "../permission-audit-runner.js";
import {
  buildChainedEntries,
  MemorySecretStore,
  sealDayFromFile,
} from "../../audit/hmac-chain.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "lvis-perm-slash-audit-"));
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe("parsePermissionAuditCommand", () => {
  it("parses 'show' with default last=50", () => {
    expect(parsePermissionAuditCommand("show")).toEqual({ verb: "show", last: 50 });
  });

  it("parses 'show --last=100'", () => {
    expect(parsePermissionAuditCommand("show --last=100")).toEqual({
      verb: "show",
      last: 100,
    });
  });

  it("clamps --last to 1000", () => {
    expect(parsePermissionAuditCommand("show --last=99999")).toEqual({
      verb: "show",
      last: 1000,
    });
  });

  it("rejects --last=0 and negative values", () => {
    expect(parsePermissionAuditCommand("show --last=0")).toMatchObject({ ok: false });
    expect(parsePermissionAuditCommand("show --last=-5")).toMatchObject({ ok: false });
  });

  it("parses 'verify'", () => {
    expect(parsePermissionAuditCommand("verify")).toEqual({ verb: "verify", last: 50 });
  });

  it("rejects 'verify --last=10' (--last only valid for show)", () => {
    expect(parsePermissionAuditCommand("verify --last=10")).toMatchObject({ ok: false });
  });

  it("rejects unknown subcommand", () => {
    expect(parsePermissionAuditCommand("dump")).toMatchObject({ ok: false });
  });

  it("rejects unknown flag", () => {
    expect(parsePermissionAuditCommand("show --foo=bar")).toMatchObject({ ok: false });
  });
});

describe("parsePermissionModeCommand", () => {
  it("parses 'strict'", () => {
    expect(parsePermissionModeCommand("strict")).toEqual({
      verb: "mode",
      mode: "strict",
      durable: false,
    });
  });

  it("parses 'auto --durable'", () => {
    expect(parsePermissionModeCommand("auto --durable")).toEqual({
      verb: "mode",
      mode: "auto",
      durable: true,
    });
  });

  it("rejects invalid mode", () => {
    expect(parsePermissionModeCommand("yolo")).toMatchObject({ ok: false });
  });

  it("rejects extra arguments", () => {
    expect(parsePermissionModeCommand("auto extra")).toMatchObject({ ok: false });
  });

  it("rejects empty input", () => {
    expect(parsePermissionModeCommand("")).toMatchObject({ ok: false });
  });
});

describe("parsePermissionHooksCommand", () => {
  it("parses 'list'", () => {
    expect(parsePermissionHooksCommand("list")).toEqual({ verb: "hooks", sub: "list" });
  });

  it("parses 'accept pre-foo.sh'", () => {
    expect(parsePermissionHooksCommand("accept pre-foo.sh")).toEqual({
      verb: "hooks",
      sub: "accept",
      name: "pre-foo.sh",
    });
  });

  it("parses 'disable pre-foo.sh'", () => {
    expect(parsePermissionHooksCommand("disable pre-foo.sh")).toEqual({
      verb: "hooks",
      sub: "disable",
      name: "pre-foo.sh",
    });
  });

  it("parses 'reject pre-foo.sh' (architect ③ — destructive expunge)", () => {
    expect(parsePermissionHooksCommand("reject pre-foo.sh")).toEqual({
      verb: "hooks",
      sub: "reject",
      name: "pre-foo.sh",
    });
  });

  it("rejects 'accept' without name", () => {
    expect(parsePermissionHooksCommand("accept")).toMatchObject({ ok: false });
  });

  it("rejects 'reject' without name", () => {
    expect(parsePermissionHooksCommand("reject")).toMatchObject({ ok: false });
  });

  it("rejects unknown subcommand with the verb hint listing reject", () => {
    const result = parsePermissionHooksCommand("yolo pre-foo.sh");
    expect(result).toMatchObject({ ok: false });
    if ("error" in result) {
      expect(result.error).toMatch(/list\|accept\|disable\|reject/);
    }
  });
});

describe("parsePermissionRulesCommand", () => {
  it("parses 'list'", () => {
    expect(parsePermissionRulesCommand("list")).toEqual({ verb: "rules", sub: "list" });
  });
  it("parses add/remove rule commands", () => {
    expect(parsePermissionRulesCommand("add allow bash:*")).toEqual({
      verb: "rules",
      sub: "add",
      action: "allow",
      pattern: "bash:*",
    });
    expect(parsePermissionRulesCommand("remove deny mcp_*")).toEqual({
      verb: "rules",
      sub: "remove",
      action: "deny",
      pattern: "mcp_*",
    });
  });
  it("rejects extra args", () => {
    expect(parsePermissionRulesCommand("list foo")).toMatchObject({ ok: false });
  });
});

describe("stripLeadingSlash", () => {
  it("strips a single leading slash", () => {
    expect(stripLeadingSlash("/permission auto")).toBe("permission auto");
  });
  it("preserves leading whitespace while stripping command slash", () => {
    expect(stripLeadingSlash("   /compact")).toBe("   compact");
  });
  it("strips every consecutive leading slash after whitespace", () => {
    expect(stripLeadingSlash("   //permission hooks accept pre-x.sh")).toBe(
      "   permission hooks accept pre-x.sh",
    );
  });
  it("strips slash chains separated by whitespace until trimmed text is non-command", () => {
    expect(stripLeadingSlash("/ /permission hooks accept pre-x.sh")).toBe(
      "permission hooks accept pre-x.sh",
    );
    expect(stripLeadingSlash("   /   /compact")).toBe("   compact");
  });
  it("does not affect non-slash input", () => {
    expect(stripLeadingSlash("hello")).toBe("hello");
  });
  it("strips leading slash from path-like non-user-origin text", () => {
    expect(stripLeadingSlash("/path/to/x")).toBe("path/to/x");
  });
});

describe("dispatchPermissionSlash — trust origin gate", () => {
  it("rejects plugin-emitted slash with leading-slash strip (security C2 fix)", () => {
    const result = dispatchPermissionSlash("/permission auto --durable", "plugin-emitted");
    expect(result).toEqual({
      kind: "rejected-non-user-origin",
      sanitized: "permission auto --durable",
    });
  });

  it("rejects llm-tool-arg origin", () => {
    const result = dispatchPermissionSlash("/permission auto", "llm-tool-arg");
    expect(result.kind).toBe("rejected-non-user-origin");
  });

  it("rejects file-content origin (LLM-fed file content)", () => {
    const result = dispatchPermissionSlash("/permission strict", "file-content");
    expect(result.kind).toBe("rejected-non-user-origin");
  });

  it("rejects unknown origin (fail-closed)", () => {
    const result = dispatchPermissionSlash("/permission auto", "unknown");
    expect(result.kind).toBe("rejected-non-user-origin");
  });

  it("accepts user-keyboard origin", () => {
    const result = dispatchPermissionSlash("/permission audit show", "user-keyboard");
    expect(result.kind).toBe("audit");
  });
});

describe("dispatchPermissionSlash — subcommand routing", () => {
  it("'/permission' alone → show-current", () => {
    const result = dispatchPermissionSlash("/permission", "user-keyboard");
    expect(result).toEqual({ kind: "show-current", needsModal: false });
  });

  it("routes 'audit show'", () => {
    const result = dispatchPermissionSlash(
      "/permission audit show --last=20",
      "user-keyboard",
    );
    expect(result).toMatchObject({ kind: "audit" });
    if (result.kind === "audit") {
      expect(result.cmd).toEqual({ verb: "show", last: 20 });
    }
  });

  it("routes 'audit verify'", () => {
    const result = dispatchPermissionSlash("/permission audit verify", "user-keyboard");
    expect(result).toMatchObject({ kind: "audit" });
    if (result.kind === "audit") {
      expect(result.cmd.verb).toBe("verify");
    }
  });

  it("routes 'dir allow /tmp/foo'", () => {
    const result = dispatchPermissionSlash(
      "/permission dir allow /tmp/foo",
      "user-keyboard",
    );
    expect(result).toMatchObject({ kind: "dir" });
  });

  it("routes 'reviewer mode rule'", () => {
    const result = dispatchPermissionSlash(
      "/permission reviewer mode rule",
      "user-keyboard",
    );
    expect(result).toMatchObject({ kind: "reviewer" });
  });

  it("routes 'mode auto --durable' with needsModal=true", () => {
    const result = dispatchPermissionSlash(
      "/permission mode auto --durable",
      "user-keyboard",
    );
    expect(result).toMatchObject({ kind: "mode", needsModal: true });
  });

  it("routes 'mode auto' (session) with needsModal=false", () => {
    const result = dispatchPermissionSlash("/permission mode auto", "user-keyboard");
    expect(result).toMatchObject({ kind: "mode", needsModal: false });
  });

  it("routes 'hooks accept foo.sh' with needsModal=false (typed TOFU approval)", () => {
    const result = dispatchPermissionSlash(
      "/permission hooks accept pre-foo.sh",
      "user-keyboard",
    );
    expect(result).toMatchObject({ kind: "hooks", needsModal: false });
  });

  it("routes 'hooks list' with needsModal=false", () => {
    const result = dispatchPermissionSlash("/permission hooks list", "user-keyboard");
    expect(result).toMatchObject({ kind: "hooks", needsModal: false });
  });

  it("routes 'hooks reject foo.sh' (architect ③ — destructive expunge from .disabled/)", () => {
    const result = dispatchPermissionSlash(
      "/permission hooks reject pre-foo.sh",
      "user-keyboard",
    );
    expect(result).toMatchObject({ kind: "hooks", needsModal: false });
    if (result.kind === "hooks") {
      expect(result.cmd).toEqual({ verb: "hooks", sub: "reject", name: "pre-foo.sh" });
    }
  });

  it("rejects 'hooks accept' from plugin-emitted origin (architect ④ — origin gate test)", () => {
    const result = dispatchPermissionSlash(
      "/permission hooks accept pre-foo.sh",
      "plugin-emitted",
    );
    expect(result).toEqual({
      kind: "rejected-non-user-origin",
      sanitized: "permission hooks accept pre-foo.sh",
    });
  });

  it("rejects 'hooks reject' from llm-tool-arg origin (architect ④ — origin gate)", () => {
    const result = dispatchPermissionSlash(
      "/permission hooks reject pre-foo.sh",
      "llm-tool-arg",
    );
    expect(result.kind).toBe("rejected-non-user-origin");
  });

  it("routes 'rules list' with needsModal=false", () => {
    const result = dispatchPermissionSlash("/permission rules list", "user-keyboard");
    expect(result).toMatchObject({ kind: "rules", needsModal: false });
  });

  it("routes 'rules add' through the same slash origin gate", () => {
    const result = dispatchPermissionSlash("/permission rules add allow bash:*", "user-keyboard");
    expect(result).toMatchObject({
      kind: "rules",
      needsModal: false,
      cmd: { sub: "add", action: "allow", pattern: "bash:*" },
    });
  });

  it("rejects unknown subcommand with parse-error", () => {
    const result = dispatchPermissionSlash("/permission yolo", "user-keyboard");
    expect(result.kind).toBe("parse-error");
  });

  it("rejects malformed grammar (no space after /permission)", () => {
    const result = dispatchPermissionSlash("/permissionFOO", "user-keyboard");
    expect(result.kind).toBe("parse-error");
  });
});

describe("readRecentAuditEntries", () => {
  it("returns empty array when audit dir is missing", () => {
    expect(readRecentAuditEntries(join(workDir, "missing"), 10)).toEqual([]);
  });

  it("returns entries newest-first across files", () => {
    const auditDir = join(workDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const secret = "aa".repeat(32);
    const day1 = buildChainedEntries(secret, [
      { decision: "allow", auditId: "d1-a", ts: "2026-05-08T00:00:00Z", trustOrigin: "user-keyboard", tool: "t1" },
      { decision: "allow", auditId: "d1-b", ts: "2026-05-08T00:00:01Z", trustOrigin: "user-keyboard", tool: "t2" },
    ]);
    const day2 = buildChainedEntries(secret, [
      { decision: "allow", auditId: "d2-a", ts: "2026-05-09T00:00:00Z", trustOrigin: "user-keyboard", tool: "t3" },
    ]);
    writeFileSync(
      join(auditDir, "2026-05-08.permission-audit.jsonl"),
      day1.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    writeFileSync(
      join(auditDir, "2026-05-09.permission-audit.jsonl"),
      day2.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const result = readRecentAuditEntries(auditDir, 10);
    expect(result.map((e) => (e as { auditId: string }).auditId)).toEqual([
      "d2-a", "d1-b", "d1-a",
    ]);
  });

  it("respects the limit parameter", () => {
    const auditDir = join(workDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const secret = "aa".repeat(32);
    const day = buildChainedEntries(secret, [
      { decision: "allow", auditId: "1", ts: "t1", trustOrigin: "user-keyboard", tool: "a" },
      { decision: "allow", auditId: "2", ts: "t2", trustOrigin: "user-keyboard", tool: "b" },
      { decision: "allow", auditId: "3", ts: "t3", trustOrigin: "user-keyboard", tool: "c" },
    ]);
    writeFileSync(
      join(auditDir, "2026-05-09.permission-audit.jsonl"),
      day.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const result = readRecentAuditEntries(auditDir, 2);
    expect(result.length).toBe(2);
    expect(result.map((e) => (e as { auditId: string }).auditId)).toEqual(["3", "2"]);
  });

  it("ignores legacy non-permission audit lines (no `decision` field)", () => {
    const auditDir = join(workDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      join(auditDir, "2026-05-09.permission-audit.jsonl"),
      [
        JSON.stringify({ type: "turn", sessionId: "s1" }),
        JSON.stringify({ decision: "allow", auditId: "x1", ts: "t", trustOrigin: "user-keyboard", tool: "a", source: "builtin", category: "read", directory: "/tmp", directoryAllowed: true, layer: 1, prevHash: "h" }),
      ].join("\n") + "\n",
    );
    const result = readRecentAuditEntries(auditDir, 10);
    expect(result.length).toBe(1);
    expect((result[0] as { decision: string }).decision).toBe("allow");
  });
});

describe("verifyAllAuditFiles", () => {
  it("intact=true on a clean chain + matching seal", () => {
    const auditDir = join(workDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const secret = "bb".repeat(32);
    const sealStore = new MemorySecretStore();
    const entries = buildChainedEntries(secret, [
      { decision: "allow", auditId: "1", ts: "t1", trustOrigin: "user-keyboard", tool: "a" },
      { decision: "deny", auditId: "2", ts: "t2", trustOrigin: "user-keyboard", tool: "b" },
    ]);
    const file = join(auditDir, "2026-05-09.permission-audit.jsonl");
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    sealDayFromFile(secret, sealStore, file, "2026-05-09");

    const result = verifyAllAuditFiles(auditDir, secret, sealStore);
    expect(result.intact).toBe(true);
    expect(result.totalFiles).toBe(1);
    expect(result.totalEntries).toBe(2);
    expect(result.perDay[0].sealMatch).toBe(true);
  });

  it("intact=false + reports first broken line on tamper", () => {
    const auditDir = join(workDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const secret = "bb".repeat(32);
    const entries = buildChainedEntries(secret, [
      { decision: "allow", auditId: "1", ts: "t1", trustOrigin: "user-keyboard", tool: "a" },
      { decision: "deny", auditId: "2", ts: "t2", trustOrigin: "user-keyboard", tool: "b" },
      { decision: "ask", auditId: "3", ts: "t3", trustOrigin: "user-keyboard", tool: "c" },
    ]);
    const lines = entries.map((e) => JSON.stringify(e));
    // Tamper line 1
    const obj = JSON.parse(lines[1]) as { tool: string };
    obj.tool = "TAMPERED";
    lines[1] = JSON.stringify(obj);
    const file = join(auditDir, "2026-05-09.permission-audit.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");

    const result = verifyAllAuditFiles(auditDir, secret);
    expect(result.intact).toBe(false);
    expect(result.firstBrokenFile).toBe("2026-05-09.permission-audit.jsonl");
    expect(result.perDay[0].result.ok).toBe(false);
    if (!result.perDay[0].result.ok) {
      expect(result.perDay[0].result.firstBrokenLineIndex).toBe(2);
    }
  });

  it("intact=false when seal exists but doesn't match (file replaced)", () => {
    const auditDir = join(workDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const secret = "bb".repeat(32);
    const sealStore = new MemorySecretStore();

    // Original day with seal
    const original = buildChainedEntries(secret, [
      { decision: "allow", auditId: "orig", ts: "t1", trustOrigin: "user-keyboard", tool: "a" },
    ]);
    const file = join(auditDir, "2026-05-09.permission-audit.jsonl");
    writeFileSync(file, JSON.stringify(original[0]) + "\n");
    sealDayFromFile(secret, sealStore, file, "2026-05-09");

    // Now replace the file content with a new (still chain-valid) line —
    // chain check passes BUT seal mismatches.
    const replacement = buildChainedEntries(secret, [
      { decision: "allow", auditId: "fake", ts: "t1", trustOrigin: "user-keyboard", tool: "a" },
    ]);
    writeFileSync(file, JSON.stringify(replacement[0]) + "\n");

    const result = verifyAllAuditFiles(auditDir, secret, sealStore);
    expect(result.perDay[0].result.ok).toBe(true);
    expect(result.perDay[0].sealMatch).toBe(false);
    expect(result.intact).toBe(false);
  });

  it("returns empty result when audit dir is missing", () => {
    const result = verifyAllAuditFiles(join(workDir, "nope"), "x".repeat(64));
    expect(result).toEqual({ totalFiles: 0, totalEntries: 0, intact: true, perDay: [] });
  });
});

describe("summarizeAuditDir", () => {
  it("counts files and bytes", () => {
    const auditDir = join(workDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, "2026-05-08.permission-audit.jsonl"), "a\n");
    writeFileSync(join(auditDir, "2026-05-09.permission-audit.jsonl"), "bb\n");
    // legacy file ignored
    writeFileSync(join(auditDir, "2026-05-09.jsonl"), "ignored\n");
    const result = summarizeAuditDir(auditDir);
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(5); // "a\n" (2) + "bb\n" (3)
  });

  it("returns zero for missing dir", () => {
    expect(summarizeAuditDir(join(workDir, "nope"))).toEqual({ files: 0, bytes: 0 });
  });
});
