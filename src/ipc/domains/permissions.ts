/**
 * Permissions domain IPC handlers.
 * Covers: lvis:permission:*, lvis:approval:*, lvis:policy:*
 */
import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { loadPolicy, savePolicy } from "../../permissions/policy-store.js";
import type { ApprovalDecision } from "../../permissions/approval-gate.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import type {
  PermissionReviewSuggestionPayload,
  PermissionReviewSuggestionReason,
} from "../../shared/permissions-events.js";
import { hasUserKeyboardIntent } from "../../shared/chat-origin.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { sendToWindow } from "../safe-send.js";
import type { IpcDeps } from "../types.js";
import type {
  PermissionDirCommand,
  PermissionModeCommand,
  PermissionReviewerCommand,
  PermissionRulesCommand,
} from "../../permissions/permission-slash.js";
import {
  REVIEWER_PROVIDERS_SET,
  type ReviewerProvider,
} from "../../permissions/permission-settings-store.js";
import {
  recordApproval,
  revokeApprovalByKey,
  listApprovals,
  canonicalStringify,
} from "../../permissions/user-approval-store.js";

function validateRulePatternInput(pattern: unknown): { ok: true; pattern: string } | { ok: false; error: string; message: string } {
  if (typeof pattern !== "string") {
    return { ok: false, error: "invalid-pattern", message: "pattern must be a string" };
  }
  const normalized = pattern.trim();
  if (normalized.length === 0) {
    return { ok: false, error: "invalid-pattern", message: "pattern must be non-empty" };
  }
  if (normalized.length > 128) {
    return { ok: false, error: "invalid-pattern", message: "pattern must not exceed 128 characters" };
  }
  if (/\s/.test(normalized)) {
    return { ok: false, error: "invalid-pattern", message: "pattern must not contain whitespace" };
  }
  return { ok: true, pattern: normalized };
}

function requireUserKeyboardIntent(payload: unknown): { ok: true } | { ok: false; error: string; message: string } {
  if (hasUserKeyboardIntent(payload)) return { ok: true };
  return {
    ok: false,
    error: "user-keyboard-required",
    message: "permission change requires active user gesture (keyboard intent)",
  };
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isParseError<T>(value: T | { ok: false; error: string }): value is { ok: false; error: string } {
  return "ok" in (value as Record<string, unknown>) && (value as { ok?: unknown }).ok === false;
}

function broadcastPermissionModeChanged(deps: IpcDeps, mode: string): void {
  const mainWindow = deps.getMainWindow?.();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const win of windows) {
    sendToWindow(win, PERMISSIONS.modeChanged, { mode });
  }
}

const REVIEW_SUGGESTION_WINDOW_MS = 5 * 60 * 1000;
const REVIEW_SUGGESTION_REPEAT_THRESHOLD = 3;
const REVIEW_SUGGESTION_COOLDOWN_MS = 30 * 60 * 1000;

interface ApprovalAllowSample {
  at: number;
  choice: ApprovalDecision["choice"];
}

function broadcastPermissionReviewSuggestion(
  deps: IpcDeps,
  payload: PermissionReviewSuggestionPayload,
): void {
  const mainWindow = deps.getMainWindow?.();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const win of windows) {
    sendToWindow(win, PERMISSIONS.reviewSuggestion, payload);
  }
}

