/**
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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { buildPluginToolsForTest } from "../../plugins/__tests__/plugin-tool-test-fixture.js";
import type { PluginManifest } from "../../plugins/types.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
} from "../../permissions/sensitive-paths.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedPluginWorkersForTest,
  getHostShellExecutionPlan,
  markPluginWorkerWrapped,
  setActiveSandboxCapability,
  setSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { getHostShellExecutionPlanAuditProjection } from "../../permissions/host-shell-execution-plan.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { approvalCacheKeyFor } from "../pipeline/display-mask.js";

// ─── Helpers ─────────────────────────────────────────

async function waitForApprovalPayload<T>(
  wc: ReturnType<typeof makeMockWebContents>,
  index = 0,
): Promise<T> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const payload = wc.send.mock.calls[index]?.[1];
    if (payload) return payload as T;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("approval request was not sent");
}

function userPermissionContext(
  overrides: Partial<import("../executor.js").ToolPermissionContext> = {},
): import("../executor.js").ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

function comparablePath(path: string | undefined): string {
  // Keep test comparisons aligned with the executor's canonical path helper.
  // Non-path strings are approval messages; normalize separators/case only.
  const raw = path ?? "";
  if (!raw) return "";
  const pathish = process.platform === "win32"
    ? /^[a-z]:[\\/]/i.test(raw) || raw.startsWith("\\\\")
    : raw.startsWith("/");
  if (!pathish) {
    return raw.replace(/\\/g, "/").toLowerCase();
  }
  return caseFoldForMatch(canonicalizePathForMatch(raw)).replace(/\\/g, "/").toLowerCase();
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

describe("ToolExecutor — A2A parent delivery capability provenance", () => {
  it.each([
    { hostCapability: true, rawCapability: false },
    { hostCapability: false, rawCapability: true },
  ])(
    "passes host capability $hostCapability and ignores raw-input spoof $rawCapability",
    async ({ hostCapability, rawCapability }) => {
      const captures: Array<{
        input: Record<string, unknown>;
        metadata: Record<string, unknown>;
      }> = [];
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "capture_a2a_parent_delivery",
        description: "Captures host-owned execution metadata.",
        source: "builtin",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: {
          type: "object",
          properties: {
            supportsA2AParentDelivery: { type: "boolean" },
          },
        },
        execute: async (rawInput, ctx) => {
          captures.push({
            input: { ...rawInput },
            metadata: { ...ctx.metadata },
          });
          return { output: "captured", isError: false };
        },
      }));
      const executor = new ToolExecutor(registry);

      const results = await executor.executeAll(
        [{
          id: "capture-a2a-capability",
          name: "capture_a2a_parent_delivery",
          input: { supportsA2AParentDelivery: rawCapability },
        }],
        {
          sessionId: "parent-session",
          supportsA2AParentDelivery: hostCapability,
          permissionContext: userPermissionContext(),
        },
      );

      expect(results[0]).toMatchObject({ content: "captured" });
      expect(captures).toHaveLength(1);
      expect(captures[0].metadata.supportsA2AParentDelivery).toBe(hostCapability);
      expect(captures[0].input.supportsA2AParentDelivery).toBe(rawCapability);
    },
  );
});

/**
 * Sensitive-path hard-block fixtures in this block exercise behavior adapted
 * from OpenHarness's permission checker (MIT License):
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/permissions/checker.py
 * Copyright (c) 2025 OpenHarness Contributors
 */
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

  it.skipIf(process.platform === "win32")("threads shell approvalCacheKey through permission rules so one command does not authorize another", async () => {
    const registry = new ToolRegistry();
    const bash = new BashTool();
    registry.register(bash);
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);

    const permissionPath = join(mkdtempSync(join(tmpdir(), "lvis-shell-approval-")), "permissions.json");
    const permMgr = new PermissionManager(permissionPath);
    const firstInput = { command: "echo safe", timeoutSeconds: 1 };
    const secondInput = { command: "echo different", timeoutSeconds: 1 };
    const firstApprovalCacheKey = approvalCacheKeyFor(
      bash,
      firstInput,
      process.cwd(),
      getHostShellExecutionPlanAuditProjection(getHostShellExecutionPlan()),
    );
    if (firstApprovalCacheKey === undefined) {
      throw new Error("Bash must provide a sealed-plan approval cache key");
    }
    await permMgr.addAlwaysAllowedPersist(firstApprovalCacheKey);

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

  it("hard-blocks sensitive shell paths before approval prompts or allow-always persistence", async () => {
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

  it("queues headless shell out-of-allowed-dir access instead of executing after a LOW reviewer verdict", async () => {
    const registry = new ToolRegistry();
    const bash = new BashTool();
    const executeSpy = vi.spyOn(bash, "execute");
    registry.register(bash);
    const dir = mkdtempSync(join(tmpdir(), "lvis-headless-outdir-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "lvis-headless-outside-"));
    const outsideFile = join(outsideDir, "probe.txt");
    writeFileSync(outsideFile, "blocked", "utf-8");

    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      const deferredQueue = new DeferredQueue(join(dir, "deferred-queue.jsonl"));
      permMgr.setReviewer({
        classifier: {
          classify: vi.fn(() => ({ level: "low", reason: "reviewer would otherwise allow" })),
        },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue,
      });
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
        [{ id: "tu-headless-outdir", name: "bash", input: { command: `cat ${outsideFile}`, timeoutSeconds: 1 } }],
        { sessionId: "sess-headless-outdir", permissionContext: userPermissionContext({ headless: true, trustOrigin: "llm-tool-arg" }) },
      );

      expect(result[0].is_error).toBe(true);
      expect(result[0].content).toContain("권한 보류");
      expect(result[0].content).toContain("허용 디렉토리 외부 경로 접근");
      expect(executeSpy).not.toHaveBeenCalled();
      const pending = deferredQueue.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        toolName: "bash",
        source: "builtin",
        category: "shell",
        verdict: expect.objectContaining({
          level: "high",
          reason: "headless out-of-allowed-dir requires manual directory approval",
        }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["sensitive env-home operand", "Get-Content $HOME/.ssh/id_rsa"],
    ["sensitive quoted operand", "Get-Content '~/.ssh/id_rsa'"],
    ["sensitive redirection target", "Get-Content package.json > ~/.ssh/leak"],
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

  it("interactive auto-approve LOW in auto mode silently allows mutating tool calls", async () => {
    // Foreground reviewer auto-approval requires BOTH explicit auto mode and
    // the configured interactive threshold. The test asserts:
    //   1. With setInteractiveAutoApprove("low") + reviewer LOW verdict,
    //      the tool executes without an approval modal (no `is_error`).
    //   2. The audit entry records `decision: "allow"` with the reviewer
    //      verdict (so the trail still shows what bypassed the modal).
    const executeSpy = vi.fn(async () => "reviewed write");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_write_probe_p3",
      description: "P3 interactive auto-approve probe",
      source: "plugin",
      pluginId: "test-plugin",
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
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-interactive-p3-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      permMgr.setInteractiveAutoApprove("low");
      permMgr.setReviewer({
        classifier: {
          classify: vi.fn(() => ({ level: "low", reason: "reviewer says safe" })),
        },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
      });
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
      const permissionReviewEvents: import("../../shared/permission-review-status.js").PermissionReviewEvent[] = [];

      const result = await executor.executeAll(
        [{ id: "tu-p3-interactive", name: "reviewed_write_probe_p3", input: { payload: "ok" } }],
        {
          sessionId: "sess-p3-interactive",
          callbacks: {
            onPermissionReview: (event) => permissionReviewEvents.push(event),
          },
          permissionContext: userPermissionContext({
            userIntent: "프로젝트 규정을 찾기 위해 플러그인 조회를 실행합니다.",
          }),
        },
      );

      // Tool ran silently — no modal, no is_error.
      expect(result[0].is_error).toBeUndefined();
      expect(executeSpy).toHaveBeenCalledOnce();
      // Audit captures the reviewer verdict so the bypass is auditable.
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        decision: "allow",
        tool: "reviewed_write_probe_p3",
        reviewer: expect.objectContaining({
          level: "low",
          reason: "reviewer says safe",
        }),
      }));
      expect(permissionReviewEvents.map((event) => event.status)).toEqual([
        "reviewing",
        "auto_approved",
      ]);
      expect(permissionReviewEvents[0]).toMatchObject({
        toolName: "reviewed_write_probe_p3",
        groupId: expect.any(String),
        toolUseId: "tu-p3-interactive",
        approvalPurpose: {
          source: "conversation",
          confidence: "sufficient",
          text: expect.stringContaining("프로젝트 규정을 찾기 위해"),
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interactive threshold in default mode falls back to the user-approval modal without reviewer classification", async () => {
    // Negative companion to the test above: a configured interactive
    // threshold does not activate the foreground reviewer outside auto mode.
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_write_probe_p3_off",
      description: "P3 off-state probe",
      source: "plugin",
      pluginId: "test-plugin",
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
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-interactive-p3-off-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("default");
      permMgr.setInteractiveAutoApprove("low");
      const classifySpy = vi.fn(() => ({ level: "low" as const, reason: "reviewer says safe" }));
      permMgr.setReviewer({
        classifier: { classify: classifySpy },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
      });
      const auditLogger = {
        log: vi.fn(),
        isPermissionAuditChainReady: vi.fn(() => true),
        assertPermissionAuditWritable: vi.fn(),
        appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => ({ ...entry, prevHash: "h" })),
      };
      const gate = {
        requestAndWait: vi.fn(async (req: { id: string }) => ({
          requestId: req.id,
          choice: "deny-once" as const,
        })),
      };
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        gate as never,
        undefined,
        auditLogger as never,
      );
      const result = await executor.executeAll(
        [{ id: "tu-p3-off", name: "reviewed_write_probe_p3_off", input: { payload: "ok" } }],
        { sessionId: "sess-p3-off", permissionContext: userPermissionContext() },
      );
      // The normal approval gate handles the request and denies execution.
      expect(executeSpy).not.toHaveBeenCalled();
      expect(result[0].is_error).toBe(true);
      expect(classifySpy).not.toHaveBeenCalled();
      expect(gate.requestAndWait).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        mode: "default",
        reviewerVerdict: undefined,
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interactive auto-review MEDIUM opens the approval gate with the reviewer verdict (deny-once blocks execution)", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_network_probe_medium",
      description: "MEDIUM reviewer approval probe",
      source: "plugin",
      pluginId: "test-plugin",
      category: "network",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-interactive-medium-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      permMgr.setInteractiveAutoApprove("low");
      const classifySpy = vi.fn((ctx: import("../../permissions/reviewer/risk-classifier.js").ToolInvocationContext) => ({
        level: "medium" as const,
        reason: `reviewed ${String(ctx.finalInput.payload)}`,
      }));
      permMgr.setReviewer({
        classifier: { classify: classifySpy },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
      });
      const requestAndWait = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "deny-once" as const,
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        { requestAndWait } as never,
      );
      const permissionReviewEvents: import("../../shared/permission-review-status.js").PermissionReviewEvent[] = [];

      const result = await executor.executeAll(
        [{
          id: "tu-medium-review",
          name: "reviewed_network_probe_medium",
          input: { payload: "send alice@example.com with sk-abcdefghijklmnopqrstuvwxyz" },
        }],
        {
          sessionId: "sess-medium-review",
          callbacks: {
            onPermissionReview: (event) => permissionReviewEvents.push(event),
          },
          permissionContext: userPermissionContext({
            userIntent: "테스트 알림 전송 경로를 확인합니다.",
          }),
        },
      );

      // Phase 0: a non-LOW foreground verdict now routes to the user approval
      // modal instead of silently hard-denying. The user is the authority — a
      // deny-once at the gate yields a blocked tool result (no execution).
      expect(result[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(permissionReviewEvents.map((event) => event.status)).toEqual([
        "reviewing",
        "needs_approval",
      ]);
      expect(permissionReviewEvents[1]).toMatchObject({
        verdictLevel: "medium",
      });
      const reviewReason = String(permissionReviewEvents[1]?.reason ?? "");
      expect(reviewReason).toContain("***@example.com");
      expect(reviewReason).not.toContain("alice@example.com");
      expect(reviewReason).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      // The modal opened, carrying the Layer-5 reviewer verdict and reason so
      // the dialog can render the risk (HIGH forces session-only + NL).
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reviewerVerdict: expect.objectContaining({ level: "medium" }),
        reason: expect.stringContaining("reviewer medium"),
      }));
      const reviewerCtx = classifySpy.mock.calls[0]?.[0];
      expect(reviewerCtx?.finalInput).toMatchObject({
        payload: "send ***@example.com with [REDACTED:TOKEN]",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reviewer-rated write asks once; allow-always suppresses the prompt on the next identical call", async () => {
    const executeSpy = vi.fn(async () => "sent");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_network_probe_retry",
      description: "MEDIUM reviewer retry probe",
      source: "plugin",
      pluginId: "test-plugin",
      category: "network",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-interactive-retry-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      permMgr.setInteractiveAutoApprove("low");
      const classifySpy = vi.fn(() => ({
        level: "medium" as const,
        reason: "needs user confirmation",
      }));
      permMgr.setReviewer({
        classifier: { classify: classifySpy },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
      });
      // The user picks "allow-always" at the modal — the executor persists an
      // always-allow rule so the next identical call short-circuits before the
      // reviewer/modal lane (no re-prompt).
      const requestAndWait = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-always" as const,
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        { requestAndWait } as never,
      );
      const input = { payload: "send release notice" };

      const first = await executor.executeAll(
        [{ id: "tu-retry-first", name: "reviewed_network_probe_retry", input }],
        {
          sessionId: "sess-reviewer-retry",
          permissionContext: userPermissionContext({
            userIntent: "릴리즈 안내 전송 경로를 확인합니다.",
          }),
        },
      );
      // First call: reviewer rated non-LOW → modal opened → user allow-always → executed.
      expect(first[0].is_error).toBeUndefined();
      expect(first[0].content).toBe("sent");
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reviewerVerdict: expect.objectContaining({ level: "medium" }),
      }));

      const second = await executor.executeAll(
        [{ id: "tu-retry-second", name: "reviewed_network_probe_retry", input }],
        {
          sessionId: "sess-reviewer-retry",
          permissionContext: userPermissionContext({
            userIntent: "다시 전송",
          }),
        },
      );

      // Second identical call: allow-always rule satisfies it without re-prompting.
      expect(second[0].is_error).toBeUndefined();
      expect(second[0].content).toBe("sent");
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(classifySpy).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Phase 0 foreground deny→ask change does not affect the headless lane (still defers to the queue, no modal)", async () => {
    const executeSpy = vi.fn(async () => "sent");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_network_probe_headless",
      description: "MEDIUM reviewer headless probe",
      source: "plugin",
      pluginId: "test-plugin",
      category: "network",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-headless-defer-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      permMgr.setInteractiveAutoApprove("low");
      const classifySpy = vi.fn(() => ({
        level: "medium" as const,
        reason: "headless data egress",
      }));
      const queue = new DeferredQueue(join(dir, "deferred-queue.jsonl"));
      permMgr.setReviewer({
        classifier: { classify: classifySpy },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: queue,
      });
      const requestAndWait = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        { requestAndWait } as never,
      );

      const result = await executor.executeAll(
        [{ id: "tu-headless-defer", name: "reviewed_network_probe_headless", input: { payload: "send summary" } }],
        {
          sessionId: "sess-headless-defer",
          permissionContext: userPermissionContext({
            headless: true,
            trustOrigin: "llm-tool-arg",
          }),
        },
      );

      // Headless has no renderer — the foreground deny→ask flip must NOT leak
      // here. The request defers to the manual queue, the modal is never opened,
      // and the tool does not execute.
      expect(result[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(requestAndWait).not.toHaveBeenCalled();
      expect(queue.listPending()).toHaveLength(1);
      expect(queue.listPending()[0].verdict.level).toBe("medium");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never treats free-form retry text as authority for changed tool input", async () => {
    const executeSpy = vi.fn(async () => "sent");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_network_probe_retry_changed",
      description: "MEDIUM reviewer retry probe changed input",
      source: "plugin",
      pluginId: "test-plugin",
      category: "network",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-interactive-retry-changed-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      permMgr.setInteractiveAutoApprove("low");
      const classifySpy = vi.fn(() => ({
        level: "medium" as const,
        reason: "needs user confirmation",
      }));
      permMgr.setReviewer({
        classifier: { classify: classifySpy },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
      });
      const executor = new ToolExecutor(registry, undefined, permMgr);

      const first = await executor.executeAll(
        [{
          id: "tu-retry-changed-first",
          name: "reviewed_network_probe_retry_changed",
          input: { payload: "send release notice" },
        }],
        {
          sessionId: "sess-reviewer-retry-changed",
          permissionContext: userPermissionContext({
            userIntent: "릴리즈 안내 전송 경로를 확인합니다.",
          }),
        },
      );
      expect(first[0].is_error).toBe(true);

      const second = await executor.executeAll(
        [{
          id: "tu-retry-changed-second",
          name: "reviewed_network_probe_retry_changed",
          input: { payload: "send secrets instead" },
        }],
        {
          sessionId: "sess-reviewer-retry-changed",
          permissionContext: userPermissionContext({
            userIntent: "진행해",
          }),
        },
      );

      expect(second[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(classifySpy).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records reviewer verdict on auto-reviewed LOW allow audit entries", async () => {
    const executeSpy = vi.fn(async () => "reviewed write");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_write_probe",
      description: "reviewed write probe",
      source: "plugin",
      pluginId: "test-plugin",
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
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-reviewer-audit-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      // Round-1 critic MAJOR-2: `mode=auto` alone no longer enables
      // foreground-auto reviewer; the interactive setting is the SOT.
      // The UI couples both flips when the user picks `auto` exec mode.
      permMgr.setInteractiveAutoApprove("low");
      permMgr.setReviewer({
        classifier: {
          classify: vi.fn(() => ({ level: "low", reason: "reviewer says safe" })),
        },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
      });
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
        [{ id: "tu-reviewed-write", name: "reviewed_write_probe", input: { payload: "ok" } }],
        { sessionId: "sess-reviewed-write", permissionContext: userPermissionContext() },
      );

      expect(result[0].is_error).toBeUndefined();
      expect(executeSpy).toHaveBeenCalledOnce();
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        decision: "allow",
        tool: "reviewed_write_probe",
        reviewer: expect.objectContaining({
          level: "low",
          reason: "reviewer says safe",
        }),
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  it("forces sub-agent message tool calls through the receiver ApprovalGate with provenance", async () => {
    const executeSpy = vi.fn(async () => "read");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_read_probe",
      description: "A2A receiver gate probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({
      decision: "allow",
      reason: "would otherwise allow",
      layer: 3,
    });
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      })),
    };
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: () => true,
      assertPermissionAuditWritable: () => undefined,
      appendPermissionAuditEntry: vi.fn(async () => undefined),
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

    const results = await executor.executeAll(
      [{ id: "tu-a2a-receiver", name: "a2a_read_probe", input: {} }],
      {
        sessionId: "sess-a2a-receiver",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "agent-message" }),
      },
    );

    expect(results[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(approvalGate.requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "[Sub-Agent: researcher] would otherwise allow",
        trustOrigin: "agent-message",
      }),
    );
    expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ trustOrigin: "agent-message" }),
    );
  });

  it("re-elevates always-allow meta tools for sub-agent message provenance", async () => {
    const executeSpy = vi.fn(async () => "asked");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_always_allow_meta_probe",
      description: "A2A always-allow receiver gate probe",
      source: "builtin",
      category: "meta",
      decisionOverride: "always-allow-with-audit",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = vi.fn(() => ({
      decision: "allow",
      reason: "receiver meta auto-allow",
      layer: 6,
    }));
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      })),
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
    );

    const results = await executor.executeAll(
      [{ id: "tu-a2a-meta", name: "a2a_always_allow_meta_probe", input: {} }],
      {
        sessionId: "sess-a2a-meta",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(results[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(permMgr.checkDetailed).toHaveBeenCalledOnce();
    expect(approvalGate.requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "a2a_always_allow_meta_probe",
        toolCategory: "meta",
        isReadOnly: false,
        reason: "[Sub-Agent: researcher] receiver meta auto-allow",
      }),
    );
  });
  it("preserves receiver deny rules for sub-agent message tool calls", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_denied_probe",
      description: "A2A receiver deny probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({
      decision: "deny",
      reason: "receiver deny",
      layer: 1,
    });
    const approvalGate = { requestAndWait: vi.fn() };
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
    );

    const results = await executor.executeAll(
      [{ id: "tu-a2a-denied", name: "a2a_denied_probe", input: {} }],
      {
        sessionId: "sess-a2a-denied",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(results[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
  });

  it("forces receiver ApprovalGate when A2A provenance exists without PermissionManager", async () => {
    const executeSpy = vi.fn(async () => "approved");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_no_manager_probe",
      description: "A2A no-manager receiver gate probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));
    const approvalGate = {
      requestAndWait: vi.fn(async (request: { id: string }) => ({
        requestId: request.id,
        choice: "allow-once" as const,
      })),
    };
    const executor = new ToolExecutor(
      registry,
      undefined,
      undefined,
      undefined,
      approvalGate as never,
    );

    const results = await executor.executeAll(
      [{ id: "tu-a2a-no-manager", name: "a2a_no_manager_probe", input: {} }],
      {
        sessionId: "sess-a2a-no-manager",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(results[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(approvalGate.requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "a2a_no_manager_probe",
        isReadOnly: false,
        reason: "[Sub-Agent: researcher] cross-agent message requires receiver approval",
      }),
    );
  });

  it("fails closed when A2A provenance has neither PermissionManager nor ApprovalGate", async () => {
    const executeSpy = vi.fn(async () => "must-not-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "a2a_no_gate_probe",
      description: "A2A missing receiver gate probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));
    const executor = new ToolExecutor(registry);

    const results = await executor.executeAll(
      [{ id: "tu-a2a-no-gate", name: "a2a_no_gate_probe", input: {} }],
      {
        sessionId: "sess-a2a-no-gate",
        approvalReasonPrefix: "[Sub-Agent: researcher]",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(results[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

// ─── D4 §4.5.3 — ordered tool approval/execution ─────────────

/**
 * D4: When the LLM emits multiple non-parallel tool_calls in one round,
 * executeAll runs them in the exact emitted order. Each call still reaches
 * the approval gate, but later calls must not start until earlier calls have
 * resolved.
 * This test verifies:
 *   1. Only the first approval request is pending before it is resolved.
 *   2. Resolving one request advances to the next request in order.
 *   3. Tool execution order matches the LLM-emitted tool call order.
 *   4. Denials continue to the later tool calls without reordering.
 */
describe("ToolExecutor — D4 ordered approval/execution (§4.5.3)", () => {
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

  it("LLM이 낸 tool_call 순서대로 승인 요청과 실행이 진행됨", async () => {
    const executionOrder: string[] = [];
    const spy1 = vi.fn(async () => {
      executionOrder.push("tool_a");
      return "result-A";
    });
    const spy2 = vi.fn(async () => {
      executionOrder.push("tool_b");
      return "result-B";
    });

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_a", spy1));
    registry.register(makeGenericTool("tool_b", spy2));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "ordered test", layer: 5 });

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

    await waitForPending(gate, 1);
    expect(gate.pendingCount).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].toolName).toBe("tool_a");
    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();

    gate.resolve(sent[0].id, { requestId: sent[0].id, choice: "allow-once", nonce: sent[0].nonce, hmac: sent[0].hmac });
    await waitForPending(gate, 1);
    expect(sent).toHaveLength(2);
    expect(sent[1].toolName).toBe("tool_b");
    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).not.toHaveBeenCalled();

    gate.resolve(sent[1].id, { requestId: sent[1].id, choice: "allow-once", nonce: sent[1].nonce, hmac: sent[1].hmac });

    const results = await execPromise;

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.is_error)).toBe(true);
    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledTimes(1);
    expect(executionOrder).toEqual(["tool_a", "tool_b"]);
  }, 10000);

  it("두 도구 순서 거부 → 두 결과 모두 오류", async () => {
    const spy1 = vi.fn(async () => "should-not-run");
    const spy2 = vi.fn(async () => "should-not-run");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_c", spy1));
    registry.register(makeGenericTool("tool_d", spy2));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "ordered deny test", layer: 5 });

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

    await waitForPending(gate, 1);
    expect(gate.pendingCount).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].toolName).toBe("tool_c");

    gate.resolve(sent[0].id, { requestId: sent[0].id, choice: "deny-once", nonce: sent[0].nonce, hmac: sent[0].hmac });
    await waitForPending(gate, 1);
    expect(sent).toHaveLength(2);
    expect(sent[1].toolName).toBe("tool_d");

    gate.resolve(sent[1].id, { requestId: sent[1].id, choice: "deny-once", nonce: sent[1].nonce, hmac: sent[1].hmac });

    const results = await execPromise;

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.is_error === true)).toBe(true);
    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
  }, 10000);

  it("이미 취소된 turn signal이면 후속 도구를 훅/권한 전에 취소 결과로 닫음", async () => {
    const spy1 = vi.fn(async () => "should-not-run");
    const spy2 = vi.fn(async () => "should-not-run");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_cancel_a", spy1));
    registry.register(makeGenericTool("tool_cancel_b", spy2));

    const executor = new ToolExecutor(registry);
    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));

    const events: string[] = [];
    const results = await executor.executeAll(
      [
        { id: "cancel-1", name: "tool_cancel_a", input: { value: "a" } },
        { id: "cancel-2", name: "tool_cancel_b", input: { value: "b" } },
      ],
      {
        abortSignal: ac.signal,
        permissionContext: userPermissionContext(),
        callbacks: {
          onToolStart: (name) => events.push(`start:${name}`),
          onToolEnd: (name, result, isError) => events.push(`end:${name}:${isError}:${result}`),
        },
      },
    );

    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.is_error === true)).toBe(true);
    expect(results.every((result) => result.content.includes("취소"))).toBe(true);
    expect(events).toEqual([
      "start:tool_cancel_a",
      "end:tool_cancel_a:true:도구 실행이 취소되었습니다.",
      "start:tool_cancel_b",
      "end:tool_cancel_b:true:도구 실행이 취소되었습니다.",
    ]);
  });

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

    await waitForPending(gate, 1);
    expect(sent).toHaveLength(1);
    expect(sent[0].toolName).toBe("tool_e");

    const reqE = sent[0];
    gate.resolve(reqE.id, { requestId: reqE.id, choice: "allow-once", nonce: reqE.nonce, hmac: reqE.hmac });

    await waitForPending(gate, 1);
    expect(sent).toHaveLength(2);
    expect(sent[1].toolName).toBe("tool_f");

    const reqF = sent[1];
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

  it("parallelSafe 도구 segment 는 동시에 실행하되 결과 순서는 유지", async () => {
    const started: string[] = [];
    const resolvers = new Map<string, (value: { output: string; isError: boolean }) => void>();
    const makeParallelTool = (name: string) => createDynamicTool({
      name,
      description: `parallel ${name}`,
      source: "builtin",
      category: "read",
      parallelSafe: true,
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => {
        started.push(name);
        return await new Promise<{ output: string; isError: boolean }>((resolve) => {
          resolvers.set(name, resolve);
        });
      },
    });

    const registry = new ToolRegistry();
    registry.register(makeParallelTool("parallel_a"));
    registry.register(makeParallelTool("parallel_b"));
    const executor = new ToolExecutor(registry);

    const execPromise = executor.executeAll(
      [
        { id: "pa", name: "parallel_a", input: {} },
        { id: "pb", name: "parallel_b", input: {} },
      ],
      { sessionId: "sess-parallel-safe", permissionContext: userPermissionContext() },
    );

    const deadline = Date.now() + 1000;
    while (started.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(started).toEqual(["parallel_a", "parallel_b"]);
    resolvers.get("parallel_b")?.({ output: "B", isError: false });
    resolvers.get("parallel_a")?.({ output: "A", isError: false });

    const results = await execPromise;
    expect(results.map((result) => result.tool_use_id)).toEqual(["pa", "pb"]);
    expect(results.map((result) => result.content)).toEqual(["A", "B"]);
  });
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

// ─── agent_spawn honors allow-all mode — no popup in "모두 허용" ──

describe("ToolExecutor — agent_spawn (meta + decisionOverride:'ask') permission gate", () => {
  // Shared helper — single definition used by all sub-groups.
  // Builds a meta tool mirroring agent_spawn's category contract
  // (category:"meta" + decisionOverride:"ask") with a stubbed execute so we
  // can observe whether the executor auto-allowed it or forced the modal.
  function makeSpawnLikeTool(execute: () => Promise<{ output: string; isError: boolean }>) {
    return createDynamicTool({
      name: "agent_spawn",
      description: "spawn a sub-agent",
      source: "builtin",
      category: "meta",
      decisionOverride: "ask",
      jsonSchema: { type: "object", properties: {} },
      execute,
    });
  }

  // ── allow-all carve-out ────────────────────────────────────────────────

  it("in allow mode does NOT force the approval modal and executes", async () => {
    const innerExecuteSpy = vi.fn(async () => ({
      output: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const spawnTool = makeSpawnLikeTool(innerExecuteSpy);

    const registry = new ToolRegistry();
    registry.register(spawnTool);

    // Real PermissionManager in allow-all mode. The PM post-guard's
    // `mode !== "allow"` check must suppress the decisionOverride="ask"
    // re-elevation so agent_spawn auto-allows with no prompt.
    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.setMode("allow");

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const requestSpy = vi.spyOn(gate, "requestAndWait");

    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-spawn-allow", name: "agent_spawn", input: {} }],
      { sessionId: "sess-spawn-allow", permissionContext: userPermissionContext() },
    );

    // No approval modal should have been requested…
    expect(requestSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    // …and the tool should have run.
    expect(innerExecuteSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBeUndefined();
  });

  it.each(["default", "strict", "auto"] as const)(
    "in %s mode STILL forces the approval modal (no §8 gate regression)",
    async (mode) => {
      const innerExecuteSpy = vi.fn(async () => ({
        output: JSON.stringify({ ok: true }),
        isError: false,
      }));
      const spawnTool = makeSpawnLikeTool(innerExecuteSpy);

      const registry = new ToolRegistry();
      registry.register(spawnTool);

      const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
      permMgr.setMode(mode);

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      // Auto-deny the modal so the ask path terminates deterministically; we
      // only care that the modal was requested at all. The executor inspects
      // decision.choice (deny-once) to skip execution.
      const requestSpy = vi
        .spyOn(gate, "requestAndWait")
        .mockResolvedValue({ requestId: "req-test", choice: "deny-once" } as never);

      const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

      await executor.executeAll(
        [{ id: `tu-spawn-${mode}`, name: "agent_spawn", input: {} }],
        { sessionId: `sess-spawn-${mode}`, permissionContext: userPermissionContext() },
      );

      // The decisionOverride:"ask" gate must still force the modal…
      expect(requestSpy).toHaveBeenCalledTimes(1);
      // …and the tool must NOT have run (approval was denied).
      expect(innerExecuteSpy).not.toHaveBeenCalled();
    },
  );

  // ── MAJOR-2 regression — persisted grant must not defeat per-invocation gate ──
  //
  // addAlwaysAllowedPersist("agent_spawn") (= "Allow always" modal click) sets
  // layer-5 alwaysAllowed, so subsequent checkDetailed calls return allow at
  // layer 5 BEFORE categoryBasedDecision runs. The PM post-guard (layer-agnostic)
  // must still re-elevate to ask+forceModal to honour the per-invocation contract.

  it("default mode: modal fires even after addAlwaysAllowedPersist('agent_spawn')", async () => {
    const innerExecuteSpy = vi.fn(async () => ({
      output: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const spawnTool = makeSpawnLikeTool(innerExecuteSpy);

    const registry = new ToolRegistry();
    registry.register(spawnTool);

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.setMode("default");
    // Simulate the user having clicked "Allow always" on a prior invocation.
    await permMgr.addAlwaysAllowedPersist("agent_spawn");

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    // Auto-deny so the test terminates; we only care the modal was requested.
    const requestSpy = vi
      .spyOn(gate, "requestAndWait")
      .mockResolvedValue({ requestId: "req-persist", choice: "deny-once" } as never);

    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    await executor.executeAll(
      [{ id: "tu-spawn-persist", name: "agent_spawn", input: {} }],
      { sessionId: "sess-spawn-persist", permissionContext: userPermissionContext() },
    );

    // The per-invocation decisionOverride:"ask" gate must STILL fire even though
    // alwaysAllowed hit at layer 5 (which would otherwise skip the modal).
    expect(requestSpy).toHaveBeenCalledTimes(1);
    // Tool must NOT have executed (modal was denied).
    expect(innerExecuteSpy).not.toHaveBeenCalled();
  });

  it("allow mode: persisted grant + allow mode → modal does NOT fire (allow-all wins)", async () => {
    const innerExecuteSpy = vi.fn(async () => ({
      output: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const spawnTool = makeSpawnLikeTool(innerExecuteSpy);

    const registry = new ToolRegistry();
    registry.register(spawnTool);

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.setMode("allow");
    await permMgr.addAlwaysAllowedPersist("agent_spawn");

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const requestSpy = vi.spyOn(gate, "requestAndWait");

    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-spawn-persist-allow", name: "agent_spawn", input: {} }],
      { sessionId: "sess-spawn-persist-allow", permissionContext: userPermissionContext() },
    );

    // allow mode: no modal even with persisted grant — allow-all invariant wins.
    expect(requestSpy).not.toHaveBeenCalled();
    expect(innerExecuteSpy).toHaveBeenCalledTimes(1);
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
      pluginId: "test-plugin",
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

    const sent = await waitForApprovalPayload<{
      id: string;
      nonce: string;
      hmac: string;
      kind?: string;
      outOfAllowedDir?: { candidatePath?: string; suggestedParent?: string };
      trustOrigin?: string;
    }>(wc);
    expect(sent.kind).toBe("out-of-allowed-dir");
    expect(sent.outOfAllowedDir?.candidatePath).toContain("file.txt");
    expect(sent.trustOrigin).toBe("user-keyboard");

    // Renderer denies — tool must not execute.
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "deny-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
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

    const sent = await waitForApprovalPayload<{ id: string; nonce: string; hmac: string }>(wc);
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

  it("allow-always resolves the central workspace lifecycle lazily and persists through it", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const allowDirectory = vi.fn(async (root: string) => [root]);
    let lifecycle:
      | import("../../permissions/permission-slash.js").PermissionDirectoryLifecycle
      | undefined;
    const executor = new ToolExecutor(
      registry,
      undefined,
      undefined,
      undefined,
      gate,
      undefined,
      undefined,
      undefined,
      undefined,
      () => lifecycle,
    );

    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-allow-always-lifecycle",
        name: "read_file",
        input: { path: "/var/tmp/persisted-scope/notes.md" },
      }],
      {
        sessionId: "sess-l1-allow-always-lifecycle",
        permissionContext: userPermissionContext(),
      },
    );

    const sent = await waitForApprovalPayload<{
      id: string;
      nonce: string;
      hmac: string;
      outOfAllowedDir?: { suggestedParent?: string };
    }>(wc);
    lifecycle = {
      allowDirectory,
      denyDirectory: vi.fn(async () => []),
    };
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "allow-always",
      rememberPattern: sent.outOfAllowedDir?.suggestedParent,
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(results[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(allowDirectory).toHaveBeenCalledTimes(1);
    expect(allowDirectory).toHaveBeenCalledWith(
      expect.any(String),
      "permission-slash",
    );
  });

  it("allow-always fails closed when a standalone executor has no workspace lifecycle", async () => {
    const previousHome = process.env.LVIS_HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), "lvis-executor-no-lifecycle-"));
    process.env.LVIS_HOME = isolatedHome;
    try {
      const executeSpy = vi.fn(async () => "ok");
      const registry = new ToolRegistry();
      registry.register(makeReadFileTool(executeSpy));
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

      const callPromise = executor.executeAll(
        [{
          id: "tu-l1-allow-always-no-lifecycle",
          name: "read_file",
          input: { path: "/var/tmp/unwired-persisted-scope/notes.md" },
        }],
        {
          sessionId: "sess-l1-allow-always-no-lifecycle",
          permissionContext: userPermissionContext(),
        },
      );

      const sent = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        outOfAllowedDir?: { suggestedParent?: string };
      }>(wc);
      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "allow-always",
        rememberPattern: sent.outOfAllowedDir?.suggestedParent,
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      expect(results[0].is_error).toBe(true);
      expect(results[0].content).toContain("workspace lifecycle unavailable");
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.LVIS_HOME;
      else process.env.LVIS_HOME = previousHome;
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it("allow-once → invokes onTurnDirectoryGrant with the request path (turn-scope grant propagation)", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

    const onTurnDirectoryGrant = vi.fn();
    const onSessionDirectoryGrant = vi.fn();
    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-allow-once-cb",
        name: "read_file",
        input: { path: "/var/tmp/turn-scope/notes.md" },
      }],
      {
        sessionId: "sess-l1-allow-once-cb",
        permissionContext: userPermissionContext({ onTurnDirectoryGrant, onSessionDirectoryGrant }),
      },
    );

    const sent = await waitForApprovalPayload<{ id: string; nonce: string; hmac: string }>(wc);
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "allow-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(results[0].is_error).toBeUndefined();
    expect(onTurnDirectoryGrant).toHaveBeenCalledTimes(1);
    expect(onSessionDirectoryGrant).not.toHaveBeenCalled();
    // Narrow path (not parent) for allow-once.
    expect(onTurnDirectoryGrant.mock.calls[0][0]).toContain("notes.md");
  });

  it("allow-session → invokes onSessionDirectoryGrant with suggestedParent (session-scope widening)", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

    const onTurnDirectoryGrant = vi.fn();
    const onSessionDirectoryGrant = vi.fn();
    const callPromise = executor.executeAll(
      [{
        id: "tu-l1-allow-session-cb",
        name: "read_file",
        input: { path: "/var/tmp/session-scope/proj/notes.md" },
      }],
      {
        sessionId: "sess-l1-allow-session-cb",
        permissionContext: userPermissionContext({ onTurnDirectoryGrant, onSessionDirectoryGrant }),
      },
    );

    const sent = await waitForApprovalPayload<{ id: string; nonce: string; hmac: string; outOfAllowedDir?: { suggestedParent?: string } }>(wc);
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "allow-session",
      rememberPattern: sent.outOfAllowedDir?.suggestedParent,
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;
    expect(results[0].is_error).toBeUndefined();
    expect(onSessionDirectoryGrant).toHaveBeenCalledTimes(1);
    expect(onTurnDirectoryGrant).not.toHaveBeenCalled();
    // session-scope widens to suggestedParent (parent dir) rather than the file path.
    expect(onSessionDirectoryGrant.mock.calls[0][0]).not.toContain("notes.md");
  });

  it("captures post-directory-grant evaluation context for the Step 3 approval", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-executor-context-scope-"));
    try {
      const target = join(outside, "notes.md");
      const executeSpy = vi.fn(async () => "ok");
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "write_file_probe",
        description: "Writes a file.",
        source: "builtin",
        category: "write",
        pathFields: ["path"],
        jsonSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        execute: async (rawInput) => {
          const value = await executeSpy(rawInput);
          return { output: String(value), isError: false };
        },
      }));

      const permMgr = new PermissionManager(join(outside, "permissions.json"));
      permMgr.checkDetailed = () => ({
        decision: "ask",
        reason: "post-directory-grant approval",
        layer: 3,
      });

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-context-scope", name: "write_file_probe", input: { path: target } }],
        { sessionId: "sess-l1-context-scope", permissionContext: userPermissionContext() },
      );

      const directoryRequest = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        evaluationContext?: { allowedDirectories: readonly string[] };
      }>(wc, 0);
      expect(directoryRequest.kind).toBe("out-of-allowed-dir");
      expect(directoryRequest.evaluationContext).toBeTruthy();
      expect(directoryRequest.evaluationContext!.allowedDirectories.map(comparablePath))
        .not.toContain(comparablePath(target));
      gate.resolve(directoryRequest.id, {
        requestId: directoryRequest.id,
        choice: "allow-once",
        nonce: directoryRequest.nonce,
        hmac: directoryRequest.hmac,
      });

      const step3Request = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        evaluationContext?: {
          allowedDirectories: readonly string[];
          targetFilePaths: readonly string[];
        };
      }>(wc, 1);
      expect(step3Request.kind).toBeUndefined();
      expect(step3Request.evaluationContext).toBeTruthy();
      expect(step3Request.evaluationContext!.allowedDirectories.map(comparablePath))
        .toContain(comparablePath(target));
      expect(step3Request.evaluationContext!.targetFilePaths.map(comparablePath))
        .toContain(comparablePath(target));
      gate.resolve(step3Request.id, {
        requestId: step3Request.id,
        choice: "allow-once",
        nonce: step3Request.nonce,
        hmac: step3Request.hmac,
      });

      const results = await callPromise;
      expect(executeSpy).toHaveBeenCalled();
      expect(results[0].is_error).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

      const sent = await waitForApprovalPayload<{ id: string; nonce: string; hmac: string }>(wc);
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

  it("shell operand outside cwd dispatches out-of-allowed-dir approval and denial prevents execution", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-executor-shell-deny-"));
    try {
      const target = join(outside, "hello.txt");
      writeFileSync(target, "outside shell denied\n", "utf8");
      const canonicalTarget = realpathSync(target);
      const registry = new ToolRegistry();
      registry.register(new BashTool());

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-shell-deny", name: "bash", input: { command: `cat ${target}`, timeoutSeconds: 1 } }],
        { sessionId: "sess-l1-shell-deny", permissionContext: userPermissionContext() },
      );

      const sent = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        toolCategory?: string;
        outOfAllowedDir?: { candidatePath?: string };
      }>(wc);
      expect(sent.kind).toBe("out-of-allowed-dir");
      expect(sent.toolCategory).toBe("shell");
      expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toBe(comparablePath(canonicalTarget));

      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "deny-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      expect(results[0].is_error).toBe(true);
      expect(results[0].content).toContain("디렉토리 정책 차단");
      expect(comparablePath(results[0].content)).toContain(comparablePath(canonicalTarget));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("shell operand outside cwd executes after out-of-allowed-dir approval", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-executor-shell-allow-"));
    try {
      const target = join(outside, "hello.txt");
      writeFileSync(target, "outside shell approved\n", "utf8");
      const canonicalTarget = realpathSync(target);
      const registry = new ToolRegistry();
      registry.register(new BashTool());

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-shell-allow", name: "bash", input: { command: `cat ${target}`, timeoutSeconds: 5 } }],
        { sessionId: "sess-l1-shell-allow", permissionContext: userPermissionContext() },
      );

      const sent = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        toolCategory?: string;
        outOfAllowedDir?: { candidatePath?: string };
      }>(wc);
      expect(sent.kind).toBe("out-of-allowed-dir");
      expect(sent.toolCategory).toBe("shell");
      expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toBe(comparablePath(canonicalTarget));

      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      expect(results[0].is_error).toBeUndefined();
      expect(results[0].content).toContain("outside shell approved");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("shell one-time approval covers the requested operand without prompting for /dev/null", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-executor-shell-null-device-"));
    try {
      const target = join(outside, "hello.txt");
      writeFileSync(target, "outside shell approved with null device\n", "utf8");
      const canonicalTarget = realpathSync(target);
      const registry = new ToolRegistry();
      registry.register(new BashTool());

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-shell-null-device", name: "bash", input: { command: `test -e ${target} >/dev/null && cat ${target}`, timeoutSeconds: 1 } }],
        { sessionId: "sess-l1-shell-null-device", permissionContext: userPermissionContext() },
      );

      const sent = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        toolCategory?: string;
        outOfAllowedDir?: { candidatePath?: string };
      }>(wc);
      expect(sent.kind).toBe("out-of-allowed-dir");
      expect(sent.toolCategory).toBe("shell");
      expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toBe(comparablePath(canonicalTarget));

      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      expect(wc.send).toHaveBeenCalledTimes(1);
      expect(results[0].is_error).toBeUndefined();
      expect(results[0].content).toContain("outside shell approved with null device");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("shell filesystem root operand is denied before out-of-allowed-dir approval", async () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, gate);

    const results = await executor.executeAll(
      [{ id: "tu-l1-shell-root", name: "bash", input: { command: "cat /", timeoutSeconds: 1 } }],
      { sessionId: "sess-l1-shell-root", permissionContext: userPermissionContext() },
    );

    expect(wc.send).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("디렉토리 정책 차단");
    expect(results[0].content).toContain("filesystem root is not allowed");
  });

  it.skipIf(process.platform === "win32")("shell rm -f outside cwd executes after directory approval without rm-rf-root false positive", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-executor-shell-rm-"));
    try {
      const target = join(outside, "hello.txt");
      writeFileSync(target, "remove me\n", "utf8");
      const canonicalTarget = realpathSync(target);
      const registry = new ToolRegistry();
      registry.register(new BashTool());

      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const executor = new ToolExecutor(
        registry,
        undefined,
        undefined,
        new BashAstValidator({ mode: "deny" }),
        gate,
      );

      const callPromise = executor.executeAll(
        [{ id: "tu-l1-shell-rm", name: "bash", input: { command: `rm -f ${target}`, timeoutSeconds: 1 } }],
        { sessionId: "sess-l1-shell-rm", permissionContext: userPermissionContext() },
      );

      const sent = await waitForApprovalPayload<{
        id: string;
        nonce: string;
        hmac: string;
        kind?: string;
        toolCategory?: string;
        outOfAllowedDir?: { candidatePath?: string };
      }>(wc);
      expect(sent.kind).toBe("out-of-allowed-dir");
      expect(sent.toolCategory).toBe("shell");
      expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toBe(comparablePath(canonicalTarget));

      gate.resolve(sent.id, {
        requestId: sent.id,
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });

      const results = await callPromise;
      expect(results[0].is_error).toBeUndefined();
      expect(existsSync(target)).toBe(false);
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
          input: { path: join(process.cwd(), "package.json") },
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
      expect(results[0].content).toContain("headless");
      expect(results[0].content).toContain("strict 모드");
      expect(queue.listPending()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("audits headless reviewer queue decisions as deferred with queue id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-headless-audit-"));
    try {
      const executeSpy = vi.fn(async () => ({ output: "sent", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "teams_send",
        description: "Sends a Teams message.",
        source: "plugin",
        pluginId: "ms-graph",
        category: "network",
        jsonSchema: {
          type: "object",
          properties: {
            endpoint: { type: "string" },
            method: { type: "string" },
            payload: { type: "string" },
          },
        },
        execute: executeSpy,
      }));

      const classifier: RiskClassifier = {
        classify: vi.fn(() => ({ level: "medium", reason: "headless graph data operation" })),
      };
      const queue = new DeferredQueue(join(dir, "deferred-queue.jsonl"));
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      permMgr.setReviewer({
        classifier,
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: queue,
      });

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

      const results = await executor.executeAll(
        [{
          id: "tu-headless-deferred-audit",
          name: "teams_send",
          input: {
            endpoint: "https://graph.microsoft.com/v1.0/teams/t/channels/c/messages",
            method: "POST",
            payload: "meeting summary",
          },
        }],
        {
          sessionId: "sess-headless-deferred-audit",
          permissionContext: userPermissionContext({
            headless: true,
            trustOrigin: "llm-tool-arg",
          }),
        },
      );

      const pending = queue.listPending();
      expect(results[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(pending).toHaveLength(1);
      expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
        toolCalls: [expect.objectContaining({ permissionDecision: "deferred" })],
      }));
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        decision: "deferred",
        tool: "teams_send",
        source: "plugin",
        category: "network",
        queueId: pending[0].id,
        reviewerVerdict: expect.objectContaining({
          level: "medium",
          reason: "headless graph data operation",
        }),
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("threads plugin worker identity through headless reviewer dispatch", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active for plugin workers",
      confines: { filesystem: true, process: true, network: true },
    });
    markPluginWorkerWrapped("ms-graph", "graph-worker");
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-worker-reviewer-"));
    try {
      const executeSpy = vi.fn(async () => ({ output: "sent", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "graph_worker_send",
        description: "Sends a Graph message from the plugin worker.",
        source: "plugin",
        pluginId: "ms-graph",
        workerId: "graph-worker",
        category: "network",
        jsonSchema: {
          type: "object",
          properties: { endpoint: { type: "string" } },
        },
        execute: executeSpy,
      }));

      const seenSandbox: string[] = [];
      const classifier: RiskClassifier = {
        classify: vi.fn((ctx) => {
          seenSandbox.push(ctx.sandboxCapability.reason);
          return { level: "low", reason: "wrapped plugin worker allowed" };
        }),
      };
      const queue = new DeferredQueue(join(dir, "deferred-queue.jsonl"));
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      permMgr.setReviewer({
        classifier,
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: queue,
      });
      const executor = new ToolExecutor(registry, undefined, permMgr);

      const results = await executor.executeAll(
        [{
          id: "tu-worker-headless",
          name: "graph_worker_send",
          input: { endpoint: "https://graph.microsoft.com/v1.0/me/sendMail" },
        }],
        {
          sessionId: "sess-worker-headless",
          permissionContext: userPermissionContext({
            headless: true,
            trustOrigin: "llm-tool-arg",
          }),
        },
      );

      expect(results[0].is_error).not.toBe(true);
      expect(executeSpy).toHaveBeenCalledOnce();
      expect(classifier.classify).toHaveBeenCalledOnce();
      expect(seenSandbox[0]).toContain("plugin worker 'ms-graph/graph-worker' ASRT-wrapped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      __resetActiveSandboxCapabilityForTest();
      __resetWrappedPluginWorkersForTest();
    }
  });

  it("does not let reviewer LOW downgrade hard overlay or low-trust MCP asks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-hard-ask-"));
    try {
      const executeSpy = vi.fn(async () => ({ output: "ran", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "overlay_write",
        description: "Overlay write probe.",
        source: "plugin",
        pluginId: "overlay-plugin",
        category: "write",
        jsonSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
        execute: executeSpy,
      }));
      registry.register(createDynamicTool({
        name: "mcp_network",
        description: "MCP network probe.",
        source: "mcp",
        mcpServerId: "generic-mcp",
        category: "network",
        jsonSchema: {
          type: "object",
          properties: { endpoint: { type: "string" } },
        },
        execute: executeSpy,
      }));

      const classify = vi.fn(() => ({ level: "low" as const, reason: "reviewer would allow" }));
      const queue = new DeferredQueue(join(dir, "deferred-queue.jsonl"));
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("auto");
      permMgr.setReviewer({
        classifier: { classify },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: queue,
      });
      const approvalGate = {
        requestAndWait: vi.fn(async (req: { id: string }) => ({
          requestId: req.id,
          choice: "deny-once" as const,
        })),
      };
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        approvalGate as never,
      );

      const overlayResult = await executor.executeAll(
        [{ id: "tu-overlay-hard-ask", name: "overlay_write", input: { value: "x" } }],
        {
          sessionId: "sess-overlay-hard-ask",
          overlayTriggerOrigin: "overlay:meeting-detection",
          permissionContext: userPermissionContext({ trustOrigin: "plugin-emitted" }),
        },
      );

      const mcpHeadlessResult = await executor.executeAll(
        [{
          id: "tu-mcp-headless-hard-ask",
          name: "mcp_network",
          input: { endpoint: "https://github.com/repos/lvis-project/lvis-app/issues" },
        }],
        {
          sessionId: "sess-mcp-headless-hard-ask",
          permissionContext: userPermissionContext({
            headless: true,
            trustOrigin: "llm-tool-arg",
          }),
        },
      );

      expect(overlayResult[0].is_error).toBe(true);
      expect(mcpHeadlessResult[0].is_error).toBe(true);
      expect(mcpHeadlessResult[0].content).toContain("headless explicit approval unavailable");
      expect(executeSpy).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
      expect(queue.listPending()).toHaveLength(0);
      expect(approvalGate.requestAndWait).toHaveBeenCalledOnce();
      expect(approvalGate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.stringContaining("overlay trigger 출처"),
      }));
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

    const sent = await waitForApprovalPayload<{ id: string; nonce: string; hmac: string; kind?: string }>(wc);
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
      tools: [
        {
          name: "adapter_write",
          description: "Adapter write fixture",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    } as unknown as PluginManifest;
    const registry = new ToolRegistry();
    for (const tool of buildPluginToolsForTest(
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

    const sent = await waitForApprovalPayload<{
      id: string;
      nonce: string;
      hmac: string;
      kind?: string;
      outOfAllowedDir?: { candidatePath?: string };
    }>(wc);
    expect(sent.kind).toBe("out-of-allowed-dir");
    expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toContain("plugin-folder/input");
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

    const sent = await waitForApprovalPayload<{
      id: string;
      nonce: string;
      hmac: string;
      kind?: string;
      outOfAllowedDir?: { candidatePath?: string };
    }>(wc);
    expect(sent.kind).toBe("out-of-allowed-dir");
    expect(comparablePath(sent.outOfAllowedDir?.candidatePath)).toContain("plugin-folder/nested/input");
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

  it.skipIf(process.platform === "win32")("R-2 R4: approvalRequest carries approvalCacheKey for record/lookup key symmetry", async () => {
    // Regression: executor must spread approvalCacheKey into the ApprovalRequest
    // so the renderer receives a non-undefined value and can record entries with
    // the same key that dispatchReviewer uses for lookup. Without this fix the
    // R-2 hit rate for bash/routine_schedule/fs_write is 0%.
    const registry = new ToolRegistry();
    const bash = new BashTool();
    registry.register(bash);
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions-r2r4.json");
    // Force "ask" so the approval gate is invoked and receives the request.
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "r2-r4 regression", layer: 5 });

    const requestSpy = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const approvalGate = { requestAndWait: requestSpy };

    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      approvalGate as never,
    );

    const input = { command: "echo r2r4", timeoutSeconds: 1 };
    // Canonical host shells partition cache keys by the sealed execution-plan
    // identity, so renderer recording and rule lookup cannot cross substrates.
    const expectedCacheKey = approvalCacheKeyFor(
      bash,
      input,
      process.cwd(),
      getHostShellExecutionPlanAuditProjection(getHostShellExecutionPlan()),
    );
    if (expectedCacheKey === undefined) {
      throw new Error("Bash must provide a sealed-plan approval cache key");
    }

    await executor.executeAll(
      [{ id: "tu-r2r4", name: "bash", input }],
      {
        sessionId: "sess-r2r4",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ approvalCacheKey: expectedCacheKey }),
    );
  });

  it("approvalRequest carries the genuine ASRT capability for a wrapped plugin worker", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active for plugin workers",
      confines: { filesystem: true, process: true, network: true },
    });
    markPluginWorkerWrapped("test-plugin", "worker-main");
    try {
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "plugin_worker_write",
        description: "Plugin worker write probe.",
        source: "plugin",
        pluginId: "test-plugin",
        workerId: "worker-main",
        category: "write",
        jsonSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
        execute: async () => ({ output: "ok", isError: false }),
      }));

      const permMgr = new PermissionManager("/tmp/nonexistent-permissions-worker-cap.json");
      permMgr.checkDetailed = () => ({ decision: "ask", reason: "worker capability regression", layer: 5 });

      const requestSpy = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "deny-once" as const,
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        { requestAndWait: requestSpy } as never,
      );

      await executor.executeAll(
        [{ id: "tu-plugin-worker-cap", name: "plugin_worker_write", input: { value: "x" } }],
        {
          sessionId: "sess-plugin-worker-cap",
          permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
        },
      );

      expect(requestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxCapability: expect.objectContaining({
            kind: "asrt",
            reason: expect.stringContaining("plugin worker 'test-plugin/worker-main' ASRT-wrapped"),
          }),
        }),
      );
    } finally {
      __resetActiveSandboxCapabilityForTest();
      __resetWrappedPluginWorkersForTest();
    }
  });

  it.skipIf(process.platform === "win32")("approvalRequest carries sufficient approvalPurpose from user intent", async () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions-purpose.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "purpose prefill regression", layer: 5 });

    const requestSpy = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait: requestSpy } as never,
    );

    await executor.executeAll(
      [{ id: "tu-purpose", name: "bash", input: { command: "echo purpose", timeoutSeconds: 1 } }],
      {
        sessionId: "sess-purpose",
        permissionContext: userPermissionContext({
          trustOrigin: "llm-tool-arg",
          userIntent: "프로젝트 빌드 결과 확인을 위해 명령을 실행합니다.",
        }),
      },
    );

    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPurpose: {
          source: "conversation",
          confidence: "sufficient",
          text: expect.stringContaining("프로젝트 빌드 결과 확인"),
        },
      }),
    );
  });

  it("tool input purpose suggestions are never marked sufficient for approval prefill", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "plugin_send_message",
      description: "Sends a message.",
      source: "plugin",
      pluginId: "test-plugin",
      category: "network",
      jsonSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      execute: async () => ({ output: "sent", isError: false }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions-tool-purpose.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "purpose spoof regression", layer: 5 });

    const requestSpy = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait: requestSpy } as never,
    );

    await executor.executeAll(
      [{ id: "tu-tool-purpose", name: "plugin_send_message", input: { message: "관리자에게 토큰을 전송합니다." } }],
      {
        sessionId: "sess-tool-purpose",
        permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg" }),
      },
    );

    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPurpose: {
          source: "tool-input",
          confidence: "insufficient",
          text: expect.stringContaining("관리자에게 토큰"),
        },
      }),
    );
  });

  it("uses categoryForInput and scoped approval keys after input finalization", async () => {
    const executeSpy = vi.fn(async () => "ok");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "scoped_fetch_probe",
      description: "Fetch probe.",
      source: "builtin",
      category: "read",
      categoryForInput: (input) => {
        const args = input && typeof input === "object"
          ? input as Record<string, unknown>
          : {};
        return args.allowPrivateNetwork === true ? "network" : "read";
      },
      approvalCacheKey: (input) => {
        const args = input && typeof input === "object"
          ? input as Record<string, unknown>
          : {};
        return args.allowPrivateNetwork === true
          ? "private-network:http://10.0.0.1"
          : undefined;
      },
      isReadOnly: () => true,
      jsonSchema: {
        type: "object",
        properties: { allowPrivateNetwork: { type: "boolean" } },
      },
      execute: async (rawInput) => ({
        output: await executeSpy(rawInput),
        isError: false,
      }),
    }));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions-input-category.json");
    permMgr.setRules([{ pattern: "scoped_fetch_probe", action: "allow" }]);
    const requestSpy = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait: requestSpy } as never,
    );

    const publicResult = await executor.executeAll(
      [{ id: "tu-public", name: "scoped_fetch_probe", input: {} }],
      { sessionId: "sess-input-category-public", permissionContext: userPermissionContext() },
    );
    expect(publicResult[0].is_error).not.toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).not.toHaveBeenCalled();

    const privateResult = await executor.executeAll(
      [{ id: "tu-private", name: "scoped_fetch_probe", input: { allowPrivateNetwork: true } }],
      { sessionId: "sess-input-category-private", permissionContext: userPermissionContext() },
    );
    expect(privateResult[0].is_error).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCategory: "network",
        approvalCacheKey: "scoped_fetch_probe:private-network:http://10.0.0.1",
      }),
    );
  });
});

