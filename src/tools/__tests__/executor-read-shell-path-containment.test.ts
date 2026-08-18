/**
 * Shell path containment must not be gated on the risk verdict.
 *
 * The structural defect: `invocation-runner` ran the shell path policy — the
 * sensitive-path hard block AND the allowed-directory check, both documented as
 * unoverridable — only when the derived category was `"shell"`. A plugin tool
 * whose command the host inspector classified `"read"` therefore executed with
 * no containment at all. The gate now keys on the SHAPE of the call ("this
 * invocation carries a command-bearing argument"), so a low-risk verdict can no
 * longer be a reason to skip the control.
 *
 * These tests drive the real `ToolExecutor` with `hostClassifiesRisk` ON so the
 * host-derived category is the one enforced, exactly as shipped.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { inspectHostRisk } from "../../permissions/reviewer/host-risk-inspector.js";
import type { ToolPermissionContext } from "../executor.js";

/** A plugin tool that takes a shell command string and reports whether it ran. */
function makeCommandBearingPluginTool(spy: { ran: boolean }): Tool {
  return createDynamicTool({
    name: "plugin_run_command",
    description: "A plugin tool whose argument carries a shell command string.",
    source: "plugin",
    pluginId: "p-shellish",
    category: "read",
    pathFields: [],
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: { command: { type: "string" } },
    },
    execute: async () => {
      spy.ran = true;
      return { output: "ran", isError: false };
    },
  });
}

async function runPluginCommand(
  input: Record<string, unknown>,
): Promise<{ isError: boolean; content: string; ran: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "lvis-read-containment-"));
  try {
    const spy = { ran: false };
    const registry = new ToolRegistry();
    registry.register(makeCommandBearingPluginTool(spy));
    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      undefined,
      undefined,
      undefined,
      () => true, // hostClassifiesRisk — the shipped default
    );
    const permissionContext: ToolPermissionContext = { trustOrigin: "user-keyboard" };
    const results = await executor.executeAll(
      [{ id: "tu-read-containment", name: "plugin_run_command", input }],
      { sessionId: "sess-read-containment", permissionContext },
    );
    return {
      isError: results[0]!.is_error === true,
      content: String(results[0]!.content),
      ran: spy.ran,
    };
  } finally {
    await cleanupTmpDir(dir);
  }
}

describe("ToolExecutor — shell path containment runs for read-classified commands", () => {
  it("blocks a sensitive-path operand on a command the host classifies as read", async () => {
    const command = `cat ${join(homedir(), ".ssh", "id_rsa")}`;
    // Precondition: this really is a `read` verdict — the gate is not being
    // exercised through the old `category === "shell"` branch.
    expect(inspectHostRisk({ source: "plugin", finalInput: { command } })).toBe("read");

    const result = await runPluginCommand({ command });
    expect(result.isError).toBe(true);
    // The shell path policy block specifically — not an approval denial.
    expect(result.content).toContain("Shell");
    expect(result.content).toContain("Sensitive path");
    expect(result.ran).toBe(false);
  });

  it("blocks a command carried by a non-primary field (script) too", async () => {
    const result = await runPluginCommand({
      command: "cat ./notes.txt",
      script: `cat ${join(homedir(), ".ssh", "id_rsa")}`,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Sensitive path");
    expect(result.ran).toBe(false);
  });
});
