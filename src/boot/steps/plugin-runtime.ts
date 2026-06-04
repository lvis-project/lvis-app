/**
 * Boot §4.2 Step 3-5 — Plugin runtime + HostApi factory.
 *
 * Extracted from boot.ts to keep orchestration thin. This module:
 *   • constructs the PluginDeploymentGuard and plugin runtime integrity gate
 *   • builds the per-plugin HostApi factory (registerKeywords / emitEvent /
 *     onEvent / getSecret / callLlm /
 *     logEvent / onShutdown)
 *   • creates the PluginRuntime, starts plugins, registers plugin tools,
 *     and wires the dev hot-reload watcher
 *   • returns the runtime + late-binding refs (llmCallerRef / pluginCallLlmRef /
 *     conversationLoopRef) that boot.ts injects once ConversationLoop exists.
 *
 * No plugin-specific literals here — everything is manifest-driven.
 */
import { app, BrowserWindow as ElectronBrowserWindow } from "electron";
import type { BrowserWindow } from "electron";
import { mkdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { installPluginPartitionPolicy } from "../../main/html-preview-partition.js";
import { isAppUpdateInstallRequested } from "../../main/app-update-install-intent.js";
import { pluginPartitionName } from "../../shared/plugin-partition.js";
import { onEvent as onHostEvent } from "../types.js";
import { normalizeAllowedHosts } from "../../main/host-allow-list.js";
import { AuditLogger, type AuditEntry } from "../../audit/audit-logger.js";
import { PluginRuntime } from "../../plugins/runtime.js";
import type { PythonRuntimeBootstrapper } from "../../main/python-runtime.js";
import { currentInvocationOrigin } from "../../plugins/runtime/origin-chain.js";
import { startPluginDevWatcher } from "../../plugins/dev-watcher.js";
import { PluginDeploymentGuard } from "../../plugins/deployment-guard.js";
// #958 round-1 security MEDIUM — read installSource from the registry so
// the Tier-3 admin-bypass gate is anchored to a host-verified field, not
// the user-writable `plugin.json` manifest.
import { readPluginRegistry } from "../../plugins/registry.js";
import type { PluginRegistryEntry } from "../../plugins/types.js";
import { createPluginStorage } from "../../plugins/storage.js";
import { shouldBlockPluginSecretRead } from "../../plugins/secret-shape.js";
import {
  setIsPackaged,
  shouldWarnPackagedFlagsIgnored,
  tamperedVarsAtBoot,
} from "../dev-flags.js";
import { canEmitEvent, requiredCapabilityForEmit } from "../../plugins/capabilities.js";
import { OVERLAY_V1 } from "../../shared/ipc-channels.js";
import { resolvePluginPaths } from "../../plugins/plugin-paths.js";
import { stripLeadingSlash } from "../../shared/slash-sanitizer.js";
import {
  emitPluginConfigChange,
  subscribePluginConfigChange,
} from "../../plugins/config-change-bus.js";
import { OVERLAY_TRIGGER_SOURCE_PATTERN, isOverlayTriggerOrigin } from "../../shared/overlay-trigger-source.js";
import type {
  ApprovalChoice,
  AuthWindowCookie,
  ConversationTriggerResult,
  ConversationTriggerSpec,
  OpenAuthWindowBaseOptions,
  OpenAuthWindowFinalUrlResult,
  PluginHostApi,
  PluginManifest,
} from "../../plugins/types.js";
import type { KeywordEngine } from "../../core/keyword-engine.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import { emitEvent, onEvent } from "../types.js";
import {
  buildPluginConfigOverrides,
  syncPluginToolRegistry,
  syncPluginToolRegistryForPlugin,
} from "../plugins.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import { stripUntrustedTags } from "../../lib/strip-untrusted-tags.js";
import { plog, PluginPhase } from "../../plugins/lifecycle-log.js";
import { incrementHostSecretCounter, sanitizeKeyPrefix } from "../../telemetry/host-secret-counters.js";
import { canonicalJSON } from "../../plugins/whitelist/canonical-json.js";
import { runTier3Then4 } from "../../plugins/whitelist/tier-order.js";
import {
  resolveApiKey as resolveApiKeyImpl,
  type ResolveApiKeyPurpose,
  type ResolveApiKeyVendor,
} from "../../main/host-api/resolve-api-key.js";
import {
  ApprovalIssuerRegistry,
  verifyApprovalRequestScope,
  verifyApprovalResponder,
  ApprovalOriginError,
} from "../../permissions/agent-action-requester.js";
const log = createLogger("lvis");

export function declaresHostManagedPythonRuntime(manifest: PluginManifest): boolean {
  const pluginManifest = manifest as PluginManifest & {
    python?: { managedBy?: unknown; requirementsLock?: unknown };
    pythonRequirementsLock?: unknown;
    runtime?: { python?: { requirementsLock?: unknown } };
    config?: { pythonRequirementsLock?: unknown };
  };
  return pluginManifest.python?.managedBy === "lvis-app" ||
    typeof pluginManifest.python?.requirementsLock === "string" ||
    typeof pluginManifest.pythonRequirementsLock === "string" ||
    typeof pluginManifest.runtime?.python?.requirementsLock === "string" ||
    typeof pluginManifest.config?.pythonRequirementsLock === "string";
}

/**
 * AC1.5 audit helper — logs an approval violation then re-throws the original
 * error. Extracted so the try-catch logic can be unit-tested without wiring the
 * full initPluginRuntime context.
 *
 * Guarantees: if `auditLogger.log` throws, that error is swallowed (non-fatal)
 * and `err` is still re-thrown to the caller.
 *
 * @internal — exported for testing only; production code calls this via the
 *             `respond()` closure inside initPluginRuntime.
 */
export function auditApprovalViolation(
  err: unknown,
  auditLogger: { log(entry: AuditEntry): void },
  pluginId: string,
  requestId: string,
): never {
  try {
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "approval-gating",
      type: "error",
      input: err instanceof ApprovalOriginError
        ? `[${err.code}] plugin='${pluginId}' requestId='${requestId}' ${err.message}`
        : `[approval-gating] plugin='${pluginId}' requestId='${requestId}' ${String(err)}`,
    });
  } catch (auditErr) {
    log.warn(
      "approval-gating audit log failed (non-fatal): %s",
      (auditErr as Error).message,
    );
  }
  throw err;
}

/**
 * §8 P0 security — shared issuer registry for agent approval origin gating.
 * Instantiated once per boot (module-level singleton). Records
 * (requestId → issuerPluginId + scope) at request time so the respond path
 * can verify cross-plugin attacks and scope violations.
 */
export const approvalIssuerRegistry = new ApprovalIssuerRegistry();

/**
 * §B3 — Explicit allowlist of host preference keys readable by plugins via
 * `hostApi.getAppPreference(key)`. Adding a new entry is a deliberate API
 * surface change: it must be reviewed for "does this leak host-private
 * state?" (secrets, auth tokens, plugin configs all stay OFF this list).
 *
 * Reader logic in `buildAppPreferenceReader()` must be updated in lockstep —
 * a key on this list with no reader returns `undefined` (safe failure).
 */
export const HOST_PUBLIC_PREFERENCE_KEYS = [
  "webView.preferredFlow",
] as const;

export type HostPublicPreferenceKey = (typeof HOST_PUBLIC_PREFERENCE_KEYS)[number];

function isHostPublicPreferenceKey(key: string): key is HostPublicPreferenceKey {
  return (HOST_PUBLIC_PREFERENCE_KEYS as readonly string[]).includes(key);
}

/**
 * §B3 — Build the reader closure used by every plugin's
 * `hostApi.getAppPreference`. Reads run live against `settingsService` so a
 * settings toggle is visible on the next call.
 *
 * Per-plugin warn dedupe: at most one warn line per (pluginId, key) per
 * runtime — prevents log floods when a plugin polls a denied key.
 */
