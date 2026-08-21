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

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe.skipIf(process.platform === "win32")("spawnWithSandbox isolated HOME", () => {
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
