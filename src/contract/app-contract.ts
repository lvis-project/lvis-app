/**
 * app-contract.ts — the #1409 single source of truth for the app's public wire
 * contract (channel names + public allowlist + gesture classification + session
 * addressing rule).
 *
 * SECURITY-SENSITIVE + BEHAVIOR-PRESERVING: every string in this module is
 * BYTE-IDENTICAL to the channel literal it replaces at the handler / preload
 * call sites. The C0 snapshot tests (`channel-inventory`, `preload-shape`,
 * `domain-exports`) must stay green with zero snapshot changes.
 *
 * Channel-name SOT first; request/response payload types are added
 * incrementally (per-handler) in later commits. The streaming/event contract
 * lives in `./events.ts`.
 */

import {
  PERMISSIONS,
  MARKETPLACE,
  UI,
  ROUTINES_V2,
  WORK_BOARD,
  SETTINGS,
  OVERLAY_V1,
} from "../shared/ipc-channels.js";

// Re-export the pre-existing per-domain SOT groups so `src/contract/` is the
// single import surface for the wire contract. The preload sweep (C11) and the
// external API/CLI/SDK surfaces will consume these from here.
export {
  PERMISSIONS,
  MARKETPLACE,
  UI,
  ROUTINES_V2,
  WORK_BOARD,
  SETTINGS,
  OVERLAY_V1,
};

/**
 * Channel-name SOT, grouped by domain. Values are byte-identical to the literal
 * strings previously inlined in `src/ipc/domains/{chat,plugins,settings}.ts`.
 *
 * NOTE: groups whose channels already had a SOT const in
 * `src/shared/ipc-channels.ts` (permissions, work-board, routines, ui,
 * marketplace announcements, overlay, suggested-replies, settings.updated /
 * settings.applyHostMap) are re-exported above rather than duplicated here.
 */
