/**
 * Boot §4.2 — triggerConversation gate subsystem.
 *
 * Extracted from `plugin-runtime.ts` (C5, behavior-preserving). Owns the pure
 * `evaluateTriggerSpec` decision function, the RateLimiter / Dedupe /
 * DenyThrottle helper classes, and their module-level singletons. The
 * singletons are defined ONCE here and imported by the host-api factory — a
 * second instance would break gating state (see the C1 trigger-gating test).
 */
import type { AuditEntry } from "../../../audit/audit-logger.js";
import type {
  ConversationTriggerResult,
  ConversationTriggerSpec,
} from "../../../plugins/types.js";
import { OVERLAY_TRIGGER_SOURCE_PATTERN, isOverlayTriggerOrigin } from "../../../shared/overlay-trigger-source.js";
import { CAPABILITY_HOST_OVERLAY } from "../../../plugins/capabilities.js";
import { neutralizeFenceClose } from "../../../shared/fence-sanitizer.js";
import { stripLeadingSlash } from "../../../shared/slash-sanitizer.js";
import { stripUntrustedTags } from "../../../lib/strip-untrusted-tags.js";
import { t } from "../../../i18n/index.js";

/**
 * In-memory dedupe for `hostApi.triggerConversation()`. A plugin can set
 * `dedupeKey` on a trigger spec to suppress repeats from the same observation
 * (e.g., the same mail re-emitting events). Keyed per pluginId so two plugins
 * cannot collide. TTL is intentionally short — long-term suppression should
 * live in the plugin, not the host.
 */
export const TRIGGER_CONVERSATION_DEDUPE_TTL_MS = 5 * 60 * 1000;

export class TriggerConversationDedupe {
  private readonly seen = new Map<string, number>();
  private key(pluginId: string, dedupeKey: string): string {
    return `${pluginId}::${dedupeKey}`;
  }
  has(pluginId: string, dedupeKey: string): boolean {
    const key = this.key(pluginId, dedupeKey);
    const seenAt = this.seen.get(key);
    if (seenAt === undefined) return false;
    if (Date.now() - seenAt > TRIGGER_CONVERSATION_DEDUPE_TTL_MS) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }
  record(pluginId: string, dedupeKey: string): void {
    // True LRU: delete-then-set refreshes Map insertion order so a frequently
    // re-recorded key won't be evicted as "oldest" when capping. Map#set on
    // an existing key would otherwise leave the original insertion position.
    const key = this.key(pluginId, dedupeKey);
    if (this.seen.has(key)) this.seen.delete(key);
    this.seen.set(key, Date.now());
    if (this.seen.size > 256) {
      // Cap unbounded growth; drop the oldest recorded key. Cheap for the
      // small N expected.
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) this.seen.delete(oldestKey);
    }
  }
}

const ALLOWED_VISIBILITIES: ReadonlySet<"silent" | "summary-only" | "user-visible"> = new Set([
  "silent",
  "summary-only",
  "user-visible",
] as const);
const ALLOWED_PRIORITIES: ReadonlySet<"low" | "normal" | "high"> = new Set([
  "low",
  "normal",
  "high",
] as const);
/** Bound dedupeKey length so a malicious / buggy plugin cannot bloat audit logs. */
const MAX_DEDUPE_KEY_LEN = 128;
/** Bound source length — same reason. dedupeKey was bounded; review caught source. */
const MAX_SOURCE_LEN = 128;
/**
 * Bound prompt length. The host trusts the plugin's templated-only contract
 * (a comment in `types.ts`) but offers no enforcement; capping prevents an
 * accidental whole-mail dump from blowing past the LLM context. 4 KB is
 * generous for templated suggestions and tight enough to reject a body.
 */
const MAX_PROMPT_LEN = 4096;
// `SOURCE_PATTERN` is the strict shape required for the `source` field
// of every overlay trigger spec. It's the SAME pattern used by the
// keyword engine, the trigger executor envelope, the IPC bridge's
// originSource detection, and the permission manager's overlay-trigger
// origin override — see `shared/overlay-trigger-source.ts` for the single
// definition. Without this gate, malformed sources (`overlay:`,
// `overlay:_x`, `overlay:Bad/Path`) could flow into audit logs and
// system prompts where loose substrings would be confusing.

/**
 * Per-plugin rate limit for `triggerConversation()`. A plugin that omits
 * `dedupeKey` (or rotates it per call) is otherwise unbounded and could
 * stage N concurrent overlay prompts. Token bucket capped at 6 calls / 60
 * seconds per plugin (sustained), with
 * burst of 3 — picked so the sample scenarios (one-meeting-mail, one-task-
 * deadline) do not throttle but a tight loop adversary is stopped early.
 */
