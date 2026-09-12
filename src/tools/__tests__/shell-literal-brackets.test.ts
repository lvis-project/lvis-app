import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { __resetActiveSandboxCapabilityForTest } from "../../permissions/sandbox-capability.js";
import type { ToolExecutionContext } from "../base.js";
import { BashTool } from "../shell-tools.js";

describe.skipIf(process.platform === "win32")("shell literal bracket path checks", () => {
  let root: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lvis-shell-brackets-")));
    const project = join(root, "project");
    const outside = join(root, "outside");
    const profile = join(project, "host-home");
    const runtime = join(profile, "subscription-runtimes");
    for (const path of [project, outside, runtime]) mkdirSync(path, { recursive: true });
    writeFileSync(join(project, "file["), "literal bracket bytes\n");
    writeFileSync(join(project, "filea"), "glob must not execute\n");
    writeFileSync(join(outside, "file["), "outside must not execute\n");
    writeFileSync(join(runtime, "file["), "protected must not execute\n");
    vi.stubEnv("LVIS_HOME", profile);
    __resetActiveSandboxCapabilityForTest();
    context = {
      cwd: project,
      extraAllowedDirectories: [],
      blockReadsOutsideWorkingDirectories: true,
      metadata: {},
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    __resetActiveSandboxCapabilityForTest();
    if (root) await cleanupTmpDir(root);
  });

  it("tests and reads an unmatched bracket filename through the real shell", async () => {
    const result = await new BashTool().execute(
      { command: "if [ -e ./file[ ]; then cat ./file[; fi" },
      context,
    );
    expect(result.isError, result.output).toBe(false);
    expect(result.metadata?.returncode).toBe(0);
    expect(result.output).toBe("literal bracket bytes");
  });

  it("declines a bracket glob before executing the shell", async () => {
    const result = await new BashTool().execute({ command: "cat ./file[ab]" }, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Shell path policy:");
    expect(result.output).toContain("unresolved");
    expect(result.output).not.toContain("glob must not execute");
    expect(result.metadata).toBeUndefined();
  });

  it.each([
    ["./host-home/subscription-runtimes/file[", "Sensitive path:"],
    ["../outside/file[", "Sandbox:"],
  ])("retains the path boundary for literal operand %s", async (operand, reason) => {
    const result = await new BashTool().execute({ command: `cat ${operand}` }, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain(reason);
    expect(result.output).not.toContain("must not execute");
    expect(result.metadata).toBeUndefined();
  });
});
