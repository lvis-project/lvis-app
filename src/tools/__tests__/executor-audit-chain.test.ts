import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { verifyAllAuditFiles } from "../../permissions/permission-audit-runner.js";

let testHome: string;
const SECRET = "aa".repeat(32);

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "lvis-executor-audit-"));
  mkdirSync(join(testHome, ".lvis", "audit"), { recursive: true });
});

afterEach(() => {
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readLines(path: string): string[] {
  return readFileSync(path, "utf-8").split("\n").filter(Boolean);
}

describe("ToolExecutor permission audit chain", () => {
  it("writes allow and deny tool decisions into the HMAC-chained channel", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "ok_tool",
      description: "allowed",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object" },
      isReadOnly: () => true,
      execute: async () => ({ output: "ok", isError: false }),
    }));
    registry.register(createDynamicTool({
      name: "blocked_tool",
      description: "denied",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object" },
      execute: async () => ({ output: "should not run", isError: false }),
    }));

    const permissionManager = new PermissionManager(join(testHome, "permissions.json"));
    permissionManager.checkDetailed = (toolName) =>
      toolName === "blocked_tool"
        ? { decision: "deny", reason: "test deny", layer: 3 }
        : { decision: "allow", reason: "test allow", layer: 3 };

    const auditLogger = new AuditLogger(join(testHome, ".lvis", "audit"));
    auditLogger.setupPermissionAuditChain(SECRET);
    const executor = new ToolExecutor(
      registry,
      undefined,
      permissionManager,
      undefined,
      undefined,
      undefined,
      auditLogger,
    );

    const result = await executor.executeAll(
      [
        { id: "allow-1", name: "ok_tool", input: {} },
        { id: "deny-1", name: "blocked_tool", input: {} },
      ],
      {
        sessionId: "audit-session",
        permissionContext: { trustOrigin: "user-keyboard", additionalDirectories: [] },
      },
    );

    expect(result.map((entry) => entry.is_error ?? false)).toEqual([false, true]);
    const lines = readLines(auditLogger.getPermissionAuditLogFile());
    expect(lines).toHaveLength(2);
    const entries = lines.map((line) => JSON.parse(line) as { tool: string; decision: string; category: string });
    expect(entries.map((entry) => entry.decision).sort()).toEqual(["allow", "deny"]);
    expect(entries.find((entry) => entry.tool === "ok_tool")?.category).toBe("read");
    expect(entries.find((entry) => entry.tool === "blocked_tool")?.category).toBe("write");
    expect(verifyAllAuditFiles(auditLogger.getAuditDir(), SECRET).intact).toBe(true);
  });

  it("fails closed when the initialized permission audit chain cannot append", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "ok_tool",
      description: "allowed",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object" },
      isReadOnly: () => true,
      execute: async () => ({ output: "ok", isError: false }),
    }));

    const permissionManager = new PermissionManager(join(testHome, "permissions.json"));
    permissionManager.checkDetailed = () => ({ decision: "allow", reason: "test allow", layer: 3 });
    const auditLogger = new AuditLogger(join(testHome, ".lvis", "audit"));
    auditLogger.setupPermissionAuditChain(SECRET);
    vi.spyOn(auditLogger, "appendPermissionAuditEntry").mockRejectedValue(new Error("append boom"));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permissionManager,
      undefined,
      undefined,
      undefined,
      auditLogger,
    );

    await expect(executor.executeAll(
      [{ id: "allow-1", name: "ok_tool", input: {} }],
      { sessionId: "audit-session", permissionContext: { trustOrigin: "user-keyboard" } },
    )).rejects.toThrow("append boom");
  });

  it("fails closed before executing when the initialized permission audit chain is not writable", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ output: "should not run", isError: false }));
    registry.register(createDynamicTool({
      name: "ok_tool",
      description: "allowed",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object" },
      isReadOnly: () => true,
      execute,
    }));

    const permissionManager = new PermissionManager(join(testHome, "permissions.json"));
    permissionManager.checkDetailed = () => ({ decision: "allow", reason: "test allow", layer: 3 });
    const auditLogger = new AuditLogger(join(testHome, ".lvis", "audit"));
    auditLogger.setupPermissionAuditChain(SECRET);
    vi.spyOn(auditLogger, "assertPermissionAuditWritable").mockImplementation(() => {
      throw new Error("not writable");
    });
    const executor = new ToolExecutor(
      registry,
      undefined,
      permissionManager,
      undefined,
      undefined,
      undefined,
      auditLogger,
    );

    const result = await executor.executeAll(
      [{ id: "allow-1", name: "ok_tool", input: {} }],
      { sessionId: "audit-session", permissionContext: { trustOrigin: "user-keyboard" } },
    );

    expect(result[0]).toMatchObject({ is_error: true });
    expect(result[0].content).toContain("permission audit chain is not writable");
    expect(execute).not.toHaveBeenCalled();
  });
});
