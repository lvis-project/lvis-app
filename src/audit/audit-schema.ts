/**
 * Audit schema (Layer 7).
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 7,
 * §11 v2.1 binding decisions.
 *
 * Discriminated union per `decision` field. Every entry shares
 * `AuditCommon` (timestamp, auditId, prevHash for HMAC chain). This
 * file defines the shapes only — emission lives in `audit-logger.ts`
 * and chain construction in `hmac-chain.ts`.
 *
 * The telemetry `AuditEntry` (turn / dlp / approval) remains the
 * general telemetry channel in `audit-logger.ts`. Permission audit entries
 * are a separate channel — written to their own JSONL file and
 * tagged via the `decision` discriminator (the telemetry channel uses
 * `type` instead). Consumers that filter on `decision` get only permission
 * events without seeing telemetry noise.
 */
import type { ToolCategory, ToolSource } from "../tools/types.js";
import type { ExecutionMode } from "../permissions/permission-manager.js";
import type { HookTrustOrigin } from "../hooks/script-hook-types.js";

export type TrustOrigin = HookTrustOrigin;
export type PermissionMode = ExecutionMode;

/**
 * Layer 5 reviewer agent verdict — kept structurally compatible with
 * `permissions/reviewer/risk-classifier.ts::RiskVerdict` so callers
 * can pass the runtime verdict in directly.
 */
export interface RiskVerdict {
  level: "low" | "medium" | "high";
  reason: string;
}

/**
 * Layer 6 hook-chain result entry — captured per script in the chain
 * so audit can reconstruct which hook said what.
 */
export interface HookResult {
  hookName: string;
  hookType: "pre" | "post" | "perm";
  action: "allow" | "deny";
  reason: string;
  durationMs: number;
}

/**
 * Routine scope snapshot at the moment of evaluation. Mirrors
 * `permissions/permission-manager.ts::ReviewerDispatchInput.routineScope`
 * but is intentionally `Record<string, unknown>` rather than the typed
 * `RoutineScope` to keep the audit shape stable across schema bumps.
 */
export type RoutineScopeSnapshot = Record<string, unknown>;

/**
 * Common fields present on every permission audit entry. The chain link is
 * the `prevHash` field — `audit-logger`'s emitter computes
 * `prevHash = HMAC(secret, prevLine)` where `prevLine` is the
 * previously-emitted line's *full JSON*. This binds each entry to
 * its predecessor; tampering with any line breaks the chain at the
 * next entry's hash check.
 */
export interface AuditCommon {
  /** ISO 8601 timestamp. */
  ts: string;
  /** UUIDv4 — uniquely identifies this audit entry. */
  auditId: string;
  /** Tool-call correlation id (when applicable). */
  toolUseId?: string;
  /** Trust origin propagated through the eval pipeline. */
  trustOrigin: TrustOrigin;
  /**
   * Hex-encoded HMAC over the previous line's serialized form.
   * For the first entry of the file this is HMAC(secret, "genesis").
   */
  prevHash: string;
}

/**
 * Layer N → "allow" — the tool call was permitted at layer `layer`.
 * `directory` and `directoryAllowed` are present only when the tool
 * invocation declares an explicit path or directory surface.
 */
export interface AuditAllow extends AuditCommon {
  decision: "allow";
  tool: string;
  source: ToolSource;
  category: ToolCategory;
  directory?: string;
  directoryAllowed?: true;
  scope?: RoutineScopeSnapshot;
  layer: number;
  reviewer?: RiskVerdict;
  hookChain?: HookResult[];
  rateLimitRemaining?: number;
}

/**
 * Layer N → "ask" — the user was prompted. The audit captures the
 * *prompt* event; the eventual user gesture (allow/deny) lands as a
 * follow-up `AuditAllow` or `AuditDeny`.
 */
export interface AuditAsk extends AuditCommon {
  decision: "ask";
  tool: string;
  source: ToolSource;
  category: ToolCategory;
  directory?: string;
  layer: number;
  reason: string;
  hookChain?: HookResult[];
}

/**
 * Layer N → "deny" — short-circuit fail. `denyReasons[]` carries the
 * collected reasons (spec §3 Layer 2). With short-circuit eval only
 * one entry is recorded in v1 — but the schema is plural so future
 * dual-deny / dry-run modes don't need a schema bump.
 */
export interface AuditDeny extends AuditCommon {
  decision: "deny";
  tool: string;
  source: ToolSource;
  category: ToolCategory;
  denyReasons: ReadonlyArray<{ layer: number; reason: string; source: string }>;
  hookChain?: HookResult[];
}

/**
 * Layer 5 routed to deferred queue — the reviewer agent classified
 * the call at the caller-selected deferred threshold and the user must
 * surface the entry from the `DeferredQueuePanel`. The `queueId` ties this
 * audit row to a specific entry in `~/.lvis/permissions/deferred-queue.jsonl`.
 */
export interface AuditDeferred extends AuditCommon {
  decision: "deferred";
  tool: string;
  source: ToolSource;
  category: ToolCategory;
  reviewerVerdict: RiskVerdict;
  queueId: string;
}

/**
 * Foreground user resolution for a previously deferred HIGH-risk action.
 * The queue file stores the mutable entry status; this append-only audit row
 * preserves the user's approval/rejection action in the tamper-evident chain.
 */
export interface AuditDeferredResolve extends AuditCommon {
  decision: "deferred_resolve";
  tool: string;
  source: ToolSource;
  category: ToolCategory;
  reviewerVerdict: RiskVerdict;
  queueId: string;
  resolution: "approved" | "rejected";
  /**
   * Issue #690 P4 — provenance of the user gesture that resolved the
   * deferred entry. "button" is the existing panel-click path;
   * "natural-language" is the in-chat intent-matched chip path. Main
   * requires this field for new writes; historical rows written before
   * P4 may omit it, so audit readers must tolerate `undefined`.
   */
  approvalSource?: "button" | "natural-language";
  reason?: string;
}

/**
 * Layer 8 `/permission mode ...` slash invocation. Spec §3 Layer 8
 * mandates `trustOrigin === "user-keyboard"` — but we record the
 * origin here so forensics can spot a slash dispatcher bug if a
 * non-user-keyboard origin ever reaches this entry.
 */
export interface AuditModeChange extends AuditCommon {
  decision: "mode_change";
  fromMode: PermissionMode;
  toMode: PermissionMode;
  durable: boolean;
}

/**
 * §3.5 manifest integrity violation — a `category: "read"` plugin
 * tool attempted a write through the runtime fs proxy. The plugin
 * is added to `manifestIntegrityState.disabledPluginIds` and this
 * row records the attempt for forensics.
 */
export interface AuditManifestViolation extends AuditCommon {
  decision: "manifest_violation";
  pluginId: string;
  toolName: string;
  attemptedOperation: string;
}

export type PermissionAuditEntry =
  | AuditAllow
  | AuditAsk
  | AuditDeny
  | AuditDeferred
  | AuditDeferredResolve
  | AuditModeChange
  | AuditManifestViolation;

export type PermissionAuditEntryInput = PermissionAuditEntry extends infer Entry
  ? Entry extends PermissionAuditEntry
    ? Omit<Entry, "prevHash">
    : never
  : never;

/**
 * Type guard — distinguishes permission audit entries from older
 * `AuditEntry` (which uses `type` instead of `decision`).
 */
export function isPermissionAuditEntry(value: unknown): value is PermissionAuditEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.decision === "string" && typeof obj.auditId === "string";
}
