import { execFileSync } from "node:child_process";

export class ShellMismatchError extends Error {
  readonly code = "SHELL_MISMATCH" as const;

  constructor(message: string) {
    super(message);
    this.name = "ShellMismatchError";
  }
}

export type ResolvedShell = { cmd: string; shellArgs: (script: string) => string[] };

let cachedShell: ResolvedShell | null = null;
let cachedError: ShellMismatchError | null = null;

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

/** Test-only: reset memoization so test cases exercising different PATH states stay isolated. */
export function __resetShellResolverCache(): void {
  cachedShell = null;
  cachedError = null;
}
