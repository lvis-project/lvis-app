import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { resolveShell, ShellMismatchError, __resetShellResolverCache } from "../shell-resolver.js";

afterEach(() => {
  __resetShellResolverCache();
  vi.mocked(execFileSync).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it("resolves Bash separately from the generic POSIX dialect", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(execFileSync).mockReturnValue("__lvis_shell_ok__");
    expect(resolveShell().cmd).toBe("sh");
    const bash = resolveShell("bash");
    expect(bash.cmd).toBe("/bin/bash");
    expect(bash.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
    expect(resolveShell("bash")).toBe(bash);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(resolveShell().cmd).toBe("sh");
  });

  it("reports missing Bash without falling back to sh or poisoning POSIX resolution", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("missing executable"); });
    expect(() => resolveShell("bash")).toThrow(/requires Bash/);
    expect(() => resolveShell("bash")).toThrow(ShellMismatchError);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(resolveShell().cmd).toBe("sh");
  });

  it("rejects executables that do not prove the Bash dialect", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(execFileSync).mockReturnValue("");
    expect(() => resolveShell("bash")).toThrow(/requires Bash/);
  });

  it("selects a Windows Bash executable even when generic sh is available", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(execFileSync).mockReturnValue("__lvis_shell_ok__");
    expect(resolveShell().cmd).toMatch(/sh\.exe$/);
    const bash = resolveShell("bash");
    expect(bash.cmd).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(bash.windowsFlavor).toBe("msys");
    expect(bash.shellArgs("echo hi")).toEqual(["-c", "echo hi"]);
    expect(execFileSync).toHaveBeenLastCalledWith(bash.cmd,
      ["-c", expect.stringContaining("<<<")], expect.any(Object));
  });

  it("pins and probes the first absolute Bash path returned by Windows lookup", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const executable = "D:\\Shell Runtime\\bash.exe";
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd === "where") return `${executable}\r\nE:\\Other\\bash.exe\r\n`;
      if (cmd !== executable) throw new Error("not installed");
      return Array.isArray(args) && args[1] === "uname -s" ? "MSYS_NT" : "__lvis_shell_ok__";
    });

    const shell = resolveShell("bash");
    expect(shell.cmd).toBe(executable);
    expect(shell.windowsFlavor).toBe("msys");
    expect(execFileSync).toHaveBeenCalledWith(executable,
      ["-c", expect.stringContaining("<<<")], expect.any(Object));
    expect(execFileSync).toHaveBeenCalledWith(executable,
      ["-c", "uname -s"], expect.any(Object));
    expect(vi.mocked(execFileSync).mock.calls.some(([cmd]) => cmd === "bash")).toBe(false);
    expect(resolveShell("bash")).toBe(shell);
  });

  it.each(["", "bash.exe", "C:bash.exe", "C:\\Runtime\\bash.cmd"])(
    "rejects unusable Windows Bash lookup result %j without probing a bare command", (lookup) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      vi.mocked(execFileSync).mockImplementation((cmd) => {
        if (cmd === "where") return lookup;
        throw new Error("not installed");
      });
      expect(() => resolveShell("bash")).toThrow(/absolute executable path/);
      expect(vi.mocked(execFileSync).mock.calls.some(([cmd]) => cmd === "bash" || cmd === "sh")).toBe(false);
    },
  );

  it.each([
    { platform: "linux", dialect: "bash", executable: "/bin/bash", lookup: "bash" },
    { platform: "win32", dialect: "bash", executable: "D:\\Runtime\\bash.exe", lookup: "bash" },
    { platform: "win32", dialect: "posix", executable: "sh", lookup: "sh" },
  ] as const)("filters every $platform $dialect probe environment", ({ platform, dialect, executable, lookup }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.stubEnv("OPENAI_API_KEY", "sentinel-provider-secret");
    vi.stubEnv("LVIS_INTERNAL_SECRET", "sentinel-host-secret");
    vi.stubEnv("BASH_ENV", "/sentinel-startup-script");
    vi.stubEnv("PATH", "sentinel-runtime-path");
    vi.stubEnv("SystemRoot", "sentinel-system-root");
    vi.stubEnv("USERPROFILE", "sentinel-user-profile");
    vi.stubEnv("LANG", "sentinel-locale");
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd === "where") return executable;
      if (cmd !== executable) throw new Error("not installed");
      return Array.isArray(args) && args[1] === "uname -s" ? "MSYS_NT" : "__lvis_shell_ok__";
    });

    expect(resolveShell(dialect).cmd).toBe(executable);
    if (platform === "win32") {
      expect(execFileSync).toHaveBeenCalledWith("where", [lookup], expect.any(Object));
      expect(execFileSync).toHaveBeenCalledWith(executable, ["-c", "uname -s"], expect.any(Object));
    }
    for (const [, , options] of vi.mocked(execFileSync).mock.calls) {
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      expect(env).toBeDefined();
      expect(env?.OPENAI_API_KEY).toBeUndefined();
      expect(env?.LVIS_INTERNAL_SECRET).toBeUndefined();
      expect(env?.BASH_ENV).toBeUndefined();
      expect(env?.PATH).toBe("sentinel-runtime-path");
      expect(env?.SystemRoot).toBe("sentinel-system-root");
      expect(env?.USERPROFILE).toBe("sentinel-user-profile");
      expect(env?.LANG).toBe("sentinel-locale");
    }
  });

  it("ShellMismatchError exposes a stable code", () => {
    expect(new ShellMismatchError("x").code).toBe("SHELL_MISMATCH");
  });
});
