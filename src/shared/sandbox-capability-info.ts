/**
 * Honest, platform-aware description of what the OS tool sandbox actually
 * enforces. Shared between main (IPC handler) and any caller that needs to
 * report capability truthfully — NO overclaiming.
 *
 * Platform reality (now backed by the Anthropic Sandbox Runtime — see
 * src/permissions/asrt-sandbox.ts):
 *   - macOS (Seatbelt via ASRT): filesystem + process confinement, AND network
 *     — ASRT routes egress through a loopback proxy enforcing the global
 *     strict-union allow-list, so egress IS contained (no longer the old
 *     sandbox-exec fake floor that left loopback/IPv6/DNS open).
 *   - Linux (bwrap via ASRT): filesystem + process + network.
 *   - Windows (srt-win via ASRT): NETWORK egress only. srt-win enforces egress
 *     with a WFP filter set + a restricted-token job, routing the child through
 *     the loopback proxy — but it provides NO filesystem and NO process
 *     isolation (ASRT 0.0.59 has no Windows FS jail). This is a PARTIAL-confine
 *     substrate: honest about what it does and does NOT contain. The reviewer's
 *     per-category relaxation (sandboxRelaxesCategory) relaxes `network` but NOT
 *     filesystem-bearing categories on Windows precisely because of this.
 */

/** What the sandbox confines, by platform. `network` is false where egress is not contained. */
export interface SandboxConfinement {
  filesystem: boolean;
  process: boolean;
  network: boolean;
}

/**
 * Windows srt-win install readiness, returned to the renderer's consent panel.
 *
 * `ready` is the single boolean the UI gates on: the discriminator group is
 * enabled in the current token (`groupState === "ready"`) AND the WFP filter set
 * is installed (`wfpState === "installed"`). Until both hold, the sandbox cannot
 * confine egress and boot keeps `isAsrtSandboxActive()` false.
 *
 * `applicable` is false on every non-win32 platform — the renderer renders the
 * macOS/Linux capability copy instead of the Windows consent flow. The state
 * fields are `null` there (no Windows backend to query).
 *
 * `instructions` is the VERBATIM ASRT `windowsInstallInstructions(...)` text,
 * tailored to the observed group state (e.g. only the relogin step remains once
 * the install ran). Empty string when not applicable.
 */
export interface SandboxWindowsStatusInfo {
  /** True only on win32. Non-win32 → false, with null state fields. */
  applicable: boolean;
  /** `absent` | `created-not-on-token` | `ready`, or null off-win32. */
  groupState: "absent" | "created-not-on-token" | "ready" | null;
  /** `absent` | `installed`, or null off-win32. */
  wfpState: "absent" | "installed" | null;
  /** group === "ready" AND wfp === "installed". Always false off-win32. */
  ready: boolean;
  /** Verbatim ASRT install/relogin instructions. Empty off-win32. */
  instructions: string;
}

/**
 * Result of the user-consented Windows install (one self-elevating UAC).
 *
 * `cancelled: true` means the user dismissed the UAC prompt — NOT an error; the
 * install simply didn't run and the toggle should revert. On success the
 * post-install group + WFP state is returned so the renderer can advance to the
 * relogin-pending visual without a second round trip.
 */
export interface SandboxWindowsInstallResult {
  /** True when the user dismissed UAC. Mutually exclusive with the state fields. */
  cancelled?: true;
  /** Post-install group state (absent when `cancelled`). */
  groupState?: "absent" | "created-not-on-token" | "ready";
  /** Post-install WFP state (absent when `cancelled`). */
  wfpState?: "absent" | "installed";
  /** group === "ready" AND wfp === "installed" post-install. */
  ready?: boolean;
}

/** Capability snapshot returned to the renderer for the settings toggle. */
export interface SandboxCapabilityInfo {
  platform: NodeJS.Platform;
  /** Whether the user setting (or env escape-hatch) currently has the sandbox enabled. */
  enabled: boolean;
  /** Whether THIS PLATFORM can confine tools (its potential), independent of
   * whether a runner is currently registered — so the toggle can be shown
   * before the user opts in. macOS/Linux → true, Windows/others → false. */
  available: boolean;
  /** The platform's confinement strength ("full" Linux | "partial" macOS |
   * "none"), derived from the platform, not from a registered runner. */
  kind: "full" | "partial" | "none";
  /** Human-readable reason from runner detection (e.g. missing binary). */
  reason: string;
  /** What the sandbox actually confines on this platform when active. */
  confines: SandboxConfinement;
}

/**
 * Compute the per-platform confinement profile — a pure (no-I/O) mapping of
 * `(platform, kind)` to what is confined. `kind` reflects the platform's
 * confinement STRENGTH (the caller derives it from the platform, not from a
 * registered runner), so this describes the platform's POTENTIAL confinement;
 * `"none"` reports nothing confined.
 */
export function sandboxConfinementForPlatform(
  platform: NodeJS.Platform,
  kind: "full" | "partial" | "none",
): SandboxConfinement {
  if (kind === "none") {
    return { filesystem: false, process: false, network: false };
  }
  if (platform === "darwin") {
    // Seatbelt via ASRT confines fs + process; network egress is contained by
    // ASRT's loopback proxy + global strict-union allow-list (REAL floor, not
    // the old sandbox-exec fake floor).
    return { filesystem: true, process: true, network: true };
  }
  if (platform === "linux") {
    // bwrap via ASRT confines fs + pid + net.
    return { filesystem: true, process: true, network: true };
  }
  if (platform === "win32") {
    // srt-win via ASRT confines NETWORK egress only (WFP + restricted-token
    // job routing the child through the loopback proxy). ASRT 0.0.59 has NO
    // Windows filesystem jail and no process confinement — so this substrate is
    // honestly PARTIAL: network-only. This is what makes the reviewer's
    // per-category relaxation bite on Windows (network relaxes, write/shell do
    // NOT).
    return { filesystem: false, process: false, network: true };
  }
  // Anything else: fail-closed, no sandbox.
  return { filesystem: false, process: false, network: false };
}
