/**
 * SOT IPC error → Korean i18n mapper (issue #830).
 *
 * Renderer-side counterpart to the "IPC layer = English, UI layer = Korean"
 * convention (CLAUDE.md "IPC Error Message Language Convention"). All
 * renderer callers that receive an IPC `{ok:false, error, message}`
 * envelope should pipe it through this helper instead of writing per-
 * callsite formatters that drift and miss new codes.
 *
 * Design:
 * - `COMMON_IPC_ERROR_MESSAGES` carries default Korean mappings for codes
 *   shared across multiple IPC domains (intent gate, payload validation,
 *   permission manager state).
 * - Per-context overrides ride on the `codeMap` option (e.g. revoke
 *   uses "유효하지 않은 승인 키" but generic `invalid-key` callers get
 *   "유효하지 않은 키").
 * - Dynamic code patterns (e.g. `reviewer-rewire-failed:<detail>`) are
 *   handled by the caller *before* invoking this helper.
 */

import { t } from "../../i18n/runtime.js";

export const COMMON_IPC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // ── Trust / intent gate (PR #826 cross-cutting code group) ──
  "user-keyboard-required": "formatIpcError.userKeyboardRequired",
  "unauthorized": "formatIpcError.unauthorized",
  // "unauthorized-frame" lives below in the frame-trust gate section with a
  // more actionable Korean message ("창을 새로고침하거나..."). Single key.
  "missing-input-origin": "formatIpcError.missingInputOrigin",
  "cross-plugin-call-denied": "formatIpcError.crossPluginCallDenied",
  "missing-plugin-envelope": "formatIpcError.missingPluginEnvelope",
  "assistant-context-origin-restricted": "formatIpcError.assistantContextOriginRestricted",
  "role-prompt-origin-restricted": "formatIpcError.rolePromptOriginRestricted",
  "persona-prompt-origin-restricted": "formatIpcError.personaPromptOriginRestricted",

  // ── Permission manager / audit state ──
  "no-permission-manager": "formatIpcError.noPermissionManager",
  "permission-audit-not-ready": "formatIpcError.permissionAuditNotReady",
  "permission-audit-write-failed": "formatIpcError.permissionAuditWriteFailed",
  "audit-chain-not-initialized": "formatIpcError.auditChainNotInitialized",
  "no-deferred-queue": "formatIpcError.noDeferredQueue",
  "managed": "formatIpcError.managed",
  "durable-mode-denied": "formatIpcError.durableModeDenied",
  "missing-durable-confirm": "formatIpcError.missingDurableConfirm",

  // ── Payload / validation ──
  "invalid-payload": "formatIpcError.invalidPayload",
  "invalid-params": "formatIpcError.invalidParams",
  "invalid-input": "formatIpcError.invalidInput",
  "invalid-value": "formatIpcError.invalidValue",
  "invalid-format": "formatIpcError.invalidFormat",
  "invalid-method": "formatIpcError.invalidMethod",
  "invalid-event-type": "formatIpcError.invalidEventType",
  "invalid-index": "formatIpcError.invalidIndex",
  "index-out-of-range": "formatIpcError.indexOutOfRange",
  "invalid-text": "formatIpcError.invalidText",
  "empty-text": "formatIpcError.emptyText",
  "empty": "formatIpcError.empty",
  "content-too-large": "formatIpcError.contentTooLarge",
  "invalid-content": "formatIpcError.invalidContent",
  "missing-tokens": "formatIpcError.missingTokens",

  // ── Args / canonicalization ──
  "args-not-object": "formatIpcError.argsNotObject",
  "args-not-json": "formatIpcError.argsNotJson",
  "invalid-args": "formatIpcError.invalidArgs",

  // ── Permission rule / approval validation ──
  "invalid-pattern": "formatIpcError.invalidPattern",
  "invalid-action": "formatIpcError.invalidAction",
  "invalid-mode": "formatIpcError.invalidMode",
  "invalid-patch": "formatIpcError.invalidPatch",
  "invalid-key": "formatIpcError.invalidKey",
  "invalid-shell": "formatIpcError.invalidShell",
  "invalid-slug": "formatIpcError.invalidSlug",
  "parse-error": "formatIpcError.parseError",
  "high-requires-session-scope": "formatIpcError.highRequiresSessionScope",
  "high-requires-justification": "formatIpcError.highRequiresJustification",
  "add-failed": "formatIpcError.addFailed",
  "remove-failed": "formatIpcError.removeFailed",

  // ── Deferred queue lifecycle ──
  "not-found": "formatIpcError.notFound",
  "no-such-request": "formatIpcError.noSuchRequest",
  "not-registered": "formatIpcError.notRegistered",
  "already-resolved": "formatIpcError.alreadyResolved",
  "already-resolving": "formatIpcError.alreadyResolving",

  // ── Assistant context / role / memory / routine ──
  "invalid-assistant-context": "formatIpcError.invalidAssistantContext",
  "invalid-assistant-context-menu": "formatIpcError.invalidAssistantContextMenu",
  "invalid-assistant-agent": "formatIpcError.invalidAssistantAgent",
  "invalid-assistant-skill": "formatIpcError.invalidAssistantSkill",
  "invalid-assistant-skills": "formatIpcError.invalidAssistantSkills",
  "invalid-role-prompt": "formatIpcError.invalidRolePrompt",
  "invalid-persona-prompt": "formatIpcError.invalidPersonaPrompt",
  "invalid-persona-prompt-id": "formatIpcError.invalidPersonaPromptId",
  "persona-prompt-not-found": "formatIpcError.personaPromptNotFound",
  "invalid-memory-sections": "formatIpcError.invalidMemorySections",
  "routine-not-found": "formatIpcError.routineNotFound",
  "no-user-message": "formatIpcError.noUserMessage",
  "last-message-not-user": "formatIpcError.lastMessageNotUser",
  "no-scheduler": "formatIpcError.noScheduler",

  // ── Plugin / marketplace / bundle ──
  "plugin-not-loaded": "formatIpcError.pluginNotLoaded",
  "unknown-plugin-id": "formatIpcError.unknownPluginId",
  "invalid-bundle-id": "formatIpcError.invalidBundleId",
  "invalid-entry-url": "formatIpcError.invalidEntryUrl",
  "entry-url-outside-install-root": "formatIpcError.entryUrlOutsideInstallRoot",
  "install-failed": "formatIpcError.installFailed",
  "uninstall-failed": "formatIpcError.uninstallFailed",
  "marketplace-disabled": "formatIpcError.marketplaceDisabled",
  // Frame-trust gate (used by chat.ts + plugins.ts pluginConfigError helper).
  // The plain "unauthorized" entry above already maps to "권한이 없습니다." but
  // "unauthorized-frame" carries a distinct semantic (the *frame/window* failed
  // the trust check, not the user's role) that the user can act on differently:
  // refresh the window or restart the app. Keep both keys with distinct
  // wording so the surfaced Korean message preserves that signal.
  "unauthorized-frame": "formatIpcError.unauthorizedFrame",
  // ── Legacy snake_case codes (src/ipc/domains/attach.ts) ──
  // These predate the kebab-case convention. New code MUST use kebab-case
  // (#803 IPC convention). The snake_case shape is grandfathered until the
  // attach.ts handlers are rewritten (tracked in follow-up).
  "path_not_authorized": "formatIpcError.pathNotAuthorized",
  "not_image": "formatIpcError.notImage",
  "invalid_payload": "formatIpcError.invalidPayloadSnake",
  "denied_extension": "formatIpcError.deniedExtension",
  "no-store": "formatIpcError.noStore",
  "no-starred-store": "formatIpcError.noStarredStore",
  "no-session-todo-store": "formatIpcError.noSessionTodoStore",
  // ── #893 Auth mockup login ──
  "invalid-credentials": "formatIpcError.invalidCredentials",
  "invalid-vendor": "formatIpcError.invalidVendor",
  "no-demo-key": "formatIpcError.noDemoKey",
  "reviewer-rewire-failed": "formatIpcError.reviewerRewireFailed",
  // v0.2.1 hotfix — Step 2 (llm-key-issuing) try/catch surfaces this
  // when setSecret / patch fails (disk full, Keychain locked, etc.).
  // The "sandbox 준비 중" transcript fail in the user-reported repro
  // was previously bubbling through as the generic "로그인 처리 중
  // 오류" toast because the IPC promise rejected unhandled.
  "llm-key-issuing-failed": "formatIpcError.llmKeyIssuingFailed",
  // ── Demo activation (lvis:demo:activate — 2026-05-19) ──
  // The LoginModal carries its own activationErrorMessage() that prefers
  // a longer "활성 코드..." string with paste instructions. These default
  // mappings exist for callers that surface IPC errors generically via
  // formatIpcError() (e.g. inline error toasts).
  "invalid-code": "formatIpcError.invalidCode",
  "no-vendor": "formatIpcError.noVendor",
  "missing-foundry-endpoint": "formatIpcError.missingFoundryEndpoint",
  "persist-failed": "formatIpcError.persistFailed",
  "not-armed": "formatIpcError.notArmed",
  // Build-embedded activation key absent (lvis:demo:activate-embedded).
  "no-embedded-code": "formatIpcError.noEmbeddedCode",
  // 2026-05-20 — Settings 로그아웃 path (`lvis:demo:clear`) 의 디스크 삭제 실패.
  "clear-failed": "formatIpcError.clearFailed",
  // ── Tutorial-C — tour:{start,mark-complete,dismiss} validation ──
  "invalid-scenario-id": "formatIpcError.invalidScenarioId",
  "write-failed": "formatIpcError.writeFailed",
  // ── Audit demo throttle (pre-existing in audit.ts) ──
  "rate-limited": "formatIpcError.rateLimited",

  // ── Misc IO / system ──
  "no-window": "formatIpcError.noWindow",
  "invalid-request-id": "formatIpcError.invalidRequestId",
  "invalid-webcontents-id": "formatIpcError.invalidWebcontentsId",
  "invalid-foundry-endpoint": "formatIpcError.invalidFoundryEndpoint",
  "invalid-host-map": "formatIpcError.invalidHostMap",
  "host-map-requires-apply-host-map": "formatIpcError.hostMapRequiresApplyHostMap",
  "auth-mode-not-manual": "formatIpcError.authModeNotManual",
  "open-failed": "formatIpcError.openFailed",
  "checkpoint-not-found": "formatIpcError.checkpointNotFound",
  "session-mismatch": "formatIpcError.sessionMismatch",
  "preference-refresh-service-unavailable": "formatIpcError.preferenceRefreshServiceUnavailable",
  "production-disabled": "formatIpcError.productionDisabled",
};

export interface FormatIpcErrorOptions {
  /**
   * Per-context code overrides (merged on top of common defaults). Use when
   * the same error code carries a domain-specific nuance — e.g. revoke
   * mapping `invalid-key` → "유효하지 않은 승인 키입니다."
   */
  codeMap?: Record<string, string>;
  /**
   * Optional Korean prefix for unrecognized codes (e.g. "리뷰어 오류").
   * Applied only when neither codeMap nor common defaults resolved a
   * mapping; the prefix is joined with the backend message or raw code.
   */
  fallbackContext?: string;
}

export function formatIpcError(
  error: string | undefined,
  message: string | undefined,
  opts: FormatIpcErrorOptions = {},
): string {
  if (error) {
    const override = opts.codeMap?.[error];
    if (override) return override;
    const commonKey = COMMON_IPC_ERROR_MESSAGES[error];
    if (commonKey) return t(commonKey);
  }
  if (message && message.trim().length > 0) {
    return opts.fallbackContext ? `${opts.fallbackContext}: ${message}` : message;
  }
  const raw = error ?? t("formatIpcError.unknownError");
  return opts.fallbackContext ? `${opts.fallbackContext}: ${raw}` : `${raw}${t("formatIpcError.errorSuffix")}`;
}
