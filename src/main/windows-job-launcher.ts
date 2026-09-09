import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import { projectRoot } from "./main-paths.js";

export function resolveWindowsJobLauncher(): string {
  const packaged = !(process as { defaultApp?: boolean }).defaultApp && !!process.resourcesPath;
  const root = packaged ? process.resourcesPath : join(projectRoot, "resources");
  const binary = join(root, "windows-job", process.arch, "lvis-job.exe");
  if (!existsSync(binary)) throw new Error(`Windows job launcher is missing: ${binary}. Build the Windows native assets first.`);
  return binary;
}

/**
 * PID and lifecycle events belong to the helper. Keep stdin open until disposal;
 * ending it or calling kill() releases the job. Never expose it as command input.
 * Target launch failures emit a diagnostic and exit 125, not a spawn error event.
 */
export function spawnWindowsJobProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessByStdio<Writable, Readable, Readable> {
  if (process.platform !== "win32") throw new Error("Windows job launcher requires Windows");
  if (!win32.isAbsolute(executable)) throw new Error("Windows job launcher requires an absolute executable path");
  return spawn(resolveWindowsJobLauncher(), [executable, ...args], {
    ...options,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
