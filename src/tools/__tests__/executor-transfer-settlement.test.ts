import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTmpDirTracker } from "../../__tests__/support/tmp-dir-teardown.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { HookRunner } from "../../hooks/hook-runner.js";
import { t } from "../../i18n/index.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { initPiiRedactionPolicy } from "../../shared/dlp.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { createDynamicTool, type Tool, type ToolExecutionResult, type ToolSource } from "../base.js";
import { ToolExecutor, type ToolExecutorCallbacks } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { TOOL_RESULT_CHUNK_MAX_CHARS } from "../tool-result-chunk.js";
import { userPermissionContext } from "./tool-context-fixture.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type Interruption = "ceiling" | "user-abort";
const INTERRUPTIONS: readonly Interruption[] = ["ceiling", "user-abort"];
const scratch = createTmpDirTracker();
const auditLoggers: AuditLogger[] = [];
const releaseTasks: Array<() => void> = [];

beforeEach(() => vi.useFakeTimers());

afterEach(async () => {
  for (const release of releaseTasks.splice(0)) release();
  vi.useRealTimers();
  initPiiRedactionPolicy(() => false);
  await Promise.all(auditLoggers.splice(0).map((logger) => logger.close()));
  await scratch.cleanup();
});

async function startInvocation(options: {
  source?: ToolSource;
  marked?: boolean;
  postFeedback?: string;
} = {}) {
  const directory = scratch.track(mkdtempSync(join(tmpdir(), "executor-settlement-")));
  const started = deferred<AbortSignal>();
  const aborted = deferred<void>();
  const task = deferred<ToolExecutionResult>();
  releaseTasks.push(() => task.resolve({ output: "released", isError: true }));
  const events: string[] = [];
  const tool: Tool = {
    ...createDynamicTool({
      name: "settlement_probe",
      description: "reports after its work settles",
      source: options.source ?? "builtin",
      ...(options.source === "plugin" ? { pluginId: "settlement-plugin" } : {}),
      ...(options.source === "mcp" ? { mcpServerId: "settlement-server" } : {}),
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute: async (_input, context) => {
        const signal = context.abortSignal!;
        signal.addEventListener("abort", () => {
          events.push("aborted");
          aborted.resolve();
        }, { once: true });
        events.push("started");
        started.resolve(signal);
        try {
          return await task.promise;
        } finally {
          events.push("settled");
        }
      },
    }),
    ...(options.marked === false ? {} : { awaitCancellationSettlement: true as const }),
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const permissions = new PermissionManager(join(directory, "permissions.json"));
  vi.spyOn(permissions, "checkDetailed").mockReturnValue({
    decision: "allow",
    reason: "test invocation admitted",
    layer: 3,
  });
  const auditLogger = new AuditLogger(join(directory, "audit"));
  auditLoggers.push(auditLogger);
  const auditLog = vi.spyOn(auditLogger, "log");
  const onToolEnd = vi.fn<NonNullable<ToolExecutorCallbacks["onToolEnd"]>>(
    () => { events.push("end"); },
  );
  const hookRunner = new HookRunner();
  if (options.postFeedback !== undefined) {
    vi.spyOn(hookRunner, "runPostHooks").mockResolvedValue(options.postFeedback);
  }
  const executor = new ToolExecutor(
    registry, hookRunner, permissions, undefined, undefined, undefined, auditLogger,
  );
  const controller = new AbortController();
  let returned = false;
  const execution = executor.executeConversationTools(
    [{ id: "settlement-invocation", name: tool.name, input: {} }],
    {
      executionCwd: directory,
      sessionId: "settlement-session",
      permissionContext: userPermissionContext(),
      callbacks: { onToolEnd },
      abortSignal: controller.signal,
    },
  );
  void execution.then(() => { returned = true; });
  const signal = await started.promise;
  return {
    directory,
    task,
    events,
    tool,
    execution,
    signal,
    onToolEnd,
    returned: () => returned,
    terminalAudits: () => auditLog.mock.calls.map(([entry]) => entry)
      .filter((entry) => entry.toolCalls?.some((call) => call.terminationReason !== undefined)),
    async interrupt(reason: Interruption) {
      if (reason === "ceiling") {
        await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs);
      } else {
        controller.abort(new Error("cancel requested"));
        await vi.advanceTimersByTimeAsync(0);
      }
      await aborted.promise;
    },
  };
}

function interruptionText(reason: Interruption): string {
  return reason === "ceiling"
    ? t("be_executor.toolCeilingExceeded", {
        name: "settlement_probe",
        seconds: String(Math.round(TOOL_TIMEOUT_POLICY.globalCeilingMs / 1000)),
      })
    : t("be_executor.toolExecutionCancelled");
}

