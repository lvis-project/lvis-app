/**
 * Preload contextBridge shape lock — Commit C0 safety snapshot.
 *
 * Mocks electron's `contextBridge.exposeInMainWorld` to record every exposed
 * world `(worldName, apiObject)`, imports `src/preload.ts`, and snapshots a
 * DEEP shape of each world: the sorted top-level keys plus, for each nested
 * object value, one level of sorted keys. This locks the `window.*` world
 * names and their exposed API surface byte-identical before the refactor that
 * follows moves them.
 *
 * Values are intentionally NOT captured (only `typeof` / nested key lists) so
 * env-dependent values (e.g. `__lvisDevMode`, platform flags) stay
 * deterministic across machines. MUST pass against the current (unchanged) code.
 *
 * Mock scaffolding mirrors `src/__tests__/preload.test.ts` (which already
 * imports preload successfully).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockUserActivation = { isActive: false };

// Named exports only — mirrors the named-import shape in preload.ts.
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, value: unknown) => {
      exposed.set(key, value);
    }),
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
}));

// Some node/bun runtimes leave `globalThis.navigator` undefined; preload reads
// `navigator.userActivation` inside its bridge functions, so stub it first.
if (typeof globalThis.navigator !== "object" || globalThis.navigator === null) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
}
Object.defineProperty(globalThis.navigator, "userActivation", {
  configurable: true,
  value: mockUserActivation,
});

/**
 * Deep shape: primitives → their `typeof` (or `"null"`); objects → an object
 * mapping each sorted key to either its nested one-level sorted key list
 * (nested plain objects), `"array"`, or the leaf `typeof`.
 */
function deepShape(value: unknown): unknown {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return "array";
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === null) {
      out[key] = "null";
    } else if (Array.isArray(v)) {
      out[key] = "array";
    } else if (typeof v === "object") {
      out[key] = Object.keys(v as Record<string, unknown>).sort();
    } else {
      out[key] = typeof v;
    }
  }
  return out;
}

beforeAll(async () => {
  await import("../preload.js");
});