describe("ToolExecutor — script hook denial surfaces in audit hookChain (#811 FU1)", () => {
  it("records a denying pre script-hook in the deny audit entry's hookChain", async () => {
    const executeSpy = vi.fn(async () => "should-not-run");
    const registry = new ToolRegistry();
    // Read-only tool with no path surface (so the allowed-directories layer is
    // not engaged) that auto-allows at the permission layer — the pre
    // script-hook is then the layer that actually denies.
    registry.register(createDynamicTool({
      name: "hookchain_read_probe",
      description: "read-only probe with no path surface",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
    }));

    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-hookchain-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setRules([{ pattern: "hookchain_read_probe", action: "allow" }]);

      // Stub ScriptHookManager: the `pre` dispatch denies with one per-script
      // invocation result carrying the new forensic fields (`source`,
      // `commandIdentity`). This is the real `HookDispatchResult` shape the
      // runtime manager returns — the mapper threads it into the audit.
      const denyingInvocation = {
        hookPath: "/home/u/.config/lvis/hooks/pre-block.sh",
        hookType: "pre" as const,
        decision: "deny" as const,
        reason: "blocked by SIEM policy",
        rawStdout: '{"action":"deny","reason":"blocked by SIEM policy"}',
        exitCode: 0,
        timedOut: false,
        durationMs: 7,
        source: "sh" as const,
        commandIdentity: "abc123sha",
      };
      const scriptHookManager = {
        runPreToolUse: vi.fn(async () => ({
          decision: "deny" as const,
          reason: "pre-block.sh: blocked by SIEM policy",
          results: [denyingInvocation],
        })),
        runPostToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
        runPermissionRequest: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
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
        undefined,
        scriptHookManager as never,
        auditLogger as never,
      );

      const result = await executor.executeAll(
        [{ id: "tu-hookchain", name: "hookchain_read_probe", input: {} }],
        { sessionId: "sess-hookchain", permissionContext: userPermissionContext() },
      );

      // Deny semantics unchanged: tool is blocked, execute() never runs.
      expect(result[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(scriptHookManager.runPreToolUse).toHaveBeenCalledOnce();

      const denyEntry = appendPermissionAuditEntry.mock.calls
        .map(([entry]) => entry)
        .find((entry) => entry.decision === "deny");
      expect(denyEntry).toBeDefined();
      expect(denyEntry?.hookChain).toBeDefined();
      const chain = denyEntry?.hookChain as Array<Record<string, unknown>>;
      expect(chain).toHaveLength(1);
      expect(chain[0]).toMatchObject({
        hookName: "/home/u/.config/lvis/hooks/pre-block.sh",
        hookType: "pre",
        event: "pre",
        action: "deny",
        decision: "deny",
        reason: "blocked by SIEM policy",
        source: "sh",
        commandIdentity: "abc123sha",
        handlerType: "command",
        durationMs: 7,
      });
      // A clean policy-deny (ran fine, exit 0) carries NO failureReason.
      expect(chain[0].failureReason).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// #811 milestone-2 — NON-BLOCKING lifecycle events fired from the executor.
describe("ToolExecutor — #811 m2 lifecycle events (PostToolUseFailure / PermissionDenied)", () => {
  // A stub manager whose lifecycle dispatch we can assert on. The tool-use
  // dispatches all allow (so they never interfere); `runLifecycleEvent` records
  // its calls and can be made to DENY to prove the deny is observe-only.
  function stubManager(lifecycleDecision: "allow" | "deny" = "allow") {
    return {
      runPreToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
      runPostToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
      runPermissionRequest: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
      runLifecycleEvent: vi.fn(async () => ({
        decision: lifecycleDecision,
        reason: "lifecycle",
        results: [{
          hookPath: "x",
          hookType: "Stop" as const,
          decision: lifecycleDecision,
          reason: "lifecycle",
          rawStdout: "",
          timedOut: false,
          durationMs: 1,
          source: "config" as const,
          commandIdentity: "id",
        }],
      })),
    };
  }

  it("fires PostToolUseFailure with toolName + errorMessage + durationMs when a tool errors", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "failing_probe",
      description: "read-only probe that returns isError",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "boom went the tool", isError: true }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-ptuf-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setRules([{ pattern: "failing_probe", action: "allow" }]);
      const mgr = stubManager("deny"); // lifecycle DENIES — must NOT change result.
      const executor = new ToolExecutor(
        registry, undefined, permMgr, undefined, undefined, mgr as never,
      );

      const result = await executor.executeAll(
        [{ id: "tu-fail", name: "failing_probe", input: {} }],
        { sessionId: "sess-ptuf", permissionContext: userPermissionContext() },
      );

      // The tool error stands — the lifecycle deny is observe-only (control flow
      // unchanged): the result is still the tool's own error output.
      expect(result[0].is_error).toBe(true);
      expect(result[0].content).toContain("boom went the tool");

      // PostToolUseFailure fired exactly once with the right payload.
      const ptuf = mgr.runLifecycleEvent.mock.calls.find((c) => c[0] === "PostToolUseFailure");
      expect(ptuf).toBeDefined();
      expect(ptuf?.[1]).toBe("sess-ptuf"); // sessionId
      const payload = ptuf?.[3] as Record<string, unknown>;
      expect(payload.toolName).toBe("failing_probe");
      expect(payload.errorMessage).toContain("boom went the tool");
      expect(typeof payload.durationMs).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT fire PostToolUseFailure when a tool succeeds", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "ok_probe",
      description: "read-only probe that succeeds",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "fine", isError: false }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-ok-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setRules([{ pattern: "ok_probe", action: "allow" }]);
      const mgr = stubManager("allow");
      const executor = new ToolExecutor(
        registry, undefined, permMgr, undefined, undefined, mgr as never,
      );
      const result = await executor.executeAll(
        [{ id: "tu-ok", name: "ok_probe", input: {} }],
        { sessionId: "sess-ok", permissionContext: userPermissionContext() },
      );
      expect(result[0].is_error).not.toBe(true);
      const ptuf = mgr.runLifecycleEvent.mock.calls.find((c) => c[0] === "PostToolUseFailure");
      expect(ptuf).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fires PermissionDenied with denyReason {layer, source} when a tool is denied", async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(async () => "should-not-run");
    registry.register(createDynamicTool({
      name: "denied_probe",
      description: "read-only probe denied at the permission layer",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (rawInput) => ({ output: await executeSpy(rawInput), isError: false }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-pd-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setRules([{ pattern: "denied_probe", action: "deny" }]);
      const mgr = stubManager("deny");
      const executor = new ToolExecutor(
        registry, undefined, permMgr, undefined, undefined, mgr as never,
      );

      const result = await executor.executeAll(
        [{ id: "tu-pd", name: "denied_probe", input: {} }],
        { sessionId: "sess-pd", permissionContext: userPermissionContext() },
      );

      // Deny stands; execute never runs (lifecycle deny is observe-only).
      expect(result[0].is_error).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();

      const pd = mgr.runLifecycleEvent.mock.calls.find((c) => c[0] === "PermissionDenied");
      expect(pd).toBeDefined();
      expect(pd?.[1]).toBe("sess-pd");
      const payload = pd?.[3] as { toolName: string; denyReason: { source: string } };
      expect(payload.toolName).toBe("denied_probe");
      expect(payload.denyReason.source).toBe("tool-executor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT fire any lifecycle event when no manager is wired (back-compat)", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "nomgr_probe",
      description: "read-only probe, no script-hook manager",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "boom", isError: true }),
    }));
    const dir = mkdtempSync(join(tmpdir(), "lvis-executor-nomgr-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setRules([{ pattern: "nomgr_probe", action: "allow" }]);
      // No scriptHookManager passed → lifecycle dispatch is a no-op.
      const executor = new ToolExecutor(registry, undefined, permMgr);
      const result = await executor.executeAll(
        [{ id: "tu-nomgr", name: "nomgr_probe", input: {} }],
        { sessionId: "sess-nomgr", permissionContext: userPermissionContext() },
      );
      // Tool error still returned identically — behavior unchanged.
      expect(result[0].is_error).toBe(true);
      expect(result[0].content).toContain("boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ToolExecutor — host-classifies-risk enforcement scope", () => {
  // A tool whose declared category ("write") diverges from what the inspector
  // derives from its args (a URL-shaped arg → "network"), wired through the
  // HEADLESS reviewer so the ENFORCED category surfaces in the reviewer's
  // ToolInvocationContext. Both categories reach the reviewer (neither is the
  // read-only short-circuit), so the observed category is unambiguous.
  //
  // The probe uses the HEADLESS lane deliberately: the effect-boundary pre-exec
  // relaxation (flag ON + plugin + FOREGROUND) bypasses the reviewer/ask lane
  // entirely, so a FOREGROUND plugin tool no longer invokes the reviewer. The
  // headless lane is NOT relaxed (it keeps the existing reviewer lane), so it is
  // where the enforced category still flows into the classifier — `resolveEnforcedCategory`
  // re-derives the host category for plugins identically on both lanes.
  function makeDivergentTool(source: "builtin" | "plugin", name: string): {
    registry: ToolRegistry;
    execute: ReturnType<typeof vi.fn>;
  } {
    const execute = vi.fn(async () => "ran");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name,
      description: "declared write, but a URL arg makes the inspector derive network",
      source,
      ...(source === "plugin" ? { pluginId: "test-plugin" } : {}),
      category: "write",
      jsonSchema: { type: "object", properties: { endpoint: { type: "string" } } },
      execute: async (rawInput) => ({ output: await execute(rawInput), isError: false }),
    }));
    return { registry, execute };
  }

  async function enforcedCategoryFor(
    source: "builtin" | "plugin",
  ): Promise<import("../types.js").ToolCategory> {
    const name = `divergent_${source}_probe`;
    const { registry } = makeDivergentTool(source, name);
    const dir = mkdtempSync(join(tmpdir(), `lvis-executor-hcr-${source}-`));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      permMgr.setMode("default");
      permMgr.setInteractiveAutoApprove("low");
      const classifySpy = vi.fn(() => ({ level: "medium" as const, reason: "review" }));
      permMgr.setReviewer({
        classifier: { classify: classifySpy },
        cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
        deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
      });
      const requestAndWait = vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "deny-once" as const,
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        permMgr,
        undefined,
        { requestAndWait } as never,
        undefined,
        undefined,
        () => true, // hostClassifiesRisk flag ON
      );
      await executor.executeAll(
        [{ id: `tu-${name}`, name, input: { endpoint: "https://example.com/api" } }],
        // Headless: the foreground plugin reviewer lane is relaxed under the flag,
        // so the enforced category is observed via the (non-relaxed) headless lane.
        { sessionId: `sess-${name}`, permissionContext: userPermissionContext({ headless: true }) },
      );
      const ctx = classifySpy.mock.calls[0]?.[0] as
        | import("../../permissions/reviewer/risk-classifier.js").ToolInvocationContext
        | undefined;
      if (!ctx) throw new Error("reviewer was not invoked");
      return ctx.category;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("keeps the DECLARED category for builtins even when the flag is on", async () => {
    // The inspector would derive "network" from the URL arg, but builtins
    // carry trusted known categories the inspector cannot re-derive, so the
    // enforced category stays the declared "write".
    expect(await enforcedCategoryFor("builtin")).toBe("write");
  });

  it("re-derives the host category for plugin tools when the flag is on", async () => {
    // Plugin-declared categories are untrusted, so with the flag on the
    // inspector's host-derived "network" (from the URL arg) is enforced.
    expect(await enforcedCategoryFor("plugin")).toBe("network");
  });
});