describe.each(INTERRUPTIONS)("builtin cancellation settlement after %s", (reason) => {
  it("waits for cleanup before result, terminal audit, and tool-end, retaining incomplete cleanup", async () => {
    const invocation = await startInvocation();
    await invocation.interrupt(reason);
    expect(invocation.signal.aborted).toBe(true);
    expect(invocation.returned()).toBe(false);
    expect(invocation.onToolEnd).not.toHaveBeenCalled();
    expect(invocation.terminalAudits()).toEqual([]);

    const cleanupReport = {
      ok: false,
      cleanup: "incomplete",
      code: "cancelled",
      residualPaths: [join(invocation.directory, "destination", "foreign.txt")],
      message: "transfer interrupted",
      cleanupErrors: ["destination contains an unowned entry"],
    };
    invocation.task.resolve({ output: JSON.stringify(cleanupReport), isError: true });
    const [result] = await invocation.execution;

    expect(result.is_error).toBe(true);
    expect(result.content).toBe(
      `${interruptionText(reason)}\n\n[Tool result after interruption]\n${JSON.stringify(cleanupReport)}`,
    );
    expect(invocation.events).toEqual(["started", "aborted", "settled", "end"]);
    expect(invocation.onToolEnd).toHaveBeenCalledOnce();
    const end = invocation.onToolEnd.mock.calls[0];
    expect(end[1]).toBe(result.content);
    expect(end[2]).toBe(true);
    expect(end[3].cancelled).toBe(reason === "user-abort" ? true : undefined);
    const [audit] = invocation.terminalAudits();
    expect(audit.output).toContain('"cleanup":"incomplete"');
    expect(audit.output).toContain(cleanupReport.residualPaths[0]);
    expect(audit.toolCalls?.[0]).toMatchObject({ terminationReason: reason, isError: true });
  });

  it("retains a reported rollback without manufacturing a cleanup status", async () => {
    const invocation = await startInvocation();
    await invocation.interrupt(reason);
    const report = { ok: false, cleanup: "removed", code: "cancelled", message: "work stopped" };
    invocation.task.resolve({ output: JSON.stringify(report), isError: true });
    const [result] = await invocation.execution;
    expect(result.content).toContain(JSON.stringify(report));
    expect(result.is_error).toBe(true);
  });

  it("keeps late success interrupted and withholds raw metadata and images", async () => {
    const invocation = await startInvocation();
    await invocation.interrupt(reason);
    const output = JSON.stringify({ ok: true, summary: { files: 1, bytesWritten: 32 } });
    invocation.task.resolve({
      output,
      isError: false,
      metadata: { rawResult: { private: "metadata-only" }, uiPayload: { private: "ui-only" } },
      image: { data: "image-only", mimeType: "image/png" },
    });
    const [result] = await invocation.execution;
    expect(result.content).toContain(interruptionText(reason));
    expect(result.content).toContain(output);
    expect(result.content).not.toContain("cleanup");
    expect(result.content).not.toContain("metadata-only");
    expect(result.is_error).toBe(true);
    expect(result).not.toHaveProperty("rawResult");
    expect(result).not.toHaveProperty("uiPayload");
    expect(result).not.toHaveProperty("image");
    expect(invocation.onToolEnd.mock.calls[0]?.[4]).toBeUndefined();
    expect(invocation.terminalAudits()[0].toolCalls?.[0].terminationReason).toBe(reason);
  });

  it("reports the actual late thrown error while preserving the interruption", async () => {
    const invocation = await startInvocation();
    await invocation.interrupt(reason);
    const failure = new Error("owned destination cleanup failed");
    failure.stack = "private-stack-only";
    invocation.task.reject(failure);
    const [result] = await invocation.execution;
    expect(result.content).toBe(
      `${interruptionText(reason)}\n\n[Tool error after interruption]\n${failure.message}`,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).not.toContain("private-stack-only");
    expect(result.content).not.toContain('"cleanup":"removed"');
    expect(invocation.terminalAudits()[0].toolCalls?.[0].terminationReason).toBe(reason);
  });

  it.each(["result", "error"] as const)("bounds oversized settled %s details", async (kind) => {
    const invocation = await startInvocation();
    await invocation.interrupt(reason);
    const detail = 'cleanup="incomplete"; ' + "x".repeat(TOOL_RESULT_CHUNK_MAX_CHARS * 2);
    if (kind === "result") invocation.task.resolve({ output: detail, isError: true });
    else invocation.task.reject(new Error(detail));
    const [result] = await invocation.execution;
    const prefix = `${interruptionText(reason)}\n\n[Tool ${kind} after interruption]\n`;
    expect(result.content.startsWith(prefix)).toBe(true);
    expect(result.content.length - prefix.length).toBe(TOOL_RESULT_CHUNK_MAX_CHARS);
    expect(result.content.endsWith("[Settled detail truncated]")).toBe(true);
    expect(invocation.terminalAudits()[0].output?.length).toBeLessThanOrEqual(1024);
  });

  it.each([
    ["result", false], ["result", true], ["error", false], ["error", true],
  ] as const)("masks settled %s detail for display and audit with PII policy %s", async (kind, pii) => {
    initPiiRedactionPolicy(() => pii);
    const invocation = await startInvocation();
    await invocation.interrupt(reason);
    const credential = "abcdefghij0123456789";
    const detail = `contact transfer.user@example.com; authorization: Bearer ${credential}`;
    if (kind === "result") invocation.task.resolve({ output: detail, isError: true });
    else invocation.task.reject(new Error(detail));
    const [result] = await invocation.execution;
    expect(result.content).toContain(detail);
    const display = invocation.onToolEnd.mock.calls[0]?.[1];
    const audit = invocation.terminalAudits()[0].output;
    for (const surface of [display, audit]) {
      expect(surface).not.toContain(credential);
      expect(surface).toContain("[REDACTED:TOKEN]");
      if (pii) {
        expect(surface).not.toContain("transfer.user@example.com");
        expect(surface).toContain("***@example.com");
      } else {
        expect(surface).toContain("transfer.user@example.com");
      }
    }
  });

  it.each(["result", "error"] as const)("masks a credential before the %s detail is truncated", async (kind) => {
    initPiiRedactionPolicy(() => true);
    const postFeedback = "follow up with feedback.user@example.com";
    const invocation = await startInvocation({ postFeedback });
    await invocation.interrupt(reason);
    const credential = "testcredential".repeat(TOOL_RESULT_CHUNK_MAX_CHARS);
    const detail = `cleanup="incomplete"; {"api_key":"${credential}"}`;
    if (kind === "result") invocation.task.resolve({ output: detail, isError: true });
    else invocation.task.reject(new Error(detail));
    const [result] = await invocation.execution;
    expect(result.content).toContain("testcredential");
    expect(result.content).toContain("[Settled detail truncated]");
    if (reason === "ceiling") expect(result.content).toContain(postFeedback);
    else expect(result.content).not.toContain(postFeedback);
    for (const surface of [
      invocation.onToolEnd.mock.calls[0]?.[1],
      invocation.terminalAudits()[0].output,
    ]) {
      expect(surface).not.toContain("testcredential");
      expect(surface).toContain("[REDACTED:TOKEN]");
      if (reason === "ceiling") {
        expect(surface).toContain("[Hook Feedback]\nfollow up with ***@example.com");
      } else {
        expect(surface).not.toContain("[Hook Feedback]");
      }
    }
  });

  it.each([
    ["builtin", false], ["plugin", true], ["mcp", true],
  ] as const)("keeps source %s with marker %s prompt when it ignores the signal", async (source, marked) => {
    const invocation = await startInvocation({ source, marked });
    await invocation.interrupt(reason);
    const [result] = await invocation.execution;
    expect(result.content).toBe(interruptionText(reason));
    expect(result.is_error).toBe(true);
    expect(invocation.events).toEqual(["started", "aborted", "end"]);
    expect(invocation.onToolEnd).toHaveBeenCalledOnce();
    invocation.task.resolve({ output: "late output stays withheld", isError: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(invocation.onToolEnd).toHaveBeenCalledOnce();
    expect(result.content).not.toContain("late output");
  });
});

describe("builtin cancellation marker boundary", () => {
  it("leaves ordinary marked success unchanged", async () => {
    const invocation = await startInvocation();
    invocation.task.resolve({ output: "completed", isError: false });
    const [result] = await invocation.execution;
    expect(result.content).toBe("completed");
    expect(result.is_error).toBeUndefined();
    expect(invocation.terminalAudits()[0].toolCalls?.[0].terminationReason).toBe("ok");
  });

  it("leaves an ordinary thrown task classified as an error", async () => {
    const invocation = await startInvocation();
    invocation.task.reject(new Error("task failed before interruption"));
    const [result] = await invocation.execution;
    expect(result.content).toBe("task failed before interruption");
    expect(result.is_error).toBe(true);
    expect(invocation.terminalAudits()[0].toolCalls?.[0].terminationReason).toBe("error");
  });

  it.each(["plugin", "mcp"] as const)("does not copy a %s descriptor's forged marker", (source) => {
    const descriptor = {
      name: "untrusted_marker",
      description: "untrusted descriptor marker",
      source,
      category: "write" as const,
      jsonSchema: { type: "object", properties: {} },
      awaitCancellationSettlement: true,
      execute: async () => ({ output: "done", isError: false }),
    };
    const tool = createDynamicTool(descriptor);
    expect(tool.awaitCancellationSettlement).toBeUndefined();
    expect(tool.toJsonSchema()).toEqual(descriptor.jsonSchema);
  });
});