export const CHANNELS = {
  chat: {
    hasProvider: "lvis:chat:has-provider",
    send: "lvis:chat:send",
    guide: "lvis:chat:guide",
    abort: "lvis:chat:abort",
    new: "lvis:chat:new",
    sessions: "lvis:chat:sessions",
    compact: "lvis:chat:compact",
    sessionResume: "lvis:chat:session-resume",
    getHistory: "lvis:chat:get-history",
    mainActiveState: "lvis:chat:main-active-state",
    sessionHistory: "lvis:chat:session-history",
    editResend: "lvis:chat:edit-resend",
    fork: "lvis:chat:fork",
    continueLastUser: "lvis:chat:continue-last-user",
    retryEffort: "lvis:chat:retry-effort",
    export: "lvis:chat:export",
    // #1500 (E3): reverse of `export` — always creates a brand-new session,
    // never overwrites. INTERNAL (mutating; not in PUBLIC_CHANNELS below).
    import: "lvis:chat:import",
    enterCheckpointView: "lvis:chat:enter-checkpoint-view",
    exitCheckpointView: "lvis:chat:exit-checkpoint-view",
    branchFromCheckpoint: "lvis:chat:branch-from-checkpoint",
    getVerbatimToolResult: "lvis:chat:get-verbatim-tool-result",
    getSubAgentTranscript: "lvis:chat:get-sub-agent-transcript",
    getWriteDiff: "lvis:chat:get-write-diff",
    // Streaming / event channels (main → renderer). Full event schema in ./events.ts.
    stream: "lvis:chat:stream",
    fallback: "lvis:chat:fallback",
  },
  llm: {
    ping: "lvis:llm:ping",
  },
  memory: {
    entriesList: "lvis:memory:entries:list",
    entriesSave: "lvis:memory:entries:save",
    entriesDelete: "lvis:memory:entries:delete",
    entriesSearch: "lvis:memory:entries:search",
    indexGet: "lvis:memory:index:get",
    indexUpdateIfUnchanged: "lvis:memory:index:update-if-unchanged",
    indexSectionsUpdate: "lvis:memory:index:sections:update",
    sessionsList: "lvis:memory:sessions:list",
    sessionsSearch: "lvis:memory:sessions:search",
    agentsMdGet: "lvis:memory:agents-md:get",
    agentsMdUpdate: "lvis:memory:agents-md:update",
    userPrefsGet: "lvis:memory:user-prefs:get",
    userPrefsUpdate: "lvis:memory:user-prefs:update",
    userPrefsRefresh: "lvis:memory:user-prefs:refresh",
  },
  starred: {
    list: "lvis:starred:list",
    add: "lvis:starred:add",
    remove: "lvis:starred:remove",
  },
  feedback: {
    submit: "lvis:feedback:submit",
  },
  askUserQuestion: {
    respond: "lvis:ask-user-question:respond",
    // Request + timeout events (main → renderer).
    request: "lvis:ask-user-question:request",
    timeout: "lvis:ask-user-question:timeout",
  },
  plugins: {
    install: "lvis:plugins:install",
    uninstall: "lvis:plugins:uninstall",
    setEnabled: "lvis:plugins:set-enabled",
    installLocal: "lvis:plugins:install-local",
    uiList: "lvis:plugins:ui:list",
    uiReadModule: "lvis:plugins:ui:read-module",
    cards: "lvis:plugins:cards",
    marketplaceList: "lvis:plugins:marketplace:list",
    configGet: "lvis:plugins:config:get",
    configSet: "lvis:plugins:config:set",
    configSchemaGet: "lvis:plugins:config:schema:get",
    configSecretSet: "lvis:plugins:config:secret:set",
    configSecretListKeys: "lvis:plugins:config:secret:list-keys",
    perfStats: "lvis:plugins:perf-stats",
    call: "lvis:plugins:call",
    // Lifecycle event channels (main → renderer). Not registered via ipcMain.
    installProgress: "lvis:plugins:install-progress",
    installResult: "lvis:plugins:install-result",
    uninstallResult: "lvis:plugins:uninstall-result",
    enabledChanged: "lvis:plugins:enabled-changed",
    runtimeUpdated: "lvis:plugins:runtime-updated",
  },
  bootstrap: {
    retry: "lvis:bootstrap:retry",
    // Lifecycle status event (main → renderer).
    status: "lvis:bootstrap:status",
  },
  runtime: {
    counts: "lvis:runtime:counts",
    env: "lvis:runtime:env",
  },
  marketplace: {
    ping: "lvis:marketplace:ping",
  },
  agents: {
    list: "lvis:agents:list",
    install: "lvis:agents:install",
    uninstall: "lvis:agents:uninstall",
    // Lifecycle event channels (main → renderer).
    installProgress: "lvis:agents:install-progress",
    installResult: "lvis:agents:install-result",
    uninstallResult: "lvis:agents:uninstall-result",
  },
  skills: {
    list: "lvis:skills:list",
    install: "lvis:skills:install",
    uninstall: "lvis:skills:uninstall",
    // Lifecycle event channels (main → renderer).
    installProgress: "lvis:skills:install-progress",
    installResult: "lvis:skills:install-result",
    uninstallResult: "lvis:skills:uninstall-result",
  },
  mcp: {
    servers: "lvis:mcp:servers",
    kill: "lvis:mcp:kill",
    configGet: "lvis:mcp:config:get",
    configPath: "lvis:mcp:config:path",
    configAdd: "lvis:mcp:config:add",
    configSetApiKey: "lvis:mcp:config:set-api-key",
    configRemove: "lvis:mcp:config:remove",
    uiResource: "lvis:mcp:ui-resource",
    // MCP Apps `oncalltool` — an app calls a tool on ITS OWN server (the renderer
    // supplies the card's serverId; the app never names one). INTERNAL, same posture
    // as the MCP-app channels below: absent from PUBLIC_CHANNELS /
    // EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE, so no external origin can reach
    // it (fail-closed isPublicChannel). Registered in ipc/domains/plugins.ts and
    // gated on validateHostRendererSender (state-mutating: it runs a tool). The call
    // itself is NOT authorized by the channel — it runs the same risk/consent gate as
    // any host tool call.
    callTool: "lvis:mcp:call-tool",
    // MCP Apps `onmessage` (`ui/message`) — the app asks for its text to enter the
    // conversation, or (with `_meta["lvisai/notification"]`) the notification surface.
    // The renderer binds the card's `serverId` AND its origin session id; the app
    // supplies neither. INTERNAL, same posture as `callTool`: absent from
    // PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE (fail-closed
    // isPublicChannel). Registered in ipc/domains/plugins.ts and gated on
    // validateHostRendererSender — it mutates conversation state (queues guidance /
    // stages a user-gated card) and fires OS notifications.
    uiMessage: "lvis:mcp:ui-message",
    // MCP Apps `ondownloadfile` (`ui/download-file`) — the app hands over INLINE bytes it
    // already possessed and asks the host to save them. The host never fetches an
    // app-supplied URI (a `resource_link` is rejected at parse time), so this channel
    // grants no egress; the user's own save dialog is the authorization for the write.
    // INTERNAL, same posture as `callTool` / `uiMessage`: absent from PUBLIC_CHANNELS /
    // EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE (fail-closed isPublicChannel).
    // Registered in ipc/domains/plugins.ts and gated on validateHostRendererSender —
    // state-mutating (it writes a file the user picked).
    uiDownloadFile: "lvis:mcp:ui-download-file",
    // MCP Apps `onupdatemodelcontext` (`ui/update-model-context`) — the app OVERWRITES the
    // context slot the model will see on the NEXT turn. It can never start one (the store
    // has no reference to the conversation loop), and the body is carried as untrusted
    // DATA. The renderer binds serverId + sessionId + cardId; the app supplies none.
    // INTERNAL, same posture as `callTool` / `uiMessage`: absent from PUBLIC_CHANNELS /
    // EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE (fail-closed isPublicChannel).
    // Registered in ipc/domains/plugins.ts and gated on validateHostRendererSender — it
    // mutates what the model reads next turn.
    uiModelContext: "lvis:mcp:ui-model-context",
    catalogList: "lvis:mcp:catalog:list",
    installFromMarketplace: "lvis:mcp:install-from-marketplace",
    importClaudeDesktopPreview: "lvis:mcp:import:claude-desktop:preview",
    importClaudeDesktopApply: "lvis:mcp:import:claude-desktop:apply",
    // #885 b2/b3 — MCP-app detach + disconnect. ALL THREE INTERNAL: absent from
    // PUBLIC_CHANNELS / CHANNEL_GESTURE / EXTERNAL_MUTATION_CHANNELS, so an
    // external origin (local-api / cli / plugin frame) can never reach them
    // (fail-closed isPublicChannel). `openDetached` (state-mutating, spawns a
    // window) + `detachedPayload` (read) are registered in window-manager.ts and
    // gated on validateHostRendererSender; `serverDisconnected` is a pure
    // main→renderer event (no ipcMain.handle, renderer validates payload shape).
    openDetached: "lvis:mcp:open-detached",
    detachedPayload: "lvis:mcp:detached-payload",
    serverDisconnected: "lvis:mcp:server-disconnected",
    // Renderer → main on card unmount: dispose the sandbox-proxy session so its token
    // is freed promptly instead of waiting for the global LRU to evict it. INTERNAL,
    // same posture as the three above. Idempotent and harmless — worst case a stale
    // token 404s a dead card's reload.
    disposeUiSession: "lvis:mcp:dispose-ui-session",
  },
  /** Plugin webview bridge (lvis:plugin:*) — sandboxed plugin-frame origin. */
  pluginBridge: {
    registerWebview: "lvis:plugin:register-webview",
    getEntryUrl: "lvis:plugin:get-entry-url",
    getTheme: "lvis:plugin:get-theme",
    callTool: "lvis:plugin:call-tool",
    configGet: "lvis:plugin:config:get",
    configSet: "lvis:plugin:config:set",
    storageGet: "lvis:plugin:storage:get",
    storageSet: "lvis:plugin:storage:set",
    emitEvent: "lvis:plugin:emit-event",
    // Fan-out to plugin webviews (main → plugin frame).
    event: "lvis:plugin:event",
  },
  host: {
    pluginThemeNotify: "lvis:host:plugin-theme-notify",
  },
  notification: {
    clicked: "lvis:notification:clicked",
    // In-app toast push (main → renderer).
    toast: "lvis:notification:toast",
  },
  settings: {
    get: "lvis:settings:get",
    update: "lvis:settings:update",
    setApiKey: "lvis:settings:set-api-key",
    hasApiKey: "lvis:settings:has-api-key",
    deleteApiKey: "lvis:settings:delete-api-key",
    listLlmModels: "lvis:settings:list-llm-models",
    marketplaceInstallProviderPreset: "lvis:settings:marketplace:install-provider-preset",
    marketplaceUninstallProviderPreset: "lvis:settings:marketplace:uninstall-provider-preset",
    marketplaceSetApiKey: "lvis:settings:marketplace:set-api-key",
    marketplaceHasApiKey: "lvis:settings:marketplace:has-api-key",
    marketplaceDeleteApiKey: "lvis:settings:marketplace:delete-api-key",
    setWebApiKey: "lvis:settings:set-web-api-key",
    hasWebApiKey: "lvis:settings:has-web-api-key",
    deleteWebApiKey: "lvis:settings:delete-web-api-key",
  },
  shell: {
    openExternal: "lvis:shell:open-external",
  },
  telemetry: {
    consentAnswer: "lvis:telemetry:consent-answer",
  },
  usage: {
    summary: "lvis:usage:summary",
    range: "lvis:usage:range",
    dailySummary: "lvis:usage:daily-summary",
    exportCsv: "lvis:usage:export-csv",
  },
  // ── preload-swept channel groups (C11: #1409 + #1411) ──────────────────────
  // Added so the preload surfaces (public/internal) reference the contract SOT
  // instead of inline `"lvis:*"` literals. Byte-identical to the strings the
  // preload previously inlined; registered-handler groups are cross-checked by
  // the channel-inventory snapshot.
  auth: {
    loginMockup: "lvis:auth:login-mockup",
    progress: "lvis:auth:progress",
    logoutBroadcast: "lvis:auth:logout-broadcast",
    reactivateBroadcast: "lvis:auth:reactivate-broadcast",
    logoutReset: "lvis:auth:logout-reset",
    reactivateDemo: "lvis:auth:reactivate-demo",
  },
  demo: {
    status: "lvis:demo:status",
    activate: "lvis:demo:activate",
    activateEmbedded: "lvis:demo:activate-embedded",
    activateOllama: "lvis:demo:activate-ollama",
    relaunchAfterActivation: "lvis:demo:relaunch-after-activation",
    clear: "lvis:demo:clear",
  },
  tour: {
    getState: "lvis:tour:get-state",
    markComplete: "lvis:tour:mark-complete",
    dismiss: "lvis:tour:dismiss",
    start: "lvis:tour:start",
  },
  onboarding: {
    contextSet: "lvis:onboarding:context:set",
  },
  settingsWindow: {
    open: "lvis:settings-window:open",
    saved: "lvis:settings-window:saved",
    tab: "lvis:settings-window:tab",
  },
  prompts: {
    listSummaries: "lvis:prompts:list-summaries",
    list: "lvis:prompts:list",
    save: "lvis:prompts:save",
    delete: "lvis:prompts:delete",
    updated: "lvis:prompts:updated",
  },
  trigger: {
    started: "lvis:trigger:started",
    completed: "lvis:trigger:completed",
    failed: "lvis:trigger:failed",
    expired: "lvis:trigger:expired",
    imported: "lvis:trigger:imported",
    dismiss: "lvis:trigger:dismiss",
    import: "lvis:trigger:import",
  },
  update: {
    state: "lvis:update:state",
    getState: "lvis:update:get-state",
    downloadNow: "lvis:update:download-now",
    installNow: "lvis:update:install-now",
    skipVersion: "lvis:update:skip-version",
  },
  app: {
    info: "lvis:app:info",
  },
  approval: {
    request: "lvis:approval:request",
  },
  dlp: {
    stats: "lvis:dlp:stats",
  },
  audit: {
    search: "lvis:audit:search",
    stats: "lvis:audit:stats",
  },
  // ── Diagnostics bundle + production log viewer + crash list (#1499 E2) ──────
  // ALL INTERNAL: deliberately absent from PUBLIC_CHANNELS / CHANNEL_GESTURE /
  // EXTERNAL_MUTATION_CHANNELS. A diagnostics bundle serializes redacted host
  // state (settings whitelist, audit jsonl, logs, crash-dump metadata) to a
  // user-chosen file — it must never be reachable from an external origin
  // (local-api / cli / plugin frame). The fail-closed default
  // (isPublicChannel === false) enforces that; each invoke additionally gates
  // on validateSender so a plugin-ui-shell frame cannot reach them either.
  diagnostics: {
    export: "lvis:diagnostics:export", // invoke renderer→main → { ok, path } | { ok:false, error }
    crashList: "lvis:diagnostics:crash-list", // invoke → crash-dump metadata list
  },
  logs: {
    tail: "lvis:logs:tail", // invoke (lines, level?) → redacted recent log lines
  },
  view: {
    activate: "lvis:view:activate",
  },
  sessionTodo: {
    list: "lvis:session-todo:list",
    clear: "lvis:session-todo:clear",
    changed: "lvis:session-todo:changed",
  },
  agentSpawn: {
    event: "lvis:agent-spawn:event",
  },
  skillLoad: {
    event: "lvis:skill-load:event",
  },
  window: {
    openDetached: "lvis:window:open-detached",
    closeDetached: "lvis:window:close-detached",
    listDetached: "lvis:window:list-detached",
    closeAllDetached: "lvis:window:close-all-detached",
    loadSessionInMain: "lvis:window:load-session-in-main",
    loadSessionInMainResult: "lvis:window:load-session-in-main-result",
    resizeForMode: "lvis:window:resize-for-mode",
    resizeForSidePanel: "lvis:window:resize-for-side-panel",
    openHtmlPreview: "lvis:window:open-html-preview",
    snapEdge: "lvis:window:snap-edge",
    detachedNavigate: "lvis:detached:navigate",
  },
  dev: {
    setPreflightOverride: "lvis:dev:setPreflightOverride",
    getPreflightStatus: "lvis:dev:getPreflightStatus",
  },
  attach: {
    openFile: "lvis:attach:openFile",
    readImage: "lvis:attach:readImage",
    saveClipboardImage: "lvis:attach:saveClipboardImage",
    openExternal: "lvis:attach:openExternal",
  },
  preview: {
    readFile: "lvis:preview:read-file",
  },
  workspace: {
    pickRoot: "lvis:workspace:pick-root",
    listRoots: "lvis:workspace:list-roots",
    listDir: "lvis:workspace:list-dir",
    removeRoot: "lvis:workspace:remove-root",
    reveal: "lvis:workspace:reveal",
    // Drag-drop add-root, step 1 (#1458). A dropped folder path is renderer-NAMED
    // (resolved in preload via webUtils.getPathForFile), so this handler re-runs
    // the SAME Layer-0 hard-deny + is-a-directory checks and — on success — mints
    // the one-time, MAIN-OWNED ack token that pickRoot({ackToken}) later consumes.
    // INTERNAL: deliberately absent from PUBLIC_CHANNELS so an external origin can
    // never propose a read-scope-widening path (fail-closed default).
    dropPrepare: "lvis:workspace:drop-prepare",
  },
  // ── Interactive PTY terminal (#1444, workspace rail) ──────────────────────
  // ALL INTERNAL: deliberately absent from PUBLIC_CHANNELS / CHANNEL_GESTURE /
  // EXTERNAL_MUTATION_CHANNELS. A terminal spawns arbitrary user commands, so
  // it must be unreachable from any external origin (local-api / cli / plugin
  // frame) — the fail-closed default (isPublicChannel === false) enforces that.
  // Each invoke handler additionally gates on validateHostRendererSender so a
  // plugin-ui-shell frame cannot reach them either. data/exit are main→renderer
  // events sent via safe-send/sendToWindow.
  terminal: {
    spawn: "lvis:terminal:spawn", // invoke renderer→main → { ok, tabId } | { ok:false, reason }
    input: "lvis:terminal:input", // invoke  (keystrokes → pty stdin)
    resize: "lvis:terminal:resize", // invoke  (cols/rows)
    kill: "lvis:terminal:kill", // invoke  (tab close / teardown)
    data: "lvis:terminal:data", // event   main→renderer (pty output chunk)
    exit: "lvis:terminal:exit", // event   main→renderer (pty exited)
  },
  // ── Side chat (workspace rail) — 2nd, independently-streaming chat session ──
  // ALL INTERNAL: deliberately absent from PUBLIC_CHANNELS / CHANNEL_GESTURE /
  // EXTERNAL_MUTATION_CHANNELS. Side chat drives a SECOND ConversationLoop that
  // runs arbitrary tools just like the main chat, so it must be unreachable from
  // any external origin (local-api / cli / plugin frame) — the fail-closed
  // default (isPublicChannel === false) enforces that. Each invoke additionally
  // gates on validateSender so a non-host frame is rejected. The `stream` /
  // `fallback` events are a DEDICATED channel pair (not `chat.stream`): the main
  // renderer's `onChatStream` subscriber never receives side-chat frames and vice
  // versa, so the two streams stay isolated by wire channel (No-Fallback: the
  // main path is never asked which session a frame belongs to).
  sidechat: {
    send: "lvis:sidechat:send", // invoke renderer→main → TurnResult | { ok:false }
    new: "lvis:sidechat:new", // invoke → { ok, sessionId }
    load: "lvis:sidechat:load", // invoke (sessionId) → { ok, messages }
    list: "lvis:sidechat:list", // invoke → session list (side-chat store)
    abort: "lvis:sidechat:abort", // invoke → { ok }
    stream: "lvis:sidechat:stream", // event main→renderer ({ streamId, ...frame })
    fallback: "lvis:sidechat:fallback", // event main→renderer (provider fallback)
  },
} as const;

