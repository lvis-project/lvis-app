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
 *   - Linux (bubblewrap via ASRT): filesystem + process + network.
 *   - Windows: fail-closed — tools run unconfined (srt-win is a network-only
 *     half-sandbox LVIS does not adopt).
 */

/** What the sandbox confines, by platform. `network` is false where egress is not contained. */
export interface SandboxConfinement {
  filesystem: boolean;
  process: boolean;
  network: boolean;
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
    // bubblewrap via ASRT confines fs + pid + net.
    return { filesystem: true, process: true, network: true };
  }
  // Windows + anything else: fail-closed, no sandbox.
  return { filesystem: false, process: false, network: false };
}
