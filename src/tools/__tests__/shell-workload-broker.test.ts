import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  getHostShellExecutionPlan,
  setSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import {
  buildHostShellExecutionRoute,
  issueBrokeredToolExecutionGrant,
  issueExecutionGrant,
  type ExecutionGrant,
} from "../../permissions/execution-router.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../types.js";
import {
  backgroundShellManager,
  BashTool,
  createBashKillTool,
  createBashOutputTool,
} from "../shell-tools.js";

const spawnSpy = vi.hoisted(() => vi.fn());
const broker = vi.hoisted(() => ({
  active: true,
  issued: true,
  capability: Object.freeze({
    version: "brokered-workload-capability/v1",
    workload: Object.freeze({
      id: "a".repeat(64),
      generation: "broker-generation-1",
      boundaryFingerprint: "b".repeat(64),
      imageDigest: `sha256:${"c".repeat(64)}`,
      cwd: "/app",
      home: "/home/lvis",
      platform: "linux",
    }),
    expiresAt: "2099-01-01T00:00:00.000Z",
    allowedOperations: Object.freeze([
      "shell.run",
      "shell.start",
      "shell.read",
      "shell.kill",
    ]),
  }),
  execute: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnSpy.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnSpy };
});

vi.mock("../../workload/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workload/runtime.js")>();
  return {
    ...actual,
    isWorkloadBrokerActive: () => broker.active,
    isIssuedActiveBrokeredWorkloadCapability: (value: unknown) =>
      broker.active && broker.issued && value === broker.capability,
    executeBrokeredWorkloadRequest: broker.execute,
    getWorkloadBrokerResponseReceipt: () => ({
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      brokerRequestId: "22222222-2222-4222-8222-222222222222",
      brokerInstanceId: "33333333-3333-4333-8333-333333333333",
      payloadDigest: "a".repeat(64),
      correlationDigest: "b".repeat(64),
      admittedReceiptDigest: "c".repeat(64),
      terminalReceiptDigest: "d".repeat(64),
    }),
    issueWorkloadBackgroundParent: (_result: unknown) => ({
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      brokerRequestId: "22222222-2222-4222-8222-222222222222",
      brokerInstanceId: "33333333-3333-4333-8333-333333333333",
      payloadDigest: "a".repeat(64),
      correlationDigest: "b".repeat(64),
      admittedReceiptDigest: "c".repeat(64),
      terminalReceiptDigest: "d".repeat(64),
      executionId: "exec_bg_1",
    }),
  };
});

const SESSION_ID = "broker-session";
const RECEIPT_DIGEST = "d".repeat(64);

function successfulRun(output = "broker output") {
  return {
    output,
    isError: false,
    status: "exited",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    oomDelta: 0,
    ownedResourcesZero: true,
    receiptDigest: RECEIPT_DIGEST,
  } as const;
}

function issueBrokerShellGrant(input: {
  command: string;
  cwd: string;
  timeoutSeconds?: number;
  background?: boolean;
}): { legacyPlan: ReturnType<typeof getHostShellExecutionPlan>; grant: ExecutionGrant } {
  const legacyPlan = getHostShellExecutionPlan();
  const route = buildHostShellExecutionRoute({
    legacyPlan,
    toolName: "bash",
    command: input.command,
    cwd: input.cwd,
    timeoutSeconds: input.timeoutSeconds ?? 10,
    background: input.background ?? false,
    brokeredWorkloadCapability: broker.capability as never,
  });
  return { legacyPlan, grant: issueExecutionGrant(route.plan, { toolUseId: "tool-use-test", toolName: "bash" }) };
}

function context(input: {
  legacyPlan?: ReturnType<typeof getHostShellExecutionPlan>;
  grant?: ExecutionGrant;
  cwd?: string;
  signal?: AbortSignal;
} = {}): ToolExecutionContext {
  return {
    cwd: input.cwd ?? "/workspace",
    extraAllowedDirectories: [],
    metadata: { sessionId: SESSION_ID },
    ...(input.legacyPlan === undefined
      ? {}
      : { hostShellExecutionPlan: input.legacyPlan }),
    ...(input.grant === undefined ? {} : { executionRouteGrant: input.grant }),
    ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
  };
}

function lifecycleContext(
  toolName: "bash_output" | "bash_kill",
  normalizedInput: unknown,
): ToolExecutionContext {
  const base = context();
  return {
    ...base,
    executionRouteGrant: issueBrokeredToolExecutionGrant({
      capability: broker.capability as never,
      toolUseId: `tool-${toolName}-${Math.random()}`,
      toolName,
      normalizedInput,
      cwd: base.cwd,
    }),
  };
}

