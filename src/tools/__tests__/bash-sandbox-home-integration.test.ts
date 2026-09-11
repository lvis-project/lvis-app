import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../permissions/asrt-sandbox.js", () => ({
  wrapToolCommand: vi.fn(async (command: string) => ({
    argv: ["/bin/bash", "-c", command],
    env: { ...process.env },
  })),
  cleanupAsrtSandboxAfterCommand: vi.fn(async () => {}),
  getDefaultSensitiveReadDenyPaths: () => [],
  getDefaultSensitiveWriteDenyPaths: () => [],
}));

import { spawnWithSandbox } from "../shell-tools.js";
import { cleanupAsrtSandboxAfterCommand, wrapToolCommand } from "../../permissions/asrt-sandbox.js";
import { prepareSandboxFixture } from "./support/prepared-shell.js";
import { disposePreparedShellInvocation, preparedShellCommand } from "../prepared-shell-invocation.js";

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe.skipIf(process.platform === "win32")("spawnWithSandbox isolated HOME", () => {
  it("does not launch after cancellation during sandbox preparation", async () => {
    const controller = new AbortController();
    let isolatedHome = "";
    vi.mocked(wrapToolCommand).mockImplementationOnce(async (_command, options) => {
      const allowWrite = options?.filesystem?.allowWrite;
      if (!allowWrite) throw new Error("Expected sandbox write paths");
      isolatedHome = allowWrite.find((path) => path.includes("lvis-sandbox-home-"))!;
      controller.abort();
      return { argv: ["/bin/bash", "-c", "exit 99"], env: {} };
    });
    const cleanupCalls = vi.mocked(cleanupAsrtSandboxAfterCommand).mock.calls.length;
    const prepared = prepareSandboxFixture("exit 99", process.cwd());
    const result = await spawnWithSandbox("exit 99", process.cwd(), [process.cwd()], 15, prepared, controller.signal);
    expect(result).toEqual({
      output: "Shell command cancelled.", isError: true,
      metadata: { aborted: true, sandboxed: false },
    });
    expect(isolatedHome).not.toBe("");
    expect(existsSync(isolatedHome)).toBe(false);
    expect(vi.mocked(cleanupAsrtSandboxAfterCommand).mock.calls.length).toBe(cleanupCalls + 1);
  });

  it("runs git without reading the real global config and removes the profile", async () => {
    const cwd = process.cwd();
    const command = `printf '%s\\n' "$HOME"; git -C ${singleQuote(cwd)} log --oneline -n 1`;
    const result = await spawnWithSandbox(
      command,
      cwd,
      [cwd],
      15,
      prepareSandboxFixture(command, cwd),
    );

    expect(result.isError).toBe(false);
    const [sandboxHome, logLine] = result.output.split("\n");
    expect(sandboxHome).toContain("lvis-sandbox-home-");
    expect(sandboxHome).not.toBe(process.env.HOME);
    expect(logLine).toMatch(/^[0-9a-f]+\s+\S/);
    expect(existsSync(sandboxHome ?? "")).toBe(false);
  });

  it("claims once before a pending wrapper and retains HOME until that work settles", async () => {
    const cwd = process.cwd(), command = "printf ready";
    const prepared = prepareSandboxFixture(command, cwd);
    const path = preparedShellCommand(prepared).homePath!;
    let finishWrap!: (value: { argv: string[]; env: NodeJS.ProcessEnv }) => void;
    vi.mocked(wrapToolCommand).mockImplementationOnce(() => new Promise((resolve) => { finishWrap = resolve; }));
    const previousCalls = vi.mocked(wrapToolCommand).mock.calls.length;
    const controller = new AbortController();
    const pending = spawnWithSandbox(command, cwd, [cwd], 15, prepared, controller.signal);
    await expect(spawnWithSandbox(command, cwd, [cwd], 15, prepared)).rejects.toThrow(/already been claimed/);
    controller.abort(); disposePreparedShellInvocation(prepared);
    expect(existsSync(path)).toBe(true);
    expect(vi.mocked(wrapToolCommand).mock.calls.length).toBe(previousCalls + 1);
    finishWrap({ argv: [], env: {} });
    expect((await pending).metadata.aborted).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
