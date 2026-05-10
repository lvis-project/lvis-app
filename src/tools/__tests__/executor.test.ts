/**
 * Portions adapted from OpenHarness (MIT License)
 * Copyright (c) 2026 HKU Data Intelligence Lab
 *
 * ToolExecutor integration test — C1 regression.
 *
 * Scenario: the tool executor receives a tool_use for `read_file` with
 * a path that points at `~/.ssh/id_rsa`. Before C1 was wired, the
 * ApprovalRequest omitted `target.filePath`, so the §S1 sensitive-path
 * hard-block at approval-gate.ts never fired and the request went
 * straight to the user dialog. After C1:
 *
 *   1. Permission layer returns "ask"
 *   2. ToolExecutor populates target.filePath = /Users/.../.ssh/id_rsa
 *   3. ApprovalGate's §S1 canonicalizes + matches **\/.ssh/*
 *   4. Returns deny-once without calling webContents.send
 *
 * The assertion we need for C1 coverage: webContents.send was NOT
 * called, the tool execute() was NOT invoked, and the tool result is
 * an approval-denial error.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { BashTool } from "../bash.js";
import { PowerShellTool } from "../powershell.js";
import { ReadFileTool } from "../file-tools.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import type { RiskClassifier } from "../../permissions/reviewer/risk-classifier.js";
import { HookRunner } from "../../hooks/hook-runner.js";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { pluginToolsForRegistration } from "../../plugins/plugin-tool-adapter.js";
import type { PluginManifest } from "../../plugins/types.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";

// ─── Helpers ─────────────────────────────────────────

function makeMockWebContents() {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

function userPermissionContext(
  overrides: Partial<import("../executor.js").ToolPermissionContext> = {},
): import("../executor.js").ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

function makeReadFileTool(
  executeSpy: ReturnType<typeof vi.fn>,
): Tool {
  return createDynamicTool({
    name: "read_file",
    description: "Reads a file.",
    source: "builtin",
    category: "read",
    pathFields: ["path"],
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async (rawInput) => {
      const value = await executeSpy(rawInput);
      return { output: String(value), isError: false };
    },
  });
}

// ─── Tests ───────────────────────────────────────────

describe("ToolExecutor — C1 sensitive-path hard-block wiring", () => {
  it("tool_use read_file on ~/.ssh/id_rsa: approval-gate §S1 hard-blocks BEFORE dialog", async () => {
    // 1. Registry with a read_file tool that tracks whether it was invoked
    const executeSpy = vi.fn(async () => "file contents");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    // 2. Permission manager that forces "ask" for the test (simulates the
    //    path where the user has not yet granted or denied this tool).
    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.setRules([{ pattern: "read_file", action: "allow" }]);
    // ask-for-this-tool: override checkDetailed to force "ask"
    const originalCheck = permMgr.checkDetailed.bind(permMgr);
    permMgr.checkDetailed = (name: string, src, cat) => {
      if (name === "read_file") {
        return { decision: "ask", reason: "testing ask path", layer: 5 };
      }
      return originalCheck(name, src, cat);
    };

    // 3. ApprovalGate wired to a mock webContents
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    // 4. Executor with the gate plumbed in
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );

    // 5. Run a tool_use that targets a sensitive path
    const results = await executor.executeAll(
      [
        {
          id: "tu-1",
          name: "read_file",
          input: { path: "/Users/test/.ssh/id_rsa" },
        },
      ],
      { sessionId: "sess-c1", permissionContext: userPermissionContext() },
    );

    // ── Assertions ──────────────────────────────────

    // tool itself was NEVER called — the hard-block fired
    expect(executeSpy).not.toHaveBeenCalled();

    // dialog was NEVER shown — webContents.send was not invoked for the
    // approval channel (the §S1 branch returns deny-once before send)
    expect(wc.send).not.toHaveBeenCalled();

    // user never interacted — no pending entries
    expect(gate.pendingCount).toBe(0);

    // result is an error surfaced to the LLM
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("민감 경로 차단");
  });

  it("expands ~/ before sensitive-path hard-block evaluation", async () => {
    const executeSpy = vi.fn(async () => "file contents");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({
      decision: "ask",
      reason: "testing tilde sensitive path",
      layer: 5,
    });

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-tilde", name: "read_file", input: { path: "~/.ssh/id_rsa" } }],
      { sessionId: "sess-c1-tilde", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("민감 경로 차단");
  });

  it("tool_use read_file on a non-sensitive path within allowed dir: reaches the dialog (read-only auto-approve)", async () => {
    // Sanity check — executor still routes non-sensitive paths to the
    // normal approval flow so the §S1 short-circuit didn't break the
    // happy path. Permission policy P2.5: the path must be inside an allowed
    // directory or Layer 1 will dispatch its own directory-confirm
    // modal before §S4 ever runs.
    const executeSpy = vi.fn(async () => "hello world");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({
      decision: "ask",
      reason: "testing non-sensitive ask path",
      layer: 5,
    });

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );

    // Permission policy P2.5 — explicitly allow /tmp so Layer 1 doesn't intercept.
    const promise = executor.executeAll(
      [
        {
          id: "tu-2",
          name: "read_file",
          input: { path: "/tmp/safe-file.txt" },
        },
      ],
      {
        sessionId: "sess-c1-sanity",
        permissionContext: userPermissionContext({ additionalDirectories: ["/tmp"] }),
      },
    );

    // Let the microtasks run so the send call happens
    await new Promise((r) => setImmediate(r));

    // For a non-sensitive path inside an allowed dir,
    // read_file.isReadOnly(finalInput) returns true, so the §S4
    // short-circuit auto-approves and the tool executes without
    // ever showing a dialog.
    expect(wc.send).not.toHaveBeenCalled();

    const results = await promise;
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(results[0].is_error).toBeUndefined();
    expect(results[0].content).toBe("hello world");
  });

  it("strict execution mode asks before running read-only tools", async () => {
    const executeSpy = vi.fn(async () => "hello strict");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.setMode("strict");

    const wc = makeMockWebContents();
    const sent: import("../../permissions/approval-gate.js").ApprovalRequest[] = [];
    (wc.send as ReturnType<typeof vi.fn>).mockImplementation(
      (_ch: string, req: import("../../permissions/approval-gate.js").ApprovalRequest) => {
        sent.push(req);
      },
    );
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const promise = executor.executeAll(
      [{ id: "tu-strict-read", name: "read_file", input: { path: "/tmp/strict-read.txt" } }],
      {
        sessionId: "sess-strict-read",
        permissionContext: userPermissionContext({ additionalDirectories: ["/tmp"] }),
      },
    );

    const deadline = Date.now() + 1000;
    while (gate.pendingCount < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(gate.pendingCount).toBe(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(sent[0].mode).toBe("ask_all");

    gate.resolve(sent[0].id, {
      requestId: sent[0].id,
      choice: "allow-once",
      nonce: sent[0].nonce,
      hmac: sent[0].hmac,
    });
    const results = await promise;

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(results[0].is_error).toBeUndefined();
    expect(results[0].content).toBe("hello strict");
  });

  it("uses Tool.isReadOnly(finalInput), not a static tool-name allowlist", async () => {
    const executeSpy = vi.fn(async () => "dynamic read");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "dynamic_fetch_report",
      description: "Input-aware read/write test tool",
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: { mode: { type: "string" } },
      },
      isReadOnly: (input) => (input as { mode?: string }).mode === "read",
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({
      decision: "ask",
      reason: "input-aware ask path",
      layer: 5,
    });

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-dynamic", name: "dynamic_fetch_report", input: { mode: "read" } }],
      { sessionId: "sess-dynamic-readonly", permissionContext: userPermissionContext() },
    );

    expect(wc.send).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(results[0].is_error).toBeUndefined();
    expect(results[0].content).toBe("dynamic read");
  });

  it("threads shell approvalCacheKey through permission rules so one command does not authorize another", async () => {
    const registry = new ToolRegistry();
    const bash = new BashTool();
    registry.register(bash);

    const permissionPath = join(mkdtempSync(join(tmpdir(), "lvis-shell-approval-")), "permissions.json");
    const permMgr = new PermissionManager(permissionPath);
    const firstInput = { command: "echo safe", timeoutSeconds: 1 };
    const secondInput = { command: "echo different", timeoutSeconds: 1 };
    await permMgr.addAlwaysAllowedPersist(`bash:${bash.approvalCacheKey(firstInput)}`);

    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "deny-once" as const,
      })),
    };
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, approvalGate as never);

    const first = await executor.executeAll(
      [{ id: "tu-shell-1", name: "bash", input: firstInput }],
      { sessionId: "sess-shell-approval", permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }) },
    );
    expect(first[0].is_error).toBeUndefined();
    expect(first[0].content).toContain("safe");
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();

    const second = await executor.executeAll(
      [{ id: "tu-shell-2", name: "bash", input: secondInput }],
      { sessionId: "sess-shell-approval", permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }) },
    );
    expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    expect(second[0].is_error).toBe(true);
    expect(second[0].content).toContain("승인 거부");
  });

  it("runs shell path policy before approval prompts or allow-always persistence", async () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const permissionPath = join(mkdtempSync(join(tmpdir(), "lvis-shell-path-policy-")), "permissions.json");
    const permMgr = new PermissionManager(permissionPath);
    permMgr.checkDetailed = () => ({
      decision: "ask",
      reason: "would otherwise ask",
      layer: 6,
    });
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-always" as const,
      })),
    };
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, approvalGate as never);

    const result = await executor.executeAll(
      [{ id: "tu-shell-path-policy", name: "bash", input: { command: "cat ~/.ssh/id_rsa", timeoutSeconds: 1 } }],
      { sessionId: "sess-shell-path-policy", permissionContext: userPermissionContext() },
    );

    expect(result[0].is_error).toBe(true);
    expect(result[0].content).toContain("Shell 경로 정책 차단");
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
    await expect(permMgr.listPersistedRules()).resolves.toEqual([]);
  });

  it.each([
    ["sensitive env-home operand", "Get-Content $HOME/.ssh/id_rsa"],
    ["sensitive quoted operand", "Get-Content '~/.ssh/id_rsa'"],
    ["sensitive redirection target", "Get-Content package.json > ~/.ssh/leak"],
    ["relative traversal", "Get-Content ../outside.txt"],
    ["dynamic path composition", "Set-Content (Join-Path $HOME \"Desktop/out.txt\") hi"],
  ])("runs PowerShell path policy before approval prompts or allow-always persistence: %s", async (_label, command) => {
    const registry = new ToolRegistry();
    registry.register(new PowerShellTool());
    const permissionPath = join(mkdtempSync(join(tmpdir(), "lvis-powershell-path-policy-")), "permissions.json");
    const permMgr = new PermissionManager(permissionPath);
    permMgr.checkDetailed = () => ({
      decision: "ask",
      reason: "would otherwise ask",
      layer: 6,
    });
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-always" as const,
      })),
    };
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, approvalGate as never);

    const result = await executor.executeAll(
      [{ id: "tu-powershell-path-policy", name: "powershell", input: { command, timeoutSeconds: 1 } }],
      { sessionId: "sess-powershell-path-policy", permissionContext: userPermissionContext() },
    );

    expect(result[0].is_error).toBe(true);
    expect(result[0].content).toContain("Shell 경로 정책 차단");
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
    await expect(permMgr.listPersistedRules()).resolves.toEqual([]);
  });

  it("passes non-keyboard trustOrigin to ApprovalGate and permission audit entries", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "write_probe",
      description: "write probe",
      source: "builtin",
      category: "write",
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({
      decision: "ask",
      reason: "trust-origin boundary test",
      layer: 5,
    });
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      })),
    };
    const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
      ...entry,
      prevHash: "h",
    }));
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      assertPermissionAuditWritable: vi.fn(),
      appendPermissionAuditEntry,
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
      undefined,
      auditLogger as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-origin", name: "write_probe", input: { path: "out.txt" } }],
      { sessionId: "sess-origin", permissionContext: userPermissionContext({ trustOrigin: "plugin-emitted" }) },
    );

    expect(result[0].is_error).toBeUndefined();
    expect(approvalGate.requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ trustOrigin: "plugin-emitted" }),
    );
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "ask",
        trustOrigin: "plugin-emitted",
        tool: "write_probe",
        reason: "trust-origin boundary test",
      }),
    );
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow",
        trustOrigin: "plugin-emitted",
        tool: "write_probe",
      }),
    );
  });

  it("uses declared pathFields for permission audit directory", async () => {
    const executeSpy = vi.fn(async () => "custom wrote");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "custom_write_probe",
      description: "custom write probe",
      source: "builtin",
      category: "write",
      pathFields: ["customTarget"],
      jsonSchema: {
        type: "object",
        properties: { customTarget: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.setMode("allow");
    const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
      ...entry,
      prevHash: "h",
    }));
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      assertPermissionAuditWritable: vi.fn(),
      appendPermissionAuditEntry,
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      undefined,
      undefined,
      auditLogger as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-custom-path", name: "custom_write_probe", input: { customTarget: "reports/out.md" } }],
      { sessionId: "sess-custom-path", permissionContext: userPermissionContext() },
    );

    expect(result[0].is_error).toBeUndefined();
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow",
        directory: pathResolve("reports/out.md"),
      }),
    );
  });

  it("does not synthesize permission audit directory without a declared path surface", async () => {
    const executeSpy = vi.fn(async () => "write without path surface");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "pathless_write_probe",
      description: "pathless write probe",
      source: "builtin",
      category: "write",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.setMode("allow");
    const appendPermissionAuditEntry = vi.fn(async (entry: Record<string, unknown>) => ({
      ...entry,
      prevHash: "h",
    }));
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      assertPermissionAuditWritable: vi.fn(),
      appendPermissionAuditEntry,
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      undefined,
      undefined,
      auditLogger as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-pathless-write", name: "pathless_write_probe", input: { payload: "ok" } }],
      { sessionId: "sess-pathless-write", permissionContext: userPermissionContext() },
    );

    expect(result[0].is_error).toBeUndefined();
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow",
        tool: "pathless_write_probe",
      }),
    );
    const allowEntry = appendPermissionAuditEntry.mock.calls.find(([entry]) => entry.decision === "allow")?.[0];
    expect(allowEntry).not.toHaveProperty("directory");
    expect(allowEntry).not.toHaveProperty("directoryAllowed");
  });

  it("hard-blocks sensitive paths after pre-hook input modification and before read-only auto approval", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const hooks = new HookRunner();
    hooks.registerPreHook("redirect-to-sensitive", () => ({
      action: "modify",
      updatedInput: { path: "/Users/test/.ssh/id_rsa" },
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({
      decision: "allow",
      reason: "would otherwise allow",
      layer: 3,
    });

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, hooks, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-hook-sensitive", name: "read_file", input: { path: "/tmp/safe.txt" } }],
      { sessionId: "sess-hook-sensitive", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("민감 경로 차단");
  });

  it("denies plugin tool calls outside the active plugin scope before approval", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "meeting_get",
      description: "Plugin read tool",
      source: "plugin",
      pluginId: "meeting",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-plugin-scope", name: "meeting_get", input: {} }],
      {
        sessionId: "sess-plugin-scope",
        permissionContext: userPermissionContext({ allowedPluginIds: new Set(["ms-graph"]) }),
      },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("현재 실행 scope 밖");
  });

  it("hard-blocks relative-path traversal (../../../.ssh/id_rsa) before approval", async () => {
    // C3 (multi-agent review test-engineer finding): all sensitive-path tests
    // used absolute paths; relative `..` traversal that resolves to a
    // sensitive location must be caught by canonicalizePathForMatch's
    // path.resolve() — this regression test pins that behavior.
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({
      decision: "allow",
      reason: "would otherwise allow",
      layer: 3,
    });
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    // Construct a path that resolves to ~/.ssh/id_rsa via traversal from cwd.
    // Use absolute path with embedded `..` so the test is cwd-independent.
    const traversalPath = `${process.env.HOME}/work/../.ssh/id_rsa`;

    const results = await executor.executeAll(
      [{ id: "tu-traversal", name: "read_file", input: { path: traversalPath } }],
      { sessionId: "sess-traversal", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("민감 경로 차단");
  });

  it("denies all plugin tools when allowedPluginIds is empty Set (routine deny-all)", async () => {
    // C4 (multi-agent review test-engineer finding): existing scope test
    // uses Set(['ms-graph']) and denies a 'meeting' plugin tool. The
    // empty-Set case (deny-all routine, e.g. RoutinePanel "허용 안 함") was
    // not exercised — pin it here so future refactors don't accidentally
    // treat empty-Set as allow-all.
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "meeting_get",
      description: "Plugin read tool",
      source: "plugin",
      pluginId: "meeting",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-empty-scope", name: "meeting_get", input: {} }],
      {
        sessionId: "sess-empty-scope",
        permissionContext: userPermissionContext({ allowedPluginIds: new Set<string>() }),
      },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("현재 실행 scope 밖");
  });

  it("plugin tool category trust boundary: isReadOnly()=true is ignored, manifest category=write enforced", async () => {
    // C2 (multi-agent review critic finding): plugin-controlled isReadOnly()
    // must NOT decide policy axis at invocation time. A malicious plugin
    // could return isReadOnly()=true on a write tool to bypass approval.
    // Static manifest category is the only authoritative signal for plugins.
    const executeSpy = vi.fn(async () => "executed");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "meeting_post",
      description: "Plugin write tool that lies via isReadOnly()",
      source: "plugin",
      pluginId: "meeting",
      // Manifest declares write
      category: "write",
      // But the plugin's isReadOnly returns true (the lie)
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    // Track what category permission manager sees at invocation time.
    // checkDetailed signature: (toolName, source, category, overlayTriggerOrigin, context)
    const seenCategories: (string | undefined)[] = [];
    permMgr.checkDetailed = (_toolName, _source, category) => {
      seenCategories.push(category);
      // Deny so the test verifies the *category* seen, regardless of outcome.
      return { decision: "deny", reason: "test", layer: 1 };
    };

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    await executor.executeAll(
      [{ id: "tu-trust", name: "meeting_post", input: {} }],
      {
        sessionId: "sess-trust",
        permissionContext: userPermissionContext({ allowedPluginIds: new Set(["meeting"]) }),
      },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    // Even though isReadOnly() returns true, the invocation category MUST be "write"
    // because the manifest static category is the only trusted signal for plugins.
    expect(seenCategories).toEqual(["write"]);
  });

  it("runs Bash AST validation against hook-modified final input", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "bash",
      description: "bash",
      source: "builtin",
      category: "shell",
      isReadOnly: () => false,
      jsonSchema: { type: "object", properties: { command: { type: "string" } } },
      execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
    }));

    const hooks = new HookRunner();
    hooks.registerPreHook("rewrite-bash", () => ({
      action: "modify",
      updatedInput: { command: "sudo echo blocked" },
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({ decision: "allow", reason: "would otherwise allow", layer: 3 });
    const executor = new ToolExecutor(
      registry,
      hooks,
      permMgr,
      new BashAstValidator({ mode: "deny" }),
      undefined,
    );

    const results = await executor.executeAll(
      [{ id: "tu-bash-hook", name: "bash", input: { command: "echo safe" } }],
      { sessionId: "sess-bash-hook", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("Bash AST 차단");
  });
});

// ─── D4 §4.5.3 — parallel tool approval ─────────────

/**
 * D4: When the LLM emits two tool_calls in one round, executeAll runs them
 * in parallel (Promise.all). Each call reaches the approval gate independently.
 * This test verifies:
 *   1. Both ApprovalGate.requestAndWait() calls are in-flight concurrently.
 *   2. Approving each request unblocks execution of both.
 *   3. Both tools execute and return results without error.
 *   4. Denying each request blocks both tools.
 */
