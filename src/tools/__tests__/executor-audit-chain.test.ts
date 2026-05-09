import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: vi.fn(orig.homedir) };
});

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
  vi.mocked(homedir).mockReturnValue(testHome);
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

    const auditLogger = new AuditLogger();
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
        permissionContext: { trustOrigin: "user", additionalDirectories: [] },
      },
    );

    expect(result.map((entry) => entry.is_error ?? false)).toEqual([false, true]);
    const lines = readLines(auditLogger.getPermissionAuditLogFile());
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).decision).sort()).toEqual(["allow", "deny"]);
    expect(verifyAllAuditFiles(auditLogger.getAuditDir(), SECRET).intact).toBe(true);
  });
});
