/**
 * ASRT Windows compatibility adapter.
 *
 * ASRT's Windows support is still moving quickly. Keep version-sensitive API
 * calls in this file so future package updates usually touch one adapter plus
 * its drift tests, not every IPC/UI caller.
 *
 * Current target: @anthropic-ai/sandbox-runtime 0.0.64
 * - dedicated `srt-sandbox` user provisioning
 * - WFP keyed to the sandbox user SID
 * - filesystem rules applied by ASRT's Windows ACL backend
 * - no Windows sign-out requirement for activation
 */
import type {
  SandboxWindowsInstallResult,
  SandboxWindowsStatusInfo,
} from "../shared/sandbox-capability-info.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, win32 as win32Path } from "node:path";
import { DEFAULT_WINDOWS_PROXY_PORT_RANGE } from "./asrt-sandbox.js";

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
}) => Promise<unknown>;

type InstallWindowsSandboxFn = (opts: {
  readonly proxyPortRange: readonly [number, number];
}) => unknown;

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
  readonly installWindowsSandbox: InstallWindowsSandboxFn;
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

const runExecFile: ExecFileFn = (file, args, options, callback) =>
  execFile(file, [...args], options, (error) => callback(error));

const ACL_TARGET_ENV = "LVIS_ASRT_ACL_TARGET";
const ICACLS_PATH_ENV = "LVIS_ASRT_ICACLS_PATH";
const APP_ASAR_PATH_SEGMENT = /(^|[\\/])app\.asar(?=$|[\\/])/i;
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
  const target = packageRoot.replace(APP_ASAR_PATH_SEGMENT, "$1app.asar.unpacked");
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

export async function resolveAsrtWindowsReady(
  userState: WindowsUserState,
  wfpState: WindowsWfpState,
  verifyWindowsWfpEgress: VerifyWindowsWfpEgressFn,
): Promise<boolean> {
  if (isAsrtWindowsReady(userState, wfpState)) return true;
  if (userState !== "ready" || wfpState !== "cannot-read") return false;

  // ASRT 0.0.64 reports `cannot-read` when BFE enumeration is admin-gated.
  // The non-elevated readiness proof is behavioral WFP egress verification.
  try {
    await verifyWindowsWfpEgress({
      proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE,
    });
    return true;
  } catch {
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

  const {
    getWindowsSandboxUserStatus,
    getWindowsWfpStatus,
    verifyWindowsWfpEgress,
    windowsInstallInstructions,
  } = await import("@anthropic-ai/sandbox-runtime");
  const userState = normalizeAsrtWindowsUserState(getWindowsSandboxUserStatus());
  const wfpState = normalizeAsrtWindowsWfpState(getWindowsWfpStatus());
  const ready = await resolveAsrtWindowsReady(
    userState,
    wfpState,
    verifyWindowsWfpEgress,
  );

  return {
    applicable: true,
    userState,
    wfpState,
    ready,
    instructions: windowsInstallInstructions(undefined),
  };
}

export async function installAsrtWindowsSandbox(
  dependencies: AsrtWindowsInstallDependencies = {},
): Promise<SandboxWindowsInstallResult> {
  const { installWindowsSandbox, verifyWindowsWfpEgress } = dependencies.loadRuntime
    ? await dependencies.loadRuntime()
    : await import("@anthropic-ai/sandbox-runtime");
  // ASRT 0.0.64 installWindowsSandbox is synchronous and may show a UAC prompt.
  // Keep that visible; only the follow-up WFP verification below is awaited.
  const result = installWindowsSandbox({
    proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  });
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
  );
  return {
    userState,
    wfpState,
    ready,
  };
}
