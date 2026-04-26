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
  /**
   * Whether to inject the Windows-safe GPU disable flags. Caller wires this
   * from `process.env.LVIS_KEEP_GPU !== "1"`. The env var stays a direct
   * read at the call site because the GPU flag is purely a corp/VDI
   * compatibility concession with no security surface (unlike sandbox).
   */
  disableGpu: boolean;
  /**
   * Whether to inject `--no-sandbox` into the registered protocol command.
   * MUST be the resolved value from `dev-flags.ts:devNoSandboxAllowed()` so
   * the `!app.isPackaged` SoT gate is enforced — passing the env var
   * directly would let a packaged binary launched with the env set silently
   * weaken Chromium sandboxing.
   */
  disableSandbox: boolean;
}

/**
 * Build the OS protocol-launcher argument list for `lvis://`. Mirrors the
 * policy used by the dev/start launchers so the OS-launched second instance
 * boots into the same userData and lock-namespace as the primary process.
 */
export function buildDevProtocolArgs(input: ProtocolArgInputs): string[] {
  const args: string[] = [resolve(resolveScriptPathArg(input.argv1))];
  if (input.userDataDir) args.push(`--user-data-dir=${input.userDataDir}`);
  if (input.platform === "win32" && input.disableGpu) {
    args.push(...WINDOWS_SAFE_GPU_FLAGS);
  }
  if (input.disableSandbox) {
    args.push(SANDBOX_BYPASS_FLAG);
  }
  return args;
}
