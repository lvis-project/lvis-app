import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../permissions/asrt-sandbox.js", () => ({
  wrapToolCommand: vi.fn(async (command: string) => ({ argv: ["/bin/bash", "-c", command], env: { ...process.env } })),
  cleanupAsrtSandboxAfterCommand: vi.fn(async () => {}),
  getDefaultSensitiveReadDenyPaths: () => [], getDefaultSensitiveWriteDenyPaths: () => [],
}));

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { BashTool, spawnWithSandbox } from "../shell-tools.js";
import { prepareSandboxFixture } from "./support/prepared-shell.js";

describe.skipIf(process.platform === "win32")("native shell termination observations", () => {
  it.each([
    ["plain", "exit 7", "Shell command exited with code 7 without output."],
    ["plain", 'kill -TERM "$$"', "Shell command terminated by signal SIGTERM without output."],
    ["wrapper", "exit 137", "Shell command exited with code 137 without output."],
    ["wrapper", 'kill -TERM "$$"', "Shell command terminated by signal SIGTERM without output."],
  ])("reports %s %s from an actual child", async (route, source, expected) => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "lvis-shell-close-")));
    try {
      writeFileSync(join(cwd, "child.sh"), `${source}\n`);
      const command = "bash ./child.sh";
      const result = route === "plain"
        ? await new BashTool().execute({ command, timeoutSeconds: 5 }, { cwd, extraAllowedDirectories: [], metadata: {} })
        : await spawnWithSandbox(command, cwd, [cwd], 5, prepareSandboxFixture(command, cwd));
      expect(result).toMatchObject({ output: expected, isError: true });
      expect(result.output).not.toContain("OOM");
    } finally {
      await cleanupTmpDir(cwd);
    }
  });
});
