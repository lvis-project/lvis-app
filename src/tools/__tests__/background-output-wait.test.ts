import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetManagedChildProcessesForTest, forceKillAndDrainManagedChildProcesses, getManagedChildProcessCount } from "../../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { ToolExecutionContext } from "../base.js";
import { backgroundShellManager as manager, createBashOutputTool, MAX_OUTPUT_CHARS } from "../shell-tools.js";

function register(killProcessGroup = false) {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kill = vi.fn(() => true);
  Object.assign(child, { stdout, stderr, kill, exitCode: null, ...(killProcessGroup ? { pid: 4321 } : {}) });
  const shellId = manager.register({ child, sessionId: "owner", command: "work", startedAt: "t", killProcessGroup });
  return { child, stdout, stderr, kill, shellId };
}
function read(shellId: string, waitMs?: unknown, signal?: AbortSignal, sessionId = "owner") {
  const ctx = { metadata: { sessionId }, abortSignal: signal } as ToolExecutionContext;
  return createBashOutputTool().execute({ shellId, ...(waitMs === undefined ? {} : { waitMs }) }, ctx);
}

beforeEach(() => { vi.useFakeTimers(); manager._resetForTest(); __resetManagedChildProcessesForTest(); });
afterEach(() => { manager._resetForTest(); __resetManagedChildProcessesForTest(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("background output bounded waiting", () => {
  it.each([undefined, 0])("keeps %s wait immediate", async (waitMs) => {
    const { shellId } = register();
    expect(JSON.parse((await read(shellId, waitMs)).output).status).toBe("running");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns unread output immediately and advances the cursor once", async () => {
    const f = register(); f.stdout.emit("data", Buffer.from("first"));
    expect(JSON.parse((await read(f.shellId, 1000)).output).output).toBe("first");
    expect(manager.read("owner", f.shellId)?.output).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["stdout", "stderr"] as const)("wakes on %s and removes abort subscription", async (stream) => {
    const f = register(); const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = read(f.shellId, 1000, controller.signal);
    f[stream].emit("data", Buffer.from("new"));
    expect(JSON.parse((await pending).output).output).toBe("new");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0); expect(f.kill).not.toHaveBeenCalled();
  });
  it("times out without stopping a running process", async () => {
    const f = register(); const pending = read(f.shellId, 1000);
    await vi.advanceTimersByTimeAsync(999); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse((await pending).output).status).toBe("running");
    expect(f.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])("cancels a read (already aborted: %s) without consuming output or killing", async (early) => {
    const f = register(); const controller = new AbortController();
    if (early) controller.abort();
    const pending = read(f.shellId, 1000, controller.signal);
    controller.abort(); f.stdout.emit("data", Buffer.from("retained"));
    expect((await pending).metadata?.aborted).toBe(true);
    expect(manager.read("owner", f.shellId)?.output).toBe("retained");
    expect(f.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves output when cancellation follows notification before the read resumes", async () => {
    const f = register(); const controller = new AbortController();
    const pending = read(f.shellId, 1000, controller.signal);
    f.stdout.emit("data", Buffer.from("retained")); controller.abort();
    expect((await pending).metadata?.aborted).toBe(true);
    expect(manager.read("owner", f.shellId)?.output).toBe("retained");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["close", "error", "kill"])("wakes on %s", async (event) => {
    const f = register(); const pending = read(f.shellId, 1000);
    if (event === "close") f.child.emit("close", 7);
    else if (event === "error") f.child.emit("error", new Error("failed"));
    else manager.kill("owner", f.shellId);
    const output = JSON.parse((await pending).output);
    expect(output.status).toBe(event === "close" ? "exited" : event === "error" ? "failed" : "killed");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns closed process status without waiting", async () => {
    const f = register(); f.child.emit("close", 0);
    expect(JSON.parse((await read(f.shellId, 1000)).output).status).toBe("exited");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["dispose", "reset"])("releases waiting reads on %s", async (action) => {
    const f = register(); const pending = read(f.shellId, 1000);
    if (action === "dispose") manager.disposeSession("owner"); else manager._resetForTest();
    expect((await pending).output).toContain("no background shell");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.skipIf(process.platform === "win32").each(["dispose", "prune"])("%s releases the session handle but retains an inaccessible group for shutdown", async (action) => {
    let denied = true;
    let groupAlive = true;
    const signal = vi.spyOn(process, "kill").mockImplementation((_pid, kind) => {
      if (!groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (kind === "SIGKILL") {
        if (denied) throw Object.assign(new Error("denied"), { code: "EPERM" });
        groupAlive = false;
      }
      return true;
    });
    const f = register(true);
    f.stdout.emit("data", Buffer.from("finished output"));
    Object.assign(f.child, { exitCode: 0 });
    f.child.emit("exit", 0, null);
    f.child.emit("close", 0);
    manager.read("owner", f.shellId);

    if (action === "prune") register();
    manager.disposeSession("owner");
    expect(manager.read("owner", f.shellId)).toBeUndefined();
    expect(getManagedChildProcessCount()).toBe(1);
    denied = false;
    const drain = forceKillAndDrainManagedChildProcesses("session-cleanup", TOOL_TIMEOUT_POLICY.processGroupPollMs + 20);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processGroupPollMs);
    await expect(drain).resolves.toEqual({ killedCount: 1, unresolvedCount: 0 });
    expect(signal.mock.calls.filter(([, kind]) => kind === "SIGKILL")).toHaveLength(2);
  });
  it("rejects other sessions immediately without consuming the owner's output", async () => {
    const f = register(); f.stdout.emit("data", Buffer.from("private"));
    expect((await read(f.shellId, 1000, undefined, "other")).isError).toBe(true);
    expect(manager.read("owner", f.shellId)?.output).toBe("private");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains the output cap and waits for completion when further bytes are dropped", async () => {
    const f = register(); f.stdout.emit("data", Buffer.from("x".repeat(MAX_OUTPUT_CHARS + 1)));
    expect(manager.read("owner", f.shellId)?.output.length).toBe(MAX_OUTPUT_CHARS);
    const pending = read(f.shellId, 1000); f.stdout.emit("data", Buffer.from("dropped"));
    expect(vi.getTimerCount()).toBe(1); f.child.emit("close", 0);
    expect(JSON.parse((await pending).output)).toMatchObject({ output: "", truncated: true, status: "exited" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([-1, 0.5, 30001, Infinity, NaN, "100", null])("rejects invalid wait %s during execution", async (waitMs) => {
    const f = register(); expect((await read(f.shellId, waitMs)).isError).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
