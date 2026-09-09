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
    const result = await spawnWithSandbox("exit 99", process.cwd(), [process.cwd()], 15, controller.signal);
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
    const result = await spawnWithSandbox(
      `printf '%s\\n' "$HOME"; git -C ${singleQuote(cwd)} log --oneline -n 1`,
      cwd,
      [cwd],
      15,
    );

    expect(result.isError).toBe(false);
    const [sandboxHome, logLine] = result.output.split("\n");
    expect(sandboxHome).toContain("lvis-sandbox-home-");
    expect(sandboxHome).not.toBe(process.env.HOME);
    expect(logLine).toMatch(/^[0-9a-f]+\s+\S/);
    expect(existsSync(sandboxHome ?? "")).toBe(false);
  });
});
