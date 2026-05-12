import { execFileSync } from "node:child_process";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export class ShellMismatchError extends Error {
  readonly code = "SHELL_MISMATCH" as const;

  constructor(message: string) {
    super(message);
    this.name = "ShellMismatchError";
  }
}

type WindowsShellFlavor = "msys" | "wsl" | "unknown";

export type ResolvedShell = {
  cmd: string;
  shellArgs: (script: string) => string[];
  windowsFlavor?: WindowsShellFlavor;
};

let cachedShell: ResolvedShell | null = null;
let cachedError: ShellMismatchError | null = null;
const WINDOWS_SHELL_PROBE_TIMEOUT_MS = 20_000;

export function resolveShell(): ResolvedShell {
  if (process.platform !== "win32") {
    return { cmd: "sh", shellArgs: (script: string) => ["-c", script] };
  }

  if (cachedShell) return cachedShell;
  if (cachedError) throw cachedError;

  const candidates = windowsShellCandidates();

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      assertWindowsShellCandidateExists(candidate.cmd);
      const probe = execFileSync(candidate.cmd, candidate.shellArgs("printf __lvis_shell_ok__"), {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: WINDOWS_SHELL_PROBE_TIMEOUT_MS,
      });
      if (probe !== "__lvis_shell_ok__") {
        throw new Error(`unexpected shell probe output: ${JSON.stringify(probe)}`);
      }
      candidate.windowsFlavor = detectWindowsShellFlavor(candidate);
      cachedShell = candidate;
      return candidate;
    } catch (err) {
      lastError = err;
    }
  }

  cachedError = new ShellMismatchError(
    `This feature requires a POSIX shell (sh or bash). On Windows, install Git for Windows or WSL to provide sh.exe or bash.exe in PATH.${lastError instanceof Error ? ` (${lastError.message})` : ""}`,
  );
  throw cachedError;
}

function windowsShellCandidates(): ResolvedShell[] {
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

function assertWindowsShellCandidateExists(cmd: string): void {
  if (/^[A-Za-z]:[\\/]/.test(cmd)) return;
  execFileSync("where", [cmd], { stdio: "pipe", encoding: "utf-8" });
}

function detectWindowsShellFlavor(shell: ResolvedShell): WindowsShellFlavor {
  if (/^[A-Za-z]:[\\/]/.test(shell.cmd) && /[\\/]Git[\\/]/i.test(shell.cmd)) {
    return "msys";
  }
  try {
    const output = execFileSync(shell.cmd, shell.shellArgs("uname -s"), {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: WINDOWS_SHELL_PROBE_TIMEOUT_MS,
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

export function shellPathForHostPath(shell: ResolvedShell, hostPath: string): string {
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

export function shellCommandForHookPath(shell: ResolvedShell, hookPath: string): string {
  const shellPath = shellPathForHostPath(shell, hookPath);
  if (process.platform === "win32" && isAbsolute(hookPath)) {
    return `${shellInterpreterCommand(shell)} ${shellQuote(shellPath)}`;
  }
  return shellQuote(shellPath);
}

export function shellEnvForChild(shell: ResolvedShell, env: Record<string, string>): Record<string, string> {
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

function shellInterpreterCommand(shell: ResolvedShell): string {
  if (process.platform !== "win32") return "sh";
  if (shell.windowsFlavor === "msys") return "/usr/bin/sh";
  if (shell.windowsFlavor === "wsl") return "/bin/sh";
  return "sh";
}

function msysPathEntriesForShell(shell: ResolvedShell): string[] {
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
  cachedShell = null;
  cachedError = null;
}
