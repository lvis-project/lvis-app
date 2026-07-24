/**
 * ASRT Windows compatibility adapter.
 *
 * ASRT's Windows support is still moving quickly. Keep version-sensitive API
 * calls in this file so future package updates usually touch one adapter plus
 * its drift tests, not every IPC/UI caller.
 *
 * Current target: @anthropic-ai/sandbox-runtime 0.0.67
 * - dedicated `srt-sandbox` user provisioning
 * - WFP keyed to the sandbox user SID
 * - filesystem rules applied by ASRT's Windows ACL backend
 * - no Windows sign-out requirement for activation
 * - NO IMPLICIT VENDORED RESOLUTION: every srt-win-backed helper takes an
 *   EXPLICIT spawn descriptor (`resolveSrtWin({ path })`) — the argless form
 *   THROWS. The srt-win path SoT lives in asrt-sandbox.ts
 *   ({@link getVendoredSrtWinExePath}); this adapter resolves the descriptor once
 *   via {@link loadSrtWin} and threads it through every status/install/verify
 *   call.
 * - ASYNC probes: `checkWindowsSandboxStatusAsync` / `installWindowsSandboxAsync`
 *   keep the main-process event loop live — the synchronous install froze the UI
 *   during the modal UAC wait (issue #1608 class).
 */
import type {
  SandboxWindowsInstallResult,
  SandboxWindowsStatusInfo,
} from "../shared/sandbox-capability-info.js";
import type { SrtWinSpawn } from "@anthropic-ai/sandbox-runtime";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, win32 as win32Path } from "node:path";
import {
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  getVendoredSrtWinExePath,
  rewriteAsarPathToUnpacked,
} from "./asrt-sandbox.js";

type WindowsUserState = NonNullable<SandboxWindowsStatusInfo["userState"]>;
type WindowsWfpState = NonNullable<SandboxWindowsStatusInfo["wfpState"]>;

export interface AsrtWindowsSandboxUserStatusLike {
  readonly provisioned?: boolean;
  readonly sid?: string;
  readonly groupExists?: boolean;
  readonly inBuiltinUsers?: boolean;
  readonly inSandboxGroup?: boolean;
  readonly hiddenFromLogon?: boolean;
  readonly credPresent?: boolean;
}

interface AsrtWindowsWfpStatusLike {
  readonly state?: unknown;
}

type VerifyWindowsWfpEgressFn = (opts?: {
  readonly proxyPortRange?: readonly [number, number];
  readonly srtWin?: SrtWinSpawn;
}) => Promise<unknown>;

// ASRT 0.0.67: the install is ASYNC (installWindowsSandboxAsync) and takes an
// explicit srt-win spawn descriptor. Keeping it async is what unfreezes the main
// process during the modal UAC wait (issue #1608 class).
type InstallWindowsSandboxAsyncFn = (opts: {
  readonly proxyPortRange: readonly [number, number];
  readonly srtWin?: SrtWinSpawn;
}) => Promise<AsrtWindowsInstallCancelledLike | AsrtWindowsInstallSuccessLike>;

interface ExecFileOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly windowsHide?: boolean;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: Error | null) => void,
) => unknown;

interface AsrtWindowsInstallRuntimeLike {
  readonly installWindowsSandboxAsync: InstallWindowsSandboxAsyncFn;
  readonly verifyWindowsWfpEgress: VerifyWindowsWfpEgressFn;
}

interface AsrtWindowsInstallDependencies {
  readonly loadRuntime?: () => Promise<AsrtWindowsInstallRuntimeLike>;
  readonly grantBackendAcl?: () => Promise<void>;
}

interface AsrtWindowsAclDependencies {
  readonly execFile?: ExecFileFn;
  readonly pathExists?: (path: string) => boolean;
  readonly resolvePackageRoot?: () => string;
  readonly systemRoot?: string;
  readonly warn?: (message: string, error: unknown) => void;
}

interface AsrtWindowsInstallCancelledLike {
  readonly cancelled: true;
}

