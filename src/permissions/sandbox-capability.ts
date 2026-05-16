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
 *   place to update; reviewer + UI read from this SOT. The audit chain
 *   currently stores the reviewer verdict derived from this value, not the
 *   full SandboxCapability snapshot.
 */

export type SandboxKind =
  | "none"
  | "bubblewrap"
  | "sandbox-exec"
  | "appcontainer"
  /** D5+D6: OS-level isolation present but evidence quality is PARTIAL (e.g. sandbox-exec partial profile). */
  | "partial"
  /** D6: filesystem-only isolation (landlock-only — future-proofing for Linux landlock runner). */
  | "fs-only";

/**
 * Confidence in the detection result.
 *
 *   - "verified"          — actively checked (binary present + invocable, OS API
 *     reports the process is sandboxed, etc.).
 *   - "assumed"           — inferred from platform without active probe (used
 *     when a probe is expensive or not yet implemented).
 *   - "policy-best-effort" — binary confirmed present + executable, but the
 *     sandbox profile is a best-effort policy (e.g. macOS sandbox-exec SBPL).
 *     Known bypass paths exist; enforcement is weaker than "verified".
 *     D2: used for macOS sandbox-exec (PARTIAL) to distinguish from assumed.
 */
export type SandboxConfidence = "verified" | "assumed" | "policy-best-effort";

export interface SandboxCapability {
  kind: SandboxKind;
  confidence: SandboxConfidence;
  /** NodeJS.Platform value at detection time. Useful for audit replay. */
  platform: NodeJS.Platform;
  /** Short human-readable explanation, surfaced to UI + reviewer prompt. */
  reason: string;
}

/**
 * MAJOR-1 SOT fix: active capability cache. Set by {@link setActiveSandboxCapability}
 * which is called from sandbox-runner.ts after a runner is registered with its
 * detection result. Avoids circular import (sandbox-runner already imports from
 * this module as `import type`; we expose a setter here so the dependency stays
 * one-directional at the value level).
 */
let _activeCapability: SandboxCapability | undefined;

/**
 * Store the active sandbox capability after boot-time runner registration.
 * Called by sandbox-runner.ts → registerSandboxRunner when a detection result
 * is provided. Subsequent calls to detectSandboxCapability return this value.
 *
 * @internal — only sandbox-runner.ts and tests should call this.
 */
export function setActiveSandboxCapability(cap: SandboxCapability): void {
  _activeCapability = cap;
}

/**
 * Reset the active capability cache. Used by test teardown.
 * @internal
 */
export function __resetActiveSandboxCapabilityForTest(): void {
  _activeCapability = undefined;
}

/**
 * Detect the OS execution sandbox available to spawned shell commands.
 *
 * MAJOR-1 fix: returns the capability stored by {@link setActiveSandboxCapability}
 * when a runner has been registered at boot with its detection result. Falls back
 * to kind="none" only when no runner is registered (isolation=none per D8).
 *
 * This is the single SOT the reviewer and UI consult — all callers automatically
 * see the correct kind after BwrapRunner registration without re-probing the OS.
 */
export function detectSandboxCapability(): SandboxCapability {
  if (_activeCapability) {
    return _activeCapability;
  }
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
 *
 * Labels for new kinds (D5+D6):
 *   partial  → "⚠ OS 격리 부분적 (sandbox-exec)"
 *   fs-only  → "ℹ 파일시스템만 격리 (landlock)"
 */
export function formatSandboxCapabilityForPrompt(capability: SandboxCapability): string {
  const kindLabel = (() => {
    switch (capability.kind) {
      case "none":         return "none";
      case "bubblewrap":   return "bubblewrap";
      case "sandbox-exec": return "sandbox-exec";
      case "appcontainer": return "appcontainer";
      case "partial":      return "partial [⚠ OS 격리 부분적 (sandbox-exec)]";
      case "fs-only":      return "fs-only [ℹ 파일시스템만 격리 (landlock)]";
      default: {
        // Exhaustive check — if a new SandboxKind is added without updating
        // this switch, the TypeScript compiler will report an error here.
        const _exhaustive: never = capability.kind;
        return _exhaustive;
      }
    }
  })();
  return (
    `executionSandbox=${kindLabel} (${capability.confidence}, ${capability.platform}) ` +
    `— ${capability.reason}`
  );
}

/**
 * Returns true when the capability is "weak" — i.e. the LLM reviewer
 * MUST NOT downgrade a rule-based MEDIUM/HIGH verdict to LOW on this
 * invocation. Centralised here so the reviewer + audit + UI agree.
 *
 *   - `kind === "none"`          → weak (no isolation)
 *   - `kind === "partial"`       → weak (D5: partial isolation = evidence gap)
 *   - `confidence === "assumed"` → weak (unverified isolation = no isolation)
 *
 * `fs-only` is NOT weak — it is strong-for-fs. The composition rule
 * handles network egress separately for fs-only runners.
 * Anything else (verified bubblewrap / sandbox-exec) is "strong".
 */
export function isWeakSandbox(cap: SandboxCapability): boolean {
  if (cap.kind === "none") return true;
  if (cap.kind === "partial") return true;
  if (cap.confidence === "assumed") return true;
  return false;
}

/**
 * @deprecated Use {@link isWeakSandbox} instead. Kept for backwards compatibility
 * until all callers are updated.
 * @internal
 */
export function isSandboxWeak(capability: SandboxCapability): boolean {
  return isWeakSandbox(capability);
}