/**
 * §B3 — Stable persistent partition for the in-app external-link viewer.
 *
 * Without `persist:`, every link window starts with empty cookies, so SSO
 * portals (outlook.office.com, calendar webLinks, etc.) re-prompt for login
 * on every open. A shared `persist:` partition lets the user log in once
 * per external service and keep the session across the app's lifetime.
 *
 * A SHARED partition (not per-plugin) is intentional: cookies are
 * origin-scoped by the browser, so two plugins both opening
 * outlook.office.com SHOULD see the same logged-in session — that's the
 * whole point. Per-plugin partitions would force re-login each time a
 * different plugin opened the same host. The viewer is sandboxed
 * (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`)
 * and cookies are never read back into plugin code, so a plugin cannot
 * exfiltrate another service's session through this partition.
 */
export const EXTERNAL_LINK_PARTITION = "persist:lvis-external-link";

/**
 * §B3 — Internal routing for `hostApi.openExternalUrl`. Extracted so it can
 * be unit-tested with stubbed services without standing up a full
 * initPluginRuntime context.
 *
 * Behavior:
 *  - Validates URL shape + scheme (http(s) only).
 *  - Reads `settings.webView.preferredFlow` LIVE on every call.
 *  - Audits with origin+path only (no full URL — query may carry secrets).
 *  - `"system-browser"` → `shellOpenExternal`.
 *  - anything else (default `"in-app"`) → light viewer with a stable
 *    persistent partition so SSO sessions survive between opens.
 */
