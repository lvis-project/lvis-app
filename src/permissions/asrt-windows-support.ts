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

interface AsrtWindowsInstallCancelledLike {
  readonly cancelled: true;
}

interface AsrtWindowsInstallSuccessLike {
  readonly user: AsrtWindowsSandboxUserStatusLike;
  readonly wfp: AsrtWindowsWfpStatusLike;
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

export async function installAsrtWindowsSandbox(): Promise<SandboxWindowsInstallResult> {
  const { installWindowsSandbox, verifyWindowsWfpEgress } = await import(
    "@anthropic-ai/sandbox-runtime"
  );
  // ASRT 0.0.64 installWindowsSandbox is synchronous and may show a UAC prompt.
  // Keep that visible; only the follow-up WFP verification below is awaited.
  const result = installWindowsSandbox({
    proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  });
  if ((result as AsrtWindowsInstallCancelledLike).cancelled) {
    return { cancelled: true };
  }

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
