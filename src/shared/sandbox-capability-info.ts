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
 *   - Windows (srt-win via ASRT): filesystem ACL + network egress confinement.
 *     ASRT provisions a dedicated `srt-sandbox` user, applies filesystem rules
 *     through its Windows ACL backend, and enforces egress with WFP + the
 *     loopback proxy. Windows still has NO process isolation, so this remains a
 *     PARTIAL-confine substrate.
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
 * `ready` is the single boolean the UI gates on: ASRT's dedicated
 * `srt-sandbox` user is provisioned (`userState === "ready"`) AND the WFP
 * filter set is installed (`wfpState === "installed"`). Until both hold, the
 * sandbox cannot confine filesystem/network access and boot keeps
 * `isAsrtSandboxActive()` false.
 *
 * `applicable` is false on every non-win32 platform — the renderer renders the
 * macOS/Linux capability copy instead of the Windows consent flow. The state
 * fields are `null` there (no Windows backend to query).
 *
 * `instructions` is the VERBATIM ASRT `windowsInstallInstructions(...)` text.
 * Empty string when not applicable.
 */
export interface SandboxWindowsStatusInfo {
  /** True only on win32. Non-win32 → false, with null state fields. */
  applicable: boolean;
  /** `absent` | `incomplete` | `ready`, or null off-win32. */
  userState: "absent" | "incomplete" | "ready" | null;
  /** `absent` | `installed` | `cannot-read`, or null off-win32. */
  wfpState: "absent" | "installed" | "cannot-read" | null;
  /**
   * True when the sandbox user is ready and WFP is either directly observed as
   * installed or `cannot-read` plus ASRT behavioral egress verification succeeds.
   * Always false off-win32.
   */
  ready: boolean;
  /** Verbatim ASRT install instructions. Empty off-win32. */
  instructions: string;
}

/**
 * Result of the user-consented Windows install (one self-elevating UAC).
 *
 * `cancelled: true` means the user dismissed the UAC prompt — NOT an error; the
 * install simply didn't run and the toggle should revert. On success the
 * post-install user + WFP state is returned so the renderer can advance without
 * a second round trip.
 */
export interface SandboxWindowsInstallResult {
  /** True when the user dismissed UAC. Mutually exclusive with the state fields. */
  cancelled?: true;
  /** Post-install sandbox user state (absent when `cancelled`). */
  userState?: "absent" | "incomplete" | "ready";
  /** Post-install WFP state (absent when `cancelled`). */
  wfpState?: "absent" | "installed" | "cannot-read";
  /** Post-install readiness, using the same WFP verification rule as status. */
  ready?: boolean;
}

/** Runtime snapshot returned to the renderer for startup/runtime honesty. */
export interface SandboxRuntimeCapabilityInfo {
  /** Whether the current process has an active sandbox runner registered. */
  available: boolean;
  /** Runtime confinement strength observed in this process, not platform potential. */
  kind: "full" | "partial" | "none";
  /** Human-readable reason from the runtime SOT. */
  reason: string;
}

/** Capability snapshot returned to the renderer for the settings toggle. */
export interface SandboxCapabilityInfo {
  platform: NodeJS.Platform;
  /** Whether the user setting (or env escape-hatch) currently has the sandbox enabled. */
  enabled: boolean;
  /** Whether THIS PLATFORM can confine tools (its potential), independent of
   * whether a runner is currently registered — so the toggle can be shown
   * before the user opts in. macOS/Linux/Windows → true, others → false. */
  available: boolean;
  /** The platform's confinement strength ("full" macOS/Linux | "partial" Windows |
   * "none"), derived from the platform, not from a registered runner. */
  kind: "full" | "partial" | "none";
  /** Back-compat summary. Prefer `potentialReason` and `runtime.reason`. */
  reason: string;
  /** Human-readable reason for this platform's potential capability. */
  potentialReason?: string;
  /** Last runtime SOT snapshot for the current process. */
  runtime?: SandboxRuntimeCapabilityInfo;
  /** What the sandbox actually confines on this platform when active. */
  confines: SandboxConfinement;
}

/**
 * Compute the per-platform confinement profile — a pure (no-I/O) mapping of
 * `(platform, kind)` to what is confined. `kind` is authoritative: `"full"`
 * means every dimension is confined, `"partial"` means a known weaker profile,
 * and `"none"` reports nothing confined. Unsupported platforms fail closed even
 * if a non-none kind is passed.
 */
export function sandboxConfinementForPlatform(
  platform: NodeJS.Platform,
  kind: "full" | "partial" | "none",
): SandboxConfinement {
  if (kind === "none") {
    return { filesystem: false, process: false, network: false };
  }
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return { filesystem: false, process: false, network: false };
  }
  if (kind === "full") {
    return { filesystem: true, process: true, network: true };
  }
  if (platform === "win32") {
    // srt-win via ASRT confines filesystem access through the dedicated
    // `srt-sandbox` user ACL backend and confines egress with WFP + loopback
    // proxy routing. Process isolation is still unavailable on Windows, so the
    // substrate remains partial.
    return { filesystem: true, process: false, network: true };
  }
  // Generic partial profile for any future non-Windows partial backend:
  // filesystem + network may be present, but process isolation is not claimed.
  return { filesystem: true, process: false, network: true };
}
