import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));
vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: vi.fn(),
  trackManagedChildProcess: vi.fn(),
  forceKillManagedChildProcess: vi.fn(),
}));
vi.mock("../../permissions/sandbox-process-home.js", () => ({
  createSandboxProcessHome: vi.fn(),
}));
vi.mock("../../permissions/asrt-sandbox.js", () => ({
  wrapToolCommand: vi.fn(async () => ({ argv: ["shell"], env: {} })),
  cleanupAsrtSandboxAfterCommand: vi.fn(async () => {}),
  getDefaultSensitiveReadDenyPaths: () => [],
  getDefaultSensitiveWriteDenyPaths: () => [],
}));

import { ChildProcess, spawn } from "node:child_process";
import { forceKillManagedChildProcess } from "../../main/managed-child-processes.js";
import { createSandboxProcessHome } from "../../permissions/sandbox-process-home.js";
import { cleanupAsrtSandboxAfterCommand } from "../../permissions/asrt-sandbox.js";
import { spawnWithSandbox } from "../shell-tools.js";
import { prepareSandboxFixture } from "./support/prepared-shell.js";

const roots: string[] = [];

describe("shell interruption resource ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it.each(["timeout", "cancel"] as const)("settles %s before close and finalizes only after termination", async (stop) => {
    const child = Object.assign(new ChildProcess(), {
      pid: 12345, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      stdout: new PassThrough(), stderr: new PassThrough(),
    });
    const cleanupHome = vi.fn();
    const home = mkdtempSync(join(tmpdir(), "shell-interruption-")); roots.push(home);
    vi.mocked(spawn).mockReturnValueOnce(child);
    vi.mocked(createSandboxProcessHome).mockReturnValueOnce({
      path: home, env: { HOME: home }, cleanup: cleanupHome,
    });
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const prepared = prepareSandboxFixture("echo ready", process.cwd());
    const pending = spawnWithSandbox("echo ready", process.cwd(), [process.cwd()], 1, prepared, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.write("partial stdout\n");
    child.stderr.write("partial stderr\n");
    if (stop === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.metadata?.[stop === "timeout" ? "timedOut" : "aborted"]).toBe(true);
    expect(result.output).toContain("partial stdout");
    expect(result.output).toContain("partial stderr");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(forceKillManagedChildProcess).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(cleanupHome).not.toHaveBeenCalled();
    expect(cleanupAsrtSandboxAfterCommand).not.toHaveBeenCalled();

    child.signalCode = "SIGKILL";
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    expect(cleanupHome).toHaveBeenCalledOnce();
    expect(cleanupAsrtSandboxAfterCommand).toHaveBeenCalledOnce();
    expect(child.listenerCount("close")).toBe(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forceKillManagedChildProcess).toHaveBeenCalledOnce();
    removeAbort.mockRestore();
  });
});
