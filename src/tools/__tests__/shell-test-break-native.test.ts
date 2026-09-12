import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { __resetActiveSandboxCapabilityForTest } from "../../permissions/sandbox-capability.js";
import type { ToolExecutionContext } from "../base.js";
import { BashTool } from "../shell-tools.js";

describe.skipIf(process.platform === "win32")("BashTool test and lexical break contract", () => {
  let root: string;
  let project: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lvis-shell-test-break-")));
    project = join(root, "project");
    const profile = join(project, "host-home");
    for (const path of [project, join(project, "stage/first"), join(profile, "subscription-runtimes")]) {
      mkdirSync(path, { recursive: true });
    }
    vi.stubEnv("LVIS_HOME", profile);
    __resetActiveSandboxCapabilityForTest();
    context = { cwd: project, extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true, metadata: {} };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    __resetActiveSandboxCapabilityForTest();
    if (root) await cleanupTmpDir(root);
  });

  it("runs a command-substitution-derived string comparison through the real tool", async () => {
    const result = await new BashTool().execute(
      { command: `value=$(printf '%s' ready); if [ "$value" = ready ]; then printf 'match\n'; fi` },
      context,
    );
    expect(result.isError, result.output).toBe(false);
    expect(result.metadata?.returncode).toBe(0);
    expect(result.output).toBe("match");
  });

  it("runs the loop and reports cwd retained at the lexical break", async () => {
    const result = await new BashTool().execute(
      { command: `cd stage; for item in first stop after; do if [ "$item" = stop ]; then break; fi; cd "$item"; done; printf '%s\n%s\n' "$PWD" "$item"` },
      context,
    );
    expect(result.isError, result.output).toBe(false);
    expect(result.metadata?.returncode).toBe(0);
    expect(result.output).toBe(`${join(project, "stage/first")}\nstop`);
  });
});