// ─── Versioned public contract ──────────────────────────────────────────────

/**
 * Wire-contract version. Bump when the public surface (PUBLIC_CHANNELS, gesture
 * classification, or a public channel's payload shape) changes in a way an
 * external SDK/CLI must react to. Read-first callers pin this.
 */
export const CONTRACT_VERSION = "1.2.0";

/**
 * The versioned allowlist of channels an external surface (SDK / CLI / local
 * API) MAY touch. Deliberately a small, mostly-read subset:
 *   - chat send + session list/history/get-history (renderer-parity reads + send)
 *   - plugin status/list + marketplace list
 *   - permission mode (READ only — mutation stays internal + gesture-gated)
 *   - usage summary/range
 *
 * Fail-closed: anything NOT in this list is internal. The gesture-gated
 * mutating channels (permission/policy/sandbox-install) MUST never appear here
 * — enforced by the contract-version-freeze test.
 */
export const PUBLIC_CHANNELS = [
  CHANNELS.chat.send,
  CHANNELS.chat.sessions,
  CHANNELS.chat.getHistory,
  CHANNELS.chat.sessionHistory,
  CHANNELS.plugins.cards,
  CHANNELS.plugins.marketplaceList,
  PERMISSIONS.getMode,
  CHANNELS.usage.summary,
  CHANNELS.usage.range,
] as const;

