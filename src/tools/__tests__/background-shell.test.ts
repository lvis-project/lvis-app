import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  backgroundShellManager,
  MAX_OUTPUT_CHARS,
} from "../background-shell-manager.js";
import { createBashOutputTool, createBashKillTool } from "../background-shell-tools.js";
import { __resetManagedChildProcessesForTest } from "../../main/managed-child-processes.js";

/** Minimal ChildProcess stand-in: stdout/stderr emitters + kill + exit/close/error. */
function fakeChild(): {
  child: import("node:child_process").ChildProcess;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  emitClose: (code: number | null) => void;
  emitError: (message: string) => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
  const kill = vi.fn(() => true);
  Object.assign(emitter, { stdout, stderr, kill, exitCode: null, pid: 1234 });
  return {
    child: emitter,
    stdout,
    stderr,
    kill,
    emitClose: (code) => emitter.emit("close", code),
    emitError: (message) => emitter.emit("error", new Error(message)),
  };
}

const ctx = (sessionId: string) => ({ metadata: { sessionId } }) as never;

beforeEach(() => {
  backgroundShellManager._resetForTest();
  __resetManagedChildProcessesForTest();
});

describe("backgroundShellManager", () => {
  it("registers a shell and reads its incremental output", () => {
    const f = fakeChild();
    const id = backgroundShellManager.register({
      sessionId: "s1",
      command: "npm run dev",
      child: f.child,
      startedAt: "t0",
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(backgroundShellManager._size()).toBe(1);

    f.stdout.emit("data", Buffer.from("hello "));
    f.stderr.emit("data", Buffer.from("warn"));
    const first = backgroundShellManager.read("s1", id);
    expect(first?.output).toBe("hello warn");
    expect(first?.status).toBe("running");

    // Second read returns only what arrived since the first.
    f.stdout.emit("data", Buffer.from("!"));
    const second = backgroundShellManager.read("s1", id);
    expect(second?.output).toBe("!");
  });

  it("transitions to exited with the exit code on close", () => {
    const f = fakeChild();
    const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
    f.emitClose(0);
    const r = backgroundShellManager.read("s1", id);
    expect(r?.status).toBe("exited");
    expect(r?.exitCode).toBe(0);
  });

  it("transitions to failed on spawn error and captures the message", () => {
    const f = fakeChild();
    const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
    f.emitError("ENOENT");
    const r = backgroundShellManager.read("s1", id);
    expect(r?.status).toBe("failed");
    expect(r?.output).toContain("ENOENT");
  });

  it("kill sends SIGTERM and marks the shell killed", () => {
    const f = fakeChild();
    const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
    const r = backgroundShellManager.kill("s1", id);
    expect(f.kill).toHaveBeenCalledWith("SIGTERM");
    expect(r?.status).toBe("killed");
  });

  it("scopes read/kill to the owning session", () => {
    const f = fakeChild();
    const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
    expect(backgroundShellManager.read("s2", id)).toBeUndefined();
    expect(backgroundShellManager.kill("s2", id)).toBeUndefined();
    expect(f.kill).not.toHaveBeenCalled();
    // Owner still sees it.
    expect(backgroundShellManager.read("s1", id)).toBeDefined();
  });

  it("caps total output and latches truncated", () => {
    const f = fakeChild();
    const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
    f.stdout.emit("data", Buffer.from("a".repeat(MAX_OUTPUT_CHARS + 500)));
    const r = backgroundShellManager.read("s1", id);
    expect(r?.truncated).toBe(true);
    expect(r?.output.length).toBe(MAX_OUTPUT_CHARS);
    // Further output is dropped.
    f.stdout.emit("data", Buffer.from("more"));
    expect(backgroundShellManager.read("s1", id)?.output).toBe("");
  });

  it("disposeSession kills running shells of that session only", () => {
    const a = fakeChild();
    const b = fakeChild();
    backgroundShellManager.register({ sessionId: "s1", command: "a", child: a.child, startedAt: "t" });
    backgroundShellManager.register({ sessionId: "s2", command: "b", child: b.child, startedAt: "t" });
    const disposed = backgroundShellManager.disposeSession("s1");
    expect(disposed).toBe(1);
    expect(a.kill).toHaveBeenCalledWith("SIGKILL");
    expect(b.kill).not.toHaveBeenCalled();
    expect(backgroundShellManager._size()).toBe(1);
  });
});

describe("bash_output / bash_kill tools", () => {
  it("bash_output returns the shell's output for the owning session", async () => {
    const f = fakeChild();
    const id = backgroundShellManager.register({ sessionId: "s1", command: "tail -f log", child: f.child, startedAt: "t" });
    f.stdout.emit("data", Buffer.from("line1\n"));
    const tool = createBashOutputTool();
    const res = await tool.execute({ shellId: id }, ctx("s1"));
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.output);
    expect(parsed).toMatchObject({ shellId: id, status: "running" });
    expect(parsed.output).toBe("line1\n");
  });

  it("bash_output rejects a shell from another session (not found)", async () => {
    const f = fakeChild();
    const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
    const tool = createBashOutputTool();
    const res = await tool.execute({ shellId: id }, ctx("other"));
    expect(res.isError).toBe(true);
    expect(res.output).toContain("no background shell");
  });

  it("bash_output requires a shellId", async () => {
    const tool = createBashOutputTool();
    const res = await tool.execute({}, ctx("s1"));
    expect(res.isError).toBe(true);
  });

  it("bash_kill terminates the owning session's shell", async () => {
    const f = fakeChild();
    const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
    const tool = createBashKillTool();
    const res = await tool.execute({ shellId: id }, ctx("s1"));
    expect(res.isError).toBe(false);
    expect(f.kill).toHaveBeenCalledWith("SIGTERM");
    expect(JSON.parse(res.output).status).toBe("killed");
  });

  it("bash_kill will not kill another session's shell", async () => {
    const f = fakeChild();
    const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
    const tool = createBashKillTool();
    const res = await tool.execute({ shellId: id }, ctx("attacker"));
    expect(res.isError).toBe(true);
    expect(f.kill).not.toHaveBeenCalled();
  });
});
