import { execFileSync } from "node:child_process";
import { delimiter, dirname, isAbsolute, join, win32 } from "node:path";
import { buildSafeChildEnv } from "../tools/safe-env.js";

export class ShellMismatchError extends Error {
  readonly code = "SHELL_MISMATCH" as const;

  constructor(message: string) {
    super(message);
    this.name = "ShellMismatchError";
  }
}

type WindowsShellFlavor = "msys" | "wsl" | "unknown";

export type ResolvedShellCommand = {
  cmd: string;
  shellArgs: (script: string) => string[];
  windowsFlavor?: WindowsShellFlavor;
};

type ShellDialect = "posix" | "bash";

const cachedShells = new Map<ShellDialect, ResolvedShellCommand>();
const cachedErrors = new Map<ShellDialect, ShellMismatchError>();
const SHELL_PROBE_TIMEOUT_MS = 20_000;

export function resolveShell(dialect: ShellDialect = "posix"): ResolvedShellCommand {
  if (process.platform !== "win32" && dialect === "posix") {
    return { cmd: "sh", shellArgs: (script: string) => ["-c", script] };
  }

  const cachedShell = cachedShells.get(dialect);
  const cachedError = cachedErrors.get(dialect);
  if (cachedShell) return cachedShell;
  if (cachedError) throw cachedError;

  const candidates: ResolvedShellCommand[] = process.platform === "win32"
    ? windowsShellCandidates().filter((candidate) => dialect !== "bash" || /(?:^|[\\/])bash(?:\.exe)?$/.test(candidate.cmd))
    : ["/bin/bash", "/usr/bin/bash"].map((cmd) => ({ cmd, shellArgs: (script: string) => ["-c", script] }));
  const probeCommand = dialect === "bash"
    ? 'test -n "$BASH_VERSION" && values=(__lvis_shell_ok__) && read -r value <<< "${values[0]}" && printf "%s" "$value"'
    : "printf __lvis_shell_ok__";

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      if (process.platform === "win32") candidate.cmd = resolveWindowsShellCandidate(candidate.cmd, dialect);
      // Bash tools are non-interactive and must not acquire login-profile behavior.
      if (dialect === "bash") candidate.shellArgs = (script: string) => ["-c", script];
      const probe = execFileSync(candidate.cmd, candidate.shellArgs(probeCommand), {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: SHELL_PROBE_TIMEOUT_MS,
        env: buildSafeChildEnv(),
      });
      if (probe !== "__lvis_shell_ok__") {
        throw new Error(`unexpected shell probe output: ${JSON.stringify(probe)}`);
      }
      if (process.platform === "win32") candidate.windowsFlavor = detectWindowsShellFlavor(candidate);
      cachedShells.set(dialect, candidate);
      return candidate;
    } catch (err) {
      lastError = err;
    }
  }

  const error = new ShellMismatchError(
    dialect === "bash"
      ? `The bash tool requires Bash. Install Bash${process.platform === "win32" ? " (Git for Windows or WSL)" : " at /bin/bash or /usr/bin/bash"}.${lastError instanceof Error ? ` (${lastError.message})` : ""}`
      : `This feature requires a POSIX shell (sh or bash). On Windows, install Git for Windows or WSL to provide sh.exe or bash.exe in PATH.${lastError instanceof Error ? ` (${lastError.message})` : ""}`,
  );
  cachedErrors.set(dialect, error);
  throw error;
}

function windowsShellCandidates(): ResolvedShellCommand[] {
  return [
    // Prefer Git for Windows when installed. WSL's Windows launcher can be
    // slow under high test concurrency and uses a different path dialect.
    { cmd: "C:\\Program Files\\Git\\usr\\bin\\sh.exe", shellArgs: (script: string) => ["-c", script] },
    { cmd: "C:\\Program Files\\Git\\bin\\bash.exe", shellArgs: (script: string) => ["-lc", script] },
    { cmd: "C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe", shellArgs: (script: string) => ["-c", script] },
    { cmd: "C:\\Program Files (x86)\\Git\\bin\\bash.exe", shellArgs: (script: string) => ["-lc", script] },
    { cmd: "sh", shellArgs: (script: string) => ["-c", script] },
    { cmd: "bash", shellArgs: (script: string) => ["-lc", script] },
  ];
}