/** A channel that is part of the externally-exposable public subset. */
export type PublicChannel = (typeof PUBLIC_CHANNELS)[number];

/** Is this channel in the externally-exposable public subset? (fail-closed) */
export function isPublicChannel(channel: string): channel is PublicChannel {
  return (PUBLIC_CHANNELS as readonly string[]).includes(channel);
}

/**
 * Gesture requirement per channel. `"required"` ⇒ the mutating
 * permission/policy/sandbox-install family that demands a fresh user-keyboard
 * gesture REGARDLESS of origin (see {@link ./trust-origin}). `"none"` ⇒ reads
 * (and chat send) that do not consume the gesture token.
 *
 * Public channels are all classified `"none"`. The `"required"` entries are the
 * internal mutating channels — they are listed here so the freeze test can
 * assert none of them ever leaks into {@link PUBLIC_CHANNELS}.
 */
export const CHANNEL_GESTURE: Record<string, "required" | "none"> = {
  // ── public subset (reads + chat send) — gesture: none ──
  [CHANNELS.chat.send]: "none",
  [CHANNELS.chat.sessions]: "none",
  [CHANNELS.chat.getHistory]: "none",
  [CHANNELS.chat.sessionHistory]: "none",
  [CHANNELS.plugins.cards]: "none",
  [CHANNELS.plugins.marketplaceList]: "none",
  [PERMISSIONS.getMode]: "none",
  [CHANNELS.usage.summary]: "none",
  [CHANNELS.usage.range]: "none",
  // ── mutating gesture-gated (permission / policy / sandbox-install) ──
  [PERMISSIONS.setMode]: "required",
  [PERMISSIONS.addRule]: "required",
  [PERMISSIONS.removeRule]: "required",
  [PERMISSIONS.policySet]: "required",
  [PERMISSIONS.dirDispatch]: "required",
  [PERMISSIONS.reviewerDispatch]: "required",
  [PERMISSIONS.deferredResolve]: "required",
  [PERMISSIONS.userApprovalRecord]: "required",
  [PERMISSIONS.userApprovalRevoke]: "required",
  [PERMISSIONS.sandboxWindowsInstall]: "required",
};

