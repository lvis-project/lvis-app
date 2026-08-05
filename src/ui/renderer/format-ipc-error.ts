




import { t } from "../../i18n/runtime.js";

export const COMMON_IPC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // ── Trust / intent gate (PR #826 cross-cutting code group) ──
  "user-keyboard-required": "formatIpcError.userKeyboardRequired",
  "unauthorized": "formatIpcError.unauthorized",
  // "unauthorized-frame" lives below in the frame-trust gate section with a

  "missing-input-origin": "formatIpcError.missingInputOrigin",
  "cross-plugin-call-denied": "formatIpcError.crossPluginCallDenied",
  "missing-plugin-envelope": "formatIpcError.missingPluginEnvelope",
  // Every staged origin returns its own missing-envelope code (see
  // shared/staged-origins.ts) — all of them are reachable from `chat:send`, so
  // all of them need a message rather than leaking the kebab-case code.
  "missing-app-envelope": "formatIpcError.missingAppEnvelope",
  "missing-mcp-prompt-envelope": "formatIpcError.missingMcpPromptEnvelope",
  // The mirror case: the text CARRIES a staged envelope while the send claims a
  // non-staged origin.
  "origin-envelope-mismatch": "formatIpcError.originEnvelopeMismatch",
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
  "one-shot-not-recordable": "formatIpcError.durableModeDenied",
  "a2a-remote-disabled": "formatIpcError.remoteA2aDisabled",
  "tailnet-sharing-disabled": "formatIpcError.tailnetSharingDisabled",
  "tailnet-sharing-input-invalid": "formatIpcError.tailnetSharingInputInvalid",
  "tailnet-sharing-operation-rejected": "formatIpcError.tailnetSharingOperationRejected",
  "tailnet-sharing-unavailable": "formatIpcError.tailnetSharingUnavailable",
  "telegram-connection-disabled": "formatIpcError.telegramConnectionDisabled",
  "telegram-connection-unavailable": "formatIpcError.telegramConnectionUnavailable",
  "telegram-connection-input-invalid": "formatIpcError.invalidInput",
  "telegram-connection-operation-rejected": "formatIpcError.telegramConnectionOperationRejected",
  "telegram-managed-by-environment": "formatIpcError.managed",
  "telegram-encryption-unavailable": "formatIpcError.telegramEncryptionUnavailable",
  "telegram-bot-token-rejected": "formatIpcError.telegramBotTokenRejected",
  "telegram-provider-unreachable": "formatIpcError.telegramProviderUnreachable",
  "telegram-webhook-conflict": "formatIpcError.telegramWebhookConflict",
  "telegram-poll-conflict": "formatIpcError.telegramPollConflict",
  "away-authority-disabled": "formatIpcError.awayAuthorityDisabled",
  "away-authority-input-invalid": "formatIpcError.invalidInput",
  "away-authority-operation-rejected": "formatIpcError.awayAuthorityOperationRejected",
  "away-authority-unavailable": "formatIpcError.awayAuthorityUnavailable",
  "a2a-remote-input-invalid": "formatIpcError.invalidInput",
  "a2a-remote-operation-rejected": "formatIpcError.remoteA2aOperationRejected",
  "a2a-remote-settings-main-owned": "formatIpcError.managed",
  "missing-durable-confirm": "formatIpcError.missingDurableConfirm",
  // Windows-only IPC (sandboxWindowsInstall) refused on a non-win32 platform.
  "not-applicable": "formatIpcError.notApplicable",

  // ── Payload / validation ──
  "invalid-payload": "formatIpcError.invalidPayload",
  "invalid-params": "formatIpcError.invalidParams",
  "invalid-input": "formatIpcError.invalidInput",
  "invalid-operation-input": "formatIpcError.invalidInput",
  "invalid-plugin-id": "formatIpcError.invalidInput",
  "invalid-contribution-trust-request": "formatIpcError.invalidInput",
  "invalid-native-context-menu": "formatIpcError.invalidInput",
  "invalid-value": "formatIpcError.invalidValue",
  "invalid-format": "formatIpcError.invalidFormat",
  "invalid-method": "formatIpcError.invalidMethod",
  "invalid-event-type": "formatIpcError.invalidEventType",
  "invalid-index": "formatIpcError.invalidIndex",
  "index-out-of-range": "formatIpcError.indexOutOfRange",
  "invalid-session-id": "formatIpcError.invalidSessionId",
  "invalid-origin-session-id": "formatIpcError.invalidOriginSessionId",
  "origin-session-not-active": "formatIpcError.originSessionNotActive",
  "invalid-child-session-id": "formatIpcError.invalidChildSessionId",
  "sub-agent-reference-not-found": "formatIpcError.subAgentReferenceNotFound",
  "session-not-found": "formatIpcError.sessionNotFound",
  "side-chat-unavailable": "formatIpcError.sideChatUnavailable",
  "project-not-allowed": "formatIpcError.projectNotAllowed",
  "invalid-text": "formatIpcError.invalidText",
  "empty-text": "formatIpcError.emptyText",
  "empty": "formatIpcError.empty",
  "content-too-large": "formatIpcError.contentTooLarge",
  "invalid-content": "formatIpcError.invalidContent",
  "missing-tokens": "formatIpcError.missingTokens",

  // ── Subscription runtime ──
  "acp-provider-not-supported": "formatIpcError.acpSubscriptionProviderNotSupported",
  "active-chat-runtime-requires-subscription-selection": "formatIpcError.activeChatRuntimeRequiresSubscriptionSelection",
  "codex-login-failed": "formatIpcError.codexLoginFailed",
  "subscription-operation-failed": "formatIpcError.subscriptionChatUnavailable",
  "subscription-chat-unavailable": "formatIpcError.subscriptionChatUnavailable",
  "subscription-logout-not-supported": "formatIpcError.subscriptionLogoutNotSupported",
  "subscription-provider-not-supported": "formatIpcError.subscriptionProviderNotSupported",

  // ── Preview / workspace file-read (preview.ts, workspace.ts) ──
  "not-a-file": "formatIpcError.notAFile",
  "not-a-dir": "formatIpcError.notADirectory",
  "binary-file": "formatIpcError.binaryFile",
  "too-large": "formatIpcError.contentTooLarge",
  "read-failed": "formatIpcError.notFound",
  // Workspace pick-root acknowledgement token (workspace.ts): the one-time ack
  // token was never issued / already consumed / past its TTL.
  "ack-unknown": "formatIpcError.ackUnknown",
  "ack-expired": "formatIpcError.ackExpired",
  // Workspace root remove (workspace.ts): removeRoot.
  "invalid-path": "formatIpcError.invalidPath",
  "cannot-remove-default": "formatIpcError.cannotRemoveDefaultRoot",
  "not-an-additional-root": "formatIpcError.notAnAdditionalRoot",
  "persist-failed": "formatIpcError.writeFailed",
  "lifecycle-failed": "formatIpcError.writeFailed",

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
  "memory-consolidation-service-unavailable": "rolesTab.errorLongTermMemoryConsolidationUnavailable",
  "memory-consolidation-failed": "rolesTab.errorLongTermMemoryConsolidationFailed",
  "routine-not-found": "formatIpcError.routineNotFound",
  "no-user-message": "formatIpcError.noUserMessage",
  "last-message-not-user": "formatIpcError.lastMessageNotUser",
  "no-scheduler": "formatIpcError.noScheduler",

  // ── Plugin / marketplace / bundle ──
  "plugin-not-loaded": "formatIpcError.pluginNotLoaded",
  "plugin-bundle-lifecycle-unavailable": "formatIpcError.noEngine",
  "contribution-trust-update-failed": "formatIpcError.writeFailed",
  "unknown-plugin-id": "formatIpcError.unknownPluginId",
  // The target Electron webview was already destroyed or is not registered
  // as a live plugin panel. Reuse the established not-registered wording.
  "webview-not-live": "formatIpcError.notRegistered",
  "invalid-bundle-id": "formatIpcError.invalidBundleId",
  "invalid-entry-url": "formatIpcError.invalidEntryUrl",
  "entry-url-outside-install-root": "formatIpcError.entryUrlOutsideInstallRoot",
  "install-failed": "formatIpcError.installFailed",
  "uninstall-failed": "formatIpcError.uninstallFailed",
  "marketplace-disabled": "formatIpcError.marketplaceDisabled",
  "invalid-provider-preset-id": "formatIpcError.invalidValue",
  "marketplace-provider-preset-install-failed": "formatIpcError.installFailed",
  "marketplace-provider-preset-uninstall-failed": "formatIpcError.uninstallFailed",
  // Plugin↔app minimum-version gate (install + load). The English IPC message
  // carries the concrete versions ("plugin requires LVIS >= X, current Y");
  // callsites that have the structured {required,current} fields render the

  // their own formatter. This generic key is the fallback for callers that
  // surface the bare code.
  "incompatible-app-version": "formatIpcError.incompatibleAppVersion",
  // A plugin webview that survived a runtime replacement no longer owns the
  // active binding. The existing frame-trust message gives the correct user
  // remediation (refresh the window or restart the app) without exposing the
  // internal revision counter.
  "stale-runtime-revision": "formatIpcError.unauthorizedFrame",
  // Frame-trust gate (used by chat.ts + plugins.ts pluginConfigError helper).

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
  "clipboard-image-not-owned": "formatIpcError.pathNotAuthorized",
  "not_image": "formatIpcError.notImage",
  "invalid_payload": "formatIpcError.invalidPayloadSnake",
  "denied_extension": "formatIpcError.deniedExtension",
  "no-store": "formatIpcError.noStore",
  // Work-board agent-orchestration engine not constructed at boot
  // (lvis:work-board:run). Sibling of "no-store" — the run channel is gated on
  // the engine the way CRUD channels are gated on the store.
  "no-engine": "formatIpcError.noEngine",
  // Work-board reporter not constructed at boot (lvis:work-board:generate-report).
  // Sibling of "no-engine" — the report channel is gated on the reporter.
  "no-reporter": "formatIpcError.noReporter",
  "no-starred-store": "formatIpcError.noStarredStore",
  "no-session-todo-store": "formatIpcError.noSessionTodoStore",
  "provider-not-installed": "formatIpcError.providerNotInstalled",
  "unknown-provider": "formatIpcError.unknownProvider",
  "reviewer-rewire-failed": "formatIpcError.reviewerRewireFailed",
  // ── Tutorial-C — tour:{start,mark-complete,dismiss} validation ──
  "invalid-scenario-id": "formatIpcError.invalidScenarioId",
  "write-failed": "formatIpcError.writeFailed",
  // ── Audit sample throttle (pre-existing in audit.ts) ──
  "rate-limited": "formatIpcError.rateLimited",

  // ── MCP Apps — the card's own IPCs (mcp.callTool / mcp.uiMessage) ──
  // A card's `oncalltool` may only run a tool its OWN server owns, and the host may
  // deny (or the tool may fail) at the risk/consent gate. `onmessage` needs the
  // notification service to be running for its popup path.
  "cross-server-call-denied": "formatIpcError.crossServerCallDenied",
  "invalid-server-id": "formatIpcError.invalidServerId",
  // ── MCP server prompts (mcp.getPrompt) ──
  // A server prompt the user picked can fail on a malformed request, on a server
  // that returned nothing renderable, or on the server itself; the server's own
  // error text is never forwarded (it can carry host paths).
  "invalid-request": "formatIpcError.invalidRequest",
  "empty-prompt": "formatIpcError.emptyPrompt",
  "prompt-failed": "formatIpcError.promptFailed",
  // ── MCP resource attachment (mcp.attachResource, mcp.attachResourceTemplate) ──
  // Both channels return the same codes on purpose: to the user, filling a template in
  // and picking a listed resource are the same act with the same failure modes, and a
  // second vocabulary for one of them would be a second table to keep in sync.
  "empty-resource": "formatIpcError.emptyResource",
  "resource-failed": "formatIpcError.resourceFailed",
  // Raised by `runStreamedTurn`, so it arrives as a rejected `invoke` message rather
  // than an `{ ok: false }` result — which `resolveIpcErrorKey` handles, and which is
  // why the turn refuses instead of trimming: the user has to be told.
  "too-many-resource-attachments": "formatIpcError.tooManyResourceAttachments",
  // `onupdatemodelcontext` — the renderer binds serverId + session + cardId; a malformed
  // binding is a host bug, and the card cannot be identified.
  "invalid-binding": "formatIpcError.invalidBinding",
  "invalid-tool-name": "formatIpcError.invalidToolName",
  "tool-call-failed": "formatIpcError.toolCallFailed",
  "notification-unavailable": "formatIpcError.notificationUnavailable",

  // ── Misc IO / system ──
  "no-window": "formatIpcError.noWindow",
  "invalid-request-id": "formatIpcError.invalidRequestId",
  "invalid-webcontents-id": "formatIpcError.invalidWebcontentsId",
  "invalid-foundry-endpoint": "formatIpcError.invalidFoundryEndpoint",
  "open-failed": "formatIpcError.openFailed",
  "checkpoint-not-found": "formatIpcError.checkpointNotFound",
  "session-mismatch": "formatIpcError.sessionMismatch",
  "preference-refresh-service-unavailable": "formatIpcError.preferenceRefreshServiceUnavailable",
  "production-disabled": "formatIpcError.productionDisabled",
  // ── Diagnostics bundle + log tail + crash list (#1499 E2) ──
  "export-failed": "formatIpcError.exportFailed",
  "crash-list-failed": "formatIpcError.crashListFailed",
  "logs-tail-failed": "formatIpcError.logsTailFailed",
  // ── Conversation import (lvis:chat:import — #1500 / E3) ──
  "file-not-found": "formatIpcError.importFileNotFound",
  "file-too-large": "formatIpcError.importFileTooLarge",
  "invalid-json": "formatIpcError.importInvalidJson",
  "invalid-file-shape": "formatIpcError.importInvalidFileShape",
  "empty-messages": "formatIpcError.importEmptyMessages",
  "invalid-message-shape": "formatIpcError.importInvalidMessageShape",
  "too-many-messages": "formatIpcError.importTooManyMessages",
};

