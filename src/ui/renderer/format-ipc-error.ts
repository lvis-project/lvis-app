




import { t } from "../../i18n/runtime.js";

export const COMMON_IPC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // ── Trust / intent gate (PR #826 cross-cutting code group) ──
  "user-keyboard-required": "formatIpcError.userKeyboardRequired",
  "unauthorized": "formatIpcError.unauthorized",
  // "unauthorized-frame" lives below in the frame-trust gate section with a

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
  // Windows-only IPC (sandboxWindowsInstall) refused on a non-win32 platform.
  "not-applicable": "formatIpcError.notApplicable",

  // ── Payload / validation ──
  "invalid-payload": "formatIpcError.invalidPayload",
  "invalid-params": "formatIpcError.invalidParams",
  "invalid-input": "formatIpcError.invalidInput",
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
  "invalid-provider-preset-id": "formatIpcError.invalidValue",
  "marketplace-provider-preset-install-failed": "formatIpcError.installFailed",
  "marketplace-provider-preset-uninstall-failed": "formatIpcError.uninstallFailed",
  // Plugin↔app minimum-version gate (install + load). The English IPC message
  // carries the concrete versions ("plugin requires LVIS >= X, current Y");
  // callsites that have the structured {required,current} fields render the

  // their own formatter. This generic key is the fallback for callers that
  // surface the bare code.
  "incompatible-app-version": "formatIpcError.incompatibleAppVersion",
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
  // ── #893 Auth mockup login ──
  "invalid-credentials": "formatIpcError.invalidCredentials",
  "invalid-vendor": "formatIpcError.invalidVendor",
  "provider-not-installed": "formatIpcError.providerNotInstalled",
  "unknown-provider": "formatIpcError.unknownProvider",
  "no-demo-key": "formatIpcError.noDemoKey",
  "reviewer-rewire-failed": "formatIpcError.reviewerRewireFailed",
  // v0.2.1 hotfix — Step 2 (llm-key-issuing) try/catch surfaces this
  // when setSecret / patch fails (disk full, Keychain locked, etc.).


  "llm-key-issuing-failed": "formatIpcError.llmKeyIssuingFailed",
  // ── Demo activation (lvis:demo:activate — 2026-05-19) ──
  // The LoginModal carries its own activationErrorMessage() that prefers

  // mappings exist for callers that surface IPC errors generically via
  // formatIpcError() (e.g. inline error toasts).
  "invalid-code": "formatIpcError.invalidCode",
  "no-vendor": "formatIpcError.noVendor",
  "missing-foundry-endpoint": "formatIpcError.missingFoundryEndpoint",
  "persist-failed": "formatIpcError.persistFailed",
  "not-armed": "formatIpcError.notArmed",
  // Build-embedded activation key absent (lvis:demo:activate-embedded).
  "no-embedded-code": "formatIpcError.noEmbeddedCode",
  // #1498 — Azure Foundry endpoint unreachable (network-boundary failure
  // during loginMockup's sandbox-preparing step) and local Ollama fallback
  // (lvis:demo:activate-ollama) — the server that answered the login
  // modal's probe is no longer reachable.
  "endpoint-unreachable": "formatIpcError.endpointUnreachable",
  "no-ollama": "formatIpcError.noOllama",

  "clear-failed": "formatIpcError.clearFailed",
  // ── Tutorial-C — tour:{start,mark-complete,dismiss} validation ──
  "invalid-scenario-id": "formatIpcError.invalidScenarioId",
  "write-failed": "formatIpcError.writeFailed",
  // ── Audit demo throttle (pre-existing in audit.ts) ──
  "rate-limited": "formatIpcError.rateLimited",

  // ── MCP Apps — the card's own IPCs (mcp.callTool / mcp.uiMessage) ──
  // A card's `oncalltool` may only run a tool its OWN server owns, and the host may
  // deny (or the tool may fail) at the risk/consent gate. `onmessage` needs the
  // notification service to be running for its popup path.
  "cross-server-call-denied": "formatIpcError.crossServerCallDenied",
  "invalid-server-id": "formatIpcError.invalidServerId",
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
  "invalid-host-map": "formatIpcError.invalidHostMap",
  "host-map-requires-apply-host-map": "formatIpcError.hostMapRequiresApplyHostMap",
  "auth-mode-not-manual": "formatIpcError.authModeNotManual",
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
