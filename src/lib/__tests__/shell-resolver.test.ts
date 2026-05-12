import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { resolveShell, ShellMismatchError, __resetShellResolverCache } from "../shell-resolver.js";

afterEach(() => {
  __resetShellResolverCache();
  vi.restoreAllMocks();
});

describe("shell-resolver", () => {
  it("returns sh on Windows when sh is found", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32" as NodeJS.Platform);
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (String(cmd).includes("C:\\Program Files\\Git\\")) {
        throw new Error("not installed");
      }
      if (cmd === "where" && args[0] === "sh") {
        return "C:\\Windows\\System32\\sh.exe";
      }
      if (cmd === "sh" && args[1] === "printf __lvis_shell_ok__") {
        return "__lvis_shell_ok__";
      }
      if (cmd === "sh" && args[1] === "uname -s") {
        return "MSYS_NT";
      }
      throw new Error("unexpected command");
    });

    const shell = resolveShell();
    expect(shell.cmd).toBe("sh");
    expect(shell.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
    expect(shell.windowsFlavor).toBe("msys");
  });

  it("prefers Git for Windows sh over the WSL bash launcher", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32" as NodeJS.Platform);
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd === "C:\\Program Files\\Git\\usr\\bin\\sh.exe" && args[1] === "printf __lvis_shell_ok__") {
        return "__lvis_shell_ok__";
      }
      if (cmd === "C:\\Program Files\\Git\\usr\\bin\\sh.exe" && args[1] === "uname -s") {
        return "MINGW64_NT";
      }
      throw new Error("unexpected command");
    });

    const shell = resolveShell();

    expect(shell.cmd).toBe("C:\\Program Files\\Git\\usr\\bin\\sh.exe");
    expect(shell.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
    expect(shell.windowsFlavor).toBe("msys");
  });

  it("falls back to bash on Windows when sh is missing", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32" as NodeJS.Platform);
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (String(cmd).includes("C:\\Program Files\\Git\\")) {
        throw new Error("not installed");
      }
      if (cmd === "where" && args[0] === "sh") {
        throw new Error("not found");
      }
      if (cmd === "where" && args[0] === "bash") {
        return "C:\\Program Files\\Git\\bin\\bash.exe";
      }
      if (cmd === "bash" && args[1] === "printf __lvis_shell_ok__") {
        return "__lvis_shell_ok__";
      }
      if (cmd === "bash" && args[1] === "uname -s") {
        return "MINGW64_NT";
      }
      throw new Error("unexpected command");
    });

    const shell = resolveShell();
    expect(shell.cmd).toBe("bash");
    expect(shell.shellArgs("echo hi")).toEqual(["-lc", "echo hi"]);
    expect(shell.windowsFlavor).toBe("msys");
  });

  it("returns sh on POSIX", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux" as NodeJS.Platform);

    const shell = resolveShell();

    expect(shell.cmd).toBe("sh");
    expect(shell.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("ShellMismatchError exposes a stable code", () => {
    expect(new ShellMismatchError("x").code).toBe("SHELL_MISMATCH");
  });
});