// ─── Approval-mediated external mutation ─────────────────────────────────────

/**
 * The allowlist of gesture-gated channels an EXTERNAL origin
 * ({@link import("./trust-origin.js").ExternalOrigin} — local-api / cli /
 * plugin-frame) MAY reach, and ONLY via an in-app {@link ../permissions/approval-gate.js}
 * consent. Every member is a `CHANNEL_GESTURE:"required"` channel that is NOT
 * in {@link PUBLIC_CHANNELS}; it stays unreachable from external origins by the
 * fail-closed default, and this list is the single, explicit exception.
 *
 * CONSENT MODEL — there is NO token bypass. An external caller cannot present a
 * credential, a stored gesture token, or any header to satisfy the gesture
 * requirement. The ONLY thing that unblocks a channel listed here is the user's
 * own approval click inside the running app: the human pressing "Allow" on the
 * ApprovalGate modal IS the explicit user action that authorizes this single
 * mutation. If the user declines or the request times out, the caller receives
 * {@link EXTERNAL_MUTATION_DENIED}.
 *
 * Every OTHER `CHANNEL_GESTURE:"required"` channel (add/remove rule, policy set,
 * dir/reviewer dispatch, deferred resolve, user-approval record/revoke, sandbox
 * install) is deliberately absent here — those remain renderer-only by design
 * and are never reachable from an external origin under any consent.
 *
 * Initially EXACTLY ONE entry: `PERMISSIONS.setMode`.
 */