interface AsrtWindowsInstallSuccessLike {
  readonly user: AsrtWindowsSandboxUserStatusLike;
  readonly wfp: AsrtWindowsWfpStatusLike;
}

function resolveAsrtPackageRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));
}

/**
 * Resolve the ASRT module namespace + the EXPLICIT srt-win spawn descriptor in
 * one spot. ASRT 0.0.67 removed implicit vendored resolution, so every
 * srt-win-backed helper (status/install/verify) needs this descriptor built from
 * the srt-win path SoT ({@link getVendoredSrtWinExePath} in asrt-sandbox.ts).
 */
async function loadSrtWin(): Promise<{
  mod: typeof import("@anthropic-ai/sandbox-runtime");
  srtWin: SrtWinSpawn;
}> {
  const mod = await import("@anthropic-ai/sandbox-runtime");
  const srtWin = mod.resolveSrtWin({ path: getVendoredSrtWinExePath() });
  return { mod, srtWin };
}

const runExecFile: ExecFileFn = (file, args, options, callback) =>
  execFile(file, [...args], options, (error) => callback(error));

const ACL_TARGET_ENV = "LVIS_ASRT_ACL_TARGET";
const ICACLS_PATH_ENV = "LVIS_ASRT_ICACLS_PATH";
const ELEVATED_ACL_SCRIPT = [
  `$target = [Environment]::GetEnvironmentVariable('${ACL_TARGET_ENV}', 'Process')`,
  `$icacls = [Environment]::GetEnvironmentVariable('${ICACLS_PATH_ENV}', 'Process')`,
  "if ([string]::IsNullOrWhiteSpace($target) -or [string]::IsNullOrWhiteSpace($icacls)) { exit 87 }",
  `$quotedTarget = '"' + $target + '"'`,
  "$arguments = @($quotedTarget, '/grant', 'sandbox-runtime-users:(OI)(CI)(RX)', '/T', '/C')",
  "try { $process = Start-Process -FilePath $icacls -ArgumentList $arguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop; exit $process.ExitCode } catch { Write-Error $_; exit 1 }",
].join("; ");
const ELEVATED_ACL_ENCODED_COMMAND = Buffer.from(ELEVATED_ACL_SCRIPT, "utf16le").toString(
  "base64",
);

function resolveWindowsSystemRoot(override?: string): string {
  return override ?? process.env.SystemRoot ?? process.env.WINDIR ?? String.raw`C:\Windows`;
}

function resolveWindowsSystemBinary(systemRoot: string, ...segments: string[]): string {
  return win32Path.join(systemRoot, "System32", ...segments);
}

function resolveAsrtWindowsAclTarget(
  packageRoot: string,
  pathExists: (path: string) => boolean,
): string {
  // Single-authority asar→asar.unpacked rewrite (hoisted to asrt-sandbox.ts).
  const target = rewriteAsarPathToUnpacked(packageRoot);
  if (!pathExists(target)) {
    throw new Error(`ASRT backend ACL target does not exist: ${target}`);
  }
  return target;
}

function isAccessDeniedError(error: Error): boolean {
  const details = error as Error & {
    readonly code?: number | string;
    readonly errno?: number | string;
  };
  return (
    details.code === 5 ||
    details.code === "5" ||
    details.code === "EACCES" ||
    details.code === "EPERM" ||
    details.errno === 5 ||
    details.errno === "5" ||
    details.errno === "EACCES" ||
    details.errno === "EPERM"
  );
}

