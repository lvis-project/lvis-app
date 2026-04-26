/**
 * Pure helpers for building the argument list that the running process registers
 * with the OS as the launcher for `lvis://` URIs.
 *
 * Extracted from main.ts so the platform / argv / env policy can be unit-tested
 * without spinning up Electron. The only Electron-specific input is the resolved
 * userData directory (passed in as a string) — the helper itself has no side
 * effects.
 */
import { resolve } from "node:path";
import {
  WINDOWS_SAFE_GPU_FLAGS,
  SANDBOX_BYPASS_FLAG,
} from "../../scripts/electron-flags.mjs";

/**
 * Decide what to use as the script-path argument. The OS appends the URL as
 * `%1` so the running process's `argv[1]` while it's BUILDING the registration
 * may already be a `lvis://` URL or an Electron switch like
 * `--user-data-dir=...` (when this code re-runs inside the OS-launched second
 * instance). Both cases would corrupt the registration if resolved as a path.
 */
export function resolveScriptPathArg(argv1: unknown): string {
  if (typeof argv1 !== "string") return ".";
  if (argv1.toLowerCase().startsWith("lvis://")) return ".";
  if (argv1.startsWith("--")) return ".";
  return argv1;
}

export interface ProtocolArgInputs {
  argv1: unknown;
  userDataDir: string | undefined;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/**
 * Build the OS protocol-launcher argument list for `lvis://`. Mirrors the
 * policy used by the dev/start launchers so the OS-launched second instance
 * boots into the same userData and lock-namespace as the primary process.
 */
export function buildDevProtocolArgs(input: ProtocolArgInputs): string[] {
  const args: string[] = [resolve(resolveScriptPathArg(input.argv1))];
  if (input.userDataDir) args.push(`--user-data-dir=${input.userDataDir}`);
  if (input.platform === "win32" && input.env.LVIS_KEEP_GPU !== "1") {
    args.push(...WINDOWS_SAFE_GPU_FLAGS);
  }
  if (input.env.LVIS_DEV_NO_SANDBOX === "1") {
    args.push(SANDBOX_BYPASS_FLAG);
  }
  return args;
}
