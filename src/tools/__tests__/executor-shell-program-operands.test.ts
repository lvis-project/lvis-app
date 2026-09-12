import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";

async function invoke(command: string, decision: "allow" | "deny" = "allow") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "executor-program-operands-")));
  try {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "shell_program_probe", source: "plugin", pluginId: "program-probe",
      description: "Command-bearing execution probe", category: "write",
      jsonSchema: { type: "object", properties: { command: { type: "string" } } },
      execute,
    }));
    const permissions = new PermissionManager(join(root, "permissions.json"));
    permissions.checkDetailed = () => ({ decision, reason: "program probe permission", layer: 5 });
    const executor = new ToolExecutor(registry, undefined, permissions, new BashAstValidator({ mode: "deny" }));
    const results = await executor.executeAll(
      [{ id: "program-probe", name: "shell_program_probe", input: { command } }],
      { executionCwd: root, sessionId: "program-probe", permissionContext: { trustOrigin: "user-keyboard" } },
    );
    return { result: results[0]!, execute };
  } finally { await cleanupTmpDir(root); }
}

describe("executor program operand gates", () => {
  const sql = `SELECT 1 AS "${"x".repeat(300)}";`;
  const command = `sqlite3 sample.db ${shellQuote(sql)}`;

  it("admits literal program text through the actual path and structural gates", async () => {
    const { result, execute } = await invoke(command);
    expect(result.is_error).toBeFalsy();
    expect(execute).toHaveBeenCalledExactlyOnceWith({ command }, expect.anything());
  });

  it("retains the permission decision after program classification", async () => {
    const { result, execute } = await invoke(command, "deny");
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    "sqlite3 /etc/shadow 'SELECT 1;'",
    "sqlite3 -init /etc/shadow sample.db 'SELECT 1;'",
    `sqlite3 sample.db ${shellQuote("SELECT readfile('/etc/shadow');")}`,
    "sqlite3 sample.db '.shell sudo printf blocked'",
    "sqlite3 -unknown operand sample.db 'SELECT 1;'",
    "sqlite3 sample.db 'SELECT 1;' > ../outside/report",
  ])("refuses an unauthorized effect before reaching the handler: %s", async (blocked) => {
    const { result, execute } = await invoke(blocked);
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
