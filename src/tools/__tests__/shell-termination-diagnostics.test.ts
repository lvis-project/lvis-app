import type { ToolOutputCapture } from "../../shared/tool-output-artifact.js";
import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: vi.fn(),
  trackManagedChildProcess: vi.fn(() => () => {}),
  forceKillManagedChildProcess: vi.fn(),
}));
vi.mock("../../permissions/asrt-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/asrt-sandbox.js")>(),
  wrapToolCommand: vi.fn(async () => ({ argv: ["shell"], env: {} })),
  cleanupAsrtSandboxAfterCommand: vi.fn(async () => {}),
  getDefaultSensitiveReadDenyPaths: () => [], getDefaultSensitiveWriteDenyPaths: () => [],
}));

import { forceKillManagedChildProcess } from "../../main/managed-child-processes.js";
import { __resetActiveSandboxCapabilityForTest, setActiveSandboxCapability, setSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { POWER_SHELL_AST_PARSER } from "../powershell-ast.js";
import { BashTool, PowerShellTool, backgroundShellManager as manager, createBashOutputTool } from "../shell-tools.js";

function childProcess() {
  return Object.assign(new ChildProcess(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
  });
}

function close(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
  Object.assign(child, { exitCode: code, signalCode: signal });
  child.emit("exit", code, signal); child.emit("close", code, signal);
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); __resetActiveSandboxCapabilityForTest();
});
afterEach(() => {
  manager._resetForTest(); __resetActiveSandboxCapabilityForTest(); vi.useRealTimers();
});