export const TRIGGER_CONVERSATION_RATE_LIMIT_WINDOW_MS = 60_000;
export const TRIGGER_CONVERSATION_RATE_LIMIT_MAX_CALLS = 6;

/**
 * Plugin overlay prompts have plugin provenance even after the user clicks the
 * overlay action. They must never dispatch host slash commands such as
 * `/load`, `/compact`, or `/permission`; those are user-keyboard only.
 */
export function sanitizePluginPendingPrompt(prompt: string): string {
  return stripLeadingSlash(prompt);
}

/**
 * Wrap a plugin-authored prompt in its provenance fence. The body is neutralized
 * against its OWN closing tag (`shared/fence-sanitizer.ts` — the same helper the
 * `<app-message>` and `<mcp-app-context>` fences use): a prompt carrying a literal
 * `</imported-from-proactive>` would otherwise author text that reads, to the model, as
 * sitting outside the plugin-provenance fence.
 */
export function formatPluginPendingPrompt(prompt: string, source: string): string {
  if (!isOverlayTriggerOrigin(source)) {
    throw new Error(`invalid overlay trigger source for pending prompt: ${source}`);
  }
  const body = neutralizeFenceClose(
    sanitizePluginPendingPrompt(prompt),
    "imported-from-proactive",
  );
  return `<imported-from-proactive source="${source}">\n${body}\n</imported-from-proactive>`;
}

export const OVERLAY_SUMMARY_DISPLAY_CAP = 2_000;

/**
 * Build the user-visible overlay preview. The full prompt still flows through
 * `pendingPrompt`; this display string is bounded and stripped of
 * plugin-authored `<untrusted-*>` wrappers before reaching renderer chrome.
 */
export function deriveOverlaySummaryForDisplay(
  spec: Pick<ConversationTriggerSpec, "prompt" | "summary">,
): string {
  const rawSummary = spec.summary != null ? spec.summary : spec.prompt;
  const stripped = stripUntrustedTags(rawSummary);
  if (stripped.length > OVERLAY_SUMMARY_DISPLAY_CAP) {
    const marker = t("be_pluginRuntime.overlaySummaryTruncationMarker");
    const cap = OVERLAY_SUMMARY_DISPLAY_CAP - marker.length;
    return stripped.slice(0, cap) + marker;
  }
  return stripped;
}

export class TriggerConversationRateLimiter {
  private readonly windowMs: number;
  private readonly maxCalls: number;
  private readonly recent = new Map<string, number[]>();

  constructor(
    windowMs: number = TRIGGER_CONVERSATION_RATE_LIMIT_WINDOW_MS,
    maxCalls: number = TRIGGER_CONVERSATION_RATE_LIMIT_MAX_CALLS,
  ) {
    this.windowMs = windowMs;
    this.maxCalls = maxCalls;
  }

  /**
   * True when adding one more call would exceed the cap. Compacts the
   * underlying map entry as a side-effect — without this the entry would
   * grow unboundedly during sustained denial loops.
   */
  isOverCap(pluginId: string, now: number = Date.now()): boolean {
    const calls = this.recent.get(pluginId) ?? [];
    const cutoff = now - this.windowMs;
    const fresh = calls.filter((t) => t >= cutoff);
    if (fresh.length !== calls.length) this.recent.set(pluginId, fresh);
    return fresh.length >= this.maxCalls;
  }

  record(pluginId: string, now: number = Date.now()): void {
    const calls = this.recent.get(pluginId) ?? [];
    const cutoff = now - this.windowMs;
    const fresh = calls.filter((t) => t >= cutoff);
    fresh.push(now);
    this.recent.set(pluginId, fresh);
  }
}

export const triggerConversationRateLimiter = new TriggerConversationRateLimiter();

/**
 * Suppress a flood of identical denial audit rows. Without this, a plugin in
 * a tight loop with always-bad input (e.g. invalid source) hits the gate
 * before the rate limiter `record` runs (denials don't consume cap), so it
 * could write thousands of audit rows / second. We log the first denial of
 * a (pluginId, reason) pair, then suppress identical follow-ups for 60s and
 * emit one consolidated "...denials suppressed" line at expiry.
 */
const TRIGGER_DENY_AUDIT_WINDOW_MS = 60_000;

export class TriggerDenyAuditThrottle {
  private readonly windowMs: number;
  private readonly state = new Map<string, { suppressedSince: number; count: number }>();