function createPermissionReviewSuggestionTracker() {
  let samples: ApprovalAllowSample[] = [];
  let lastSuggestedAt = 0;

  return {
    record(
      deps: IpcDeps,
      decision: ApprovalDecision,
      snapshot: { toolName: string } | null | undefined,
    ): void {
      if (!decision.choice.startsWith("allow")) return;
      if (snapshot?.toolName === "/permission mode") return;

      const pm = deps.conversationLoop.permissionManager;
      if (!pm) return;
      if (pm.getMode() !== "default") return;
      if (pm.getInteractiveAutoApprove() !== "off" && pm.hasReviewer()) return;

      const now = Date.now();
      samples = samples
        .filter((sample) => now - sample.at <= REVIEW_SUGGESTION_WINDOW_MS)
        .concat({ at: now, choice: decision.choice });

      if (now - lastSuggestedAt < REVIEW_SUGGESTION_COOLDOWN_MS) return;

      const allowAlwaysCount = samples.filter((sample) => sample.choice === "allow-always").length;
      const reason: PermissionReviewSuggestionReason | null =
        decision.choice === "allow-always" || allowAlwaysCount > 0
          ? "allow-always"
          : samples.length >= REVIEW_SUGGESTION_REPEAT_THRESHOLD
            ? "repeat-allow"
            : null;
      if (reason === null) return;

      lastSuggestedAt = now;
      deps.auditLogger?.log?.({
        timestamp: new Date().toISOString(),
        sessionId: "permissions",
        type: "approval",
        output:
          `[permission-review:suggest] reason=${reason} allowCount=${samples.length} ` +
          `allowAlwaysCount=${allowAlwaysCount} windowMs=${REVIEW_SUGGESTION_WINDOW_MS}`,
      });
      broadcastPermissionReviewSuggestion(deps, {
        reason,
        allowCount: samples.length,
        allowAlwaysCount,
        threshold: REVIEW_SUGGESTION_REPEAT_THRESHOLD,
        windowMs: REVIEW_SUGGESTION_WINDOW_MS,
      });
    },
  };
}

/**
 * Notify all renderers that the allowed-directories config mutated
 * (session-add via slash dispatch / PermissionsTab dirDispatch / etc.).
 * Multi-window subscribers (PermissionsTab) refresh their views without
 * manual reload. Sent as a hint event — listeners pull fresh state via
 * the existing `permission.dirDispatch("list")` rather than receiving
 * the full list in the broadcast payload (avoids serialization size
 * and keeps a single source of truth in the slash dispatcher).
 */
export function broadcastPermissionConfigChanged(deps: IpcDeps): void {
  const mainWindow = deps.getMainWindow?.();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const win of windows) {
    sendToWindow(win, PERMISSIONS.configChanged, {});
  }
}