export async function routeExternalUrl(input: {
  url: string;
  pluginId: string;
  settingsService: Pick<SettingsService, "get">;
  bootAuditLogger: { log: (entry: AuditEntry) => void };
  openLinkWindowService: (
    opts: { url: string; windowTitle?: string; persistPartition?: string },
  ) => Promise<void>;
  shellOpenExternal: (url: string) => Promise<void>;
}): Promise<void> {
  const { url, pluginId, settingsService, bootAuditLogger, openLinkWindowService, shellOpenExternal } = input;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`[plugin:${pluginId}] openExternalUrl: url must be a non-empty string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[plugin:${pluginId}] openExternalUrl: invalid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `[plugin:${pluginId}] openExternalUrl: only http(s) URLs are allowed (got ${parsed.protocol})`,
    );
  }
  const safeUrlForLog = `${parsed.origin}${parsed.pathname}`;
  const flow = settingsService.get("webView")?.preferredFlow ?? "in-app";

  try {
    bootAuditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "plugin",
      type: "tool_call",
      input: `[plugin:${pluginId}] openExternalUrl flow=${flow} url=${safeUrlForLog}`,
    });
  } catch { /* audit must not break host */ }

  if (flow === "system-browser") {
    await shellOpenExternal(url);
    return;
  }
  await openLinkWindowService({ url, persistPartition: EXTERNAL_LINK_PARTITION });
}

export function buildAppPreferenceReader(
  settingsService: SettingsService,
  warnLogger: { warn: (msg: string) => void },
): (pluginId: string, key: string) => unknown {
  const warnedPerPlugin = new Map<string, Set<string>>();
  const recordWarn = (pluginId: string, key: string) => {
    let set = warnedPerPlugin.get(pluginId);
    if (!set) {
      set = new Set();
      warnedPerPlugin.set(pluginId, set);
    }
    if (set.has(key)) return false;
    set.add(key);
    return true;
  };

  return (pluginId, key) => {
    if (typeof key !== "string" || key.length === 0) {
      if (recordWarn(pluginId, String(key))) {
        warnLogger.warn(
          `plugin:${pluginId} getAppPreference: invalid key`,
        );
      }
      return undefined;
    }
    if (!isHostPublicPreferenceKey(key)) {
      if (recordWarn(pluginId, key)) {
        warnLogger.warn(
          `plugin:${pluginId} getAppPreference: key not on host public allowlist key=${key}`,
        );
      }
      return undefined;
    }
    switch (key) {
      case "webView.preferredFlow":
        return settingsService.get("webView")?.preferredFlow;
      default: {
        // Exhaustiveness: if a key is added to HOST_PUBLIC_PREFERENCE_KEYS but
        // not wired here, fall through and warn so it's caught in tests.
        const _exhaustive: never = key;
        void _exhaustive;
        return undefined;
      }
    }
  };
}

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
 * burst of 3 — picked so the demo scenarios (one-meeting-mail, one-task-
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

export function formatPluginPendingPrompt(prompt: string, source: string): string {
  if (!isOverlayTriggerOrigin(source)) {
    throw new Error(`invalid overlay trigger source for pending prompt: ${source}`);
  }
  return `<imported-from-proactive source="${source}">\n${sanitizePluginPendingPrompt(prompt)}\n</imported-from-proactive>`;
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

const triggerConversationRateLimiter = new TriggerConversationRateLimiter();

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

const triggerDenyAuditThrottle = new TriggerDenyAuditThrottle();

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
  loopBound: boolean;
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
    loopBound,
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

  if (!capabilities.includes("host:overlay")) {
    auditDeny("reason=capability_denied");
    return {
      kind: "deny",
      result: { accepted: false, reason: "capability_denied", source: "" },
    };
  }
  // Order matters: env-fault (`loop_unavailable`) supersedes state
  // opinions (`duplicate`, `rate_limited`) so a plugin retrying during
  // boot ordering windows sees the actual cause.
  if (!loopBound) {
    auditDeny("reason=loop_unavailable");
    return {
      kind: "deny",
      result: { accepted: false, reason: "loop_unavailable", source },
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

const triggerConversationDedupe = new TriggerConversationDedupe();

/** Late-binding container the ConversationLoop fills in after it exists. */
export interface LateBindingRefs {
  llmCallerRef: {
    fn:
      | ((prompt: string, opts?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal }) => Promise<string>)
      | null;
  };
  pluginCallLlmRef: {
    fn:
      | ((
          pluginId: string,
          prompt: string,
          opts?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal },
        ) => Promise<string>)
      | null;
  };
  conversationLoopRef: {
    fn: import("../../engine/conversation-loop.js").ConversationLoop | null;
  };
  pluginToolInvokerRef: {
    fn:
      | ((
          toolName: string,
          payload: unknown,
          context: { origin: "plugin" | "ui"; callerPluginId?: string; ownerPluginId?: string },
        ) => Promise<unknown>)
      | null;
  };
  /**
   * Trigger executor ref — kept for future use; currently always null since
   * TriggerExecutor was removed. triggerConversation() returns loop_unavailable
   * when this is null.
   */
  triggerExecutorRef: {
    fn: null;
  };
}

export interface InitPluginRuntimeInput {
  projectRoot: string;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  keywordEngine: KeywordEngine;
  toolRegistry: ToolRegistry;
  pythonPath: string | undefined;
  pythonRuntime?: PythonRuntimeBootstrapper;
  bootAuditLogger: AuditLogger;
  mainWindow: BrowserWindow;
  getMainWindow?: () => BrowserWindow | null;
  openAuthWindowService: (
    parent: BrowserWindow,
    opts: OpenAuthWindowBaseOptions & { returnFinalUrl?: boolean },
  ) => Promise<AuthWindowCookie[] | OpenAuthWindowFinalUrlResult>;
  /**
   * §B3 — Light external-link viewer used when
   * `settings.webView.preferredFlow === "in-app"`. Distinct from
   * `openAuthWindowService` (no cookieHosts / completionUrlPatterns).
   * Tests inject a stub; production wiring is `openLinkWindow` from
   * `src/main/link-window-service.ts`.
   */
  openLinkWindowService: (
    parent: BrowserWindow,
    opts: { url: string; windowTitle?: string; persistPartition?: string },
  ) => Promise<void>;
  /**
   * Issue #649 — viewer that loads a URL inside the *caller plugin's*
   * `persist:plugin-auth:<pluginId>` partition so AAD/OIDC cookies deposited
   * by an earlier `openAuthWindow` produce silent SSO. Production wiring is
   * `openAuthPartitionViewer` from `src/main/auth-partition-viewer-service.ts`;
   * tests inject a stub.
   */
  openAuthPartitionViewerService: (
    parent: BrowserWindow,
    opts: import("../../main/auth-partition-viewer-service.js").OpenAuthPartitionViewerOptions,
  ) => Promise<void>;
  /**
   * SDK 5.6.0 — wipe-partition surface used by plugin `clearAuthPartition`
   * to delete cookies / storage / cache / HTTP-auth from one of the
   * plugin's own `persist:plugin-auth:<pluginId>[:<sub>]` partitions
   * after a user-triggered sign-out. Production wiring is
   * `clearAuthPartition` from `src/main/auth-window-service.ts`; tests
   * inject a stub.
   */
  clearAuthPartitionService: (partition: string) => Promise<void>;
  /**
   * §B3 — System browser opener used when
   * `settings.webView.preferredFlow === "system-browser"`. Production wiring
   * is `shell.openExternal` from electron; tests inject a spy.
   */
  shellOpenExternal: (url: string) => Promise<void>;
  /**
   * Cluster review M1 — optional PermissionManager reference. When provided,
   * the per-plugin `resolveApiKey` host implementation merges the manager's
   * `getPluginRevokeSignal` with the caller's request signal so a permission
   * rule change aborts outstanding bearers across plugins. Optional so unit
   * tests that build a minimal runtime can skip the wiring; production boot
   * (boot.ts) always passes the live instance.
   */
  permissionManager?: import("../../permissions/permission-manager.js").PermissionManager;
  /**
   * §8 — required ApprovalGate instance. The `agentApproval` namespace on
   * every plugin's HostApi is wired to this gate so main-process plugin
   * handlers can respond to pending approvals without going through the
   * renderer-only preload bridge. Required (not optional) so that boot
   * sequence inversion is impossible — if approvalGate is not yet built,
   * initPluginRuntime cannot be called.
   */
  approvalGate: import("../../permissions/approval-gate.js").ApprovalGate;
}

export interface InitPluginRuntimeOutput {
  pluginRuntime: PluginRuntime;
  deploymentGuard: PluginDeploymentGuard;
  lateBinding: LateBindingRefs;
  pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }>;
  runPluginShutdownHandlers: () => Promise<void>;
  /** SoT — shared with MarketplaceService + post-boot update detector. */
  pluginPaths: ReturnType<typeof resolvePluginPaths>;
}

/**
 * §4.2 Step 3-5 — construct PluginRuntime, register the per-plugin HostApi
 * factory, start all plugins, register plugin tools into ToolRegistry, and
 * wire the dev hot-reload watcher.
 */
export async function initPluginRuntime(
  input: InitPluginRuntimeInput,
): Promise<InitPluginRuntimeOutput> {
  const {
    projectRoot,
    settingsService,
    keywordEngine,
    toolRegistry,
    pythonPath,
    pythonRuntime,
    bootAuditLogger,
    mainWindow,
    getMainWindow,
    openAuthWindowService,
    openLinkWindowService,
    openAuthPartitionViewerService,
    clearAuthPartitionService,
    shellOpenExternal,
    approvalGate,
    permissionManager,
  } = input;

  // §B3 — host public preference reader, shared across all per-plugin HostApi
  // instances. Reads `settingsService` live so a Settings toggle is visible on
  // the next plugin call without reload.
  const readAppPreference = buildAppPreferenceReader(settingsService, log);

  // Plugin shutdown handler registry — fires on before-quit (see shared AuditLogger + hooks wiring).
  const pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }> = [];
  let pluginShutdownRan = false;
  let pluginShutdownPromise: Promise<void> | null = null;
  const runPluginShutdownHandlers = (): Promise<void> => {
    if (pluginShutdownRan) return pluginShutdownPromise ?? Promise.resolve();
    if (pluginShutdownHandlers.length === 0) return Promise.resolve();
    pluginShutdownRan = true;
    const SHUTDOWN_TIMEOUT_MS = 5000;
    pluginShutdownPromise = (async () => {
      await Promise.allSettled(
        pluginShutdownHandlers.map(async ({ pluginId, handler }) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.resolve().then(() => handler()),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`shutdown handler timeout [plugin:${pluginId}]`)), SHUTDOWN_TIMEOUT_MS);
              }),
            ]);
          } catch (err) {
            log.warn(`shutdown handler error [plugin:${pluginId}]: %s`, (err as Error).message);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      );
    })();
    return pluginShutdownPromise;
  };
  app.prependOnceListener("before-quit", (event) => {
    if (isAppUpdateInstallRequested()) return;
    if (pluginShutdownHandlers.length === 0 || pluginShutdownRan) return;
    event.preventDefault();
    void (async () => {
      await runPluginShutdownHandlers();
      app.quit();
    })();
  });

  // 범용 configOverrides + pythonExecutable 선언형 주입
  const configOverrides = buildPluginConfigOverrides(settingsService);
  if (pythonPath) {
    configOverrides["*"] = {
      ...(configOverrides["*"] ?? {}),
      pythonExecutable: pythonPath,
    };
  }

  // §7.2 Plugin Deployment Guard.
  // Plugin layout anchors at `lvisHome()/plugins/<id>/` — single root for both
  // user-installed and admin-injected plugins (distinguished by metadata,
  // not by physical directory). The resolver always uses
  // `lvisHome()/plugins`; E2E overrides LVIS_HOME once and every caller
  // follows the same app-home SOT.
  const pluginPaths = resolvePluginPaths();
  // mkdir the root once so the trust-root realpath check in PluginRuntime
  // (and any first-install write under pluginsRoot/<id>/) doesn't trip on a
  // missing directory the very first time the app boots.
  mkdirSync(pluginPaths.pluginsRoot, { recursive: true });
  const deploymentGuard = new PluginDeploymentGuard({
    registryPath: pluginPaths.registryPath,
    pluginsRoot: pluginPaths.pluginsRoot,
  });

  // #958/#959 security — registry-entry cache. The registry file
  // (`~/.lvis/plugins/registry.json`) is the host-verified source of
  // truth for both admin/user installSource and the install-time manifest
  // SHA pin. `plugin.json` lives inside the plugin's writable surface and
  // cannot be trusted alone. We populate this map at boot and refresh on
  // every install/uninstall event so HostApi closures answer lookups
  // synchronously without touching disk on the hot path.
  //
  // Trust source: caller code (getSecret / resolveApiKey) reads this map;
  // manifest-only admin metadata cannot activate secret-access bypass.
  const registryEntryCache = new Map<string, Pick<PluginRegistryEntry, "installSource" | "manifestSha256">>();
  const refreshRegistryEntryCache = async (): Promise<void> => {
    try {
      const registry = await readPluginRegistry(pluginPaths.registryPath);
      registryEntryCache.clear();
      for (const entry of registry.plugins) {
        if (entry.installSource !== undefined || entry.manifestSha256 !== undefined) {
          registryEntryCache.set(entry.id, {
            installSource: entry.installSource,
            manifestSha256: entry.manifestSha256,
          });
        }
      }
    } catch (err) {
      registryEntryCache.clear();
      // Cache stays empty. Secret-access bypass stays fail-closed
      // because callers treat a missing registry installSource as "user".
      log.warn(
        "registry-entry cache refresh failed: %s",
        (err as Error).message,
      );
    }
  };
  await refreshRegistryEntryCache();
  const getRegistryEntry = (
    pluginId: string,
  ): Pick<PluginRegistryEntry, "installSource" | "manifestSha256"> | undefined => registryEntryCache.get(pluginId);

  // Late-binding refs for ConversationLoop-dependent callers.
  const lateBinding: LateBindingRefs = {
    llmCallerRef: { fn: null },
    pluginCallLlmRef: { fn: null },
    conversationLoopRef: { fn: null },
    pluginToolInvokerRef: { fn: null },
    triggerExecutorRef: { fn: null },
  };

  // §Step 4 — wire `app.isPackaged` into the dev-flag gate before any
  // helper or downstream module reads it. Packaged builds with LVIS_DEV* set
  // get a single audit warning, never a per-flag enumeration.
  setIsPackaged(app.isPackaged);
  if (shouldWarnPackagedFlagsIgnored()) {
    // Snapshot was captured at `dev-flags.ts` import time, BEFORE
    // `main.ts:67-73` scrubbed the vars from `process.env`. Listing the
    // specific names lets operators distinguish a stale launcher
    // (`LVIS_PLUGINS_DIR`) from an active dev tamper (`LVIS_DEV=1`).
    const names = tamperedVarsAtBoot();
    log.error(`LVIS_DEV* ignored in packaged build: ${names.join(", ")}`);
  }

  // Plugin-owned OAuth removed host-owned provider auth APIs. The related
  // capability is advisory metadata only; there is no host-side auth gate.
  let pluginRuntime!: PluginRuntime;

  const installLoadedPluginPartitionPolicy = (pluginId: string): void => {
    installPluginPartitionPolicy(pluginPartitionName(pluginId), {
      pluginRoot: pluginRuntime.getPluginRoot(pluginId),
    });
  };

  // §Step 1 + §Step 2 — thread the user-installed dir as a second
  // trust root and the unsigned-user-plugin opt-in flag.
  pluginRuntime = new PluginRuntime({
    hostRoot: projectRoot,
    pluginsRoot: pluginPaths.pluginsRoot,
    registryPath: pluginPaths.registryPath,
    configOverrides,
    deploymentGuard,
    installReceiptCacheRoot: pluginPaths.cacheRoot,
    auditLog: (level, message, data) => {
      try {
        bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "plugin-runtime",
          type: level === "error" ? "error" : "tool_call",
          input: `[${level.toUpperCase()}] ${message}`,
          output: data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
        });
      } catch {}
    },
    preparePluginStart: ({ pluginId, manifest, manifestPath, reportProgress }) => {
      if (!pythonRuntime || !declaresHostManagedPythonRuntime(manifest)) return undefined;
      const win = getMainWindow?.() ?? mainWindow;
      return (async () => {
        reportProgress?.({
          phase: "pending",
          message: t("be_pluginRuntime.pluginRuntimePreparationStarting"),
          progressPct: 5,
        });
        const runtime = await pythonRuntime.ensureReadyForPluginManifest(manifestPath, win, (status) => {
          reportProgress?.({
            phase: status.phase,
            message: status.msg,
            progressPct: status.pct,
          });
        });
        if (!runtime) {
          throw new Error(`plugin '${pluginId}' declares host-managed Python but no accessible lockfile was found`);
        }
        reportProgress?.({
          phase: "ready",
          message: t("be_pluginRuntime.pluginRuntimeReady"),
          progressPct: 100,
        });
        pluginRuntime.mergeConfigOverride(pluginId, { pythonExecutable: runtime.pythonPath });
        log.info("plugin dependency runtime ready: %s -> %s", pluginId, runtime.pythonPath);
      })();
    },
    onDisable: (pluginId) => {
      keywordEngine.unregisterByPlugin(pluginId);
      toolRegistry.unregisterByPlugin(pluginId);
      lateBinding.conversationLoopRef.fn?.onPluginDisabled(pluginId);
    },
    onActiveStateChange: (pluginId, enabled) => {
      if (!enabled) {
        keywordEngine.unregisterByPlugin(pluginId);
        lateBinding.conversationLoopRef.fn?.onPluginDisabled(pluginId);
        return;
      }
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      if (!keywordEngine.hasPluginKeywords(pluginId) && manifest?.keywords && manifest.keywords.length > 0) {
        keywordEngine.registerKeywords(manifest.keywords.map((k) => ({ ...k, pluginId })));
        log.debug(`plugin:${pluginId} re-registered ${manifest.keywords.length} keywords on activation`);
      }
    },
    // Symmetric to `onDisable` — re-registers tools after a successful
    // restart/add/reload. Without this every chat-surface tool call hits
    // `도구를 찾을 수 없습니다` post-restart (see PR #760). Non-fatal:
    // a sync exception is logged but does not become `runtime reload failed`.
    onEnable: (pluginId) => {
      // `restartAll()` is also the managed-marketplace first-sync path:
      // ensureManagedInstalled() writes the registry, then restartAll() loads
      // the new plugin without emitting plugin.installed. Register the
      // partition preload here so freshly managed plugin UIs get
      // window.lvisPlugin immediately instead of only after app restart.
      installLoadedPluginPartitionPolicy(pluginId);
      try {
        syncPluginToolRegistryForPlugin(pluginRuntime, toolRegistry, pluginId);
      } catch (err) {
        log.error(
          `tool registry sync failed after plugin onEnable (${pluginId}): %s`,
          (err as Error).message,
        );
      }
      // Runtime restart/reload can reach loaded+started after a prior teardown.
      // registerKeywords usually runs through hostApi during start(); keep this
      // guarded manifest replay as the lifecycle safety net without duplicating
      // entries or reviving user-inactive plugins.
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      if (
        pluginRuntime.isPluginEnabled(pluginId) &&
        !keywordEngine.hasPluginKeywords(pluginId) &&
        manifest?.keywords &&
        manifest.keywords.length > 0
      ) {
        keywordEngine.registerKeywords(manifest.keywords.map((k) => ({ ...k, pluginId })));
        log.debug(`plugin:${pluginId} re-registered ${manifest.keywords.length} keywords on enable`);
      }
    },
    createHostApi: (pluginId: string, manifest: PluginManifest, pluginDataDir: string): PluginHostApi => {
      // #893 Stage 2 — manifest sha256 pin (Tier-3 whitelist check). The
      // whitelist registry stores `approvedManifestSha256` per pluginId; we
      // compare against the canonicalized JSON of the running manifest so a
      // post-install manifest swap (different tools / wider hostSecrets.read)
      // forces a fresh whitelist roll.
      //
      // Ralph cycle 1 fix — previously this used the REPLACER-ARRAY form of
      // `JSON.stringify(manifest, Object.keys(manifest).sort())` which only
      // filters top-level keys and emits every nested object as `{}`. As a
      // result every plugin's manifest hashed to (nearly) the same sha and
      // the Tier-3 pin was defeated. Switching to a recursive canonical
      // JSON serializer (RFC 8785 JCS-style — sort keys at every depth,
      // preserve array element order) restores the pin.
      const canonical = canonicalJSON(manifest);
      const manifestSha256 = createHash("sha256").update(canonical).digest("hex");
      return ({
      storage: createPluginStorage(pluginId, pluginDataDir, (msg, meta) => {
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "warn",
            input: `[plugin:${pluginId}] storage_${msg.replace(/\s+/g, "_")} ${typeof meta === "object" ? JSON.stringify(meta) : ""}`.trim(),
          });
        } catch { /* audit must not break host */ }
      }),
      // §9.2 Track B — typed plugin config access, scoped to this pluginId.
      // `get` reads the live merged config (manifest defaults + saved
      //   overrides) directly from settingsService so a write from another
      //   surface (renderer, IPC, sibling plugin) is visible without reload.
      // `set` persists via the same `setPluginConfig` IPC bridge used by the
      //   settings UI and triggers a plugin reload so the plugin's `config`
      //   snapshot in `PluginRuntimeContext.config` is rebuilt with the new
      //   value. `format: "secret"` keys are rejected here — secrets MUST go
      //   through `hostApi.setSecret` so they land encrypted, never in
      //   cleartext `pluginConfigs`.
      // `onChange` listeners are registered against the plugin's own id only;
      //   the underlying bus rejects cross-plugin observation.
      config: {
        get: <T = unknown>(key: string): T | undefined => {
          // PR #894 B2 follow-up — merge wildcard slot (`hostApiVendor` etc.)
          // BETWEEN manifest defaults and plugin-specific overrides so a
          // plugin's own config can shadow a host-injected value (rare, but
          // useful for test fixtures and explicit per-plugin overrides),
          // while shipping a sensible default for plugins that don't set it.
          const merged = {
            ...(manifest.config ?? {}),
            ...(pluginRuntime.getWildcardConfigOverride?.() ?? {}),
            ...(settingsService.getPluginConfig(pluginId) ?? {}),
          };
          return merged[key] as T | undefined;
        },
        set: async <T = unknown>(key: string, value: T): Promise<void> => {
          const schemaProp = manifest.configSchema?.properties?.[key];
          if (schemaProp?.type === "string" && schemaProp.format === "secret") {
            throw new Error(
              `[plugin:${pluginId}] config.set('${key}'): secret fields must be saved via hostApi.setSecret(), not config.set().`,
            );
          }
          const current = settingsService.getPluginConfig(pluginId) ?? {};
          // structuredClone so we never accidentally hand the plugin our
          // internal record reference.
          const nextRecord = structuredClone({
            ...current,
            [key]: value as unknown,
          });
          await settingsService.setPluginConfig(pluginId, nextRecord);
          // Mirror the IPC handler — refresh the runtime's per-plugin
          // override so the next reload picks up the new value, then emit
          // the change so existing listeners observe it without waiting
          // for the reload.
          pluginRuntime.setConfigOverride(pluginId, nextRecord);
          emitPluginConfigChange(pluginId, key, value);
          // US-A3 — targeted restartPlugin (not restartAll) so changing one
          // plugin's config does not wipe other plugins' in-memory state.
          // ToolRegistry resync happens automatically via the runtime's
          // wired `onEnable` callback.
          try {
            await pluginRuntime.restartPlugin(pluginId);
          } catch (err) {
            throw new Error(
              `[plugin:${pluginId}] config.set('${key}'): runtime reload failed: ${(err as Error).message}`,
            );
          }
        },
        onChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
        ): (() => void) => {
          const unsubscribe = subscribePluginConfigChange(
            pluginId,
            key,
            (_changedKey, value) => {
              callback(value as T | undefined);
            },
          );
          // Auto-cleanup on plugin disable to mirror onEvent semantics.
          pluginRuntime.registerDisposer(pluginId, unsubscribe);
          return unsubscribe;
        },
      },
      registerKeywords: (keywords) => {
        // #1176 M3: inactive plugins must not register keywords at start() time.
        // onActiveStateChange(true) re-registers them if the plugin is later
        // activated without a runtime restart.
        if (!pluginRuntime.isPluginEnabled(pluginId)) {
          log.debug(`plugin:${pluginId} skipping keyword registration — plugin inactive`);
          return;
        }
        keywordEngine.registerKeywords(
          keywords.map((k) => ({ ...k, pluginId })),
        );
        log.info(`plugin:${pluginId} registered ${keywords.length} keywords`);
      },
      emitEvent: (type, data) => {
        plog("debug", { pluginId, phase: PluginPhase.CAPABILITY_CHECK, eventType: type }, "checking emit capability");
        const manifest = pluginRuntime?.getPluginManifest(pluginId);
        const manifestCapabilities = manifest?.capabilities ?? [];
        if (!canEmitEvent(type, manifestCapabilities)) {
          const requiredCap = requiredCapabilityForEmit(type);
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] plugin_emit_capability_denied eventType=${type} required=${requiredCap} actual=${manifestCapabilities.join("|")}`,
            });
          } catch { /* audit must not break host */ }
          plog("warn", { pluginId, phase: PluginPhase.CAPABILITY_DENY, capability: requiredCap ?? type, eventType: type, reason: "missing_capability" }, "capability denied");
          return;
        }
        pluginRuntime.assertPluginEventEmitAccess(pluginId, type);
        plog("debug", { pluginId, phase: PluginPhase.EVENT_EMIT, eventType: type }, "event emitted");
        emitEvent(type, { ...((data as Record<string, unknown>) ?? {}), pluginId });
      },
      onEvent: (type, handler) => {
        pluginRuntime.assertPluginEventAccess(pluginId, type);
        const unsubscribe = onEvent(type, handler);
        pluginRuntime.registerDisposer(pluginId, unsubscribe);
        plog("debug", { pluginId, phase: PluginPhase.EVENT_LISTEN, eventType: type }, "event listener registered");
        return unsubscribe;
      },
      getInstalledPluginIds: () => {
        return pluginRuntime.listPluginIds().filter((id) => id !== pluginId);
      },
      onPluginsChanged: (handler) => {
        const dispatchInstalled = (data: unknown) => {
          const payload = data as { pluginId?: string; source?: "marketplace" | "local-dev" } | null | undefined;
          const subjectId = payload?.pluginId;
          if (typeof subjectId !== "string" || subjectId === pluginId) return;
          const source = payload?.source === "local-dev" ? "local-dev" : "marketplace";
          handler({ type: "installed", pluginId: subjectId, source });
        };
        const dispatchUninstalled = (data: unknown) => {
          const subjectId = (data as { pluginId?: string } | null | undefined)?.pluginId;
          if (typeof subjectId !== "string" || subjectId === pluginId) return;
          handler({ type: "uninstalled", pluginId: subjectId });
        };
        const unsubInstalled = onEvent("plugin.installed", dispatchInstalled);
        const unsubUninstalled = onEvent("plugin.uninstalled", dispatchUninstalled);
        const unsubscribe = () => { unsubInstalled(); unsubUninstalled(); };
        pluginRuntime.registerDisposer(pluginId, unsubscribe);
        return unsubscribe;
      },
      // #893 Stage 2 — Host implementation of the SDK's `resolveApiKey`.
      // Returns the SDK `ResolveApiKeyResult` discriminated union (bearer +
      // release on success; typed reason on failure). Plugins read the
      // key via `result.bearer()` and SHOULD call `result.release()` in a
      // `finally` so the captured string has a deterministic lifetime.
      // All four tiers are evaluated in-line inside `resolveApiKeyImpl`;
      // the call here is a thin closure capture of pluginId + manifest +
      // manifestSha256 + the shared audit/settings services.
      resolveApiKey: async (opts) => {
        return resolveApiKeyImpl(
          {
            purpose: opts.purpose as ResolveApiKeyPurpose,
            vendor: opts.vendor as ResolveApiKeyVendor | undefined,
            signal: opts.signal,
          },
          {
            pluginId,
            manifest,
            manifestSha256,
            settingsService,
            auditLogger: bootAuditLogger,
            // #958/#959 — feed the registry-anchored installSource and
            // install-time manifest SHA so admin bypasses skip only the
            // host-secret ACL, never the manifest tamper check.
            ...((): {
              registryInstallSource?: "admin" | "user" | "local-dev";
              registryManifestSha256?: string;
            } => {
              const entry = getRegistryEntry(pluginId);
              return {
                ...(entry?.installSource !== undefined ? { registryInstallSource: entry.installSource } : {}),
                ...(entry?.manifestSha256 !== undefined ? { registryManifestSha256: entry.manifestSha256 } : {}),
              };
            })(),
            // Cluster review M1 — bind the permission-manager revoke signal
            // accessor so an in-flight bearer aborts when permissions
            // change for this plugin. When permissionManager is not wired
            // (test runtimes) the host-api falls back to caller-signal-only.
            ...(permissionManager
              ? {
                  getPluginRevokeSignal: (id: string) =>
                    permissionManager.getPluginRevokeSignal(id),
                }
              : {}),
          },
        );
      },
      getSecret: (key) => {
        // #893 Stage 2 — Four-tier secret access gate:
        //   (1) Plugin's own `plugin.<pluginId>.*` namespace — always allowed.
        //       ADDITIVE WHITELIST: this tier intentionally never consults the
        //       whitelist registry so non-whitelisted plugins still get to hold
        //       their own keys under their own namespace.
        //   (2) Host secret declared in `manifest.hostSecrets.read[]` — must
        //       match the static manifest allowlist. Manifest-only check.
        //   (3) Whitelist registry — `whitelistRegistry.isAllowed(pluginId,
        //       key, manifestSha256)`. Tier-3 was added in Stage 2 of the
        //       #893 redesign so a remote-signed policy roll can pull a
        //       grant without shipping a host build. Manifest sha pin
        //       prevents post-install manifest swaps from inheriting the
        //       grant.
        //   (4) Active-vendor cross-check — `settings.llm.provider` must
        //       equal the vendor in the requested `llm.apiKey.<vendor>` key.
        //       Stops a plugin from harvesting idle credentials for a
        //       non-active provider.
        //
        // PR #894 review B7 — `keyPrefix` is folded through `sanitizeKeyPrefix`
        // before it reaches the in-process counter map. An attacker plugin
        // could otherwise call `hostApi.getSecret("<random-prefix>.x")` in a
        // loop and grow the counter map unboundedly via the `denied` branch
        // (one entry per attacker-controlled prefix). Folding unknown
        // prefixes to the bucket `"other"` caps the cardinality.
        //
        // Audit log lines additionally cap `key` to 64 chars so an attacker
        // can't bloat the JSONL with megabyte-long denied keys.
        const auditKey = key.slice(0, 64);
        // Tier 1 — own namespace.
        if (key.startsWith(`plugin.${pluginId}.`)) {
          const value = settingsService.getSecret(key);
          if (shouldBlockPluginSecretRead({ pluginId, storageKey: key, value })) {
            try {
              bootAuditLogger.log({
                timestamp: new Date().toISOString(),
                sessionId: "plugin",
                type: "warn",
                input: `[plugin:${pluginId}] pluginSecret_denied reason=endpoint-url-in-api-key-like-secret key=${auditKey}`,
              });
            } catch { /* audit must not break host */ }
            return null;
          }
          return value;
        }
        const allowlist = manifest.hostSecrets?.read ?? [];
        const keyPrefix = sanitizeKeyPrefix(key);
        // Tier 2 — manifest allowlist.
        if (allowlist.includes(key)) {
          // Tier 3 + Tier 4 — shared helper (`runTier3Then4`) keeps the
          // order identical with `resolveApiKey`: whitelist registry
          // (coarse signed ACL) before vendor cross-check (per-call
          // dynamic state). Ralph cycle 1 MEDIUM fix.
          //
          // Tier-4 only applies to `llm.apiKey.*` keys; non-`llm.apiKey.*`
          // allowlist entries (if any future host-secret class is added)
          // are passed `activeProvider === vendor` so the cross-check is a
          // no-op for them.
          const llmKeyPrefix = "llm.apiKey.";
          const isLlmKey = key.startsWith(llmKeyPrefix);
          const vendor = isLlmKey ? key.slice(llmKeyPrefix.length) : "";
          const activeProvider = isLlmKey
            ? (settingsService.get("llm").provider as string)
            : vendor;
          // #958/#959 security — registry-recorded `installSource` is the
          // only source that can activate admin secret-access bypass.
          // The registry file is host-managed; `plugin.json` is inside
          // the plugin's writable surface so a malicious post-install
          // patch could flip `installPolicy:"admin"` and inherit Tier-3
          // bypass if manifest-only metadata were trusted here.
          const registryEntry = getRegistryEntry(pluginId);
          const registryInstallSource = registryEntry?.installSource;
          const effectiveInstallPolicy: "admin" | "user" =
            registryInstallSource === "admin" ? "admin" : "user";
          const outcome = runTier3Then4({
            pluginId,
            key,
            manifestSha256,
            installedManifestSha256: registryEntry?.manifestSha256,
            vendor,
            activeProvider,
            // #955/#959 — admin-installed plugins bypass only the Tier-3
            // signed whitelist registry ACL. The registry manifest SHA and
            // Tier-4 vendor cross-check still apply via the same helper.
            installPolicy: effectiveInstallPolicy,
          });
          if (outcome.kind === "deny") {
            const auditReason =
              outcome.tier === "tier-4" ? "non-active-vendor" : outcome.reason;
            try {
              bootAuditLogger.log({
                timestamp: new Date().toISOString(),
                sessionId: "plugin",
                type: "warn",
                input: `[plugin:${pluginId}] hostSecret_denied reason=${auditReason} key=${auditKey}`,
              });
            } catch { /* audit must not break host */ }
            incrementHostSecretCounter("hostSecret_denied", pluginId, keyPrefix);
            return null;
          }
          // #958 round-1 security MEDIUM — admin-bypass audit + counter.
          // Emit BEFORE the host-secret read line so operators can pivot
          // on `policy=admin manifest-allowlist-bypassed` in the audit log. The
          // dedicated `hostSecret_admin_bypass` counter is on top of the
          // regular `hostSecret_read` increment below so totals stay
          // comparable across bypass and non-bypass reads.
          if (outcome.via === "admin-bypass") {
            try {
              bootAuditLogger.log({
                timestamp: new Date().toISOString(),
                sessionId: "plugin",
                type: "info",
                input: `[plugin:${pluginId}] policy=admin manifest-allowlist-bypassed key=${auditKey} source=registry.installSource`,
              });
            } catch { /* audit must not break host */ }
            incrementHostSecretCounter(
              "hostSecret_admin_bypass",
              pluginId,
              keyPrefix,
            );
          }
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "info",
              input: `[plugin:${pluginId}] hostSecret_read key=${auditKey}`,
            });
          } catch { /* audit must not break host */ }
          incrementHostSecretCounter("hostSecret_read", pluginId, keyPrefix);
          return settingsService.getSecret(key);
        }
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "warn",
            input: `[plugin:${pluginId}] hostSecret_denied reason=not-allowlisted key=${auditKey}`,
          });
        } catch { /* audit must not break host */ }
        incrementHostSecretCounter("hostSecret_denied", pluginId, keyPrefix);
        return null;
      },
      callTool: async <T = unknown>(toolName: string, payload?: unknown): Promise<T> => {
        pluginRuntime.assertPluginToolAccess(pluginId, toolName);
        const invoker = lateBinding.pluginToolInvokerRef.fn;
        if (!invoker) {
          throw new Error("Plugin tool executor is not wired; plugin callTool denied");
        }
        // Issue #664 P2 — propagate the effective origin chain into the
        // inner invocation. When this HostApi.callTool is reached from a
        // wrapper handler that itself runs inside a UI-rooted chain, the
        // ambient AsyncLocalStorage frame already holds "ui" and the inner
        // invoker reads it through `currentInvocationOrigin()`. We pass
        // `parentOrigin` explicitly so a wrapper that calls into a fresh
        // async frame (queueMicrotask, setTimeout boundary) still inherits.
        const parentOrigin = currentInvocationOrigin();
        return invoker(toolName, payload, {
          origin: "plugin",
          callerPluginId: pluginId,
          ownerPluginId: pluginRuntime.resolveToolOwner(toolName),
          ...(parentOrigin ? { parentOrigin } : {}),
        }) as Promise<T>;
      },
      callLlm: async (prompt, opts) => {
        if (lateBinding.pluginCallLlmRef.fn) {
          return lateBinding.pluginCallLlmRef.fn(pluginId, prompt, opts);
        }
        if (!lateBinding.llmCallerRef.fn) throw new Error("LLM provider not ready");
        return lateBinding.llmCallerRef.fn(prompt, opts);
      },
      logEvent: (level, message, data) => {
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: level === "error" ? "error" : "tool_call",
            input: `[plugin:${pluginId}] [${level.toUpperCase()}] ${message}`,
            output: data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
          });
        } catch (err) {
          log.warn(`logEvent failed: %s`, (err as Error).message);
        }
      },
      onShutdown: (handler) => {
        pluginShutdownHandlers.push({ pluginId, handler });
      },
      // ─── §B3 외부 URL viewer + host public preference read ────────────
      // openExternalUrl: Settings → webView.preferredFlow 토글에 따라
      //   "in-app"  → light BrowserWindow (link-window-service)
      //   "system-browser" → shell.openExternal
      // 매 호출마다 settingsService 에서 다시 읽어 live update 반영.
      //
      // getAppPreference: HOST_PUBLIC_PREFERENCE_KEYS allowlist 만 read 허용.
      //   거부된 key 는 throw 하지 않고 undefined 반환 + 1회/key/session warn.
      openExternalUrl: async (url: string): Promise<void> => {
        await routeExternalUrl({
          url,
          pluginId,
          settingsService,
          bootAuditLogger,
          openLinkWindowService: (opts) => openLinkWindowService(mainWindow, opts),
          shellOpenExternal,
        });
      },
      getAppPreference: <T = unknown>(key: string): T | undefined => {
        return readAppPreference(pluginId, key) as T | undefined;
      },
      // ─── 외부 포털 interactive 인증 (쿠키 수집) ───────────────────
      // `external-auth-consumer` capability 로 게이팅 — 쿠키는 민감 자산이므로
      // 선언적 opt-in 없이는 호출 거부. 거부/허용 모두 AuditLogger 에 남긴다.
      //
      // 로그에는 origin + path 만 기록 — SAML/OAuth URL 에 담기는 민감 query
      // (SAMLRequest, code, state, session id 등) 은 유출 방지 위해 제외.
      openAuthWindow: (async (opts: OpenAuthWindowBaseOptions & { returnFinalUrl?: boolean }) => {
        const safeUrlForLog = (() => {
          try {
            const parsed = new URL(opts.url);
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return "[invalid-url]";
          }
        })();
        const cookieHostCount = Array.isArray(opts.cookieHosts) ? opts.cookieHosts.length : 0;

        if (!manifest.capabilities?.includes("external-auth-consumer")) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_window_capability_denied url=${safeUrlForLog} missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }

        log.info(
          `plugin:${pluginId} openAuthWindow url=${safeUrlForLog} cookieHostCount=${cookieHostCount}`,
        );
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input:
              `[plugin:${pluginId}] openAuthWindow ` +
              `url=${safeUrlForLog} cookieHostCount=${cookieHostCount}`,
          });
        } catch { /* audit must not break host */ }

        // 기본값은 plugin 별 비영속 partition. Electron 의 default session 을
        // 쓰면 (a) 여러 BrowserWindow 간 쿠키가 공유되어 타 플러그인이
        // 수집한 세션을 그대로 볼 수 있고 (b) 디스크에 영속화된다. 둘 다
        // openAuthWindow 의 "호스트는 세션을 보관하지 않는다" 원칙 위반.
        //
        // 플러그인이 명시적으로 지정한 persistPartition 은 반드시 자기
        // 네임스페이스(`persist:plugin-auth:<pluginId>` 또는 그 하위 `:<sub>`)
        // 여야 한다. 그렇지 않으면 plugin A 가 `plugin-auth:pluginB` 를 지정해
        // plugin B 의 쿠키를 읽어가는 cross-plugin exfiltration 경로가 열린다.
        const encodedId = encodeURIComponent(pluginId);
        const defaultPartition = `plugin-auth:${encodedId}`;
        const allowedPersistBase = `persist:${defaultPartition}`;
        const requested = opts.persistPartition;
        if (
          requested !== undefined &&
          requested !== allowedPersistBase &&
          !requested.startsWith(`${allowedPersistBase}:`)
        ) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input:
                `[plugin:${pluginId}] open_auth_window_invalid_partition ` +
                `persistPartition=${requested} allowed=${allowedPersistBase}[:<sub>]`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] openAuthWindow: persistPartition must be '${allowedPersistBase}' or '${allowedPersistBase}:<sub>'`,
          );
        }
        const effectiveOpts = requested
          ? opts
          : { ...opts, persistPartition: defaultPartition };
        return openAuthWindowService(ElectronBrowserWindow.getFocusedWindow() ?? mainWindow, effectiveOpts);
      }) as PluginHostApi["openAuthWindow"],

      // ─── Issue #649 — Auth-partition viewer ───────────────────────────
      // Opens a hardened BrowserWindow inside the *caller plugin's*
      // `persist:plugin-auth:<pluginId>` partition so a re-load of an
      // SSO-protected URL (e.g. Outlook calendar after ms-graph login)
      // does not force the user through AAD again. Same `external-auth-
      // consumer` capability gate as openAuthWindow — both surfaces grant
      // access to the plugin's auth partition cookie jar.
      //
      // The partition is computed from `pluginId` of *this* HostApi
      // instance (one HostApi per plugin per `PluginRuntime.start` call)
      // — cross-plugin cookie reuse must route through a `callTool` to a
      // tool owned by the partition-owning plugin so its handler gets
      // its own HostApi (and hence its own partition).
      openAuthPartitionViewer: async (opts: { url: string; windowTitle?: string }) => {
        const safeUrlForLog = (() => {
          try {
            const parsed = new URL(opts.url);
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return "[invalid-url]";
          }
        })();
        if (!manifest.capabilities?.includes("external-auth-consumer")) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_partition_viewer_capability_denied url=${safeUrlForLog} missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }
        const declared = manifest.auth?.partitionDomains ?? [];
        let allowedHosts: string[];
        try {
          allowedHosts = normalizeAllowedHosts(declared);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_partition_viewer_manifest_invalid reason=${reason}`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] openAuthPartitionViewer: manifest.auth.partitionDomains invalid (${reason})`,
          );
        }
        if (allowedHosts.length === 0) {
          throw new Error(
            `[plugin:${pluginId}] openAuthPartitionViewer: manifest.auth.partitionDomains must be a non-empty list`,
          );
        }
        return openAuthPartitionViewerService(
          ElectronBrowserWindow.getFocusedWindow() ?? mainWindow,
          {
            pluginId,
            url: opts.url,
            allowedHosts,
            windowTitle: opts.windowTitle,
            parent: ElectronBrowserWindow.getFocusedWindow() ?? mainWindow,
            audit: (event) => {
              try {
                bootAuditLogger.log({
                  timestamp: event.timestamp,
                  sessionId: "plugin",
                  type: event.type === "open_auth_partition_viewer" ? "tool_call" : "error",
                  input:
                    `[plugin:${event.pluginId}] ${event.type} ` +
                    `url=${event.url}` +
                    (event.deniedHost ? ` deniedHost=${event.deniedHost}` : "") +
                    ` allowedHosts=${event.allowedHosts.join(",")}`,
                });
              } catch { /* audit must not break host */ }
            },
          },
        );
      },

      // ─── SDK 5.6.0 — clearAuthPartition ──────────────────────────────
      // Wipe cookies / storage / cache / HTTP-auth from one of the calling
      // plugin's own `persist:plugin-auth:<pluginId>[:<sub>]` partitions.
      // Used after a user-triggered plugin sign-out so a subsequent
      // `openAuthWindow` cannot silently SSO via residual IdP cookies.
      // Capability + partition allow-list mirror `openAuthWindow`.
      clearAuthPartition: async (partition: string): Promise<void> => {
        if (!manifest.capabilities?.includes("external-auth-consumer")) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] clear_auth_partition_capability_denied missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }
        if (typeof partition !== "string" || partition.length === 0) {
          throw new Error(
            `[plugin:${pluginId}] clearAuthPartition: partition must be a non-empty string`,
          );
        }
        const encodedId = encodeURIComponent(pluginId);
        const allowedPersistBase = `persist:plugin-auth:${encodedId}`;
        if (
          partition !== allowedPersistBase &&
          !partition.startsWith(`${allowedPersistBase}:`)
        ) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input:
                `[plugin:${pluginId}] clear_auth_partition_invalid_partition ` +
                `partition=${partition} allowed=${allowedPersistBase}[:<sub>]`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] clearAuthPartition: partition must be '${allowedPersistBase}' or '${allowedPersistBase}:<sub>'`,
          );
        }
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input: `[plugin:${pluginId}] clearAuthPartition partition=${partition}`,
          });
        } catch { /* audit must not break host */ }
        await clearAuthPartitionService(partition);
      },

      // ─── §8 Agent Approval — hostApi.agentApproval ────────────────────
      // Exposes the main-process ApprovalGate to plugins so they can request
      // and resolve pending approval entries from handler code (NOT from the
      // renderer-only preload bridge). approvalGate is REQUIRED at construction
      // time — there is no noop fallback. A missing gate would mean the boot
      // order is wrong, which is a programming error to surface loudly.
      //
      // §8 P0 security (issue #71):
      //   request(): verifies scope against the approved install grant, then records
      //              (requestId → pluginId + scope) in registry.
      //   respond(): verifies (a) requestId was issued by THIS plugin
      //              (b) scope is still in the approved install grant.
      //   Violations throw ApprovalOriginError (no silent fallback, §No-Fallback).
      agentApproval: {
        request: async (input: {
          toolName: string;
          args: unknown;
          reason: string;
          scope: string;
        }): Promise<ApprovalChoice> => {
          const approvedAccess = pluginRuntime.getApprovedPluginAccess(pluginId);
          const allowedScopes: string[] =
            Array.isArray(approvedAccess?.agentApprovalScopes)
              ? approvedAccess.agentApprovalScopes
              : [];
          try {
            verifyApprovalRequestScope(pluginId, input.scope, allowedScopes);
          } catch (err) {
            auditApprovalViolation(err, bootAuditLogger, pluginId, `request:${input.scope}`);
          }
          const { requestAgentApproval } = await import(
            "../../permissions/agent-action-requester.js"
          );
          return requestAgentApproval(
            approvalGate,
            {
              toolName: input.toolName,
              args: input.args,
              reason: input.reason,
              source: "plugin",
              sourcePluginId: pluginId,
              scope: input.scope,
            },
            approvalIssuerRegistry,
          );
        },

        respond: async (
          requestId: string,
          choice: ApprovalChoice,
          nonce?: string,
          hmac?: string,
        ): Promise<void> => {
          const approvedAccess = pluginRuntime.getApprovedPluginAccess(pluginId);
          const allowedScopes: string[] =
            Array.isArray(approvedAccess?.agentApprovalScopes)
              ? approvedAccess.agentApprovalScopes
              : [];
          try {
            verifyApprovalResponder(
              approvalIssuerRegistry,
              requestId,
              pluginId,
              allowedScopes,
            );
          } catch (err) {
            auditApprovalViolation(err, bootAuditLogger, pluginId, requestId);
          }
          approvalGate.resolve(requestId, { requestId, choice, nonce, hmac });
        },
      },

      // ─── Overlay runner — hostApi.triggerConversation() ────────────────
      // Overlay runner: gate body lives in evaluateTriggerSpec() so prod
      // and tests share one implementation. On allow, the host holds the spec
      // in OverlayContext staging via IPC (fresh ConversationLoop is NOT
      // started). The user's confirm action inserts the prompt as a user
      // message into main chat via the imported_trigger mechanism.
      //
      triggerConversation: async (spec: ConversationTriggerSpec) => {
        const decision = evaluateTriggerSpec({
          spec,
          pluginId,
          capabilities: manifest.capabilities ?? [],
          dedupe: triggerConversationDedupe,
          rateLimiter: triggerConversationRateLimiter,
          denyAuditThrottle: triggerDenyAuditThrottle,
          // Overlay runner does not need a ConversationLoop — always bound.
          loopBound: true,
          auditLogger: bootAuditLogger,
        });

        if (decision.kind === "deny") {
          return decision.result;
        }

        // Allow path — push to renderer OverlayContext via IPC instead of
        // spawning a fresh ConversationLoop.
        const eventId = randomUUID();
        const overlayId = `plugin:${pluginId}:${eventId}`;
        const derivedSummary = deriveOverlaySummaryForDisplay(spec);
        const overlayItem = {
          id: overlayId,
          source: { kind: "plugin" as const, pluginId, eventId },
          title: spec.title ?? spec.source.replace(/^overlay:/, ""),
          summary: derivedSummary,
          running: false,
          primaryActionLabel: spec.primaryActionLabel ?? t("be_pluginRuntime.overlayPrimaryActionLabel"),
          pendingPrompt: formatPluginPendingPrompt(spec.prompt, decision.source),
          createdAt: new Date().toISOString(),
        };
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(OVERLAY_V1.show, overlayItem);
        }

        return { accepted: true, source: decision.source, eventId };
      },
    });
    },
  });

  // AC1.2 — periodic purge of stale ApprovalIssuerRegistry entries.
  // ApprovalGate's per-request timeout (default 5 min) resolves deny-once but
  // doesn't reach back into this registry; if the respond path is never hit
  // (renderer crash, plugin crash) the issuer entry would leak. We sweep on
  // a 1-minute cadence, dropping anything older than the gate timeout. The
  // interval is cleared on `before-quit` to avoid keeping the process alive
  // during shutdown.
  const APPROVAL_REGISTRY_PURGE_MAX_AGE_MS = 5 * 60 * 1000;
  const APPROVAL_REGISTRY_PURGE_INTERVAL_MS = 60 * 1000;
  const approvalRegistryPurgeTimer = setInterval(() => {
    try {
      const purged = approvalIssuerRegistry.purgeStalerThan(
        APPROVAL_REGISTRY_PURGE_MAX_AGE_MS,
      );
      if (purged > 0) {
        log.info("approval issuer registry purged %d stale entries", purged);
      }
    } catch (err) {
      log.warn("approval registry purge failed: %s", (err as Error).message);
    }
  }, APPROVAL_REGISTRY_PURGE_INTERVAL_MS);
  // Don't keep the event loop alive solely for this housekeeping timer.
  approvalRegistryPurgeTimer.unref?.();
  app.prependOnceListener("before-quit", () => {
    clearInterval(approvalRegistryPurgeTimer);
  });

  await pluginRuntime.startAll();
  log.info("boot: plugins loaded: %s", pluginRuntime.listToolNames());

  // Pre-register the per-partition `setPreloads(...)` policy for every
  // loaded plugin (#498). Electron's `<webview partition="persist:plugin:..."
  // preload="...">` honors `preload=` only when sandbox=no; with sandbox=yes
  // the preload script must be registered on the partition's Session via
  // `session.setPreloads()`. The previous attach-time hook in main.ts
  // tries to read `contents.session.partition` to decide which partition
  // got attached, but that property is undocumented and returns
  // `undefined` on current Electron — so the hook never fires `setPreloads`
  // and plugin webviews load without the `lvisPlugin` contextBridge,
  // surfacing as "lvisPlugin bridge missing" in the shell. Pre-registering
  // by walking the loaded-plugin set sidesteps the partition-name read
  // entirely.
  for (const pluginId of pluginRuntime.listPluginIds()) {
    installLoadedPluginPartitionPolicy(pluginId);
  }
  // Cover plugins added AFTER startAll() — deep-link install
  // (`lvis://install/<slug>` → `addPlugin`), dev hot-reload watcher
  // (LVIS_DEV_RELOAD=1), Settings sideload. The boot loop above only sees
  // `startAll`-era plugins; the attach-time hook in main.ts is dead code
  // for these (it reads `contents.session.partition` which is undocumented
  // and returns `undefined`), so the partition policy must be installed at
  // plugin-install time.
  // Install events: partition policy is per-install (Electron `session`s are
  // created lazily and pinned per pluginId), so it stays here. ToolRegistry
  // resync runs through the runtime's `onEnable` hook wired above —
  // `addPlugin` / `restartPlugin` already fire it before this event lands.
  onHostEvent("plugin.installed", (data) => {
    const pluginId = (data as { pluginId?: string } | undefined)?.pluginId;
    if (typeof pluginId !== "string") return;
    installLoadedPluginPartitionPolicy(pluginId);
    // #958/#959 — keep installSource + manifest SHA pin in sync so a freshly
    // installed admin plugin gets both decisions on first call.
    void refreshRegistryEntryCache();
  });

  // Uninstall: `onDisable` only unregisters the removed plugin's tools, but a
  // full resync also sweeps any ghost entries (e.g. a stale registry row from
  // a previous load generation). `onEnable` covers add/restart/reload; it
  // does NOT fire on uninstall, so the listener-driven sync is still load-bearing.
  onHostEvent("plugin.uninstalled", (data) => {
    const pluginId = (data as { pluginId?: string } | undefined)?.pluginId;
    if (typeof pluginId !== "string") return;
    try {
      syncPluginToolRegistry(pluginRuntime, toolRegistry);
    } catch (err) {
      log.error(
        `tool registry sync failed after plugin.uninstalled (${pluginId}): %s`,
        (err as Error).message,
      );
    }
    // #958/#959 — drop the stale cache entry so a re-install does not inherit
    // the previous Tier-3 bypass or manifest SHA decision.
    void refreshRegistryEntryCache();
  });

  // 플러그인 메서드를 ToolRegistry에 등록. Async dependency preparation may
  // finish between startAll() and this point, so use idempotent sync instead
  // of duplicate-sensitive append registration.
  syncPluginToolRegistry(pluginRuntime, toolRegistry);

  // I2 — Dev-mode live-reload watcher. No-op unless LVIS_DEV_RELOAD=1.
  // ToolRegistry resync runs through the runtime's `onEnable` callback wired
  // above — `reloadPlugin` fires it on success — so the watcher only
  // surfaces the hot-reload log line here.
  const pluginDevWatcher = startPluginDevWatcher({
    pluginRuntime,
    onReloaded: (pluginId) => {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      if (!manifest) return;
      log.info(`plugin:${pluginId} hot-reloaded (${manifest.tools.length} tools)`);
    },
  });
  app.prependOnceListener("before-quit", () => { pluginDevWatcher.stop(); });

  return {
    pluginRuntime,
    deploymentGuard,
    lateBinding,
    pluginShutdownHandlers,
    runPluginShutdownHandlers,
    pluginPaths,
  };
}

// Re-export so boot.ts's return statement can still reach BrowserWindow type.
export type { BrowserWindow };