describe.each(["plain", "sandbox"] as const)("%s shell completion", (route) => {
  describe.each(["bash", "powershell"] as const)("%s", (dialect) => {
    async function start(captureFactory?: () => ToolOutputCapture) {
      setSandboxRequestedAtBoot(route === "sandbox");
      if (route === "sandbox") setActiveSandboxCapability({
        kind: "asrt", confidence: "verified", platform: process.platform,
        reason: "Controlled wrapper", confines: { filesystem: true, process: true, network: true },
      });
      const child = childProcess();
      vi.mocked(spawn).mockImplementation((_command, args) => {
        if (args?.includes(POWER_SHELL_AST_PARSER)) {
          const parser = childProcess();
          queueMicrotask(() => {
            parser.stdout.write(JSON.stringify({ errors: [], commands: [], redirections: [], unsupported: [] }));
            close(parser, 0, null);
          });
          return parser;
        }
        return child;
      });
      const controller = new AbortController();
      const tool = dialect === "bash" ? new BashTool() : new PowerShellTool();
      const pending = tool.execute({ command: dialect === "bash" ? "echo ready" : "Write-Output ready", timeoutSeconds: 1 }, {
        cwd: process.cwd(), extraAllowedDirectories: [], metadata: captureFactory ? { toolOutputCaptureFactory: captureFactory } : {}, abortSignal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(child.listenerCount("close")).toBeGreaterThan(0);
      return { child, controller, pending };
    }

    it.each(["close", "error", "timeout", "cancel"] as const)("awaits one artifact publication on %s", async (cause) => {
      const chunks: Buffer[] = [];
      let publish!: () => void;
      const gate = new Promise<void>((resolve) => { publish = resolve; });
      const finish = vi.fn(async (interrupted?: boolean) => {
        await gate;
        return {
          version: 1 as const, captureId: "3138f9c6-89f0-4645-85ea-2c205f9523f4",
          status: interrupted ? "partial" as const : "complete" as const,
          ...(interrupted ? { reason: "interrupted" as const } : {}),
          capturedBytes: 15_012, observedBytes: 15_012, capturedChars: 15_012, sha256: "a".repeat(64),
        };
      });
      const f = await start(() => ({
        captureId: "3138f9c6-89f0-4645-85ea-2c205f9523f4",
        append: (bytes) => { chunks.push(Buffer.from(bytes)); return true; },
        waitForDrain: async () => {}, finish,
      }));
      f.child.stdout.write("a".repeat(15_000));
      f.child.stderr.write("stderr");
      f.child.stdout.write("stdout");
      let resolved = false;
      void f.pending.then(() => { resolved = true; });
      if (cause === "close") close(f.child, 7, null);
      else if (cause === "error") f.child.emit("error", new Error("operation failed"));
      else if (cause === "cancel") f.controller.abort();
      else await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(finish).toHaveBeenCalledExactlyOnceWith(cause !== "close");
      expect(resolved).toBe(false);
      publish();
      const result = await f.pending;
      expect(result.isError).toBe(true);
      expect(result.metadata?.outputArtifact).toMatchObject({ status: cause === "close" ? "complete" : "partial" });
      expect(Buffer.concat(chunks).toString()).toBe("a".repeat(15_000) + "stderrstdout");
      close(f.child, null, "SIGKILL");
      expect(finish).toHaveBeenCalledTimes(1);
    });

    it.each([
      [0, null, "", "(no output)", false],
      [7, null, "", "Shell command exited with code 7 without output.", true],
      [137, null, "", "Shell command exited with code 137 without output.", true],
      [null, "SIGTERM", "", "Shell command terminated by signal SIGTERM without output.", true],
      [7, null, "stdout\nstderr\n", "Shell command exited with code 7.\nstdout\nstderr", true],
      [null, "SIGKILL", "partial\n", "Shell command terminated by signal SIGKILL.\npartial", true],
      [7, null, "(no output)", "Shell command exited with code 7.\n(no output)", true],
    ] as const)("reports code %s signal %s and retains output %s", async (code, signal, output, expected, isError) => {
      const f = await start();
      f.child.stdout.write(output); close(f.child, code, signal);
      expect(await f.pending).toMatchObject({ output: expected, isError });
    });

    it.each(["timeout", "cancel"] as const)("keeps %s primary and settles before a later close", async (cause) => {
      const f = await start(); f.child.stdout.write("partial");
      if (cause === "cancel") f.controller.abort(); else await vi.advanceTimersByTimeAsync(1_000);
      const result = await f.pending;
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(cause === "cancel" ? /cancelled/ : /timed out/);
      expect(result.output).toContain("partial");
      expect(result.output).not.toMatch(/exited with|terminated by|SIGKILL/);
      expect(forceKillManagedChildProcess).toHaveBeenCalledOnce();
      close(f.child, null, "SIGKILL");
      expect(result.output).not.toContain("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("background terminal diagnostics", () => {
  it.each([[7, null], [null, "SIGTERM"]] as const)("retains code %s signal %s across incremental polling", async (code, signal) => {
    const child = childProcess();
    const shellId = manager.register({ child, command: "work", sessionId: "owner", startedAt: "t" });
    child.stdout.write("before close");
    expect(manager.read("owner", shellId)?.output).toBe("before close");
    close(child, code, signal);
    const result = await createBashOutputTool().execute({ shellId }, { cwd: process.cwd(), extraAllowedDirectories: [], metadata: { sessionId: "owner" } });
    expect(result.isError).toBe(false);
    const status = signal === null ? "exited" : "killed";
    expect(JSON.parse(result.output)).toMatchObject({ status, exitCode: code, signal, output: "" });
    expect(manager.read("owner", shellId)).toMatchObject({ status, exitCode: code, signal, output: "" });
  });
  it("records an observed close after a kill request without inventing a signal beforehand", () => {
    const child = childProcess();
    const shellId = manager.register({ child, command: "work", sessionId: "owner", startedAt: "t" });
    expect(manager.kill("owner", shellId)).toMatchObject({ status: "killed", exitCode: null, signal: null });
    close(child, null, "SIGKILL");
    expect(manager.read("owner", shellId)).toMatchObject({ status: "killed", exitCode: null, signal: "SIGKILL" });
  });
});
