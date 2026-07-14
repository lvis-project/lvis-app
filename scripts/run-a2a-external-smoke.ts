import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { A2ASubAgentLifecycleRunner } from "../src/api/a2a-subagent-handler.js";
import { startLocalApiHttpServer } from "../src/api/http-server.js";
import { createStreamBroadcaster } from "../src/api/stream-broadcaster.js";
import type {
  A2AWireHostBinding,
  A2AWireResumeBinding,
  A2AWireRunSnapshot,
  A2AWireSpawnCallbacks,
  SubAgentSpawnCallbacks,
  SubAgentSpawnResult,
} from "../src/engine/subagent-runner.js";
import type { LoadedAgentProfile } from "../src/main/agent-profile-store.js";
import { createA2ALoopbackRuntime } from "../src/main/a2a-loopback-runtime.js";
import { A2ATaskState } from "../src/shared/a2a.js";
import { resolveUvTarget } from "./uv-targets.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const clientDir = resolve(scriptDir, "a2a-external-smoke");
const clientPath = resolve(clientDir, "client.py");
const smokeWorkspaceRoot = resolve(repoRoot, "scripts", "a2a-external-smoke", "workspace");
const smokeProfilePath = resolve(repoRoot, "scripts", "a2a-external-smoke", "external-smoke.md");
const PHASE_TIMEOUT_MS = 180_000;
const PROCESS_EXIT_GRACE_MS = 5_000;
const PROCESS_KILL_GRACE_MS = 5_000;
const PROCESS_POLL_MS = 50;

type ChildOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; error: Error }
  | { kind: "timeout" };

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForChildOutcome(child: ChildProcess, timeoutMs: number): Promise<ChildOutcome> {
  if (!isChildRunning(child)) {
    return Promise.resolve({ kind: "exit", code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<ChildOutcome>((resolveOutcome) => {
    let settled = false;
    const finish = (outcome: ChildOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolveOutcome(outcome);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({ kind: "exit", code, signal });
    };
    const onError = (error: Error): void => {
      finish({ kind: "error", error });
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const outcome = await waitForChildOutcome(child, timeoutMs);
  return outcome.kind === "exit" || !isChildRunning(child);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(PROCESS_POLL_MS, remaining));
  }
  return true;
}

async function stopWindowsProcessTree(child: ChildProcess, pid: number): Promise<void> {
  if (!isChildRunning(child)) return;
  const childExit = waitForChildExit(
    child,
    PROCESS_EXIT_GRACE_MS + PROCESS_KILL_GRACE_MS,
  );
  if (!isChildRunning(child)) return;
  const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const taskkillOutcome = await waitForChildOutcome(taskkill, PROCESS_EXIT_GRACE_MS);
  if (taskkillOutcome.kind === "timeout") {
    taskkill.kill("SIGKILL");
    await waitForChildExit(taskkill, PROCESS_KILL_GRACE_MS);
    throw new Error("taskkill timed out while stopping the external A2A smoke process tree");
  }
  if (taskkillOutcome.kind === "error") {
    throw new Error("taskkill failed to start for the external A2A smoke process tree", {
      cause: taskkillOutcome.error,
    });
  }
  const exited = await childExit;
  if (!exited) {
    throw new Error("external A2A smoke process tree did not exit after taskkill");
  }
  if (taskkillOutcome.code !== 0 && isChildRunning(child)) {
    throw new Error(`taskkill exited ${taskkillOutcome.code ?? taskkillOutcome.signal ?? "unknown"}`);
  }
}

async function stopPosixProcessTree(child: ChildProcess, pid: number): Promise<void> {
  if (!isChildRunning(child) && !processGroupExists(pid)) return;
  signalProcessGroup(pid, "SIGTERM");
  const [termChildExited, termGroupExited] = await Promise.all([
    waitForChildExit(child, PROCESS_EXIT_GRACE_MS),
    waitForProcessGroupExit(pid, PROCESS_EXIT_GRACE_MS),
  ]);
  if (termChildExited && termGroupExited) return;

  signalProcessGroup(pid, "SIGKILL");
  const [killChildExited, killGroupExited] = await Promise.all([
    waitForChildExit(child, PROCESS_KILL_GRACE_MS),
    waitForProcessGroupExit(pid, PROCESS_KILL_GRACE_MS),
  ]);
  if (!killChildExited || !killGroupExited) {
    throw new Error("external A2A smoke process tree did not exit after SIGKILL");
  }
}

async function stopProcessTree(child: ChildProcess | undefined): Promise<void> {
  if (!child) return;
  const pid = child.pid;
  if (pid === undefined) {
    // Spawn failed before an operating-system process existed; there is no tree to stop.
    return;
  }
  if (process.platform === "win32") {
    if (!isChildRunning(child)) return;
    await stopWindowsProcessTree(child, pid);
    return;
  }
  await stopPosixProcessTree(child, pid);
}

interface MutationCounts {
  approvals: number;
  spawns: number;
  resumes: number;
  cancels: number;
}

function result(
  childSessionId: string,
  input: Partial<SubAgentSpawnResult> = {},
): SubAgentSpawnResult {
  return {
    summary: "Smoke task completed.",
    toolCallCount: 0,
    turnCount: 1,
    childSessionId,
    entries: [],
    ok: true,
    ...input,
  };
}

class DeterministicLifecycleRunner implements A2ASubAgentLifecycleRunner {
  readonly counts: MutationCounts = {
    approvals: 0,
    spawns: 0,
    resumes: 0,
    cancels: 0,
  };

  private readonly snapshots = new Map<string, A2AWireRunSnapshot>();
  private readonly pending = new Map<string, (value: SubAgentSpawnResult) => void>();

  private snapshot(
    childSessionId: string,
    taskState: A2AWireRunSnapshot["taskState"],
    extra: Partial<A2AWireRunSnapshot> = {},
  ): A2AWireRunSnapshot {
    return {
      childSessionId,
      title: "External SDK smoke",
      taskState,
      ...extra,
    };
  }

  async spawnFromA2AWire(
    request: { messageText: unknown },
    _binding: A2AWireHostBinding,
    callbacks: A2AWireSpawnCallbacks,
  ): Promise<SubAgentSpawnResult> {
    this.counts.spawns += 1;
    const prompt = String(request.messageText);
    const childSessionId = prompt === "complete-request"
      ? "task-complete"
      : prompt === "wait-request"
        ? "task-waiting"
        : prompt === "cancel-request"
          ? "task-cancel"
          : "task-rejected";
    this.snapshots.set(
      childSessionId,
      this.snapshot(childSessionId, A2ATaskState.WORKING),
    );
    await callbacks.onDurablyLinked({ childSessionId });

    if (prompt === "complete-request") {
      this.snapshots.set(
        childSessionId,
        this.snapshot(childSessionId, A2ATaskState.COMPLETED, {
          summary: "Smoke task completed.",
        }),
      );
      return result(childSessionId);
    }
    if (prompt === "wait-request") {
      const suspension = {
        reason: "question" as const,
        prompt: "Send the continuation message.",
        resumeId: childSessionId,
      };
      this.snapshots.set(
        childSessionId,
        this.snapshot(childSessionId, A2ATaskState.INPUT_REQUIRED, { suspension }),
      );
      return result(childSessionId, {
        summary: "Waiting for input.",
        suspension,
      });
    }
    if (prompt === "cancel-request") {
      return await new Promise<SubAgentSpawnResult>((resolvePending) => {
        this.pending.set(childSessionId, resolvePending);
      });
    }
    throw new Error("unexpected external smoke request");
  }

  async resumeFromA2AWire(
    request: { resumeId: unknown; messageText: unknown },
    _binding: A2AWireResumeBinding,
    _callbacks?: SubAgentSpawnCallbacks,
  ): Promise<SubAgentSpawnResult> {
    this.counts.resumes += 1;
    assert.equal(request.resumeId, "task-waiting");
    assert.equal(request.messageText, "continue-request");
    const childSessionId = String(request.resumeId);
    this.snapshots.set(
      childSessionId,
      this.snapshot(childSessionId, A2ATaskState.COMPLETED, {
        summary: "Continuation completed.",
      }),
    );
    return result(childSessionId, { summary: "Continuation completed." });
  }

  getA2AWireRunSnapshot(
    childSessionId: string,
    _binding: A2AWireResumeBinding,
  ): A2AWireRunSnapshot | null {
    const snapshot = this.snapshots.get(childSessionId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async cancelA2AWireRun(
    childSessionId: string,
    _binding: A2AWireResumeBinding,
  ) {
    this.counts.cancels += 1;
    const snapshot = this.snapshot(childSessionId, A2ATaskState.CANCELED);
    this.snapshots.set(childSessionId, snapshot);
    const resolvePending = this.pending.get(childSessionId);
    this.pending.delete(childSessionId);
    resolvePending?.(
      result(childSessionId, {
        summary: "Smoke task canceled.",
        ok: false,
        error: "Smoke task canceled.",
        stopReason: "interrupted",
      }),
    );
    return { ok: true as const, run: structuredClone(snapshot) };
  }
}

function inMemoryNamespace() {
  let stored: unknown;
  return {
    readJson: async <T>(_name: string, fallback: T): Promise<T> =>
      structuredClone(stored === undefined ? fallback : stored) as T,
    writeJson: async <T>(_name: string, value: T): Promise<void> => {
      stored = structuredClone(value);
    },
  };
}

function smokeProfile(): LoadedAgentProfile {
  return {
    name: "external-smoke",
    description: "External SDK interoperability smoke profile.",
    sourceTools: [],
    triggers: [],
    body: "Complete only the deterministic external smoke request.",
    filePath: smokeProfilePath,
  };
}

async function runPythonClient(
  uvPath: string,
  phase: "unauthorized" | "scenarios",
  baseUrl: string,
  bearer: string,
  setActiveChild: (child: ChildProcess | undefined) => void,
): Promise<void> {
  const child = spawn(uvPath, ["run", "--frozen", clientPath], {
    cwd: clientDir,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      A2A_SMOKE_BASE_URL: baseUrl,
      A2A_SMOKE_BEARER: bearer,
      A2A_SMOKE_PHASE: phase,
    },
    stdio: "inherit",
    windowsHide: true,
  });
  setActiveChild(child);

  const outcome = await waitForChildOutcome(child, PHASE_TIMEOUT_MS);
  if (outcome.kind === "exit" && outcome.code === 0) {
    setActiveChild(undefined);
    return;
  }
  const failure = outcome.kind === "timeout"
    ? new Error(`official Python A2A SDK smoke (${phase}) timed out after ${PHASE_TIMEOUT_MS}ms`)
    : outcome.kind === "error"
      ? new Error(`official Python A2A SDK smoke (${phase}) failed to start`, {
          cause: outcome.error,
        })
      : new Error(
          `official Python A2A SDK smoke (${phase}) exited ${outcome.code ?? outcome.signal ?? "unknown"}`,
        );
  try {
    await stopProcessTree(child);
    setActiveChild(undefined);
  } catch (cleanupError) {
    throw new AggregateError(
      [failure, cleanupError],
      `official Python A2A SDK smoke (${phase}) failed and its process tree cleanup failed`,
    );
  }
  throw failure;
}

async function main(): Promise<void> {
  const uvTarget = resolveUvTarget(process.platform, process.arch);
  const uvPath = resolve(repoRoot, "resources", "uv", uvTarget.dir, uvTarget.bin);
  await access(uvPath);
  await access(clientPath);

  const runner = new DeterministicLifecycleRunner();
  const profile = smokeProfile();
  const runtime = await createA2ALoopbackRuntime({
    services: {
      agentProfileStore: { list: async () => [profile] } as never,
      getSubAgentRunner: () => runner as never,
      auditLogger: { log: () => undefined } as never,
    },
    project: { root: smokeWorkspaceRoot },
    appVersion: "1.0.0",
    approveAgentAction: async () => {
      runner.counts.approvals += 1;
      return true;
    },
    namespace: inMemoryNamespace(),
  });
  assert(runtime, "production A2A loopback runtime was not created");

  const bearer = randomBytes(32).toString("base64url");
  const wrongBearer = randomBytes(32).toString("base64url");
  let server: Awaited<ReturnType<typeof startLocalApiHttpServer>> | undefined;
  let activeChild: ChildProcess | undefined;

  let operationFailed = false;
  let operationError: unknown;
  try {
    server = await startLocalApiHttpServer({
      api: { dispatch: async () => ({ ok: true as const, data: {} }) },
      secret: bearer,
      broadcaster: createStreamBroadcaster(),
      a2aRouter: runtime.router,
      routeFamilies: { localApi: false, a2a: true },
      host: "127.0.0.1",
      port: 0,
    });
    const handlerId = runtime.router.handlerIds[0];
    assert(handlerId, "production A2A runtime exposed no handler");
    const baseUrl = `http://127.0.0.1:${server.port}/a2a/${handlerId}`;

    await runPythonClient(
      uvPath,
      "unauthorized",
      baseUrl,
      wrongBearer,
      (child) => { activeChild = child; },
    );
    assert.deepEqual(runner.counts, {
      approvals: 0,
      spawns: 0,
      resumes: 0,
      cancels: 0,
    }, "wrong bearer reached an approval or runner mutation");

    await runPythonClient(
      uvPath,
      "scenarios",
      baseUrl,
      bearer,
      (child) => { activeChild = child; },
    );
    assert.deepEqual(runner.counts, {
      approvals: 5,
      spawns: 3,
      resumes: 1,
      cancels: 1,
    }, "production handler mutation counts did not match the smoke scenarios");
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupLabels = ["external SDK process tree", "loopback server", "A2A runtime"] as const;
  const cleanupResults = await Promise.allSettled([
    stopProcessTree(activeChild),
    Promise.resolve().then(async () => { await server?.close(); }),
    runtime.dispose(),
  ]);
  const cleanupErrors = cleanupResults.flatMap((cleanupResult, index) =>
    cleanupResult.status === "rejected"
      ? [new Error(`${cleanupLabels[index]} cleanup failed`, { cause: cleanupResult.reason })]
      : [],
  );
  if (
    cleanupResults[0]?.status === "rejected"
    && activeChild
    && isChildRunning(activeChild)
  ) {
    activeChild.unref();
  }

  if (operationFailed) {
    if (cleanupErrors.length === 0) throw operationError;
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "external A2A smoke failed and one or more cleanup operations failed",
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "external A2A smoke cleanup failed");
  }
  process.stdout.write("production-handler external A2A smoke: passed\n");
}

await main();