  constructor(windowMs: number = TRIGGER_DENY_AUDIT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Returns whether the caller should write the audit row right now.
   * - First seen → returns true, marks suppression window open.
   * - Within open window → returns false, increments suppressed count.
   * - Window expired → returns true (with a "suppressed N" hint via
   *   {@link drainSuppressed}).
   */
  shouldEmit(pluginId: string, reason: string, now: number = Date.now()): boolean {
    const key = `${pluginId}::${reason}`;
    const entry = this.state.get(key);
    if (entry === undefined) {
      this.state.set(key, { suppressedSince: now, count: 0 });
      return true;
    }
    if (now - entry.suppressedSince >= this.windowMs) {
      // Window expired — emit again, and the caller can summarize the
      // suppressed period via drainSuppressed().
      this.state.set(key, { suppressedSince: now, count: 0 });
      return true;
    }
    entry.count += 1;
    return false;
  }

  /**
   * Returns the count of suppressed events since the last emit for this key
   * and resets the counter (caller appends `... +N suppressed` to the audit
   * row). Returns 0 if the most recent decision was an emit.
   */
  drainSuppressed(pluginId: string, reason: string): number {
    const entry = this.state.get(`${pluginId}::${reason}`);
    if (!entry) return 0;
    const n = entry.count;
    entry.count = 0;
    return n;
  }
}

export const triggerDenyAuditThrottle = new TriggerDenyAuditThrottle();

/**
 * Pure decision function for the `triggerConversation` gate. Extracted from
 * createHostApi so production code and tests share one implementation —
 * any future drift would have to be intentional.
 *
 * Returns either:
 *   { kind: "deny", result }      — fully-formed ConversationTriggerResult
 *                                   the host should return; audit row has
 *                                   already been written.
 *   { kind: "allow", result, ... } — caller should stage an overlay item
 *                                   with the normalized fields.
 *
 * The function ALSO writes the success / deny audit rows so the caller
 * stays simple (no double-bookkeeping).
 */
export interface EvaluateTriggerSpecInput {
  spec: ConversationTriggerSpec | undefined | null;
  pluginId: string;
  capabilities: readonly string[];
  dedupe: TriggerConversationDedupe;
  rateLimiter: TriggerConversationRateLimiter;
  /** Burst-suppress identical denial audit rows. */
  denyAuditThrottle?: TriggerDenyAuditThrottle;
  auditLogger: { log(entry: AuditEntry): void };
  now?: () => number;
}

export type EvaluateTriggerSpecOutcome =
  | { kind: "deny"; result: ConversationTriggerResult }
  | {
      kind: "allow";
      result: ConversationTriggerResult;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
    };

export function evaluateTriggerSpec(
  input: EvaluateTriggerSpecInput,
): EvaluateTriggerSpecOutcome {
  const {
    spec,
    pluginId,
    capabilities,
    dedupe,
    rateLimiter,
    auditLogger,
  } = input;
  const denyAuditThrottle = input.denyAuditThrottle;
  const now = input.now ?? Date.now;

  // NEVER slice-before-validate: slicing a too-long source could turn
  // obviously-bad input into a passing prefix. Reject outright (below)
  // so the regex sees the original.
  const source = typeof spec?.source === "string" ? spec.source : "";
  const { visibility, priority, dedupeKey } = normalizeTriggerSpecFields(
    spec ?? ({} as ConversationTriggerSpec),
  );

  const auditDeny = (reasonInput: string) => {
    // Reason key is the first `reason=<value>` token, used to throttle
    // identical denials per-(pluginId, reason). Different reasons (e.g.
    // capability_denied vs invalid_source) get independent windows.
    const reasonKey = (/reason=([a-z_]+)/.exec(reasonInput)?.[1]) ?? "unknown";
    if (denyAuditThrottle && !denyAuditThrottle.shouldEmit(pluginId, reasonKey, now())) {
      return;
    }
    const suppressed = denyAuditThrottle?.drainSuppressed(pluginId, reasonKey) ?? 0;
    try {
      auditLogger.log({
        timestamp: new Date(now()).toISOString(),
        sessionId: "plugin",
        type: "error",
        input:
          `[plugin:${pluginId}] trigger_conversation_denied ${reasonInput}` +
          (suppressed > 0 ? ` (+${suppressed} suppressed)` : ""),
      });
    } catch { /* audit must not break host */ }
  };

  if (!capabilities.includes(CAPABILITY_HOST_OVERLAY)) {
    auditDeny("reason=capability_denied");
    return {
      kind: "deny",
      result: { accepted: false, reason: "capability_denied", source: "" },
    };
  }
  // A too-long source is rejected outright; the regex sees the original
  // string (no slice-before-validate). Same for prompt length.
  if (source.length > MAX_SOURCE_LEN || !OVERLAY_TRIGGER_SOURCE_PATTERN.test(source)) {
    auditDeny(`reason=invalid_source source=${source.slice(0, 32) || "<empty>"}`);
    return {
      kind: "deny",
      // Echo only the first 32 chars so a malicious 10MB source cannot
      // pin into the caller-visible result either.
      result: { accepted: false, reason: "invalid_source", source: source.slice(0, 32) },
    };
  }
  if (typeof spec?.prompt !== "string" || spec.prompt.trim().length === 0) {
    auditDeny(`reason=invalid_source source=${source} (empty prompt)`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "invalid_source", source },
    };
  }
  if (spec.prompt.length > MAX_PROMPT_LEN) {
    auditDeny(`reason=invalid_source source=${source} (prompt>${MAX_PROMPT_LEN})`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "invalid_source", source },
    };
  }
  if (rateLimiter.isOverCap(pluginId, now())) {
    auditDeny("reason=rate_limited");
    return {
      kind: "deny",
      result: { accepted: false, reason: "rate_limited", source },
    };
  }
  if (dedupeKey && dedupe.has(pluginId, dedupeKey)) {
    auditDeny(`reason=duplicate dedupeKey=${dedupeKey}`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "duplicate", source },
    };
  }

  // Allow path — record both bookkeeping operations BEFORE returning so the
  // caller never gets an "accepted=true" without the dedupe + rate window
  // having advanced.
  if (dedupeKey) dedupe.record(pluginId, dedupeKey);
  rateLimiter.record(pluginId, now());

  // Compose the success audit row with sanitized contextKeys — key names
  // can carry PII so we accept only keys matching a strict identifier shape
  // and report a count for the rest. Single audit row per accepted trigger;
  // the loop-side trigger row would be redundant.
  let contextSuffix = "";
  if (spec?.context) {
    const KEY_SHAPE = /^[a-zA-Z_][a-zA-Z0-9_]{0,32}$/;
    const allKeys = Object.keys(spec.context);
    const okKeys = allKeys.filter((k) => KEY_SHAPE.test(k));
    const badCount = allKeys.length - okKeys.length;
    const parts: string[] = [];
    if (okKeys.length > 0) parts.push(`contextKeys=${okKeys.slice(0, 8).join(",")}`);
    if (badCount > 0) parts.push(`contextKeysOmitted=${badCount}`);
    if (parts.length > 0) contextSuffix = ` ${parts.join(" ")}`;
  }
  try {
    auditLogger.log({
      timestamp: new Date(now()).toISOString(),
      sessionId: "plugin",
      type: "tool_call",
      input:
        `[plugin:${pluginId}] trigger_conversation source=${source} ` +
        `visibility=${visibility} priority=${priority}` +
        (dedupeKey ? ` dedupeKey=${dedupeKey}` : "") +
        contextSuffix,
    });
  } catch { /* audit must not break host */ }

  return {
    kind: "allow",
    result: { accepted: true, source },
    source,
    visibility,
    priority,
  };
}

