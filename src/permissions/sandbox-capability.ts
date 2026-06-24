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
 * How the capability is resolved:
 *   OS isolation is now backed by the Anthropic Sandbox Runtime (ASRT) —
 *   see asrt-sandbox.ts. The legacy per-OS runner registry
 *   (bubblewrap / sandbox-exec / AppContainer) was removed; ASRT provides the
 *   host-tool filesystem jail + global strict-union network enforcement. When
 *   the ASRT path is active it reports `kind: "asrt"`; the SOT falls back to
 *   `kind: "none"` (confidence: "verified") when the sandbox gate is off
 *   (DEFAULT) — the reviewer + UI then correctly report the absence of OS
 *   isolation. The active capability is published via
 *   `setActiveSandboxCapability`. The audit chain currently stores the reviewer
 *   verdict derived from this value, not the full SandboxCapability snapshot.
 */

import { t } from "../i18n/index.js";

export type SandboxKind =
  | "none"
  /** OS isolation provided by the Anthropic Sandbox Runtime (ASRT). Backend is
   * bwrap on Linux, Seatbelt on macOS; both report as a single `asrt` kind. */
  | "asrt"
  /** OS-level isolation present but evidence quality is PARTIAL. */
  | "partial"
  /** Filesystem-only isolation (landlock-only — future-proofing for Linux landlock runner). */
  | "fs-only";

/**
 * Confidence in the detection result.
 *
 *   - "verified"          — actively checked (binary present + invocable, OS API
 *     reports the process is sandboxed, etc.).
 *   - "assumed"           — inferred from platform without active probe (used
 *     when a probe is expensive or not yet implemented).
 *   - "policy-best-effort" — binary confirmed present + executable, but the
 *     sandbox profile is a best-effort policy with known bypass paths;
 *     enforcement is weaker than "verified". Reserved for a future PARTIAL
 *     backend; no current platform reports this (macOS + Linux are verified
 *     ASRT). Distinguishes a best-effort policy from "assumed".
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
 * Active capability cache. Set by {@link setActiveSandboxCapability} when the
 * ASRT sandbox path is initialized at boot. Defaults to `undefined` (the SOT
 * then reports `kind: "none"`).
 */
let _activeCapability: SandboxCapability | undefined;

/**
 * Store the active sandbox capability after the ASRT sandbox is initialized at
 * boot. Subsequent calls to detectSandboxCapability return this value.
 *
 * @internal — only the boot-time ASRT init path and tests should call this.
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
 * Returns the capability stored by {@link setActiveSandboxCapability} when the
 * ASRT sandbox path was initialized at boot. Falls back to kind="none" when no
 * sandbox is active (the gate is DEFAULT-OFF; isolation=none).
 *
 * This is the single SOT the reviewer and UI consult — all callers automatically
 * see the correct kind once ASRT is active without re-probing the OS.
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
 * Labels for extended kinds:
 *   partial  → "⚠ OS 격리 부분적"
 *   fs-only  → "ℹ 파일시스템만 격리 (landlock)"
 */
export function formatSandboxCapabilityForPrompt(capability: SandboxCapability): string {
  const kindLabel = (() => {
    switch (capability.kind) {
      case "none":         return "none";
      case "asrt":         return "asrt";
      case "partial":      return t("be_sandboxCapability.partialLabel");
      case "fs-only":      return t("be_sandboxCapability.fsOnlyLabel");
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
 *   - `kind === "partial"`       → weak (partial isolation = evidence gap)
 *   - `confidence === "assumed"` → weak (unverified isolation = no isolation)
 *
 * `fs-only` is NOT weak — it is strong-for-fs. The composition rule
 * handles network egress separately for fs-only runners.
 * Anything else (verified `asrt`) is "strong".
 */
export function isWeakSandbox(cap: SandboxCapability): boolean {
  if (cap.kind === "none") return true;
  if (cap.kind === "partial") return true;
  if (cap.confidence === "assumed") return true;
  return false;
}