function resolveWindowsShellCandidate(cmd: string, dialect: ShellDialect): string {
  if (/^[A-Za-z]:[\\/]/.test(cmd)) return cmd;
  const matches = execFileSync("where", [cmd], { stdio: "pipe", encoding: "utf-8", env: buildSafeChildEnv() });
  if (dialect === "posix") return cmd;
  // Pin the first search result before probing so later execution cannot repeat
  // PATH lookup under a different working directory or environment.
  const executable = matches.split(/\r?\n/)[0]?.trim();
  if (!executable || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/.test(executable) || !/\.exe$/i.test(executable)) {
    throw new Error("Bash lookup did not return an absolute executable path");
  }
  return win32.normalize(executable);
}

function detectWindowsShellFlavor(shell: ResolvedShellCommand): WindowsShellFlavor {
  if (/^[A-Za-z]:[\\/]/.test(shell.cmd) && /[\\/]Git[\\/]/i.test(shell.cmd)) {
    return "msys";
  }
  try {
    const output = execFileSync(shell.cmd, shell.shellArgs("uname -s"), {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: SHELL_PROBE_TIMEOUT_MS,
      env: buildSafeChildEnv(),
    }).trim();
    if (/^(MINGW|MSYS|CYGWIN)/i.test(output)) return "msys";
    if (/linux/i.test(output)) return "wsl";
  } catch {
    // Keep the shell usable for generic commands even if flavor probing fails.
  }
  return "unknown";
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellPathForHostPath(shell: ResolvedShellCommand, hostPath: string): string {
  if (process.platform !== "win32") return hostPath;
  const normalized = hostPath.replace(/\\/g, "/");
  const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!driveMatch) return normalized;
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2];
  if (shell.windowsFlavor === "wsl") return `/mnt/${drive}/${rest}`;
  if (shell.windowsFlavor === "msys") return `/${drive}/${rest}`;
  return normalized;
}

export function shellCommandForHookPath(shell: ResolvedShellCommand, hookPath: string): string {
  const shellPath = shellPathForHostPath(shell, hookPath);
  if (process.platform === "win32" && isAbsolute(hookPath)) {
    return `${shellInterpreterCommand(shell)} ${shellQuote(shellPath)}`;
  }
  return shellQuote(shellPath);
}

export function shellEnvForChild(shell: ResolvedShellCommand, env: Record<string, string>): Record<string, string> {
  if (process.platform !== "win32" || shell.windowsFlavor !== "msys") return env;
  const additions = msysPathEntriesForShell(shell);
  if (additions.length === 0) return env;

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey];
  return {
    ...env,
    [pathKey]: [additions.join(delimiter), currentPath].filter(Boolean).join(delimiter),
  };
}

function shellInterpreterCommand(shell: ResolvedShellCommand): string {
  if (process.platform !== "win32") return "sh";
  if (shell.windowsFlavor === "msys") return "/usr/bin/sh";
  if (shell.windowsFlavor === "wsl") return "/bin/sh";
  return "sh";
}

function msysPathEntriesForShell(shell: ResolvedShellCommand): string[] {
  if (!/^[A-Za-z]:[\\/]/.test(shell.cmd)) return [];
  const shellDir = dirname(shell.cmd);
  const lowerShellDir = shellDir.toLowerCase();
  if (lowerShellDir.endsWith("\\usr\\bin") || lowerShellDir.endsWith("/usr/bin")) {
    return [shellDir];
  }
  const gitRoot = dirname(shellDir);
  const usrBin = join(gitRoot, "usr", "bin");
  return [usrBin, shellDir];
}

/** Test-only: reset memoization so test cases exercising different PATH states stay isolated. */
export function __resetShellResolverCache(): void {
  cachedShells.clear();
  cachedErrors.clear();
}
