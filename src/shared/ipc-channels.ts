/**
 * IPC channel name constants — single source of truth.
 *
 * All main-process handlers, preload bridges, and renderer callers
 * reference these constants so hardcoded channel strings are eliminated.
 */

/**
 * Overlay IPC channels for main→renderer overlay state sync.
 *
 * main → renderer: show / update / dismiss (pushed from plugin-runtime overlay runner)
 */
export const OVERLAY_V1 = {
  /** main → renderer: push a new OverlayItem into the renderer queue */
  show: "lvis:overlay:show",
  /** main → renderer: patch an existing OverlayItem (e.g. running→done) */
  update: "lvis:overlay:update",
  /** main → renderer: remove an item by id */
  dismiss: "lvis:overlay:dismiss",
} as const;

export const ROUTINES = {
  list: "lvis:routines:list",
  add: "lvis:routines:add",
  dismiss: "lvis:routines:dismiss",
  remove: "lvis:routines:remove",
  triggerNow: "lvis:routines:trigger-now",
  fired: "lvis:routines:fired",
  pendingResults: "lvis:routines:pending-results",
  acknowledgeResult: "lvis:routines:ack-result",
  listSessions: "lvis:routines:list-sessions",
  // Running indicator events (renderer reflects LLM session progress)
  runningStarted: "lvis:routines:running-started",
  runningFinished: "lvis:routines:running-finished",
  // Emitted when an LLM session errors out so renderer can clear running state
  failed: "lvis:routines:failed",
} as const;

export const WORK_BOARD = {
  list: "lvis:work-board:list",
  get: "lvis:work-board:get",
  add: "lvis:work-board:add",
  update: "lvis:work-board:update",
  transition: "lvis:work-board:transition",
  complete: "lvis:work-board:complete",
  reopen: "lvis:work-board:reopen",
  remove: "lvis:work-board:remove",
  // Emitted by the work-board IPC domain after any successful mutation
  // (created/updated/transitioned/completed/reopened/removed) so the renderer
  // board view re-lists without polling.
  itemChanged: "lvis:work-board:item-changed",
  // Renderer → main: kick off a plan→approve→execute run for one item.
  // Fire-and-forget; the renderer tracks completion via the run-progress
  // events below (mirroring the ROUTINES running-* pattern).
  run: "lvis:work-board:run",
  // Main → renderer: per-phase liveness for an in-flight run (WorkBoardRunEvent).
  runProgress: "lvis:work-board:run-progress",
  // Main → renderer: terminal markers so the renderer can clear running state.
  runStarted: "lvis:work-board:run-started",
  runFinished: "lvis:work-board:run-finished",
  runFailed: "lvis:work-board:run-failed",
  // Renderer → main: generate a daily / weekly personal work report from the
  // board state + activity log + learned memory. Returns the markdown.
  generateReport: "lvis:work-board:generate-report",
  // Renderer → main: read a past run's persisted transcript
  // (sessions/<itemId>/<runId>.jsonl) for the run-history view.
  runTranscript: "lvis:work-board:run-transcript",
} as const;

export const PERMISSIONS = {
  getMode: "lvis:permission:get-mode",
  setMode: "lvis:permission:set-mode",
  modeChanged: "lvis:permissions:mode-changed",
  listRules: "lvis:permission:list-rules",
  addRule: "lvis:permission:add-rule",
  removeRule: "lvis:permission:remove-rule",
  approvalRespond: "lvis:approval:respond",
  policyGet: "lvis:policy:get",
  policySet: "lvis:policy:set",
  dirDispatch: "lvis:permissions:dir-dispatch",
  reviewerDispatch: "lvis:permissions:reviewer-dispatch",
  reviewerProviderHasKey: "lvis:permissions:reviewer-provider-has-key",
  deferredList: "lvis:permissions:deferred-list",
  deferredResolve: "lvis:permissions:deferred-resolve",
  deferredPending: "lvis:permissions:deferred-pending",
  auditShow: "lvis:permissions:audit-show",
  auditVerify: "lvis:permissions:audit-verify",
  hookTrustList: "lvis:permissions:hook-trust-list",
  manifestViolation: "lvis:permissions:manifest-violation",
  // Read-only: OS sandbox capability for the current platform — drives the

  sandboxCapability: "lvis:permissions:sandbox-capability",
  // Read-only: Windows srt-win install readiness (group + WFP state) + the
  // verbatim ASRT install instructions. Drives the win32 consent panel in
  // PermissionsTab. Non-win32 returns a clean "not-applicable" shape.
  sandboxWindowsStatus: "lvis:permissions:sandbox-windows-status",
  // MUTATING (sender-frame-guarded): the ONLY user-consented privilege
  // escalation entry point — triggers ASRT installWindowsSandbox's single
  // self-elevating UAC prompt. Never auto-triggered.
  sandboxWindowsInstall: "lvis:permissions:sandbox-windows-install",
  // `/allow <sentence>` — resolve a user sentence onto one of the PENDING
  // approval's own scopes. Gesture-gated because only a keyboard-origin
  // submission may speak for the user, but it grants nothing on its own: the
  // reply names a button the card already renders, and that button still has
  // to be pressed.
  approvalSentenceSelect: "lvis:permissions:approval-sentence-select",
  // User-approval store
  userApprovalRecord: "lvis:permissions:user-approval-record",
  userApprovalRevoke: "lvis:permissions:user-approval-revoke",
  userApprovalList: "lvis:permissions:user-approval-list",
  // 4.1: memory-hit auto-approve disclosure (main → renderer)
  userApprovalHit: "lvis:permissions:user-approval-hit",
  // Default-mode approval pattern hint (main → renderer)
  reviewSuggestion: "lvis:permissions:review-suggestion",
  // Broadcast: directory config changed (main → all renderers). Emitted
  // when allowed-directories list mutates (session-add, slash-allow,
  // PermissionsTab dirDispatch). Multi-window PermissionsTab subscribes
  // to refresh its "session additions" view without manual reload.
  configChanged: "lvis:permissions:config-changed",
} as const;

export const SETTINGS = {
  updated: "lvis:settings:updated",
} as const;

export const MARKETPLACE = {
  announcements: "lvis:marketplace:announcements",
} as const;

export const UI = {
  assistantContextMenu: "lvis:ui:assistant-context-menu",
  assistantContextAction: "lvis:ui:assistant-context-action",
  nativeContextMenu: "lvis:ui:native-context-menu",
  nativeContextAction: "lvis:ui:native-context-action",
} as const;
