import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

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

  const candidates: ResolvedShell[] = [
    { cmd: "sh", shellArgs: (script: string) => ["-c", script] },
    { cmd: "bash", shellArgs: (script: string) => ["-lc", script] },
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      execFileSync("where", [candidate.cmd], { stdio: "pipe", encoding: "utf-8" });
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

function detectWindowsShellFlavor(shell: ResolvedShell): WindowsShellFlavor {
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
    return `sh ${shellQuote(shellPath)}`;
  }
  return shellQuote(shellPath);
}

/** Test-only: reset memoization so test cases exercising different PATH states stay isolated. */
export function __resetShellResolverCache(): void {
  cachedShell = null;
  cachedError = null;
}
