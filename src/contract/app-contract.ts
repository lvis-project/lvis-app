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
  ROUTINES,
  WORK_BOARD,
  SETTINGS,
  OVERLAY_V1,
} from "../shared/ipc-channels.js";

// Re-export the pre-existing per-domain SOT groups so `src/contract/` is the
// single import surface for the wire contract. The preload surfaces and the
// external API/CLI/SDK surfaces consume these from here.
export {
  PERMISSIONS,
  MARKETPLACE,
  UI,
  ROUTINES,
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
 * marketplace announcements, overlay, suggested-replies, settings.updated)
 * are re-exported above rather than duplicated here.
 */
/**
 * Tiled chat groups — the main area can show more than one conversation.
 *
 * The id travels on every `lvis:chat:*` call, so it belongs to the contract
 * rather than to either side of it. A conversation is one ConversationLoop in
 * main, so a group id names a LOOP, not a view: two tiles showing the same
 * group would be two views of one conversation, which is not what a split is.
 */
export const MAIN_CHAT_GROUP_ID = "main";

/**
 * How many conversations may be tiled at once.
 *
 * Capped because each one is a live agent loop: an uncapped split would let the
 * window run more background work than the user can watch, and four is the
 * point past which a tile is too narrow to read a transcript in.
 */
export const MAX_CHAT_GROUPS = 4;

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
    // Reverse of `export` — always creates a brand-new session,
    // never overwrites. INTERNAL (mutating; not in PUBLIC_CHANNELS below).
    import: "lvis:chat:import",
    // Row-level conversation edits. INTERNAL (mutating) — the renderer may set
    // ONLY the three fields these name, never arbitrary session metadata.
    sessionUpdate: "lvis:chat:session-update",
    sessionDelete: "lvis:chat:session-delete",
    enterCheckpointView: "lvis:chat:enter-checkpoint-view",
    exitCheckpointView: "lvis:chat:exit-checkpoint-view",
    branchFromCheckpoint: "lvis:chat:branch-from-checkpoint",
    // A closed tile lets go of its conversation. INTERNAL (mutating).
    groupRelease: "lvis:chat:group-release",
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
    candidatesList: "lvis:memory:candidates:list",
    candidateActivate: "lvis:memory:candidates:activate",
    candidateDelete: "lvis:memory:candidates:delete",
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
    longTermRefresh: "lvis:memory:long-term:refresh",
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
    rollback: "lvis:plugins:rollback",
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
    contributionTrustList: "lvis:plugins:contribution-trust:list",
    contributionTrustSet: "lvis:plugins:contribution-trust:set",
    /** Trusted-renderer, LVIS_E2E-only bundle generation observation. */
    e2eBundleSnapshot: "lvis:plugins:e2e:bundle-snapshot",
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
  remoteA2a: {
    targets: "lvis:a2a-remote:targets",
    send: "lvis:a2a-remote:send",
    status: "lvis:a2a-remote:status",
    task: "lvis:a2a-remote:task",
    action: "lvis:a2a-remote:action",
  },
  // Local-owner-only Tailnet pairing/share administration. These are INTERNAL:
  // never add them to PUBLIC_CHANNELS or EXTERNAL_MUTATION_CHANNELS. A pairing
  // invite is not access, and every mutation requires a fresh local keyboard
  // intent in addition to the host-renderer sender guard.
  tailnetSharing: {
    snapshot: "lvis:tailnet-sharing:snapshot",
    createInvitation: "lvis:tailnet-sharing:create-invitation",
    activatePairing: "lvis:tailnet-sharing:activate-pairing",
    createCurrentConversationShare: "lvis:tailnet-sharing:create-current-conversation-share",
    revokeShare: "lvis:tailnet-sharing:revoke-share",
    revokePairing: "lvis:tailnet-sharing:revoke-pairing",
    // Main → renderer only. Carries no data; consumers pull a fresh safe snapshot.
    changed: "lvis:tailnet-sharing:changed",
  },
  // Local-owner-only Tailnet observer configuration. INTERNAL for the same
  // reasons as tailnetSharing: `apply` decides whether a listener comes up at
  // all, which capability key authorizes it, and whether remote control and the
  // web surface are in scope. The renderer proposes and the host persists —
  // never to the settings store, which a webpage can reach.
  tailnetObserver: {
    snapshot: "lvis:tailnet-observer:snapshot",
    apply: "lvis:tailnet-observer:apply",
  },
  // Local-owner-only Telegram private-DM connection administration. These are
  // INTERNAL for the same reasons as tailnetSharing, and additionally because
  // Telegram is an external cloud recipient: connecting is an egress decision
  // the local owner makes at the keyboard, never something a caller can drive.
  telegramConnection: {
    snapshot: "lvis:telegram-connection:snapshot",
    connect: "lvis:telegram-connection:connect",
    disconnect: "lvis:telegram-connection:disconnect",
    pause: "lvis:telegram-connection:pause",
    resume: "lvis:telegram-connection:resume",
    createPairingCode: "lvis:telegram-connection:create-pairing-code",
    revokePairing: "lvis:telegram-connection:revoke-pairing",
    approveCurrentConversation: "lvis:telegram-connection:approve-current-conversation",
    revokeApproval: "lvis:telegram-connection:revoke-approval",
    // Main → renderer only. Carries no data; consumers pull a fresh safe snapshot.
    changed: "lvis:telegram-connection:changed",
  },
  // Local-owner-only arming of the desk-armed away answerer. INTERNAL for the
  // same reasons as the two above, and additionally because arming is the one
  // gesture that lets an approval be answered while nobody is watching: it is a
  // decision the owner makes at this keyboard, in advance, and nothing reachable
  // from a message may create, extend, or widen it.
  awayAuthority: {
    status: "lvis:away-authority:status",
    arm: "lvis:away-authority:arm",
    disarm: "lvis:away-authority:disarm",
  },
  marketplace: {
    ping: "lvis:marketplace:ping",
    /** Legacy main-to-renderer update notification; kept byte-identical on wire. */
    updatesAvailable: "marketplace:updates-available",
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
    // MCP server prompt (`prompts/get`) — the USER picked a prompt the server
    // declared, and the host fetches its messages and returns them wrapped in the
    // `<mcp-prompt source="mcp-prompt:<serverId>">` provenance envelope. The
    // renderer then sends that envelope through the ordinary `chat:send` path
    // under the `mcp-prompt-emitted` origin, so nothing here starts a turn.
    // INTERNAL, same posture as `callTool` / `uiMessage`: absent from
    // PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS / CHANNEL_GESTURE (fail-closed
    // isPublicChannel). Registered in ipc/domains/plugins.ts and gated on
    // validateHostRendererSender — it reaches out to a server on the user's behalf.
    getPrompt: "lvis:mcp:get-prompt",
    // INTERNAL, same posture as `getPrompt`: the renderer asks the host to read a
    // DECLARED resource and hand back the fenced block the user attaches to their own
    // turn. The host builds the fence, never the renderer — that is what keeps the
    // untrusted framing on server text that lands beside the user's words.
    attachResource: "lvis:mcp:attach-resource",
    // The catalogue the composer's `@` mention picker offers, read from
    // `McpManager.listDeclaredResources()`.
    //
    // Why a channel rather than deriving it in the renderer from `mcp:servers`: that
    // payload carries configs, errors and transport state the picker has no business
    // seeing, and a renderer-side filter would be a second place that decides which
    // servers count. The narrow surface is the whole reason — this channel returns
    // exactly `{serverId, resources[]}` and nothing else.
    //
    // It does NOT filter for attachability, and an earlier version of this comment
    // claimed it did. `listDeclaredResources` answers "what did the host catalogue",
    // which is what the model-facing tool wants; a row the host will refuse to fetch
    // (`hostFetchRefused`, the spec's client-fetched `https:` case) is still listed and
    // is disabled by the PICKER, which answers the different question "what can be
    // attached right now".
    listResources: "lvis:mcp:list-resources",
    // The URI TEMPLATES half of that catalogue, from
    // `McpManager.listDeclaredResourceTemplates()`.
    //
    // A sibling channel rather than another field on `listResources` for the reason the
    // two projections are separate in the manager: a template's identity is its
    // `uriTemplate` and a resource's is its `uri`, so one payload carrying both would
    // make every consumer discriminate before it could validate an entry — and the
    // picker is not the only consumer this surface will ever have.
    listResourceTemplates: "lvis:mcp:list-resource-templates",
    // INTERNAL, same posture as `attachResource`, and the reason it is a SEPARATE
    // channel: the renderer sends the TEMPLATE plus the user's values, never a URI.
    // Main matches the template against what the client listed and expands it there.
    // Accepting a URI here instead would mean matching an arbitrary URI back against a
    // pattern, and a matcher for `file:///{path}` accepts `file:///../../etc/passwd`.
    attachResourceTemplate: "lvis:mcp:attach-resource-template",
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
    // #885 b3 — INTERNAL: absent from PUBLIC_CHANNELS / CHANNEL_GESTURE /
    // EXTERNAL_MUTATION_CHANNELS, so an external origin (local-api / cli / plugin
    // frame) can never reach it (fail-closed isPublicChannel). A pure main→renderer
    // event (no ipcMain.handle; the renderer validates the payload shape).
    serverDisconnected: "lvis:mcp:server-disconnected",
    // Renderer → main on card unmount: dispose the sandbox-proxy session so its token
    // is freed promptly instead of waiting for the global LRU to evict it. INTERNAL,
    // same posture as the three above. Idempotent and harmless — worst case a stale
    // token 404s a dead card's reload.
    disposeUiSession: "lvis:mcp:dispose-ui-session",
  },
  /** Plugin webview bridge (lvis:plugin:*) — sandboxed plugin-frame origin. */
  pluginBridge: {
    // Renderer → main BEFORE a plugin panel's <webview> exists: install the
    // partition's session policy (preload, network gate, asset scheme) so the
    // guest frame is never the thing that creates the partition. A frame binds
    // its URL loaders once, at first load, so a scheme installed after that
    // point is unreachable from it for the frame's whole life.
    ensurePartition: "lvis:plugin:ensure-partition",
    registerWebview: "lvis:plugin:register-webview",
    getEntryUrl: "lvis:plugin:get-entry-url",
    getTheme: "lvis:plugin:get-theme",
    callTool: "lvis:plugin:call-tool",
    requestOperationGrant: "lvis:plugin:request-operation-grant",
    configGet: "lvis:plugin:config:get",
    configSet: "lvis:plugin:config:set",
    storageGet: "lvis:plugin:storage:get",
    storageSet: "lvis:plugin:storage:set",
    emitEvent: "lvis:plugin:emit-event",
    // Fan-out to plugin webviews (main → plugin frame).
    event: "lvis:plugin:event",
  },
  /**
   * Floating dock (lvis:dock:*) — the host's always-on-top window.
   *
   * Main-to-dock unless the comment says otherwise. Separate from
   * `pluginBridge` because these are the HOST's channels: the plugin cards
   * inside the dock talk over `pluginBridge` exactly as sidebar cards do, and
   * nothing here is reachable from a plugin frame.
   */
  dock: {
    /** Replace the host's activity line. `null` clears it. */
    activity: "lvis:dock:activity",
    /** Add a plugin card to a slot. */
    mount: "lvis:dock:mount",
    /** Change one card's height. */
    resize: "lvis:dock:resize",
    /** Remove a plugin card. */
    unmount: "lvis:dock:unmount",
    /** Dock-to-main: the user pressed the dock's close control. */
    requestClose: "lvis:dock:request-close",
    /** Dock-to-main: one slot's guest died. */
    slotGone: "lvis:dock:slot-gone",
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
    // Which settings the boot environment is currently forcing ON. A read of
    // presence only — never the value of any variable.
    envForcedSettings: "lvis:settings:env-forced",
    deleteApiKey: "lvis:settings:delete-api-key",
    listLlmModels: "lvis:settings:list-llm-models",
    codexSubscriptionStatus: "lvis:settings:codex-subscription:status",
    codexSubscriptionStartBrowserLogin: "lvis:settings:codex-subscription:start-browser-login",
    codexSubscriptionStartDeviceCodeLogin: "lvis:settings:codex-subscription:start-device-code-login",
    codexSubscriptionCancelLogin: "lvis:settings:codex-subscription:cancel-login",
    codexSubscriptionLogout: "lvis:settings:codex-subscription:logout",
    codexSubscriptionListModels: "lvis:settings:codex-subscription:list-models",
    subscriptionRuntimeStatus: "lvis:settings:subscription:status",
    // Main → host renderer safe status invalidation; never carries a status payload.
    subscriptionRuntimeStatusUpdated: "lvis:settings:subscription:status-updated",
    subscriptionChooseRuntime: "lvis:settings:subscription:choose-runtime",
    subscriptionForgetRuntime: "lvis:settings:subscription:forget-runtime",
    subscriptionVerifyRuntime: "lvis:settings:subscription:verify",
    subscriptionStartLogin: "lvis:settings:subscription:start-login",
    subscriptionOpenLoginBrowser: "lvis:settings:subscription:open-login-browser",
    subscriptionCancelLogin: "lvis:settings:subscription:cancel-login",
    subscriptionLogout: "lvis:settings:subscription:logout",
    subscriptionListModels: "lvis:settings:subscription:list-models",
    subscriptionUseForChat: "lvis:settings:subscription:use-for-chat",
    subscriptionUseApiForChat: "lvis:settings:subscription:use-api-for-chat",
    acpSubscriptionStatus: "lvis:settings:acp-subscription:status",
    acpSubscriptionChooseRuntime: "lvis:settings:acp-subscription:choose-runtime",
    acpSubscriptionForgetRuntime: "lvis:settings:acp-subscription:forget-runtime",
    acpSubscriptionVerify: "lvis:settings:acp-subscription:verify",
    acpSubscriptionStartLogin: "lvis:settings:acp-subscription:start-login",
    acpSubscriptionOpenLoginBrowser: "lvis:settings:acp-subscription:open-login-browser",
    acpSubscriptionCancelLogin: "lvis:settings:acp-subscription:cancel-login",
    acpSubscriptionLogout: "lvis:settings:acp-subscription:logout",
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
    consentPrompt: "lvis:telemetry:consent-prompt",
    consentAnswer: "lvis:telemetry:consent-answer",
    allowedHosts: "lvis:telemetry:allowed-hosts",
  },
  usage: {
    summary: "lvis:usage:summary",
    range: "lvis:usage:range",
    dailySummary: "lvis:usage:daily-summary",
    exportCsv: "lvis:usage:export-csv",
  },
  // ── preload-swept channel groups ───────────────────────────────────────────
  // Added so the preload surfaces (public/internal) reference the contract SOT
  // instead of inline `"lvis:*"` literals. Byte-identical to the strings the
  // preload previously inlined; registered-handler groups are cross-checked by
  // the channel-inventory snapshot.
  tour: {
    getState: "lvis:tour:get-state",
    markComplete: "lvis:tour:mark-complete",
    dismiss: "lvis:tour:dismiss",
    start: "lvis:tour:start",
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
  // ── Diagnostics bundle + production log viewer + crash list ──────
  // ALL INTERNAL: deliberately absent from PUBLIC_CHANNELS / CHANNEL_GESTURE /
  // EXTERNAL_MUTATION_CHANNELS. A diagnostics bundle serializes redacted host
  // state (settings whitelist, audit jsonl, logs, crash-dump metadata) to a
  // user-chosen file — it must never be reachable from an external origin
  // (local-api / cli / plugin frame). The fail-closed default
  // (isPublicChannel === false) enforces that; each invoke additionally gates
  // on validateHostRendererSender so a plugin-ui-shell frame cannot reach them
  // either.
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
    minimize: "window:minimize",
    toggleMaximize: "window:toggleMaximize",
    close: "window:close",
    syncTitleBarTheme: "window:syncTitleBarTheme",
    maximizedChanged: "window:maximizedChanged",
    fullscreenChanged: "window:fullscreenChanged",
    resizeForMode: "lvis:window:resize-for-mode",
    resizeForSidePanel: "lvis:window:resize-for-side-panel",
    openHtmlPreview: "lvis:window:open-html-preview",
  },
  dev: {
    setPreflightOverride: "lvis:dev:setPreflightOverride",
    getPreflightStatus: "lvis:dev:getPreflightStatus",
  },
  attach: {
    openFile: "lvis:attach:openFile",
    readImage: "lvis:attach:readImage",
    saveClipboardImage: "lvis:attach:saveClipboardImage",
    discardClipboardImage: "lvis:attach:discardClipboardImage",
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
  // gates on validateHostRendererSender so a non-host frame is rejected. The `stream` /
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
  [PERMISSIONS.approvalSentenceSelect]: "required",
  [PERMISSIONS.userApprovalRecord]: "required",
  [PERMISSIONS.userApprovalRevoke]: "required",
  [PERMISSIONS.sandboxWindowsInstall]: "required",
  // Local-owner Tailnet sharing: all mutations are host-renderer-only and
  // require a current keyboard intent. The snapshot and change hint carry no
  // externally callable mutation capability, so they are deliberately omitted.
  [CHANNELS.tailnetSharing.createInvitation]: "required",
  [CHANNELS.tailnetSharing.activatePairing]: "required",
  [CHANNELS.tailnetSharing.createCurrentConversationShare]: "required",
  [CHANNELS.tailnetSharing.revokeShare]: "required",
  [CHANNELS.tailnetSharing.revokePairing]: "required",
  // Enabling the observer, moving its port, or widening its scope is an owner
  // decision made at this keyboard, exactly like a share.
  [CHANNELS.tailnetObserver.apply]: "required",
  // Local-owner Telegram connection: same rule. Saving a bot token, starting
  // the outbound connection, minting a pairing code, and sharing the open
  // conversation are each an owner decision made at this keyboard.
  [CHANNELS.telegramConnection.connect]: "required",
  [CHANNELS.telegramConnection.disconnect]: "required",
  [CHANNELS.telegramConnection.pause]: "required",
  [CHANNELS.telegramConnection.resume]: "required",
  [CHANNELS.telegramConnection.createPairingCode]: "required",
  [CHANNELS.telegramConnection.revokePairing]: "required",
  [CHANNELS.telegramConnection.approveCurrentConversation]: "required",
  [CHANNELS.telegramConnection.revokeApproval]: "required",
  // Away authority: arming is the gesture, so it needs the gesture. Disarming
  // is listed too — not because withdrawing authority is dangerous, but because
  // a caller that could disarm without a keyboard could disarm the owner's
  // grant out from under them and time the gap.
  [CHANNELS.awayAuthority.arm]: "required",
  [CHANNELS.awayAuthority.disarm]: "required",
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
 * ApprovalGate dock IS the explicit user action that authorizes this single
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

/**
 * Payload of the `plugins.installResult` / `plugins.uninstallResult` broadcasts
 * (main -> renderer). Single declaration for the channel: the preload bridge,
 * the renderer API type and the toast handler all read this one, so a field the
 * producer attaches cannot go missing on the way to the UI.
 *
 * `error` is the stable English IPC code when one exists (e.g.
 * `incompatible-app-version`) and the plain message otherwise; `message` is the
 * human detail that accompanies a code. Together they are exactly the pair
 * `formatIpcError(error, message)` consumes — pass both, never render `error`
 * raw, or the user sees the bare code.
 */
export interface PluginInstallResultPayload {
  slug: string;
  success: boolean;
  error?: string;
  message?: string;
}

/**
 * Payload of the `agents.installResult` / `agents.uninstallResult` broadcasts.
 *
 * Extends the plugin shape rather than restating it: the status-bar toast runs
 * one handler for all three package families, so the `error`/`message` pair has
 * to mean the same thing here. `agentId` is the success-only field — a failed
 * install never resolved one.
 */
export interface AgentInstallResultPayload extends PluginInstallResultPayload {
  agentId?: string;
}

/** Skill twin of {@link AgentInstallResultPayload}. */
export interface SkillInstallResultPayload extends PluginInstallResultPayload {
  skillId?: string;
}