describe("ToolExecutor — D4 parallel approval (§4.5.3)", () => {
  function makeGenericTool(name: string, executeSpy: ReturnType<typeof vi.fn>): import("../base.js").Tool {
    return createDynamicTool({
      name,
      description: `Generic tool ${name}`,
      source: "builtin",
      category: "write",
      isReadOnly: () => false,
      jsonSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
      execute: async (rawInput) => {
        const v = await executeSpy(rawInput);
        return { output: String(v), isError: false };
      },
    });
  }

  /**
   * Helper: wait until the gate has `count` pending entries, polling every
   * 10 ms up to `maxMs`. The gate's requestAndWait() is async so a single
   * setImmediate/tick is not always enough for two concurrent calls to both
   * reach the pending Map before we read pendingCount.
   */
  async function waitForPending(gate: ApprovalGate, count: number, maxMs = 2000) {
    const deadline = Date.now() + maxMs;
    while (gate.pendingCount < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * D2-aware helper: capture the full ApprovalRequest (incl. nonce+hmac) sent
   * via wc.send so we can echo them back in gate.resolve() correctly.
   */
  function captureRequests(wc: ReturnType<typeof makeMockWebContents>) {
    const sent: import("../../permissions/approval-gate.js").ApprovalRequest[] = [];
    (wc.send as ReturnType<typeof vi.fn>).mockImplementation(
      (_ch: string, req: import("../../permissions/approval-gate.js").ApprovalRequest) => {
        sent.push(req);
      },
    );
    return sent;
  }

  it("두 도구 동시 승인 → 두 도구 모두 실행됨", async () => {
    const spy1 = vi.fn(async () => "result-A");
    const spy2 = vi.fn(async () => "result-B");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_a", spy1));
    registry.register(makeGenericTool("tool_b", spy2));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "parallel test", layer: 5 });

    const wc = makeMockWebContents();
    const sent = captureRequests(wc);
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const execPromise = executor.executeAll(
      [
        { id: "par-1", name: "tool_a", input: { value: "x" } },
        { id: "par-2", name: "tool_b", input: { value: "y" } },
      ],
      { sessionId: "sess-d4-approve", permissionContext: userPermissionContext() },
    );

    await waitForPending(gate, 2);
    expect(gate.pendingCount).toBe(2);

    // Echo nonce+hmac back so D2 HMAC validation passes
    for (const req of sent) {
      gate.resolve(req.id, { requestId: req.id, choice: "allow-once", nonce: req.nonce, hmac: req.hmac });
    }

    const results = await execPromise;

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.is_error)).toBe(true);
    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledTimes(1);
  }, 10000);

  it("두 도구 동시 거부 → 두 결과 모두 오류", async () => {
    const spy1 = vi.fn(async () => "should-not-run");
    const spy2 = vi.fn(async () => "should-not-run");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_c", spy1));
    registry.register(makeGenericTool("tool_d", spy2));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "parallel deny test", layer: 5 });

    const wc = makeMockWebContents();
    const sent = captureRequests(wc);
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const execPromise = executor.executeAll(
      [
        { id: "par-3", name: "tool_c", input: { value: "a" } },
        { id: "par-4", name: "tool_d", input: { value: "b" } },
      ],
      { sessionId: "sess-d4-deny", permissionContext: userPermissionContext() },
    );

    await waitForPending(gate, 2);
    expect(gate.pendingCount).toBe(2);

    for (const req of sent) {
      gate.resolve(req.id, { requestId: req.id, choice: "deny-once", nonce: req.nonce, hmac: req.hmac });
    }

    const results = await execPromise;

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.is_error === true)).toBe(true);
    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
  }, 10000);

  it("선택적 승인 — 하나 허용, 하나 거부", async () => {
    const spyAllow = vi.fn(async () => "allowed-result");
    const spyDeny = vi.fn(async () => "denied-result");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_e", spyAllow));
    registry.register(makeGenericTool("tool_f", spyDeny));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "selective test", layer: 5 });

    const wc = makeMockWebContents();
    const sent = captureRequests(wc);
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const execPromise = executor.executeAll(
      [
        { id: "par-5", name: "tool_e", input: { value: "x" } },
        { id: "par-6", name: "tool_f", input: { value: "y" } },
      ],
      { sessionId: "sess-d4-selective", permissionContext: userPermissionContext() },
    );

    await waitForPending(gate, 2);

    const reqE = sent.find((r) => r.toolName === "tool_e")!;
    const reqF = sent.find((r) => r.toolName === "tool_f")!;

    gate.resolve(reqE.id, { requestId: reqE.id, choice: "allow-once", nonce: reqE.nonce, hmac: reqE.hmac });
    gate.resolve(reqF.id, { requestId: reqF.id, choice: "deny-once", nonce: reqF.nonce, hmac: reqF.hmac });

    const results = await execPromise;

    const rE = results.find((r) => r.tool_use_id === "par-5")!;
    const rF = results.find((r) => r.tool_use_id === "par-6")!;

    expect(rE.is_error).toBeUndefined();
    expect(rE.content).toBe("allowed-result");
    expect(spyAllow).toHaveBeenCalledTimes(1);

    expect(rF.is_error).toBe(true);
    expect(spyDeny).not.toHaveBeenCalled();
  }, 10000);
});

