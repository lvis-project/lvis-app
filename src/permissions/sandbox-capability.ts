/**
 * OS-level execution sandbox capability — single source of truth.
 *
 * Spec ref: docs/architecture/permission-policy-design.md (sandbox capability layer)
 * Issue: #691 (sandbox capability + reviewer SOT integration)
 *
 * Why this module exists:
 *   The permission stack (Layer 0 deny / Layer 1 directory allow / Layer 3
 *   approval gate / Layer 5 reviewer) protects against accidental dangerous
 *   tool calls, but none of those layers physically isolate the *executed*
 *   shell command from the host filesystem. A reviewer that downgrades a
 *   tool call from HIGH to LOW based solely on intent is missing half the
 *   picture — without OS-level isolation, "low intent + no sandbox" is
 *   still a meaningful residual risk.
 *
 *   This module is the SOT the reviewer consults. The reviewer prompt is
 *   updated to honor a composition rule: "if executionSandbox.kind === 'none',
 *   the LLM MUST NOT downgrade a rule-based MEDIUM/HIGH verdict to LOW
 *   purely on intent."
 *
 * Why "none" for now:
 *   We have not yet wired bubblewrap (Linux) / sandbox-exec (macOS) /
 *   AppContainer (Windows). The detection function returns `kind: "none"`
 *   with `confidence: "verified"` — the SOT correctly reports the absence
 *   of OS isolation. When isolation lands, this function is the single
 *   place to update; reviewer + UI + audit all read from this SOT.
 */

export type SandboxKind = "none" | "bubblewrap" | "sandbox-exec" | "appcontainer";

/**
 * Confidence in the detection result.
 *
 *   - "verified" — actively checked (binary present + invocable, OS API
 *     reports the process is sandboxed, etc.).
 *   - "assumed"  — inferred from platform without active probe (used
 *     when a probe is expensive or not yet implemented).
 */
export type SandboxConfidence = "verified" | "assumed";

export interface SandboxCapability {
  kind: SandboxKind;
  confidence: SandboxConfidence;
  /** NodeJS.Platform value at detection time. Useful for audit replay. */
  platform: NodeJS.Platform;
  /** Short human-readable explanation, surfaced to UI + audit. */
  reason: string;
}

/**
 * Detect the OS execution sandbox available to spawned shell commands.
 *
 * Current implementation: returns `kind: "none", confidence: "verified"`
 * unconditionally. The platform field captures the host OS so audit
 * records remain replayable, and the reason string is stable for tests.
 *
 * Future plumbing points (single-place edits, no fallback paths):
 *   - Linux  : `which bwrap` + check `bwrap --version` exit code
 *              → `kind: "bubblewrap", confidence: "verified"`
 *   - macOS  : `which sandbox-exec` (always present on darwin)
 *              → `kind: "sandbox-exec", confidence: "verified"`
 *              (still gated on host policy actually using it)
 *   - Windows: `appcontainer` requires UWP-style packaging; mostly N/A
 *              for an Electron desktop app, so this stays `none` even
 *              after Linux/macOS land.
 *
 * Detection is pure / sync — no filesystem touch — so every caller can
 * invoke this once per dispatch without ceremony.
 */
export function detectSandboxCapability(): SandboxCapability {
  return {
    kind: "none",
    confidence: "verified",
    platform: process.platform,
    reason: "no OS sandbox configured for the host process",
  };
}

/**
 * Format the capability for inclusion in the reviewer LLM prompt.
 *
 * The format is stable + grep-able so the reviewer's response can be
 * audited against the input that produced it. Example output:
 *
 *   "executionSandbox=none (verified, darwin) — no OS sandbox configured for the host process"
 */
export function formatSandboxCapabilityForPrompt(capability: SandboxCapability): string {
  return (
    `executionSandbox=${capability.kind} (${capability.confidence}, ${capability.platform}) ` +
    `— ${capability.reason}`
  );
}

/**
 * Returns true when the capability is "weak" — i.e. the LLM reviewer
 * MUST NOT downgrade a rule-based MEDIUM/HIGH verdict to LOW on this
 * invocation. Centralised here so the reviewer + audit + UI agree.
 *
 *   - `kind === "none"`          → weak (no isolation)
 *   - `confidence === "assumed"` → weak (unverified isolation = no isolation)
 *
 * Anything else (verified bubblewrap / sandbox-exec) is "strong".
 */
export function isSandboxWeak(capability: SandboxCapability): boolean {
  if (capability.kind === "none") return true;
  if (capability.confidence === "assumed") return true;
  return false;
}
