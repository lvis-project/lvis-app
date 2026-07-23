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
import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";

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
 *
 * #811 (design §7) — extended with FORWARD-COMPATIBLE optional fields for the
 * command-hooks / lifecycle expansion. All additions are optional so existing
 * readers and historical rows keep working; `hookType` is RETAINED as the
 * derived back-compat alias of `event` (writers may emit both — `event` is the
 * richer closed-set surface, `hookType` is the narrow pre|post|perm projection).
 */
export interface HookResult {
  hookName: string;
  /**
   * Narrow pre|post|perm projection — derived alias of {@link event}. Kept
   * required so back-compat readers that key on `hookType` never see `undefined`.
   */
  hookType: "pre" | "post" | "perm";
  action: "allow" | "deny";
  reason: string;
  durationMs: number;
  /**
   * Closed-set lifecycle event (design §5). Today equals `hookType`; widens to
   * the full event surface (Stop / UserPromptSubmit / …) in later milestones.
   */
  event?: "pre" | "post" | "perm";
  /** The configured glob matcher that selected this hook (absent ⇒ match-all). */
  matcher?: string;
  /** Handler type — `"command"` today; http/mcp/prompt/agent in later phases. */
  handlerType?: "command";
  /**
   * Trust identity of the command: the resolved local-script sha256, or a hash
   * of the verbatim command string when no local anchor exists. Lets forensics
   * tie an audit row to the exact code that ran.
   */
  commandIdentity?: string;
  /**
   * Origin discriminant — a legacy `.sh` hook vs a declarative `hooks.json`
   * command entry. Absent on historical rows.
   */
  source?: "sh" | "config";
  /**
   * Decision surface incl. the non-blocking lifecycle outcome. `"observe"` is
   * reserved for non-blocking events whose `deny` is recorded as a policy signal
   * only (design §7). Today's blocking events emit `allow`/`deny`.
   */
  decision?: "allow" | "deny" | "observe";
  /** Why the hook failed closed, when it did. */
  failureReason?: "timeout" | "nonzero-exit" | "spawn-error" | "bad-output";
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
 * `prevHash = HMAC(secret, prevLine)` binds each entry to its predecessor.
 * New rows also carry `entryHash`, an HMAC over that row before `entryHash`
 * is appended, so the active tail is authenticated without waiting for a
 * successor. `entryHash` is optional only for reading pre-migration rows.
 */
export interface AuditCommon {
  /** ISO 8601 timestamp. */
  ts: string;
  /** UUIDv4 — uniquely identifies this audit entry. */
  auditId: string;
  /** Tool-call correlation id (when applicable). */
  toolUseId?: string;
  /**
   * Public-safe host shell substrate selected for this exact invocation.
   * This excludes tool arguments, directories, approval bindings, permits,
   * nonces, HMACs, and capability reasons.
   */
  executionPlan?: HostShellExecutionPlanAuditProjection;
  /** Metadata-only lifecycle evidence for one host-issued plugin operation grant. */
  pluginOperation?: {
    pluginId: string;
    operation: string;
    outcome:
      | "issued"
      | "denied"
      | "consumed"
      | "rejected"
      | "indeterminate"
      | "settled";
    grantId?: string;
  };

  /** Trust origin propagated through the eval pipeline. */
  trustOrigin: TrustOrigin;
  /**
   * Hex-encoded HMAC over the previous line's serialized form.
   * For the first entry of the file this is HMAC(secret, "genesis").
   */
  prevHash: string;
  entryHash?: string;
}

/**
 * Host-owned correlation metadata threaded only through audit writers. It is
 * never renderer payload data and never carries approval material.
 */
export interface ToolExecutionAuditMetadata {
  readonly toolUseId?: string;
  readonly executionPlan?: HostShellExecutionPlanAuditProjection;
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
  /**
   * Grant lifetime for out-of-allowed-dir directory approvals. Set when
   * the user resolved an `AuditAsk` (out-of-allowed-dir) with allow-once
   * / allow-session / allow-always. Forensic replay distinguishes
   * "narrow + turn-bound" vs "parent + conversation-bound" vs
   * "parent + persisted" grants from a single audit log diff.
   * `"degraded-to-turn"` records the propagateGrantScope fallback when a
   * session-intent grant could not be wired through to the conversation
   * loop and was conservatively narrowed.
   */
  grantLifetime?: "turn" | "session" | "always" | "degraded-to-turn";
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
  /**
   * Present when an explicit user action is the confirmation surface for a
   * durable mode change, so no secondary tool approval dialog was shown:
   *   - `"settings-ui"` / `"builtin-slash"` — a first-party renderer user action
   *     (Settings toggle / built-in `/permission mode` slash).
   *   - `"local-api-approval"` — an external origin (local-api / cli, #1409)
   *     initiated the change and the user consented via the in-app ApprovalGate
   *     modal at the transport-lifecycle layer BEFORE the handler ran. The
   *     `trustOrigin` field stays on the permission axis (`"user-keyboard"`,
   *     the human's Allow click), so `confirmationSource` is the sole forensic
   *     marker that the request was externally initiated.
   * Historical rows omit this field.
   */
  confirmationSource?: "settings-ui" | "builtin-slash" | "local-api-approval";
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
    ? Omit<Entry, "prevHash" | "entryHash">
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