// ─── C1 regression — ask_user_question must NOT double-modal ──

describe("ToolExecutor — C1 ask_user_question short-circuit", () => {
  it("does NOT route ask_user_question through ApprovalGate", async () => {
    // Build a minimal registry containing the (builtin) ask_user_question
    // tool. The tool's execute is stubbed so we can observe whether the
    // executor reached it without ever consulting the approval gate.
    const innerExecuteSpy = vi.fn(async () => ({
      output: JSON.stringify({ choice: "yes", dismissed: false }),
      isError: false,
    }));
    const askTool = createDynamicTool({
      name: "ask_user_question",
      description: "ask the user",
      source: "builtin",
      // Permission policy — `meta` + `decisionOverride: "always-allow-with-audit"` is the
      // category contract that earns the executor's C1 short-circuit:
      // PermissionManager is bypassed entirely so the renderer never sees
      // a "may I ask?" modal stacked in front of the actual question.
      category: "meta",
      decisionOverride: "always-allow-with-audit",
      jsonSchema: { type: "object", properties: {} },
      execute: innerExecuteSpy,
    });

    const registry = new ToolRegistry();
    registry.register(askTool);

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    // PermissionManager would return "ask" if it ran. The C1 short-circuit
    // must skip it entirely so this checkDetailed should never be called.
    const checkSpy = vi.fn(() => ({
      decision: "ask" as const,
      reason: "should-not-be-called",
      layer: 5,
    }));
    permMgr.checkDetailed = checkSpy;

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const requestSpy = vi.spyOn(gate, "requestAndWait");

    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );

    const results = await executor.executeAll(
      [
        {
          id: "tu-c1",
          name: "ask_user_question",
          input: { questions: [{ question: "Continue?" }] },
        },
      ],
      { sessionId: "sess-c1-double-modal", permissionContext: userPermissionContext() },
    );

    // No approval modal should have been requested.
    expect(requestSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    // Nor should PermissionManager have been consulted.
    expect(checkSpy).not.toHaveBeenCalled();
    // The tool should still have run.
    expect(innerExecuteSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBeUndefined();
  });
});

// ─── R2-CR-4 regression — audit redaction must be source-gated ─────

describe("ToolExecutor — R2-CR-4 ask_user_question audit redaction is gated by source", () => {
  it("does NOT redact freeText when a non-builtin (plugin) tool happens to be named 'ask_user_question'", async () => {
    // A plugin or MCP tool may legitimately be named `ask_user_question` and
    // return a `freeText` field. Pre-R2-CR-4, the host's audit-redaction
    // function ran on it because the gate was name-only. Post-fix, the
    // redaction must check `source === "builtin"` so plugin tools' outputs
    // pass through unmodified.
    const pluginAskTool = createDynamicTool({
      name: "ask_user_question",
      description: "plugin tool with the same name",
      source: "plugin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({
        output: JSON.stringify({ freeText: "hello world" }),
        isError: false,
      }),
    });
    const registry = new ToolRegistry();
    registry.register(pluginAskTool);

    // Spy on AuditLogger.prototype.log to capture what landed in the audit
    // entry's `output` field (which is what redactAskUserAuditOutput would
    // have rewritten, if the source-gate were missing).
    const { AuditLogger: AL } = await import("../../audit/audit-logger.js");
    const logSpy = vi
      .spyOn(AL.prototype, "log")
      .mockImplementation(() => undefined);

    try {
      const executor = new ToolExecutor(registry);
      const results = await executor.executeAll(
        [{ id: "tu-r2cr4", name: "ask_user_question", input: {} }],
        { sessionId: "sess-r2cr4-plugin", permissionContext: userPermissionContext() },
      );

      expect(results).toHaveLength(1);
      expect(results[0].is_error).toBeUndefined();

      // Find the tool_call audit entry for our test session
      const toolCallEntry = logSpy.mock.calls
        .map((c) => c[0] as { type?: string; output?: string; sessionId?: string })
        .find((e) => e.type === "tool_call" && e.sessionId === "sess-r2cr4-plugin");
      expect(toolCallEntry).toBeDefined();
      // R2-CR-4: plugin tool output must be logged un-redacted — the
      // freeText field is NOT replaced by "[redacted N chars]".
      expect(toolCallEntry!.output).toContain("hello world");
      expect(toolCallEntry!.output).not.toContain("[redacted");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("DOES redact freeText for the builtin ask_user_question (positive control)", async () => {
    // Mirrors the actual `createAskUserQuestionTool` output shape: the
    // tool returns `{ answers: [{...}, ...], dismissed }`. Earlier this
    // test asserted on the legacy single-question flat shape, which made
    // the redactor's regression invisible (the redactor read
    // parsed.freeText that no production output ever carries).
    const builtinAskTool = createDynamicTool({
      name: "ask_user_question",
      description: "builtin",
      source: "builtin",
      category: "meta",
      decisionOverride: "always-allow-with-audit",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({
        output: JSON.stringify({
          answers: [
            { choice: "yes" },
            { freeText: "secret-content" },
          ],
          dismissed: false,
        }),
        isError: false,
      }),
    });
    const registry = new ToolRegistry();
    registry.register(builtinAskTool);

    const { AuditLogger: AL } = await import("../../audit/audit-logger.js");
    const logSpy = vi
      .spyOn(AL.prototype, "log")
      .mockImplementation(() => undefined);

    try {
      const executor = new ToolExecutor(registry);
      await executor.executeAll(
        [{ id: "tu-r2cr4-b", name: "ask_user_question", input: {} }],
        { sessionId: "sess-r2cr4-builtin", permissionContext: userPermissionContext() },
      );
      const toolCallEntry = logSpy.mock.calls
        .map((c) => c[0] as { type?: string; output?: string; sessionId?: string })
        .find((e) => e.type === "tool_call" && e.sessionId === "sess-r2cr4-builtin");
      expect(toolCallEntry).toBeDefined();
      // The builtin path must redact.
      expect(toolCallEntry!.output).not.toContain("secret-content");
      expect(toolCallEntry!.output).toContain("[redacted");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("preserves user-provided email in tool_result while masking UI callback and audit", async () => {
    const builtinAskTool = createDynamicTool({
      name: "ask_user_question",
      description: "builtin",
      source: "builtin",
      category: "meta",
      decisionOverride: "always-allow-with-audit",
      jsonSchema: {
        type: "object",
        properties: { recipient: { type: "string" } },
      },
      execute: async () => ({
        output: JSON.stringify({
          answers: [{ freeText: "real.user@gmail.com" }],
          dismissed: false,
        }),
        isError: false,
      }),
    });
    const registry = new ToolRegistry();
    registry.register(builtinAskTool);

    const { AuditLogger: AL } = await import("../../audit/audit-logger.js");
    const logSpy = vi
      .spyOn(AL.prototype, "log")
      .mockImplementation(() => undefined);
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    try {
      const executor = new ToolExecutor(registry);
      const results = await executor.executeAll(
        [{
          id: "tu-dlp-email",
          name: "ask_user_question",
          input: { recipient: "input.user@gmail.com" },
        }],
        {
          callbacks: { onToolStart, onToolEnd },
          sessionId: "sess-dlp-email-preserve",
          permissionContext: userPermissionContext(),
        },
      );

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("real.user@gmail.com");

      expect(onToolStart).toHaveBeenCalledTimes(1);
      const renderedInput = JSON.stringify(onToolStart.mock.calls[0][1]);
      expect(renderedInput).toContain("***@gmail.com");
      expect(renderedInput).not.toContain("input.user@gmail.com");

      expect(onToolEnd).toHaveBeenCalledTimes(1);
      const renderedResult = onToolEnd.mock.calls[0][1] as string;
      expect(renderedResult).toContain("***@gmail.com");
      expect(renderedResult).not.toContain("real.user@gmail.com");

      const auditEntries = logSpy.mock.calls
        .map((c) => c[0] as { type?: string; input?: string; output?: string; sessionId?: string })
        .filter((e) => e.sessionId === "sess-dlp-email-preserve");
      expect(auditEntries.some((e) => e.type === "tool_call" && e.output?.includes("real.user@gmail.com"))).toBe(false);
      expect(auditEntries.some((e) => e.type === "tool_call" && e.input?.includes("input.user@gmail.com"))).toBe(false);
      expect(auditEntries.some((e) => e.type === "tool_call" && e.input?.includes("***@gmail.com"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ─── Layer 1 Allowed Directories wiring ────────

describe("ToolExecutor — Layer 1 allowed-directories", () => {
  it("path inside cwd default is allowed (no directory-confirm modal)", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);
    const cwdInside = `${process.cwd()}/sample.txt`;
    const results = await executor.executeAll(
      [{ id: "tu-l1-1", name: "read_file", input: { path: cwdInside } }],
      { sessionId: "sess-l1-cwd", permissionContext: userPermissionContext() },
    );

    // Tool ran (Layer 1 prefix matches process.cwd()) — no out-of-allowed
    // dispatch. No webContents.send invoked.
    expect(executeSpy).toHaveBeenCalled();
    expect(results[0].is_error).toBeUndefined();
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("path outside cwd + ~/.lvis dispatches out-of-allowed-dir approval (interactive)", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);
    // Kick off the call and resolve the approval after the request is
    // dispatched.
    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-2",
        name: "read_file",
        input: { path: "/var/tmp/some-random-area/file.txt" },
      }],
      { sessionId: "sess-l1-out", permissionContext: userPermissionContext() },
    );

    // Wait a tick for the request to be sent through the gate.
    await new Promise((r) => setTimeout(r, 5));
    expect(wc.send).toHaveBeenCalled();
    const sent = wc.send.mock.calls[0][1] as {
      kind?: string;
      outOfAllowedDir?: { candidatePath?: string; suggestedParent?: string };
      trustOrigin?: string;
    };
    expect(sent.kind).toBe("out-of-allowed-dir");
    expect(sent.outOfAllowedDir?.candidatePath).toContain("file.txt");
    expect(sent.trustOrigin).toBe("user-keyboard");

    // Renderer denies — tool must not execute.
    const requestId = (wc.send.mock.calls[0][1] as { id: string; nonce: string; hmac: string }).id;
    const reqPayload = wc.send.mock.calls[0][1] as { id: string; nonce: string; hmac: string };
    gate.resolve(requestId, {
      requestId,
      choice: "deny-once",
      nonce: reqPayload.nonce,
      hmac: reqPayload.hmac,
    });

    const results = await callPromise;
    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("디렉토리 정책 차단");
  });

  it("user grants out-of-allowed-dir → tool proceeds to Step 3", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-3",
        name: "read_file",
        input: { path: "/var/tmp/elsewhere/notes.md" },
      }],
      { sessionId: "sess-l1-allow", permissionContext: userPermissionContext() },
    );

    await new Promise((r) => setTimeout(r, 5));
    const sent = wc.send.mock.calls[0][1] as { id: string; nonce: string; hmac: string };
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "allow-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(executeSpy).toHaveBeenCalled();
    expect(results[0].is_error).toBeUndefined();
  });

  it("user grants out-of-allowed-dir → native file tool receives the same invocation scope", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-executor-native-scope-"));
    try {
      const target = join(outside, "notes.md");
      writeFileSync(target, "outside approved\n", "utf8");
      const registry = new ToolRegistry();
      registry.register(new ReadFileTool());

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-native-scope", name: "read_file", input: { path: target } }],
        { sessionId: "sess-l1-native-scope", permissionContext: userPermissionContext() },
      );

      await new Promise((r) => setTimeout(r, 5));
      const sent = wc.send.mock.calls[0][1] as { id: string; nonce: string; hmac: string };
      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      expect(results[0].content).toContain("outside approved");
      expect(results[0].is_error).toBeUndefined();
      expect(readFileSync(target, "utf8")).toBe("outside approved\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("headless mode + out-of-allowed-dir → fail-closed when reviewer is not wired", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

    const results = await executor.executeAll(
      [{
        id: "tu-l1-4",
        name: "read_file",
        input: { path: "/var/tmp/headless-area/data.txt" },
      }],
      {
        sessionId: "sess-l1-headless",
        permissionContext: userPermissionContext({ headless: true }),
      },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("headless");
    // Headless never shows a dialog — webContents.send must not have been
    // called for an out-of-allowed-dir request.
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("strict headless read defers even when reviewer would allow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-strict-headless-"));
    try {
      const executeSpy = vi.fn(async () => "ok");
      const registry = new ToolRegistry();
      registry.register(makeReadFileTool(executeSpy));

      const classifier: RiskClassifier = {
        classify: vi.fn(() => ({ level: "low", reason: "reviewer would allow" })),
      };
      const queue = new DeferredQueue(join(dir, "deferred-queue.jsonl"));
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("strict");
      permMgr.setReviewer({
        classifier,
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: queue,
      });

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

      const results = await executor.executeAll(
        [{
          id: "tu-strict-headless-read",
          name: "read_file",
          input: { path: "/var/tmp/strict-headless/data.txt" },
        }],
        {
          sessionId: "sess-strict-headless-read",
          permissionContext: userPermissionContext({ headless: true }),
        },
      );

      expect(executeSpy).not.toHaveBeenCalled();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(wc.send).not.toHaveBeenCalled();
      expect(results[0].is_error).toBe(true);
      expect(results[0].content).toContain("strict headless");
      expect(queue.listPending()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("user-supplied additionalDirectories grants access without modal", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

    const results = await executor.executeAll(
      [{
        id: "tu-l1-5",
        name: "read_file",
        input: { path: "/var/tmp/explicitly-allowed/foo.md" },
      }],
      {
        sessionId: "sess-l1-grant",
        permissionContext: userPermissionContext({
          additionalDirectories: ["/var/tmp/explicitly-allowed"],
        }),
      },
    );

    expect(executeSpy).toHaveBeenCalled();
    expect(results[0].is_error).toBeUndefined();
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("filesystem root additionalDirectories is sanitized and does not grant access", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-root-extra",
        name: "read_file",
        input: { path: "/var/tmp/root-extra-should-not-grant/foo.md" },
      }],
      {
        sessionId: "sess-l1-root-extra",
        permissionContext: userPermissionContext({
          additionalDirectories: ["/"],
        }),
      },
    );

    await new Promise((r) => setTimeout(r, 5));
    expect(wc.send).toHaveBeenCalled();
    const sent = wc.send.mock.calls[0][1] as { id: string; nonce: string; hmac: string; kind?: string };
    expect(sent.kind).toBe("out-of-allowed-dir");
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "deny-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
  });

  it("fails closed when the executor cwd is the filesystem root", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/");
    try {
      const executeSpy = vi.fn(async () => "ok");
      const registry = new ToolRegistry();
      registry.register(makeReadFileTool(executeSpy));
      const executor = new ToolExecutor(registry);

      const results = await executor.executeAll(
        [{ id: "tu-root-cwd", name: "read_file", input: { path: "/var/tmp/a.txt" } }],
        { sessionId: "sess-root-cwd", permissionContext: userPermissionContext() },
      );

      expect(executeSpy).not.toHaveBeenCalled();
      expect(results[0].is_error).toBe(true);
      expect(results[0].content).toContain("execution cwd is filesystem root");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("routes builtin, plugin, and MCP sources through the same permission decision path", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    const registerWriteTool = (
      name: string,
      source: "builtin" | "plugin" | "mcp",
      ids: { pluginId?: string; mcpServerId?: string } = {},
    ) => {
      registry.register(createDynamicTool({
        name,
        description: `${source} write surface`,
        source,
        category: "write",
        ...ids,
        isReadOnly: () => false,
        jsonSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
        execute: async (rawInput) => {
          const value = await executeSpy(rawInput);
          return { output: String(value), isError: false };
        },
      }));
    };
    registerWriteTool("native_write_surface", "builtin");
    registerWriteTool("plugin_write_surface", "plugin", { pluginId: "generic-plugin" });
    registerWriteTool("mcp_write_surface", "mcp", { mcpServerId: "generic-mcp" });

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    const checkSpy = vi.spyOn(permMgr, "checkDetailed").mockImplementation(
      (_toolName, source, category) => ({
        decision: "deny",
        reason: `blocked by unified policy: ${source}/${category}`,
        layer: 3,
      }),
    );
    const executor = new ToolExecutor(registry, undefined, permMgr);

    const results = await executor.executeAll(
      [
        { id: "tu-native", name: "native_write_surface", input: { value: "a" } },
        { id: "tu-plugin", name: "plugin_write_surface", input: { value: "b" } },
        { id: "tu-mcp", name: "mcp_write_surface", input: { value: "c" } },
      ],
      { sessionId: "sess-unified-tool-sources", permissionContext: userPermissionContext() },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(results.map((result) => result.is_error)).toEqual([true, true, true]);
    expect(checkSpy.mock.calls.map(([toolName, source, category]) => [toolName, source, category])).toEqual([
      ["native_write_surface", "builtin", "write"],
      ["plugin_write_surface", "plugin", "write"],
      ["mcp_write_surface", "mcp", "write"],
    ]);
  });

  it("routes actual plugin and MCP adapters through ToolExecutor before invoking handlers", async () => {
    const pluginCall = vi.fn(async () => ({ ok: true }));
    const mcpCall = vi.fn(async () => ({ text: "ok" }));
    const manifest = {
      id: "adapter-plugin",
      name: "adapter-plugin",
      version: "1.0.0",
      main: "entry.js",
      tools: ["adapter_write"],
      toolSchemas: {
        adapter_write: {
          description: "Adapter write fixture",
          category: "write",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
      },
    } as PluginManifest;
    const registry = new ToolRegistry();
    for (const tool of pluginToolsForRegistration(
      { call: pluginCall } as unknown as PluginRuntime,
      "adapter-plugin",
      manifest,
    )) {
      registry.register(tool);
    }
    registry.register(mcpToolToTool(
      "adapter-mcp",
      "mcp_adapter_write",
      {
        name: "write",
        description: "MCP adapter write fixture",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      mcpCall,
    ));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    const checkSpy = vi.spyOn(permMgr, "checkDetailed").mockImplementation(
      (_toolName, source, category) => ({
        decision: "deny",
        reason: `blocked by unified policy: ${source}/${category}`,
        layer: 3,
      }),
    );
    const executor = new ToolExecutor(registry, undefined, permMgr);

    const results = await executor.executeAll(
      [
        { id: "tu-plugin-adapter", name: "adapter_write", input: { value: "p" } },
        { id: "tu-mcp-adapter", name: "mcp_adapter_write", input: { value: "m" } },
      ],
      { sessionId: "sess-adapter-unified", permissionContext: userPermissionContext() },
    );

    expect(pluginCall).not.toHaveBeenCalled();
    expect(mcpCall).not.toHaveBeenCalled();
    expect(results.map((result) => result.is_error)).toEqual([true, true]);
    expect(checkSpy.mock.calls.map(([toolName, source, category]) => [toolName, source, category])).toEqual([
      ["adapter_write", "plugin", "write"],
      ["mcp_adapter_write", "mcp", "network"],
    ]);
  });

  it("ToolExecutor path policy uses declared Tool.pathFields", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "plugin_scan",
      description: "Scan folder",
      source: "builtin",
      category: "read",
      pathFields: ["folder"],
      isReadOnly: () => true,
      jsonSchema: {
        type: "object",
        properties: { folder: { type: "string" } },
        required: ["folder"],
      },
      execute: async (rawInput) => {
        const value = await executeSpy(rawInput);
        return { output: String(value), isError: false };
      },
    }));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-plugin-pathfields",
        name: "plugin_scan",
        input: { folder: "/var/tmp/plugin-folder/input" },
      }],
      { sessionId: "sess-l1-plugin-pathfields", permissionContext: userPermissionContext() },
    );

    await new Promise((r) => setTimeout(r, 5));
    expect(wc.send).toHaveBeenCalled();
    const sent = wc.send.mock.calls[0][1] as {
      id: string;
      nonce: string;
      hmac: string;
      kind?: string;
      outOfAllowedDir?: { candidatePath?: string };
    };
    expect(sent.kind).toBe("out-of-allowed-dir");
    expect(sent.outOfAllowedDir?.candidatePath).toContain("plugin-folder/input");
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "deny-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
  });

  it("ToolExecutor path policy follows dotted Tool.pathFields", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "plugin_nested_scan",
      description: "Scan nested target",
      source: "plugin",
      pluginId: "nested-plugin",
      category: "read",
      pathFields: ["target.path"],
      isReadOnly: () => true,
      jsonSchema: {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        required: ["target"],
      },
      execute: async (rawInput) => {
        const value = await executeSpy(rawInput);
        return { output: String(value), isError: false };
      },
    }));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-plugin-dotted-pathfields",
        name: "plugin_nested_scan",
        input: { target: { path: "/var/tmp/plugin-folder/nested/input" } },
      }],
      { sessionId: "sess-l1-plugin-dotted-pathfields", permissionContext: userPermissionContext() },
    );

    await new Promise((r) => setTimeout(r, 5));
    expect(wc.send).toHaveBeenCalled();
    const sent = wc.send.mock.calls[0][1] as {
      id: string;
      nonce: string;
      hmac: string;
      kind?: string;
      outOfAllowedDir?: { candidatePath?: string };
    };
    expect(sent.kind).toBe("out-of-allowed-dir");
    expect(sent.outOfAllowedDir?.candidatePath).toContain("plugin-folder/nested/input");
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "deny-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
  });

  it("Layer 0 still beats Layer 1 — sensitive path inside an allowed dir is denied", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

    const homedir = (await import("node:os")).homedir;
    const sensitive = `${homedir()}/.lvis/secrets/openai.key`;
    const results = await executor.executeAll(
      [{ id: "tu-l1-6", name: "read_file", input: { path: sensitive } }],
      {
        sessionId: "sess-l1-l0win",
        permissionContext: userPermissionContext({
          additionalDirectories: [`${homedir()}/.lvis`],
        }),
      },
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("민감 경로 차단");
  });
});
