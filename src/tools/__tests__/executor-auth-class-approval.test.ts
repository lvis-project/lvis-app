/**
 * ToolExecutor — auth-class consistency.
 *
 * An auth-class tool is a plugin manifest's `auth.loginTool` / `auth.logoutTool`
 * (NOT `statusTool`). It must surface the SAME ApprovalGate modal on BOTH lanes
 * REGARDLESS of the ambient permission posture:
 *
 *   • AGENT lane (headless:true) — previously hit the foreground-auto reviewer
 *     hard-deny ("no approval popup was opened"). Now routes to the modal.
 *   • UI lane (headless:false) — previously passed silently when the ambient
 *     posture allowed (e.g. `allow` mode / an allow rule), no reviewer/modal.
 *     Now requires the same modal.
 *
 * The baseline used here is `allow` mode — the exact posture where a plain
 * plugin tool runs SILENTLY on both lanes. That makes the auth-class elevation
 * unambiguous: only the loginTool/logoutTool flips to the modal; statusTool and
 * every other tool keep their silent allow.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";

function userPermissionContext(
  overrides: Partial<import("../executor.js").ToolPermissionContext> = {},
): import("../executor.js").ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

function makePluginWriteTool(name: string, executeSpy: ReturnType<typeof vi.fn>): Tool {
  return createDynamicTool({
    name,
    description: `${name} probe`,
    source: "plugin",
    pluginId: "test-plugin",
    category: "write",
    jsonSchema: { type: "object", properties: { payload: { type: "string" } } },
    execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
  });
}

const AUTH_TOOL = "lge_login"; // manifest.auth.loginTool
const STATUS_TOOL = "lge_status"; // manifest.auth.statusTool — NOT auth-class
const PLAIN_TOOL = "lge_attendance_clock"; // ordinary write tool

/** Classifier mirroring PluginRuntime.isAuthClassTool for the fixture plugin. */
function isAuthClassTool(toolName: string): boolean {
  return toolName === AUTH_TOOL; // login/logout only; status excluded
}

function makeAuditLogger() {
  return {
    log: vi.fn(),
    isPermissionAuditChainReady: vi.fn(() => false),
    assertPermissionAuditWritable: vi.fn(),
    appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => ({ ...entry, prevHash: "h" })),
  };
}

function makeExecutor(
  registry: ToolRegistry,
  permMgr: PermissionManager,
  requestAndWait: ReturnType<typeof vi.fn>,
): ToolExecutor {
  return new ToolExecutor(
    registry,
    undefined,
    permMgr,
    undefined,
    { requestAndWait } as never,
    undefined,
    makeAuditLogger() as never,
    () => false,
    isAuthClassTool,
  );
}

describe("ToolExecutor — auth-class approval consistency", () => {
  it("AGENT lane (headless): auth-class login routes to the ApprovalGate modal (was hard-deny)", async () => {
    const executeSpy = vi.fn(async () => "logged-in");
    const registry = new ToolRegistry();
    registry.register(makePluginWriteTool(AUTH_TOOL, executeSpy));
    const dir = mkdtempSync(join(tmpdir(), "lvis-authclass-agent-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      // `allow` is the SILENT baseline — a plain headless write would just run.
      // The auth-class elevation must still open the modal.
      permMgr.setMode("allow");
      const requestAndWait = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      }));
      const executor = makeExecutor(registry, permMgr, requestAndWait);
      const result = await executor.executeAll(
        [{ id: "tu-auth-agent", name: AUTH_TOOL, input: { payload: "go" } }],
        {
          sessionId: "sess-auth-agent",
          permissionContext: userPermissionContext({ headless: true, trustOrigin: "llm-tool-arg" }),
        },
      );
      // The modal was opened and the user approved → tool ran.
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(result[0].is_error).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("UI lane (headless:false): auth-class login requires the ApprovalGate modal (was silent pass)", async () => {
    const executeSpy = vi.fn(async () => "logged-in");
    const registry = new ToolRegistry();
    registry.register(makePluginWriteTool(AUTH_TOOL, executeSpy));
    const dir = mkdtempSync(join(tmpdir(), "lvis-authclass-ui-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("allow"); // silent baseline — plain UI write would run
      const requestAndWait = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "deny-once" as const,
      }));
      const executor = makeExecutor(registry, permMgr, requestAndWait);
      const result = await executor.executeAll(
        [{ id: "tu-auth-ui", name: AUTH_TOOL, input: { payload: "go" } }],
        {
          sessionId: "sess-auth-ui",
          permissionContext: userPermissionContext({ headless: false, trustOrigin: "plugin-emitted" }),
        },
      );
      // The same modal was opened (not silently passed); the user denied → no run.
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(result[0].is_error).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auth.statusTool stays silent (read-only status is NOT auth-class)", async () => {
    const executeSpy = vi.fn(async () => JSON.stringify({ authenticated: true }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: STATUS_TOOL,
      description: "status probe",
      source: "plugin",
      pluginId: "test-plugin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-authclass-status-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("allow"); // silent baseline
      const requestAndWait = vi.fn(async (req: { id: string }) => ({ requestId: req.id, choice: "allow-once" as const }));
      const executor = makeExecutor(registry, permMgr, requestAndWait);
      const result = await executor.executeAll(
        [{ id: "tu-status", name: STATUS_TOOL, input: {} }],
        {
          sessionId: "sess-status",
          permissionContext: userPermissionContext({ headless: false, trustOrigin: "plugin-emitted" }),
        },
      );
      // statusTool is excluded from auth-class → no modal, runs silently.
      expect(requestAndWait).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(result[0].is_error).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("posture preserved — NON-auth plugin write runs silently on the agent lane (no modal)", async () => {
    const executeSpy = vi.fn(async () => "ran");
    const registry = new ToolRegistry();
    registry.register(makePluginWriteTool(PLAIN_TOOL, executeSpy));
    const dir = mkdtempSync(join(tmpdir(), "lvis-authclass-plain-agent-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("allow");
      const requestAndWait = vi.fn(async (req: { id: string }) => ({ requestId: req.id, choice: "allow-once" as const }));
      const executor = makeExecutor(registry, permMgr, requestAndWait);
      const result = await executor.executeAll(
        [{ id: "tu-plain-agent", name: PLAIN_TOOL, input: { payload: "x" } }],
        {
          sessionId: "sess-plain-agent",
          permissionContext: userPermissionContext({ headless: true, trustOrigin: "llm-tool-arg" }),
        },
      );
      // Unchanged: no auth-class elevation → silent allow, NO modal.
      expect(requestAndWait).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(result[0].is_error).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("posture preserved — NON-auth plugin write runs silently on the UI lane (no modal)", async () => {
    const executeSpy = vi.fn(async () => "ran");
    const registry = new ToolRegistry();
    registry.register(makePluginWriteTool(PLAIN_TOOL, executeSpy));
    const dir = mkdtempSync(join(tmpdir(), "lvis-authclass-plain-ui-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("allow");
      const requestAndWait = vi.fn(async (req: { id: string }) => ({ requestId: req.id, choice: "allow-once" as const }));
      const executor = makeExecutor(registry, permMgr, requestAndWait);
      const result = await executor.executeAll(
        [{ id: "tu-plain-ui", name: PLAIN_TOOL, input: { payload: "x" } }],
        {
          sessionId: "sess-plain-ui",
          permissionContext: userPermissionContext({ headless: false, trustOrigin: "plugin-emitted" }),
        },
      );
      // Unchanged trusted-UI posture: allow-mode lets the write run silently.
      expect(requestAndWait).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(result[0].is_error).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