function executeFile(
  exec: ExecFileFn,
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<Error | null> {
  return new Promise((resolve) => {
    exec(file, args, options, resolve);
  });
}

/**
 * Mirror the installer's persistent group ACL grant for the runtime repair path.
 * This is deliberately best-effort: a failed repair must not brick Settings or
 * suppress the readiness result from the provision/verification steps.
 */
export async function grantAsrtWindowsBackendAcl(
  dependencies: AsrtWindowsAclDependencies = {},
): Promise<void> {
  const exec = dependencies.execFile ?? runExecFile;
  const pathExists = dependencies.pathExists ?? existsSync;
  const resolvePackageRoot =
    dependencies.resolvePackageRoot ?? resolveAsrtPackageRoot;
  const systemRoot = resolveWindowsSystemRoot(dependencies.systemRoot);
  const icaclsPath = resolveWindowsSystemBinary(systemRoot, "icacls.exe");
  const powershellPath = resolveWindowsSystemBinary(
    systemRoot,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const warn = dependencies.warn ?? console.warn;

  try {
    const packageRoot = resolveAsrtWindowsAclTarget(resolvePackageRoot(), pathExists);
    const icaclsArgs = [
      packageRoot,
      "/grant",
      "sandbox-runtime-users:(OI)(CI)(RX)",
      "/T",
      "/C",
    ];
    const error = await executeFile(exec, icaclsPath, icaclsArgs, { windowsHide: true });
    if (!error) return;

    if (!isAccessDeniedError(error)) {
      warn("[sandbox] ASRT backend ACL grant failed (non-fatal)", error);
      return;
    }

    const elevatedError = await executeFile(
      exec,
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        ELEVATED_ACL_ENCODED_COMMAND,
      ],
      {
        env: {
          ...process.env,
          [ACL_TARGET_ENV]: packageRoot,
          [ICACLS_PATH_ENV]: icaclsPath,
        },
        windowsHide: true,
      },
    );
    if (elevatedError) {
      warn("[sandbox] ASRT backend ACL elevated grant failed (non-fatal)", elevatedError);
    }
  } catch (error) {
    warn("[sandbox] ASRT backend ACL grant failed (non-fatal)", error);
  }
}

function hasUserProvisionSignal(user: AsrtWindowsSandboxUserStatusLike): boolean {
  return Boolean(
    user.provisioned ||
      user.sid ||
      user.groupExists ||
      user.inBuiltinUsers ||
      user.inSandboxGroup ||
      user.hiddenFromLogon ||
      user.credPresent,
  );
}

export function normalizeAsrtWindowsUserState(
  user: AsrtWindowsSandboxUserStatusLike,
): WindowsUserState {
  if (!hasUserProvisionSignal(user)) return "absent";
  if (
    user.provisioned === true &&
    typeof user.sid === "string" &&
    user.sid.length > 0 &&
    user.groupExists === true &&
    user.inBuiltinUsers === true &&
    user.inSandboxGroup === true &&
    user.hiddenFromLogon === true &&
    user.credPresent === true
  ) {
    return "ready";
  }
  return "incomplete";
}

export function normalizeAsrtWindowsWfpState(
  wfp: AsrtWindowsWfpStatusLike,
): WindowsWfpState {
  return wfp.state === "installed" || wfp.state === "cannot-read"
    ? wfp.state
    : "absent";
}

export function isAsrtWindowsReady(
  userState: WindowsUserState,
  wfpState: WindowsWfpState,
): boolean {
  return userState === "ready" && wfpState === "installed";
}

/**
 * Read the stable {@link WindowsSandboxError} `.code` off a caught value without
 * importing the class — keeps {@link resolveAsrtWindowsReady} pure and
 * unit-testable with a plain throwing stub. Returns undefined for a non-ASRT
 * error (no string `.code`).
 */
function windowsSandboxErrorCode(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export async function resolveAsrtWindowsReady(
  userState: WindowsUserState,
  wfpState: WindowsWfpState,
  verifyWindowsWfpEgress: VerifyWindowsWfpEgressFn,
  srtWin?: SrtWinSpawn,
): Promise<boolean> {
  if (isAsrtWindowsReady(userState, wfpState)) return true;
  if (userState !== "ready" || wfpState !== "cannot-read") return false;

  // ASRT 0.0.67 reports `cannot-read` when BFE enumeration is admin-gated.
  // The non-elevated readiness proof is behavioral WFP egress verification.
  try {
    await verifyWindowsWfpEgress({
      proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE,
      srtWin,
    });
    return true;
  } catch (error) {
    const code = windowsSandboxErrorCode(error);
    if (code === "wfp_fence_inactive") {
      // DEFINITIVE not-ready: srt-win proved DIRECT egress SUCCEEDED, so the WFP
      // fence is absent — the sandbox is not actually fencing egress.
      return false;
    }
    // Any other failure (bind failed, unparseable, spawn error, timeout, …)
    // means we could NOT prove the fence is active. Fail-closed (not ready), but
    // surface the code as a diagnostic instead of swallowing it silently.
    console.warn(
      "[sandbox] ASRT Windows WFP egress verification did not confirm the fence " +
        `(code=${code ?? "unknown"}) — treating the sandbox as not ready`,
    );
    return false;
  }
}

export async function readAsrtWindowsStatus(): Promise<SandboxWindowsStatusInfo> {
  if (process.platform !== "win32") {
    return {
      applicable: false,
      userState: null,
      wfpState: null,
      ready: false,
      instructions: "",
    };
  }

  const { mod, srtWin } = await loadSrtWin();
  // ASRT 0.0.67: ONE `srt-win status` spawn returns BOTH the sandbox-user and
  // WFP state (checkWindowsSandboxStatusAsync), non-blocking — replaces the two
  // separate synchronous user + wfp probes.
  const { user, wfp } = await mod.checkWindowsSandboxStatusAsync({ srtWin });
  const userState = normalizeAsrtWindowsUserState(user);
  const wfpState = normalizeAsrtWindowsWfpState(wfp);
  const ready = await resolveAsrtWindowsReady(
    userState,
    wfpState,
    mod.verifyWindowsWfpEgress,
    srtWin,
  );

  return {
    applicable: true,
    userState,
    wfpState,
    ready,
    instructions: mod.windowsInstallInstructions(undefined),
  };
}

export async function installAsrtWindowsSandbox(
  dependencies: AsrtWindowsInstallDependencies = {},
): Promise<SandboxWindowsInstallResult> {
  // Resolve the real module (for the explicit srt-win descriptor + the
  // WindowsSandboxError class) once; the install/verify functions may be
  // overridden by the DI seam for tests.
  const { mod, srtWin } = await loadSrtWin();
  const { installWindowsSandboxAsync, verifyWindowsWfpEgress } =
    dependencies.loadRuntime ? await dependencies.loadRuntime() : mod;

  // ASRT 0.0.67: the install is ASYNC — the modal UAC prompt is still shown, but
  // the main-process event loop stays live (spinners/timers keep running) rather
  // than freezing for the full consent wait (issue #1608 class). The srt-win
  // descriptor is explicit (no implicit vendored fallback in 0.0.67).
  let result: AsrtWindowsInstallCancelledLike | AsrtWindowsInstallSuccessLike;
  try {
    result = await installWindowsSandboxAsync({
      proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE,
      srtWin,
    });
  } catch (error) {
    if (
      error instanceof mod.WindowsSandboxError &&
      error.code === "install_timeout"
    ) {
      // The self-elevating install subprocess was killed by the 120s spawn
      // timeout with the UAC consent dialog still open. Surface it distinctly so
      // the caller can prompt the user to re-run and approve elevation promptly
      // (a late approval after the timeout would half-complete).
      throw new Error(
        "ASRT Windows sandbox install timed out after 120s with the UAC consent " +
          "prompt still open. Re-run the install and approve the elevation prompt.",
      );
    }
    throw error;
  }

  if ((result as AsrtWindowsInstallCancelledLike).cancelled) {
    return { cancelled: true };
  }

  await (dependencies.grantBackendAcl ?? grantAsrtWindowsBackendAcl)();

  const success = result as AsrtWindowsInstallSuccessLike;
  const userState = normalizeAsrtWindowsUserState(success.user);
  const wfpState = normalizeAsrtWindowsWfpState(success.wfp);
  const ready = await resolveAsrtWindowsReady(
    userState,
    wfpState,
    verifyWindowsWfpEgress,
    srtWin,
  );
  return {
    userState,
    wfpState,
    ready,
  };
}