export const EXTERNAL_MUTATION_CHANNELS = [
  PERMISSIONS.setMode,
] as const;

/** A channel reachable from an external origin via ApprovalGate consent. */
export type ExternalMutationChannel = (typeof EXTERNAL_MUTATION_CHANNELS)[number];

/**
 * Fail-closed error returned to an external caller when an approval-mediated
 * external mutation ({@link EXTERNAL_MUTATION_CHANNELS}) is NOT authorized —
 * the user declined the ApprovalGate consent, or the request timed out.
 */
export const EXTERNAL_MUTATION_DENIED = "external-mutation-denied";

// ─── Host-internal out-of-tree channel families ─────────────────────────────

/**
 * Channel families whose `ipcMain.handle` / `ipcMain.on` registrations live
 * OUTSIDE `src/ipc/` — the three "out-of-tree" host surfaces:
 *   - `settingsWindow` → registered in `src/main.ts` (settings BrowserWindow).
 *   - `detachedWindow` → registered in `src/main/window-manager.ts`.
 *   - `autoUpdater`    → registered in `src/main/auto-updater.ts`.
 *
 * Recorded here so the contract's public/internal classification is COMPLETE —
 * there is no longer an "unclassified" out-of-tree hole. All three are
 * INTERNAL: none appear in {@link PUBLIC_CHANNELS}, so an external
 * (local-api / cli / sdk) {@link import("./trust-origin.js").TrustOrigin} can
 * never reach them — {@link isPublicChannel} fails closed. They are host-only
 * surfaces (a first-party BrowserWindow lifecycle, detached-window management,
 * and the packaged auto-updater) with no external wire contract.
 *
 * BYTE-IDENTICAL: values mirror {@link CHANNELS} exactly, which already match
 * the literals at the registration sites. C12 only RECORDS the classification;
 * the C17 sweep replaces the inline literals at those sites with these consts.
 * `lvis:window:open-html-preview` is intentionally NOT listed — it is
 * registered in-tree by the `window` IPC domain and is already classified
 * (internal: registered-but-not-public) by the channel inventory. For the SAME
 * reason the #1499 E2 diagnostics channels (`lvis:diagnostics:export`,
 * `lvis:diagnostics:crash-list`, `lvis:logs:tail`) are NOT listed here — they
 * are registered in-tree by the `diagnostics` IPC domain and classified
 * internal (registered-but-not-public) by the channel inventory; this map is
 * ONLY for the out-of-tree host surfaces above.
 */
export const INTERNAL_HOST_CHANNELS = {
  settingsWindow: [
    CHANNELS.settingsWindow.open,
    CHANNELS.settingsWindow.saved,
    CHANNELS.settingsWindow.tab,
  ],
  detachedWindow: [
    CHANNELS.window.openDetached,
    CHANNELS.window.closeDetached,
    CHANNELS.window.listDetached,
    CHANNELS.window.closeAllDetached,
    CHANNELS.window.loadSessionInMain,
    CHANNELS.window.loadSessionInMainResult,
    CHANNELS.window.resizeForMode,
    CHANNELS.window.snapEdge,
    CHANNELS.window.detachedNavigate,
    // #885 b2 — MCP-app detach IPC handlers are registered in window-manager.ts
    // (out-of-tree), so they are classified here for inventory completeness.
    CHANNELS.mcp.openDetached,
    CHANNELS.mcp.detachedPayload,
  ],
  autoUpdater: [
    CHANNELS.update.state,
    CHANNELS.update.getState,
    CHANNELS.update.downloadNow,
    CHANNELS.update.installNow,
    CHANNELS.update.skipVersion,
  ],
} as const;