export interface FormatIpcErrorOptions {



  codeMap?: Record<string, string>;



  fallbackContext?: string;
}

/**
 * Resolve a code to its i18n key, or `undefined` when the table does not know it.
 *
 * Split out of {@link formatIpcError} because that function always returns a
 * string: a caller that wants its OWN fallback phrasing (the send path keeps a
 * localized wrapper for unmapped errors) otherwise has to re-implement the lookup,
 * and then this table has two guarded readers instead of one.
 *
 * `Object.hasOwn` because callers may pass an arbitrary `Error.message` as the code
 * (a rejected `invoke` carries its code in the message). A bare index would resolve
 * `constructor`/`toString` to an inherited function and hand it to `t()`.
 */
export function resolveIpcErrorKey(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return Object.hasOwn(COMMON_IPC_ERROR_MESSAGES, code)
    ? COMMON_IPC_ERROR_MESSAGES[code]
    : undefined;
}

export function formatIpcError(
  error: string | undefined,
  message: string | undefined,
  opts: FormatIpcErrorOptions = {},
): string {
  if (error) {
    const override = opts.codeMap && Object.hasOwn(opts.codeMap, error)
      ? opts.codeMap[error]
      : undefined;
    if (override) return override;
    const commonKey = resolveIpcErrorKey(error);
    if (commonKey) return t(commonKey);
  }
  if (message && message.trim().length > 0) {
    return opts.fallbackContext ? `${opts.fallbackContext}: ${message}` : message;
  }
  const raw = error ?? t("formatIpcError.unknownError");
  return opts.fallbackContext ? `${opts.fallbackContext}: ${raw}` : `${raw}${t("formatIpcError.errorSuffix")}`;
}