describe("preload contextBridge world shape lock", () => {
  it("exposes the expected set of worlds", () => {
    expect([...exposed.keys()].sort()).toMatchInlineSnapshot(`
      [
        "__lvisDevMode",
        "__lvisInitialAppMode",
        "__lvisInitialTheme",
        "lvis",
        "lvisApi",
        "lvisDrop",
        "lvisHost",
        "lvisPlatform",
        "lvisWindow",
      ]
    `);
  });

  it("locks each exposed world's deep shape", () => {
    const worlds: Record<string, unknown> = {};
    for (const name of [...exposed.keys()].sort()) {
      worlds[name] = deepShape(exposed.get(name));
    }
    expect(worlds).toMatchInlineSnapshot(`
      {
        "__lvisDevMode": "boolean",
        "__lvisInitialAppMode": "null",
        "__lvisInitialTheme": "null",
        "lvis": {
          "approval": [
            "listPending",
            "onRequest",
            "onSettled",
            "respond",
            "selectSentence",
          ],
          "attach": [
            "discardClipboardImage",
            "openExternal",
            "openFile",
            "readImage",
            "saveClipboardImage",
          ],
          "env": [
            "debugStream",
            "enableDevConsole",
            "isDev",
            "isE2E",
          ],
          "mcp": [
            "addConfig",
            "attachResource",
            "attachResourceTemplate",
            "callTool",
            "disposeUiSession",
            "downloadFile",
            "getConfigPath",
            "getConfigs",
            "getPrompt",
            "kill",
            "listResourceTemplates",
            "listResources",
            "onServerDisconnected",
            "postUiMessage",
            "postUiModelContext",
            "readUiResource",
            "removeConfig",
            "servers",
            "setApiKey",
          ],
          "permission": [
            "addRule",
            "auditShow",
            "auditVerify",
            "deferredList",
            "deferredResolve",
            "dirDispatch",
            "getMode",
            "hookTrustList",
            "listRules",
            "onConfigChanged",
            "onDeferredPending",
            "onManifestViolation",
            "onModeChanged",
            "onReviewSuggestion",
            "onUserApprovalHit",
            "removeRule",
            "reviewerDispatch",
            "reviewerProviderHasKey",
            "sandboxCapability",
            "sandboxWindowsInstall",
            "sandboxWindowsStatus",
            "setMode",
          ],
          "pluginConfig": [
            "get",
            "getSchema",
            "listSecretKeys",
            "set",
            "setSecret",
          ],
          "plugins": [
            "cards",
          ],
          "policy": [
            "get",
            "set",
          ],
          "preview": [
            "readFile",
          ],
          "ui": [
            "onDynamicMenuAction",
            "onNativeContextMenuAction",
            "showDynamicMenu",
            "showNativeContextMenu",
          ],
          "userApproval": [
            "list",
            "record",
            "revokeByKey",
          ],
          "workspace": [
            "dropPrepare",
            "listDir",
            "listRoots",
            "pickRoot",
            "removeRoot",
            "reveal",
          ],
        },
        "lvisApi": {
          "acceptWorkProposal": "function",
          "acknowledgeRoutineResult": "function",
          "acpSubscriptionCancelLogin": "function",
          "acpSubscriptionChooseRuntime": "function",
          "acpSubscriptionForgetRuntime": "function",
          "acpSubscriptionLogout": "function",
          "acpSubscriptionOpenLoginBrowser": "function",
          "acpSubscriptionStartLogin": "function",
          "acpSubscriptionStatus": "function",
          "acpSubscriptionVerify": "function",
          "addRoutine": "function",
          "addWorkBoardItem": "function",
          "applyClaudeDesktopMcpImport": "function",
          "approval": [
            "listPending",
            "onRequest",
            "onSettled",
            "respond",
            "selectSentence",
          ],
          "audit": [
            "getStats",
            "search",
          ],
          "awayAuthority": [
            "arm",
            "disarm",
            "status",
          ],
          "callPluginMethod": "function",
          "captureUserKeyboardIntent": "function",
          "chatAbort": "function",
          "chatBranchFromCheckpoint": "function",
          "chatCompact": "function",
          "chatContinueLastUser": "function",
          "chatEditResend": "function",
          "chatEnterCheckpointView": "function",
          "chatExitCheckpointView": "function",
          "chatExport": "function",
          "chatFork": "function",
          "chatGetHistory": "function",
          "chatGetSubAgentTranscript": "function",
          "chatGetVerbatimToolResult": "function",
          "chatGetWriteDiff": "function",
          "chatGroup": "function",
          "chatGroupRelease": "function",
          "chatGuide": "function",
          "chatHasProvider": "function",
          "chatImport": "function",
          "chatMainActiveState": "function",
          "chatNew": "function",
          "chatRetryEffort": "function",
          "chatRewindTo": "function",
          "chatSend": "function",
          "chatSessionDelete": "function",
          "chatSessionHistory": "function",
          "chatSessionResume": "function",
          "chatSessionUpdate": "function",
          "chatSessions": "function",
          "clearSessionGoal": "function",
          "clearSessionTasks": "function",
          "codexSubscriptionCancelLogin": "function",
          "codexSubscriptionListModels": "function",
          "codexSubscriptionLogout": "function",
          "codexSubscriptionStartBrowserLogin": "function",
          "codexSubscriptionStartDeviceCodeLogin": "function",
          "codexSubscriptionStatus": "function",
          "completeWorkBoardItem": "function",
          "deleteApiKey": "function",
          "deleteMarketplaceApiKey": "function",
          "deletePersonaPrompt": "function",
          "deleteWebApiKey": "function",
          "dev": [
            "getPreflightStatus",
            "setPreflightOverride",
          ],
          "diagnostics": [
            "crashList",
            "export",
          ],
          "dismissRoutine": "function",
          "dismissTrigger": "function",
          "dismissWorkProposal": "function",
          "dlp": [
            "getStats",
          ],
          "downloadAppUpdate": "function",
          "e2ePluginBundleSnapshot": "function",
          "ensurePluginPartition": "function",
          "envForcedSettings": "function",
          "exportUsageCsv": "function",
          "generateWorkBoardReport": "function",
          "getAppInfo": "function",
          "getAppUpdateState": "function",
          "getBootstrapStatus": "function",
          "getRuntimeCounts": "function",
          "getRuntimeEnv": "function",
          "getSessionGoal": "function",
          "getSettings": "function",
          "getUsageDailySummary": "function",
          "getUsageRange": "function",
          "getUsageSummary": "function",
          "getWorkBoardItem": "function",
          "getWorkBoardRunTranscript": "function",
          "hasApiKey": "function",
          "hasMarketplaceApiKey": "function",
          "hasWebApiKey": "function",
          "homeDocsApplyMerged": "function",
          "homeDocsApplyPackaged": "function",
          "homeDocsDiscardMerged": "function",
          "homeDocsGetCustom": "function",
          "homeDocsKeepMine": "function",
          "homeDocsMerge": "function",
          "homeDocsReadMarker": "function",
          "homeDocsStatus": "function",
          "homeDocsUpdateCustom": "function",
          "importTrigger": "function",
          "installAgentFromMarketplace": "function",
          "installAppUpdate": "function",
          "installLocalPlugin": "function",
          "installMarketplaceProviderPreset": "function",
          "installMcpFromMarketplace": "function",
          "installSkillFromMarketplace": "function",
          "listAgentProfiles": "function",
          "listLlmModels": "function",
          "listMarketplacePlugins": "function",
          "listMcpCatalog": "function",
          "listPendingRoutineResults": "function",
          "listPersonaPromptSummaries": "function",
          "listPersonaPrompts": "function",
          "listPluginCards": "function",
          "listPluginContributionTrust": "function",
          "listPluginUiExtensions": "function",
          "listRoutineSessions": "function",
          "listRoutines": "function",
          "listSessionTasks": "function",
          "listSkills": "function",
          "listWorkBoard": "function",
          "listWorkProposals": "function",
          "logs": [
            "tail",
          ],
          "mcp": [
            "addConfig",
            "attachResource",
            "attachResourceTemplate",
            "callTool",
            "disposeUiSession",
            "downloadFile",
            "getConfigPath",
            "getConfigs",
            "getPrompt",
            "kill",
            "listResourceTemplates",
            "listResources",
            "onServerDisconnected",
            "postUiMessage",
            "postUiModelContext",
            "readUiResource",
            "removeConfig",
            "servers",
            "setApiKey",
          ],
          "memoryActivateCandidate": "function",
          "memoryDeleteCandidate": "function",
          "memoryDeleteEntry": "function",
          "memoryGetAgentsMd": "function",
          "memoryGetIndex": "function",
          "memoryGetUserPrefs": "function",
          "memoryListCandidates": "function",
          "memoryListEntries": "function",
          "memoryListSessions": "function",
          "memoryRefreshLongTerm": "function",
          "memoryRefreshUserPrefs": "function",
          "memorySaveEntry": "function",
          "memorySearchEntries": "function",
          "memorySearchSessions": "function",
          "memoryUpdateAgentsMd": "function",
          "memoryUpdateIndexIfUnchanged": "function",
          "memoryUpdateIndexSections": "function",
          "memoryUpdateUserPrefs": "function",
          "notifyClick": "function",
          "notifyPluginTheme": "function",
          "onAgentInstallProgress": "function",
          "onAgentInstallResult": "function",
          "onAgentSpawnEvent": "function",
          "onAgentUninstallResult": "function",
          "onAppUpdateState": "function",
          "onAskUserQuestion": "function",
          "onAskUserQuestionTimeout": "function",
          "onBootstrapStatus": "function",
          "onChatFallback": "function",
          "onChatStream": "function",
          "onMarketplaceAnnouncements": "function",
          "onMarketplaceUpdatesAvailable": "function",
          "onNotificationClicked": "function",
          "onNotificationToast": "function",
          "onOverlayDismiss": "function",
          "onOverlayShow": "function",
          "onOverlayUpdate": "function",
          "onPersonaPromptsUpdated": "function",
          "onPluginEnabledChanged": "function",
          "onPluginEvent": "function",
          "onPluginInstallProgress": "function",
          "onPluginInstallResult": "function",
          "onPluginRuntimeUpdated": "function",
          "onPluginUninstallResult": "function",
          "onRoutineFailed": "function",
          "onRoutineFired": "function",
          "onRoutineRunningFinished": "function",
          "onRoutineRunningStarted": "function",
          "onSessionGoalChanged": "function",
          "onSessionTasksChanged": "function",
          "onSettingsUpdated": "function",
          "onSkillInstallProgress": "function",
          "onSkillInstallResult": "function",
          "onSkillLoaded": "function",
          "onSkillUninstallResult": "function",
          "onSubscriptionRuntimeStatusUpdated": "function",
          "onTriggerCompleted": "function",
          "onTriggerExpired": "function",
          "onTriggerFailed": "function",
          "onTriggerImported": "function",
          "onTriggerStarted": "function",
          "onViewActivate": "function",
          "onWorkBoardItemChanged": "function",
          "onWorkBoardRunFailed": "function",
          "onWorkBoardRunFinished": "function",
          "onWorkBoardRunProgress": "function",
          "onWorkBoardRunStarted": "function",
          "onWorkProposalChanged": "function",
          "onboarding": [
            "answer",
            "listPending",
          ],
          "openExternalUrl": "function",
          "pauseSessionGoal": "function",
          "permission": [
            "addRule",
            "auditShow",
            "auditVerify",
            "deferredList",
            "deferredResolve",
            "dirDispatch",
            "getMode",
            "hookTrustList",
            "listRules",
            "onConfigChanged",
            "onDeferredPending",
            "onManifestViolation",
            "onModeChanged",
            "onReviewSuggestion",
            "onUserApprovalHit",
            "removeRule",
            "reviewerDispatch",
            "reviewerProviderHasKey",
            "sandboxCapability",
            "sandboxWindowsInstall",
            "sandboxWindowsStatus",
            "setMode",
          ],
          "pingAiProvider": "function",
          "pingMarketplace": "function",
          "pluginPreloadUrl": "string",
          "pluginShellUrl": "string",
          "plugins": [
            "getPerfStats",
          ],
          "policy": [
            "get",
            "set",
          ],
          "previewClaudeDesktopMcpImport": "function",
          "readPluginUiModule": "function",
          "registerPluginWebview": "function",
          "remoteA2a": [
            "action",
            "send",
            "status",
            "targets",
            "task",
          ],
          "removeRoutine": "function",
          "removeWorkBoardItem": "function",
          "reopenWorkBoardItem": "function",
          "respondAskUserQuestion": "function",
          "resumeSessionGoal": "function",
          "retryBootstrap": "function",
          "runWorkBoardBriefing": "function",
          "runWorkBoardItem": "function",
          "savePersonaPrompt": "function",
          "setApiKey": "function",
          "setMarketplaceApiKey": "function",
          "setPluginContributionTrust": "function",
          "setPluginEnabled": "function",
          "setWebApiKey": "function",
          "sideChat": [
            "abort",
            "list",
            "load",
            "new",
            "onFallback",
            "onStream",
            "send",
          ],
          "skipAppUpdate": "function",
          "starredAdd": "function",
          "starredList": "function",
          "starredRemove": "function",
          "submitFeedback": "function",
          "subscriptionCancelLogin": "function",
          "subscriptionChooseRuntime": "function",
          "subscriptionForgetRuntime": "function",
          "subscriptionListModels": "function",
          "subscriptionLogout": "function",
          "subscriptionOpenLoginBrowser": "function",
          "subscriptionRuntimeStatus": "function",
          "subscriptionStartLogin": "function",
          "subscriptionUseApiForChat": "function",
          "subscriptionUseForChat": "function",
          "subscriptionVerifyRuntime": "function",
          "tailnetObserver": [
            "apply",
            "configureServe",
            "snapshot",
          ],
          "tailnetSharing": [
            "activatePairing",
            "createCurrentConversationShare",
            "createInvitation",
            "onChanged",
            "revokePairing",
            "revokeShare",
            "snapshot",
          ],
          "telegramConnection": [
            "approveCurrentConversation",
            "connect",
            "createPairingCode",
            "disconnect",
            "onChanged",
            "pause",
            "resume",
            "revokeApproval",
            "revokePairing",
            "snapshot",
          ],
          "telemetryAllowedHosts": "function",
          "terminal": [
            "input",
            "kill",
            "onData",
            "onExit",
            "resize",
            "spawn",
          ],
          "tour": [
            "dismiss",
            "getState",
            "markComplete",
            "onStart",
            "start",
          ],
          "transitionWorkBoardItem": "function",
          "triggerRoutineNow": "function",
          "uninstallAgentPackage": "function",
          "uninstallMarketplaceProviderPreset": "function",
          "uninstallSkillPackage": "function",
          "updateSettings": "function",
          "updateWorkBoardItem": "function",
          "userApproval": [
            "list",
            "record",
            "revokeByKey",
          ],
          "window": [
            "openHtmlPreview",
            "resizeForMode",
            "resizeForSidePanel",
          ],
        },
        "lvisDrop": {
          "resolveDroppedPaths": "function",
        },
        "lvisHost": {
          "takePluginMarketplaceApi": "function",
        },
        "lvisPlatform": {
          "isDarwin": "boolean",
        },
        "lvisWindow": {
          "close": "function",
          "minimize": "function",
          "onFullscreenChanged": "function",
          "onMaximizedChanged": "function",
          "syncTitleBarTheme": "function",
          "toggleMaximize": "function",
        },
      }
    `);
  });
});