export function registerPermissionsHandlers(deps: IpcDeps): void {
  const { conversationLoop, approvalGate, auditLogger } = deps;
  const deferredResolveInFlight = new Set<string>();
  const reviewSuggestionTracker = createPermissionReviewSuggestionTracker();

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.getMode, () => {
    const mode = conversationLoop.permissionManager?.getMode() ?? "default";
    return { mode };
  });

  // read-only, sender guard optional — honest OS sandbox capability for the
  // current platform. `available`/`kind` report the PLATFORM's potential
  // (macOS/Linux can confine, Windows/others cannot), NOT whether a runner is
  // currently registered — registration is boot-time + opt-in, so reporting
  // the platform potential lets the toggle show "not available on this
  // platform" rather than reading as unavailable merely because it's off.
  // `enabled` separately reflects the current setting.
  ipcMain.handle(PERMISSIONS.sandboxCapability, async () => {
    const { sandboxConfinementForPlatform } = await import(
      "../../shared/sandbox-capability-info.js"
    );
    const platform = process.platform;
    const enabled =
      (deps.settingsService.get("features")?.osToolSandbox ?? false) ||
      process.env["LVIS_SANDBOX_ENABLED"] === "1";
    // Map the platform to the simplified confinement strength. Both macOS
    // (Seatbelt via ASRT) and Linux (bwrap via ASRT) confine fs + process +
    // network ("full"); Windows + others are fail-closed ("none"). The gate
    // (enabled) only controls whether the ASRT sandbox initializes at boot, not
    // what the platform is capable of, so report the platform's potential even
    // when off — the toggle text stays honest before the user opts in.
    const kind: "full" | "partial" | "none" =
      platform === "linux" || platform === "darwin" ? "full" : "none";
    const available = kind !== "none";
    return {
      platform,
      enabled,
      available,
      kind,
      reason: "",
      confines: sandboxConfinementForPlatform(platform, kind),
    };
  });

  ipcMain.handle(PERMISSIONS.setMode, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.setMode, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const mode = body.mode;
    if (typeof mode !== "string") {
      return { ok: false, error: "invalid-mode", message: "mode must be a string" };
    }
    const { parsePermissionModeCommand } = await import("../../permissions/permission-slash.js");
    const parsed = parsePermissionModeCommand(`${mode} --durable`);
    if (isParseError<PermissionModeCommand>(parsed)) {
      return { ok: false, error: "invalid-mode", message: parsed.error };
    }
    if (parsed.durable !== true) {
      return { ok: false, error: "missing-durable-confirm", message: "durable mode command must require modal confirmation" };
    }
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "permission manager not initialized" };
    const { applyPermissionModeCommand } = await import("../../permissions/permission-mode-apply.js");
    const result = await applyPermissionModeCommand(parsed, {
      permissionManager: pm,
      approvalGate,
      auditLogger,
      approvalBypass: {
        source: "settings-ui",
        trustOrigin: "user-keyboard",
        explicitUserAction: true,
      },
    });
    if (!result.ok) return result;
    broadcastPermissionModeChanged(deps, result.mode);
    return { ok: true, mode: result.mode };
  });

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.listRules, async () => {
    const pm = conversationLoop.permissionManager;
    if (!pm) return [];
    return pm.listPersistedRules();
  });

  ipcMain.handle(PERMISSIONS.addRule, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.addRule, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const action = body.action;
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `invalid action: '${action}' (allowed: allow, deny)` };
    }
    const validated = validateRulePatternInput(body.pattern);
    if (!validated.ok) return validated;
    const { parsePermissionRulesCommand } = await import("../../permissions/permission-slash.js");
    const parsed = parsePermissionRulesCommand(`add ${action} ${validated.pattern}`);
    if (isParseError<PermissionRulesCommand>(parsed)) return { ok: false, error: "parse-error", message: parsed.error };
    if (parsed.sub !== "add") return { ok: false, error: "parse-error", message: "add rule command did not parse as add" };
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "permission manager not initialized" };
    try {
      if (parsed.action === "allow") {
        await pm.addAlwaysAllowedPersist(parsed.pattern);
      } else {
        await pm.addAlwaysDeniedPersist(parsed.pattern);
      }
      deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
      // No explicit broadcast — PermissionManager.addAlwaysAllowed/DeniedPersist
      // fire broadcastConfigChanged via the boot-wired setter (round-4 SOT).
      return { ok: true, rule: { pattern: parsed.pattern, action: parsed.action } };
    } catch (err) {
      return { ok: false, error: "add-failed", message: (err as Error).message };
    }
  });

  ipcMain.handle(PERMISSIONS.removeRule, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.removeRule, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const action = body.action;
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `invalid action: '${action}' (allowed: allow, deny)` };
    }
    const validated = validateRulePatternInput(body.pattern);
    if (!validated.ok) return validated;
    const { parsePermissionRulesCommand } = await import("../../permissions/permission-slash.js");
    const parsed = parsePermissionRulesCommand(`remove ${action} ${validated.pattern}`);
    if (isParseError<PermissionRulesCommand>(parsed)) return { ok: false, error: "parse-error", message: parsed.error };
    if (parsed.sub !== "remove") return { ok: false, error: "parse-error", message: "remove rule command did not parse as remove" };
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "permission manager not initialized" };
    try {
      await pm.removeRule(parsed.pattern, parsed.action);
      deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
      // No explicit broadcast — PermissionManager.removeRule fires
      // broadcastConfigChanged via the boot-wired setter (round-4 SOT).
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "remove-failed", message: (err as Error).message };
    }
  });

  // lvis:approval:request direction is main→renderer (webContents.send) — no ipcMain.handle needed
  ipcMain.handle(PERMISSIONS.approvalRespond, (e, decision: ApprovalDecision) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.approvalRespond, e); return UNAUTHORIZED_FRAME; }
    const snapshot = approvalGate?.getRequestSnapshot?.(decision.requestId);
    let honoredDecision: ApprovalDecision | null = null;
    if (approvalGate) {
      honoredDecision = approvalGate.resolve(decision.requestId, decision);
    }
    if (honoredDecision) {
      reviewSuggestionTracker.record(deps, honoredDecision, snapshot);
    }
    return { ok: true };
  });

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.policyGet, async () => {
    return loadPolicy();
  });

  // ── Permission policy — `/permission dir` slash dispatcher (IPC) ──────────
  ipcMain.handle(
    PERMISSIONS.dirDispatch,
    async (e, args: { rawArgs: string }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.dirDispatch, e);
        return UNAUTHORIZED_FRAME;
      }
      const { parsePermissionDirCommand, dispatchPermissionDirCommand } =
        await import("../../permissions/permission-slash.js");
      const parsed = parsePermissionDirCommand(args?.rawArgs ?? "");
      if (isParseError<PermissionDirCommand>(parsed)) return { ok: false, error: parsed.error };
      if (parsed.verb !== "list") {
        const intent = requireUserKeyboardIntent((args as { intent?: unknown } | undefined)?.intent);
        if (!intent.ok) return intent;
      }
      const result = await dispatchPermissionDirCommand(parsed);
      if (result.ok && result.verb === "allow" && result.sessionOnly && result.sessionDirectory) {
        conversationLoop.addSessionAdditionalDirectory(result.sessionDirectory);
      }
      // Notify all renderer windows whenever the directory config mutates
      // (any successful allow/deny that touches persisted or session
      // additions). The `verb === "list"` short-circuit avoids spurious
      // broadcasts from read-only list queries.
      if (result.ok && result.verb !== "list") {
        broadcastPermissionConfigChanged(deps);
      }
      return result;
    },
  );

  // ── Permission policy — `/permission reviewer` slash dispatcher (IPC) ─────
  ipcMain.handle(
    PERMISSIONS.reviewerDispatch,
    async (e, args: { rawArgs: string }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.reviewerDispatch, e);
        return UNAUTHORIZED_FRAME;
      }
      const { parsePermissionReviewerCommand, dispatchPermissionReviewerCommandWithRewire } =
        await import("../../permissions/permission-slash.js");
      const parsed = parsePermissionReviewerCommand(args?.rawArgs ?? "");
      if (isParseError<PermissionReviewerCommand>(parsed)) return { ok: false, error: parsed.error };
      if (parsed.verb !== "show") {
        const intent = requireUserKeyboardIntent((args as { intent?: unknown } | undefined)?.intent);
        if (!intent.ok) return intent;
      }
      const result = await dispatchPermissionReviewerCommandWithRewire(
        parsed,
        deps.rewireReviewerAgent,
      );
      // Surface the runtime degrade flag (persisted mode="llm" but wiring fell
      // back to rule because no provider/key is configured). This is a runtime
      // condition computed at boot wiring, not a persisted setting, so it is
      // read from the live PermissionManager rather than the settings file.
      if (result.ok) {
        const pm = conversationLoop.permissionManager;
        return {
          ...result,
          reviewerDegradedToRule: pm?.isReviewerDegradedToRule() ?? false,
        };
      }
      return result;
    },
  );

  // ── Reviewer provider key-presence check ─────────────────────────────────
  // Used by the renderer settings UI to determine which reviewer providers
  // are activatable (key-driven dynamic activation). Read-only, but gated
  // to prevent a foreign frame from probing which LLM API keys are present.
  //
  // MAJOR-4: returns UNAUTHORIZED_FRAME (sibling handler parity) instead of
  // bare `false` on validateSender failure. Bare `false` is indistinguishable
  // from "key not present", masking the security rejection from the caller.
  //
  // MEDIUM: input allowlist — only the five known reviewer provider strings
  // are accepted; anything else short-circuits before touching the secret store.
  // Minor: REVIEWER_PROVIDERS_SET imported from permission-settings-store (single SOT).
  ipcMain.handle(PERMISSIONS.reviewerProviderHasKey, async (e, provider: unknown) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, PERMISSIONS.reviewerProviderHasKey, e);
      return UNAUTHORIZED_FRAME;
    }
    // MEDIUM: reject unknown provider names before touching the secret store.
    if (typeof provider !== "string" || !REVIEWER_PROVIDERS_SET.has(provider as ReviewerProvider)) {
      return false;
    }
    const { reviewerProviderKeyPresent } = await import(
      "../../permissions/reviewer/provider-adapters.js"
    );
    return reviewerProviderKeyPresent(
      provider,
      (key) => deps.settingsService.getSecret(key),
      // Foundry endpoint lives in the plain settings (not encrypted).
      // Minor-2: vendors may be undefined — use optional chain to avoid TypeError.
      () => deps.settingsService.get("llm").vendors?.["azure-foundry"]?.baseUrl ?? null,
    );
  });

  // ── Permission policy — deferred queue surface ────────────────────────────
  // Returns DLP-redacted tool inputs + verdicts; gated to prevent a
  // compromised foreign frame from harvesting them (Copilot round 3).
  ipcMain.handle(PERMISSIONS.deferredList, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, PERMISSIONS.deferredList, e);
      return UNAUTHORIZED_FRAME;
    }
    const pm = conversationLoop.permissionManager;
    const queue = pm?.getDeferredQueue();
    if (!queue) return { ok: true, pending: [], total: 0 };
    return { ok: true, pending: queue.listPending(), total: queue.size() };
  });

  ipcMain.handle(PERMISSIONS.hookTrustList, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, PERMISSIONS.hookTrustList, e);
      return UNAUTHORIZED_FRAME;
    }
    const { listHookTrustState } = await import(
      "../../hooks/hook-trust-commands.js"
    );
    const state = listHookTrustState();
    return {
      ok: true,
      active: state.active,
      disabled: state.disabled,
      totalDisabled: state.disabled.length,
    };
  });

  // Resolve a pending entry — gated. The renderer's button click
  // dispatches with `decision` ∈ {"approved","rejected"}.
  ipcMain.handle(
    PERMISSIONS.deferredResolve,
    async (
      e,
      params: {
        id: string;
        decision: "approved" | "rejected";
        reason?: string;
        intent?: unknown;
        /**
         * Issue #690 P4 — provenance of the approval gesture. "button"
         * means the user clicked a panel button (existing path);
         * "natural-language" means the renderer's intent matcher
         * recognised an in-chat phrase AND the user explicitly
         * confirmed via the suggestion chip. Required: callers must
         * explicitly declare provenance for audit-chain entries.
         */
        approvalSource: "button" | "natural-language";
      },
    ) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.deferredResolve, e);
        return UNAUTHORIZED_FRAME;
      }
      const intent = requireUserKeyboardIntent(params?.intent);
      if (!intent.ok) return intent;
      if (
        !params ||
        typeof params.id !== "string" ||
        (params.decision !== "approved" && params.decision !== "rejected") ||
        (
          params.reason !== undefined &&
          (typeof params.reason !== "string" || params.reason.length > 1_000)
        ) ||
        (params.approvalSource !== "button" && params.approvalSource !== "natural-language")
      ) {
        return { ok: false, error: "invalid-params" };
      }
      const approvalSource = params.approvalSource;
      const pm = conversationLoop.permissionManager;
      const queue = pm?.getDeferredQueue();
      if (!queue) return { ok: false, error: "no-deferred-queue" };
      if (deferredResolveInFlight.has(params.id)) {
        return { ok: false, error: "already-resolving" };
      }
      deferredResolveInFlight.add(params.id);
      try {
        const current = queue.get(params.id);
        if (!current) return { ok: false, error: "not-found" };
        if (current.status !== "pending") {
          if (current.status === params.decision) return { ok: true, entry: current };
          return { ok: false, error: "already-resolved", entry: current };
        }
        if (!auditLogger.isPermissionAuditChainReady()) {
          return { ok: false, error: "permission-audit-not-ready" };
        }
        const auditReason =
          approvalSource === "natural-language"
            ? "natural-language chip click"
            : params.reason;
        try {
          await auditLogger.appendPermissionAuditEntry({
            decision: "deferred_resolve",
            auditId: randomUUID(),
            ts: new Date().toISOString(),
            trustOrigin: "user-keyboard",
            tool: current.toolName,
            source: current.source,
            category: current.category,
            reviewerVerdict: current.verdict,
            queueId: current.id,
            resolution: params.decision,
            approvalSource,
            ...(auditReason ? { reason: auditReason } : {}),
          });
        } catch (err) {
          return {
            ok: false,
            error: "permission-audit-write-failed",
            message: (err as Error).message,
          };
        }
        const resolved = await queue.resolve(params.id, params.decision, auditReason);
        if (!resolved) return { ok: false, error: "not-found" };
        if (resolved.status !== params.decision) {
          return { ok: false, error: "already-resolved", entry: resolved };
        }
        return { ok: true, entry: resolved };
      } finally {
        deferredResolveInFlight.delete(params.id);
      }
    },
  );

  // ── Permission policy — `/permission audit show|verify` IPC handlers ─────
  // Audit entries can contain DLP-redacted tool inputs and decision
  // metadata; gated so foreign frames cannot harvest them (Copilot
  // round 3).
  ipcMain.handle(
    PERMISSIONS.auditShow,
    async (e, args: { last?: number }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.auditShow, e);
        return UNAUTHORIZED_FRAME;
      }
      const last = Math.max(1, Math.min(1000, Math.floor(args?.last ?? 50)));
      const { readRecentAuditEntries, summarizeAuditDir } = await import(
        "../../permissions/permission-audit-runner.js"
      );
      const dir = auditLogger.getAuditDir();
      const entries = readRecentAuditEntries(dir, last);
      const summary = summarizeAuditDir(dir);
      return { ok: true, entries, total: entries.length, summary };
    },
  );

  ipcMain.handle(PERMISSIONS.auditVerify, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, PERMISSIONS.auditVerify, e);
      return UNAUTHORIZED_FRAME;
    }
    const { verifyAllAuditFiles } = await import(
      "../../permissions/permission-audit-runner.js"
    );
    const secret = auditLogger.getPermissionAuditSecret();
    if (!secret) {
      return {
        ok: false,
        error: "audit-chain-not-initialized",
      };
    }
    const sealStore = auditLogger.getPermissionAuditSealStore() ?? undefined;
    const dir = auditLogger.getAuditDir();
    const result = verifyAllAuditFiles(dir, secret, sealStore);
    return {
      ok: true,
      intact: result.intact,
      totalFiles: result.totalFiles,
      totalEntries: result.totalEntries,
      firstBrokenFile: result.firstBrokenFile,
      perDay: result.perDay.map((d) => ({
        file: d.file,
        totalLines: d.totalLines,
        chainOk: d.result.ok,
        firstBrokenLineIndex: d.result.ok ? undefined : d.result.firstBrokenLineIndex,
        reason: d.result.ok ? undefined : d.result.reason,
        sealMatch: d.sealMatch,
      })),
    };
  });

  ipcMain.handle(PERMISSIONS.policySet, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.policySet, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const patch = payloadRecord(body.patch);
    if ("managed" in patch) {
      return { ok: false, error: "invalid-patch", message: "'managed' field is read-only and cannot be modified by user" };
    }
    if ("requireExplicitApproval" in patch && typeof patch.requireExplicitApproval !== "boolean") {
      return { ok: false, error: "invalid-patch", message: "'requireExplicitApproval' must be a boolean" };
    }
    try {
      const updated = await savePolicy(patch as Parameters<typeof savePolicy>[0]);
      if (approvalGate) {
        approvalGate.setPolicy(updated);
      }
      return { ok: true, policy: updated };
    } catch (err) {
      return { ok: false, error: "managed", message: (err as Error).message };
    }
  });

  // ── User-Approval Store handlers ──────────────────────────

  ipcMain.handle(PERMISSIONS.userApprovalRecord, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.userApprovalRecord, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    // Issue #798: parity with peer mutating handlers (addRule, removeRule,
    // setMode, dirDispatch, reviewerDispatch, deferredResolve, policySet).
    // Gates on user-keyboard freshness so a synthetic record submission
    // from a compromised renderer cannot record without an active gesture.
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const scope = body.scope;
    const verdictAtApproval = body.verdictAtApproval;
    const nlJustification = body.nlJustification;
    const args = body.args;
    // Issue #799 — server-side ApprovalRequest binding.
    //
    // Pre-fix this handler trusted the renderer to faithfully echo back
    // `body.toolName`, `body.source`, `body.trustOrigin`, and
    // `body.approvalCacheKey`. A renderer XSS could swap any of these and
    // make the recorded entry a memory hit for a different
    // (toolName, source, trustOrigin, approvalCacheKey) tuple than the
    // one the main process emitted — defeating cache identity isolation.
    //
    // Fix: the renderer now sends `requestId` (the original
    // ApprovalRequest.id). The handler reads the canonical
    // toolName/source/trustOrigin/approvalCacheKey from the in-flight
    // ApprovalGate entry via `getRequestSnapshot()`. The renderer can no
    // longer spoof identity fields — it can only contribute the parts
    // that are semantically the user's decision (scope, verdict at
    // approval, NL justification) and the args/intent freshness gates.
    const requestId = body.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return { ok: false, error: "invalid-request-id", message: "user-approval record: requestId required (server-side ApprovalRequest binding)" };
    }
    if (
      typeof args !== "string" ||
      (scope !== "session" && scope !== "persistent") ||
      (verdictAtApproval !== "low" && verdictAtApproval !== "medium" && verdictAtApproval !== "high")
    ) {
      return { ok: false, error: "invalid-payload", message: "user-approval record: invalid payload" };
    }
    // HIGH verdict enforcement: HIGH approvals must use session scope and
    // include a non-empty NL justification. Enforced here in the IPC handler
    // (renderer-side XSS bypass protection) in addition to dialog-level guards.
    if (verdictAtApproval === "high") {
      if (scope !== "session") {
        return { ok: false, error: "high-requires-session-scope", message: "HIGH verdict approvals must use session scope" };
      }
      if (typeof nlJustification !== "string" || nlJustification.trim().length === 0) {
        return { ok: false, error: "high-requires-justification", message: "HIGH verdict approvals require non-empty NL justification" };
      }
    }
    // Server-side SOT lookup. If the approval already resolved/timed out
    // or never existed, reject — we never silently create an orphan entry
    // that the renderer can later use to fish for memory hits.
    const snapshot = approvalGate?.getRequestSnapshot(requestId) ?? null;
    if (!snapshot) {
      return { ok: false, error: "no-such-request", message: "user-approval record: no in-flight ApprovalRequest for requestId" };
    }
    try {
      // Canonicalize at IPC handler to catch any non-renderer
      // callers that bypass the renderer-side canonicalization. Non-JSON or
      // non-object args are explicitly rejected (CLAUDE.md No Fallback Code).
      let canonicalArgs: string;
      try {
        const parsed = JSON.parse(args);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, error: "args-not-object", message: "user-approval record: args must be a JSON object" };
        }
        canonicalArgs = canonicalStringify(parsed);
      } catch {
        return { ok: false, error: "args-not-json", message: "user-approval record: args must be valid JSON" };
      }
      // Authority fields come from the main-process snapshot, never the
      // renderer body. The renderer contribution is reduced to
      // (scope, verdictAtApproval, nlJustification, args).
      await recordApproval(snapshot.toolName, canonicalArgs, snapshot.source, {
        scope,
        verdictAtApproval,
        nlJustification: typeof nlJustification === "string" ? nlJustification : null,
        trustOrigin: snapshot.trustOrigin,
        approvalCacheKey: snapshot.approvalCacheKey,
      });
      // User-approval store mutation — outside PermissionManager, so
      // emit the broadcast explicitly to keep the Active Approvals view
      // in multi-window PermissionsTab fresh.
      broadcastPermissionConfigChanged(deps);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "managed", message: (err as Error).message };
    }
  });

  ipcMain.handle(PERMISSIONS.userApprovalRevoke, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.userApprovalRevoke, e); return UNAUTHORIZED_FRAME; }
    // Issue #798: revoke is destructive (forces re-approval). Gate on
    // user-keyboard intent for parity with peer mutating handlers.
    //
    // Payload contract: object `{ key, intent }`. The preload bridge
    // auto-injects `intent`; untrusted callers that submit a raw string
    // key will fail the `payloadRecord` narrow and return `invalid-key`.
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const key = body.key;
    if (typeof key !== "string" || key.trim().length === 0) {
      return { ok: false, error: "invalid-key", message: "revoke: key must be a non-empty string" };
    }
    try {
      await revokeApprovalByKey(key.trim());
      // Destructive — emit broadcast so the Active Approvals table refreshes
      // in any concurrently open PermissionsTab.
      broadcastPermissionConfigChanged(deps);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "managed", message: (err as Error).message };
    }
  });

  ipcMain.handle(PERMISSIONS.userApprovalList, async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.userApprovalList, e); return UNAUTHORIZED_FRAME; }
    try {
      return await listApprovals();
    } catch {
      return [];
    }
  });
}
