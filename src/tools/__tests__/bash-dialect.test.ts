import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../permissions/asrt-sandbox.js", () => ({
  wrapToolCommand: vi.fn(async (command: string, options: { binShell: string }) => ({
    argv: [options.binShell, "-c", command],
    env: { ...process.env },
  })),
  cleanupAsrtSandboxAfterCommand: vi.fn(async () => {}),
  getDefaultSensitiveReadDenyPaths: () => [],
  getDefaultSensitiveWriteDenyPaths: () => [],
}));

import * as shellResolver from "../../lib/shell-resolver.js";
import * as windowsJobLauncher from "../../main/windows-job-launcher.js";
import { wrapToolCommand } from "../../permissions/asrt-sandbox.js";
import { BashTool, backgroundShellManager, spawnWithSandbox } from "../shell-tools.js";

const COMMAND = 'values=(alpha beta); read -r value <<< "${values[1]}"; printf "%s" "$value"';
const context = { cwd: process.cwd(), extraAllowedDirectories: [], metadata: { sessionId: "bash-dialect" } };

afterEach(() => {
  backgroundShellManager.disposeSession("bash-dialect");
  vi.restoreAllMocks();
});

describe("Bash dialect across execution paths", () => {
  it("executes arrays and here-strings in the foreground", async () => {
    const result = await new BashTool().execute({ command: COMMAND }, context);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("beta");
  });

  it("executes arrays and here-strings in the background", async () => {
    const result = await new BashTool().execute({ command: COMMAND, run_in_background: true }, context);
    expect(result.isError).toBe(false);
    const { shellId } = JSON.parse(result.output) as { shellId: string };
    let output = "";
    await vi.waitFor(() => {
      const state = backgroundShellManager.read("bash-dialect", shellId);
      output += state?.output ?? "";
      expect(state?.status).toBe("exited");
      expect(state?.exitCode).toBe(0);
    });
    expect(output).toBe("beta");
  });

  it("fails before wrapping when Bash is unavailable", async () => {
    vi.spyOn(shellResolver, "resolveShell").mockImplementationOnce(() => {
      throw new shellResolver.ShellMismatchError("The bash tool requires Bash.");
    });
    vi.mocked(wrapToolCommand).mockClear();
    const result = await spawnWithSandbox(COMMAND, context.cwd, [context.cwd], 15);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("requires Bash");
    expect(wrapToolCommand).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "win32")("rejects guest background execution before creating a handle", async () => {
    const shell = shellResolver.resolveShell("bash");
    const spawn = vi.spyOn(windowsJobLauncher, "spawnWindowsJobProcess");
    vi.spyOn(shellResolver, "resolveShell").mockReturnValue({ ...shell, windowsFlavor: "wsl" });
    const result = await new BashTool().execute({ command: "printf unexpected", run_in_background: true }, context);
    expect(result.isError).toBe(true);
    expect(result.metadata?.backgroundUnavailable).toBe(true);
    expect(result.metadata?.backgrounded).toBeUndefined();
    expect(result.output).toContain("this command was not started");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("passes the same Bash interpreter into the sandbox wrapper", async () => {
    const result = await spawnWithSandbox(COMMAND, context.cwd, [context.cwd], 15);
    expect(wrapToolCommand).toHaveBeenLastCalledWith(COMMAND,
      expect.objectContaining({ binShell: shellResolver.resolveShell("bash").cmd }));
    expect(result.isError).toBe(false);
    expect(result.output).toBe("beta");
  });
});