/**
 * Normalize plugin-supplied trigger fields to known/safe values BEFORE they
 * flow into audit logs or downstream pipelines. Unknown enum values fall
 * back to defaults. Non-string dedupeKey is dropped.
 */
export function normalizeTriggerSpecFields(spec: ConversationTriggerSpec): {
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  dedupeKey: string | undefined;
} {
  const visibility = ALLOWED_VISIBILITIES.has(
    spec.visibility as "silent" | "summary-only" | "user-visible",
  )
    ? (spec.visibility as "silent" | "summary-only" | "user-visible")
    : "summary-only";
  const priority = ALLOWED_PRIORITIES.has(
    spec.priority as "low" | "normal" | "high",
  )
    ? (spec.priority as "low" | "normal" | "high")
    : "normal";
  let dedupeKey: string | undefined;
  if (typeof spec.dedupeKey === "string") {
    const trimmed = spec.dedupeKey.trim();
    if (trimmed.length > 0) {
      dedupeKey = trimmed.length > MAX_DEDUPE_KEY_LEN
        ? trimmed.slice(0, MAX_DEDUPE_KEY_LEN)
        : trimmed;
    }
  }
  return { visibility, priority, dedupeKey };
}

export const triggerConversationDedupe = new TriggerConversationDedupe();