function terminalResult(
  status: "timed-out" | "cancelled" | "oom-killed" | "cleanup-unproven",
) {
  return {
    output: "partial broker output",
    isError: false,
    status,
    exitCode: status === "oom-killed" ? 0 : null,
    signal: status === "cancelled" ? "SIGKILL" : null,
    timedOut: status === "timed-out",
    cancelled: status === "cancelled",
    oomDelta: status === "oom-killed" ? 1 : 0,
    ownedResourcesZero: status !== "cleanup-unproven",
    receiptDigest: RECEIPT_DIGEST,
  } as const;
}

beforeEach(() => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  setSandboxRequestedAtBoot(false);
  backgroundShellManager._resetForTest();
  broker.active = true;
  broker.issued = true;
  broker.execute.mockReset();
  spawnSpy.mockClear();
});

afterEach(() => {
  backgroundShellManager._resetForTest();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  vi.restoreAllMocks();
});

describe("brokered workload shell execution", () => {
  it("uses the exact grant capability and accepts a clean non-default guest cwd", async () => {
    const command = "pwd";
    const cwd = "/tmp";
    const binding = issueBrokerShellGrant({ command, cwd });
    const controller = new AbortController();
    broker.execute.mockResolvedValueOnce(successfulRun("/tmp\n"));

    const result = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10 },
      context({ ...binding, signal: controller.signal }),
    );

    expect(result).toMatchObject({
      output: "/tmp",
      isError: false,
      metadata: {
        source: "workload-broker",
        executionTransport: "workload-broker",
        isolation: "disposable-container",
        workloadReceipt: { status: "exited", receiptDigest: RECEIPT_DIGEST },
      },
    });
    expect(broker.execute).toHaveBeenCalledWith(
      broker.capability,
      "shell.run",
      { command, cwd, timeoutMs: 10_000 },
      expect.objectContaining({ operation: "shell.run", toolName: "bash" }),
      controller.signal,
    );
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("accepts the broker protocol maximum timeout", async () => {
    const command = "long-build";
    const cwd = "/app";
    const binding = issueBrokerShellGrant({ command, cwd, timeoutSeconds: 3_600 });
    broker.execute.mockResolvedValueOnce(successfulRun("done"));

    const result = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 3_600 },
      context(binding),
    );

    expect(result).toMatchObject({ output: "done", isError: false });
    expect(broker.execute).toHaveBeenCalledWith(
      broker.capability,
      "shell.run",
      { command, cwd, timeoutMs: 3_600_000 },
      expect.objectContaining({ operation: "shell.run" }),
      undefined,
    );
  });

  it("returns an actionable broker timeout-limit error above 3600 seconds without sending a request", async () => {
    const command = "too-long-build";
    const cwd = "/app";
    const binding = issueBrokerShellGrant({ command, cwd, timeoutSeconds: 3_601 });

    const result = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 3_601 },
      context(binding),
    );

    expect(result).toMatchObject({ isError: true, metadata: { source: "workload-broker" } });
    expect(result.output).toContain("accepts at most 3600 seconds");
    expect(result.output).toContain("retry with a smaller timeoutSeconds");
    expect(broker.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["timed-out", /timed out/i],
    ["cancelled", /cancelled/i],
    ["oom-killed", /OOM-killed/i],
    ["cleanup-unproven", /cleanup was not proven/i],
  ] as const)("surfaces %s completion in content and forces an error", async (status, message) => {
    const command = "compile | tee build.log";
    const cwd = "/git";
    const binding = issueBrokerShellGrant({ command, cwd });
    broker.execute.mockResolvedValueOnce(terminalResult(status));

    const result = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10 },
      context(binding),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("partial broker output");
    expect(result.output).toMatch(message);
    expect(result.metadata?.workloadReceipt).toMatchObject({ status });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("preserves a large foreground result as an output artifact", async () => {
    const command = "emit-large-output";
    const cwd = "/app";
    const binding = issueBrokerShellGrant({ command, cwd });
    const largeOutput = "x".repeat(20_000);
    const artifact = {
      version: 1 as const,
      captureId: "00000000-0000-4000-8000-000000000001",
      status: "complete" as const,
      capturedBytes: largeOutput.length,
      observedBytes: largeOutput.length,
      capturedChars: largeOutput.length,
      sha256: "e".repeat(64),
    };
    const capture = {
      captureId: artifact.captureId,
      append: vi.fn(() => true),
      waitForDrain: vi.fn(async () => undefined),
      finish: vi.fn(async () => artifact),
    };
    broker.execute.mockResolvedValueOnce(successfulRun(largeOutput));

    const result = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10 },
      {
        ...context(binding),
        metadata: {
          sessionId: SESSION_ID,
          toolOutputCaptureFactory: () => capture,
        },
      },
    );

    expect(result.output).toMatch(/\.\.\.\[truncated\]\.\.\.$/);
    expect(result.metadata?.outputArtifact).toEqual(artifact);
    expect(capture.append).toHaveBeenCalledWith(Buffer.from(largeOutput));
    expect(capture.finish).toHaveBeenCalledWith(false);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("fails closed for missing, forged, replayed, and changed broker grants", async () => {
    const command = "printf should-not-run";
    const cwd = "/workspace";
    broker.execute.mockResolvedValue(successfulRun());

    const missing = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10 },
      context({ legacyPlan: getHostShellExecutionPlan(), cwd }),
    );
    expect(missing).toMatchObject({ isError: true, metadata: { source: "workload-broker" } });

    const forgedBinding = issueBrokerShellGrant({ command, cwd });
    const forged = Object.freeze({ ...forgedBinding.grant }) as ExecutionGrant;
    const forgedResult = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10 },
      context({ legacyPlan: forgedBinding.legacyPlan, grant: forged, cwd }),
    );
    expect(forgedResult).toMatchObject({ isError: true, metadata: { source: "workload-broker" } });

    const replayBinding = issueBrokerShellGrant({ command, cwd });
    const first = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10 },
      context({ ...replayBinding, cwd }),
    );
    expect(first.isError).toBe(false);
    const replay = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10 },
      context({ ...replayBinding, cwd }),
    );
    expect(replay).toMatchObject({ isError: true, metadata: { source: "workload-broker" } });

    const changedBinding = issueBrokerShellGrant({ command, cwd });
    broker.issued = false;
    const changed = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10 },
      context({ ...changedBinding, cwd }),
    );
    expect(changed).toMatchObject({ isError: true, metadata: { source: "workload-broker" } });

    expect(broker.execute).toHaveBeenCalledTimes(1);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("does not fall back locally when a previously issued broker grant becomes inactive", async () => {
    const command = "printf should-not-run";
    const cwd = "/workspace";
    const binding = issueBrokerShellGrant({ command, cwd });
    broker.active = false;

    const result = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10 },
      context({ ...binding, cwd }),
    );

    expect(result).toMatchObject({ isError: true, metadata: { source: "workload-broker" } });
    expect(broker.execute).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("does not use a local lifecycle handle while the workload broker route is active", async () => {
    const shellId = "local-looking-handle";
    const readInput = { shellId, waitMs: 0 };
    const waitForOutput = vi.fn();
    const read = vi.fn();
    const kill = vi.fn();
    const manager = {
      isBrokerShell: vi.fn(() => false),
      waitForOutput,
      read,
      kill,
    } as never;

    const readResult = await createBashOutputTool(manager).execute(
      readInput,
      lifecycleContext("bash_output", readInput),
    );
    const killInput = { shellId };
    const killResult = await createBashKillTool(manager).execute(
      killInput,
      lifecycleContext("bash_kill", killInput),
    );

    expect(readResult).toMatchObject({
      isError: true,
      metadata: { source: "workload-broker" },
    });
    expect(readResult.output).toContain("background-handle-not-found");
    expect(killResult).toMatchObject({
      isError: true,
      metadata: { source: "workload-broker" },
    });
    expect(killResult.output).toContain("background-handle-not-found");
    expect(waitForOutput).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("returns broker transport failures without trying a host process", async () => {
    const command = "make all";
    const cwd = "/app";
    const binding = issueBrokerShellGrant({ command, cwd });
    const failure: ToolExecutionResult = {
      output: "Workload broker refused execution (handshake-binding-mismatch).",
      isError: true,
      metadata: { source: "workload-broker", code: "handshake-binding-mismatch" },
    };
    broker.execute.mockResolvedValueOnce(failure);

    const result = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10 },
      context(binding),
    );

    expect(result).toMatchObject({
      isError: true,
      metadata: {
        source: "workload-broker",
        code: "handshake-binding-mismatch",
        executionTransport: "workload-broker",
      },
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("routes background start, read, and kill through the same broker capability", async () => {
    const command = "serve";
    const cwd = "/app";
    const binding = issueBrokerShellGrant({ command, cwd, background: true });
    broker.execute.mockImplementation(async (_capability, operation) => {
      if (operation === "shell.start") {
        return {
          output: "",
          isError: false,
          executionId: "exec_1",
          offset: 0,
          status: "running",
        };
      }
      if (operation === "shell.read") {
        return {
          executionId: "exec_1",
          offset: 0,
          nextOffset: 5,
          output: "ready",
          isError: false,
          running: true,
          truncated: false,
          status: "running",
        };
      }
      if (operation === "shell.kill") {
        return {
          executionId: "exec_1",
          nextOffset: 9,
          // shell.kill returns the full retained transcript. The shell manager
          // removes the already-read five UTF-8 bytes before presentation.
          output: "readydone",
          isError: false,
          truncated: false,
          status: "cancelled",
          exitCode: null,
          signal: "SIGKILL",
          timedOut: false,
          cancelled: true,
          oomDelta: 0,
          ownedResourcesZero: true,
          receiptDigest: RECEIPT_DIGEST,
        };
      }
      throw new Error(`unexpected operation: ${String(operation)}`);
    });

    const started = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10, run_in_background: true },
      context(binding),
    );
    const shellId = (JSON.parse(started.output) as { shellId: string }).shellId;
    expect(started).toMatchObject({
      isError: false,
      metadata: { source: "workload-broker", backgrounded: true },
    });

    const readInput = { shellId, waitMs: 0 };
    const ownerContext = lifecycleContext("bash_output", readInput);
    const read = await createBashOutputTool().execute(
      readInput,
      ownerContext,
    );
    expect(JSON.parse(read.output)).toMatchObject({
      shellId,
      status: "running",
      output: "ready",
    });

    const beforeCrossSession = broker.execute.mock.calls.length;
    const denied = await createBashOutputTool().execute(
      { shellId, waitMs: 0 },
      { ...ownerContext, metadata: { sessionId: "other-session" } },
    );
    expect(denied.isError).toBe(true);
    expect(broker.execute).toHaveBeenCalledTimes(beforeCrossSession);

    const killInput = { shellId };
    const killed = await createBashKillTool().execute(
      killInput,
      lifecycleContext("bash_kill", killInput),
    );
    expect(killed.isError).toBe(true);
    expect(JSON.parse(killed.output)).toMatchObject({
      shellId,
      status: "killed",
      workloadStatus: "cancelled",
      output: "done",
      completion: expect.stringMatching(/cancelled/i),
    });
    expect(killed.metadata?.workloadReceipt).toMatchObject({
      status: "cancelled",
      receiptDigest: RECEIPT_DIGEST,
    });

    expect(broker.execute.mock.calls.map((call) => call[1])).toEqual([
      "shell.start",
      "shell.read",
      "shell.kill",
    ]);
    expect(broker.execute.mock.calls.every((call) => call[0] === broker.capability)).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("advances background cursors in UTF-8 bytes and de-duplicates full kill output", async () => {
    const command = "unicode-stream";
    const cwd = "/app";
    const binding = issueBrokerShellGrant({ command, cwd, background: true });
    broker.execute.mockImplementation(async (_capability, operation) => {
      if (operation === "shell.start") {
        return {
          output: "",
          isError: false,
          executionId: "exec_unicode",
          offset: 0,
          status: "running",
        };
      }
      if (operation === "shell.read") {
        return {
          executionId: "exec_unicode",
          offset: 0,
          nextOffset: 6,
          output: "é🙂",
          isError: false,
          running: true,
          truncated: false,
          status: "running",
        };
      }
      if (operation === "shell.kill") {
        return {
          executionId: "exec_unicode",
          nextOffset: 9,
          output: "é🙂終",
          isError: true,
          truncated: false,
          status: "cancelled",
          exitCode: null,
          signal: "SIGKILL",
          timedOut: false,
          cancelled: true,
          oomDelta: 0,
          ownedResourcesZero: true,
          receiptDigest: RECEIPT_DIGEST,
        };
      }
      throw new Error(`unexpected operation: ${String(operation)}`);
    });

    const started = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10, run_in_background: true },
      context(binding),
    );
    const shellId = (JSON.parse(started.output) as { shellId: string }).shellId;
    const readInput = { shellId, waitMs: 0 };
    const read = await createBashOutputTool().execute(
      readInput,
      lifecycleContext("bash_output", readInput),
    );
    expect(JSON.parse(read.output)).toMatchObject({ output: "é🙂" });

    const killInput = { shellId };
    const killed = await createBashKillTool().execute(
      killInput,
      lifecycleContext("bash_kill", killInput),
    );
    expect(JSON.parse(killed.output)).toMatchObject({ output: "終" });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("rejects a broker read whose cursor advances by characters instead of UTF-8 bytes", async () => {
    const command = "bad-unicode-cursor";
    const cwd = "/app";
    const binding = issueBrokerShellGrant({ command, cwd, background: true });
    broker.execute.mockResolvedValueOnce({
      output: "",
      isError: false,
      executionId: "exec_bad_cursor",
      offset: 0,
      status: "running",
    }).mockResolvedValueOnce({
      executionId: "exec_bad_cursor",
      offset: 0,
      nextOffset: "é🙂".length,
      output: "é🙂",
      isError: false,
      running: true,
      truncated: false,
      status: "running",
    });

    const started = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10, run_in_background: true },
      context(binding),
    );
    const shellId = (JSON.parse(started.output) as { shellId: string }).shellId;
    const readInput = { shellId, waitMs: 0 };
    const read = await createBashOutputTool().execute(
      readInput,
      lifecycleContext("bash_output", readInput),
    );

    expect(read).toMatchObject({ isError: true, metadata: { source: "workload-broker" } });
    expect(read.output).toMatch(/background-binding-mismatch/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("tracks broker session disposal until terminal cleanup is proven", async () => {
    const command = "serve-until-dispose";
    const cwd = "/app";
    const binding = issueBrokerShellGrant({ command, cwd, background: true });
    let finishKill!: (result: unknown) => void;
    const pendingKill = new Promise((resolve) => { finishKill = resolve; });
    broker.execute.mockResolvedValueOnce({
      output: "",
      isError: false,
      executionId: "exec_dispose",
      offset: 0,
      status: "running",
    }).mockReturnValueOnce(pendingKill);

    const started = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10, run_in_background: true },
      context(binding),
    );
    expect(started.isError).toBe(false);
    expect(backgroundShellManager.disposeSession(SESSION_ID)).toBe(1);
    expect(backgroundShellManager.getBrokerCleanupReport(SESSION_ID)).toMatchObject({
      state: "pending",
      requested: 1,
      settled: 0,
      pending: 1,
    });

    finishKill({
      executionId: "exec_dispose",
      nextOffset: 0,
      output: "",
      isError: true,
      truncated: false,
      status: "cancelled",
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      cancelled: true,
      oomDelta: 0,
      ownedResourcesZero: true,
      receiptDigest: RECEIPT_DIGEST,
    });
    const report = await backgroundShellManager.waitForBrokerCleanup(SESSION_ID);
    expect(report).toMatchObject({
      state: "complete",
      requested: 1,
      settled: 1,
      pending: 0,
      cleanupUnproven: 0,
      outcomes: [{
        executionId: "exec_dispose",
        state: "complete",
        ownedResourcesZero: true,
        requiresExternalRelease: false,
      }],
    });
    await expect(backgroundShellManager.waitForAllBrokerCleanup()).resolves.toEqual([
      report,
    ]);
    expect(broker.execute.mock.calls.map((call) => call[1])).toEqual([
      "shell.start",
      "shell.kill",
    ]);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("preserves capability-expired disposal as cleanup-unproven for external release", async () => {
    const command = "serve-across-expiry";
    const cwd = "/app";
    const binding = issueBrokerShellGrant({ command, cwd, background: true });
    const expiresAt = Date.parse(broker.capability.expiresAt);
    const now = vi.spyOn(Date, "now");
    // Leave the full command deadline plus the expanded Docker identity and
    // terminal cleanup allowance live at admission, then force expiry only
    // for the disposal path under test.
    now.mockReturnValue(expiresAt - 60_000);
    broker.execute.mockResolvedValueOnce({
      output: "",
      isError: false,
      executionId: "exec_expired",
      offset: 0,
      status: "running",
    }).mockResolvedValueOnce({
      output: "Workload broker refused execution (capability-expired).",
      isError: true,
      metadata: { source: "workload-broker", code: "capability-expired" },
    });

    const started = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10, run_in_background: true },
      context(binding),
    );
    expect(started.isError).toBe(false);
    now.mockReturnValue(expiresAt + 1);

    expect(backgroundShellManager.disposeSession(SESSION_ID)).toBe(1);
    const report = await backgroundShellManager.waitForBrokerCleanup(SESSION_ID);
    expect(report).toMatchObject({
      state: "cleanup-unproven",
      requested: 1,
      settled: 1,
      pending: 0,
      cleanupUnproven: 1,
      outcomes: [{
        executionId: "exec_expired",
        state: "cleanup-unproven",
        ownedResourcesZero: false,
        requiresExternalRelease: true,
        failure: "workload-broker:capability-expired",
      }],
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("starts cleanup for every live broker shell at process shutdown", async () => {
    backgroundShellManager.registerBroker({
      sessionId: "shutdown-a",
      command: "serve-a",
      executionId: "exec_shutdown_a",
      capability: broker.capability as never,
      parent: {} as never,
      offset: 0,
    });
    backgroundShellManager.registerBroker({
      sessionId: "shutdown-b",
      command: "serve-b",
      executionId: "exec_shutdown_b",
      capability: broker.capability as never,
      parent: {} as never,
      offset: 0,
    });
    broker.execute.mockImplementation(async (_capability, operation, payload) => {
      expect(operation).toBe("shell.kill");
      const executionId = (payload as { executionId: string }).executionId;
      return {
        executionId,
        nextOffset: 0,
        output: "",
        isError: true,
        truncated: false,
        status: "cancelled",
        exitCode: null,
        signal: "SIGKILL",
        timedOut: false,
        cancelled: true,
        oomDelta: 0,
        ownedResourcesZero: true,
        receiptDigest: RECEIPT_DIGEST,
      };
    });

    expect(backgroundShellManager.disposeAllBrokerShells()).toBe(2);
    const reports = await backgroundShellManager.waitForAllBrokerCleanup();
    expect(reports).toHaveLength(2);
    expect(reports.every((report) => report.state === "complete")).toBe(true);
    expect(backgroundShellManager._size()).toBe(0);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("propagates the shutdown deadline through a delayed broker cleanup request", async () => {
    const controller = new AbortController();
    let cleanupSignal: AbortSignal | undefined;
    backgroundShellManager.registerBroker({
      sessionId: "shutdown-delayed",
      command: "serve-delayed",
      executionId: "exec_shutdown_delayed",
      capability: broker.capability as never,
      parent: {} as never,
      offset: 0,
    });
    broker.execute.mockImplementationOnce(async (_capability, operation, _payload, _authority, signal) => {
      expect(operation).toBe("shell.kill");
      cleanupSignal = signal as AbortSignal;
      return await new Promise<ToolExecutionResult>((resolve) => {
        const aborted = () => resolve({
          output: "Workload broker refused execution (request-aborted).",
          isError: true,
          metadata: { source: "workload-broker", code: "request-aborted" },
        });
        if (cleanupSignal!.aborted) aborted();
        else cleanupSignal!.addEventListener("abort", aborted, { once: true });
      });
    });

    expect(backgroundShellManager.disposeAllBrokerShells(controller.signal)).toBe(1);
    controller.abort(new Error("shutdown deadline elapsed"));
    const reports = await backgroundShellManager.waitForAllBrokerCleanup();

    expect(cleanupSignal?.aborted).toBe(true);
    expect(reports).toMatchObject([{
      state: "cleanup-unproven",
      outcomes: [{
        executionId: "exec_shutdown_delayed",
        requiresExternalRelease: true,
        failure: "workload-broker:request-aborted",
      }],
    }]);
  });

  it("does not start a background job that would outlive its broker capability", async () => {
    const command = "too-late";
    const cwd = "/app";
    const binding = issueBrokerShellGrant({ command, cwd, background: true });
    const expiresAt = Date.parse(broker.capability.expiresAt);
    vi.spyOn(Date, "now").mockReturnValue(expiresAt - 25_000);

    const result = await new BashTool().execute(
      { command, cwd, timeoutSeconds: 10, run_in_background: true },
      context(binding),
    );

    expect(result).toMatchObject({ isError: true, metadata: { source: "workload-broker" } });
    expect(result.output).toMatch(/background-capability-lifetime-insufficient/);
    expect(broker.execute).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("retains ordinary desktop host execution when no broker is configured", async () => {
    broker.active = false;
    broker.issued = false;

    const result = await new BashTool().execute(
      { command: "printf host-ok", timeoutSeconds: 10 },
      context({ cwd: process.cwd() }),
    );

    expect(result).toMatchObject({ output: "host-ok", isError: false });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(broker.execute).not.toHaveBeenCalled();
  });
});
