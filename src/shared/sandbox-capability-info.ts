/**
 * Honest, platform-aware description of what the OS tool sandbox actually
 * enforces. Shared between main (IPC handler) and any caller that needs to
 * report capability truthfully — NO overclaiming.
 *
 * Platform reality (see runner sources under src/permissions/runners/):
 *   - macOS (Seatbelt/sandbox-exec): filesystem + process confinement, but
 *     NOT network — sandbox-exec does not block loopback/IPv6/DNS. Full
 *     network containment is a later proxy/loopback-jail layer.
 *   - Linux (bubblewrap): filesystem + process + network (`--unshare-net`).
 *   - Windows: not yet available — tools run unconfined.
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
  /** True only when a runner is registered AND detected available on this host. */
  available: boolean;
  /** Detection kind from the active runner ("full" | "partial" | "none"). */
  kind: "full" | "partial" | "none";
  /** Human-readable reason from runner detection (e.g. missing binary). */
  reason: string;
  /** What the sandbox actually confines on this platform when active. */
  confines: SandboxConfinement;
}

/**
 * Compute the per-platform confinement profile. Pure — no I/O. The `kind`
 * argument comes from the active runner's detection so an unavailable runner
 * reports no confinement.
 */
export function sandboxConfinementForPlatform(
  platform: NodeJS.Platform,
  kind: "full" | "partial" | "none",
): SandboxConfinement {
  if (kind === "none") {
    return { filesystem: false, process: false, network: false };
  }
  if (platform === "darwin") {
    // Seatbelt confines fs + process; network is NOT contained (PARTIAL).
    return { filesystem: true, process: true, network: false };
  }
  if (platform === "linux") {
    // bubblewrap unshares fs + pid + net.
    return { filesystem: true, process: true, network: true };
  }
  // Windows + anything else: no runner.
  return { filesystem: false, process: false, network: false };
}
