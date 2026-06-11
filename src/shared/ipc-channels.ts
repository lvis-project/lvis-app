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

export const ROUTINES_V2 = {
  list: "lvis:routines:v2:list",
  add: "lvis:routines:v2:add",
  dismiss: "lvis:routines:v2:dismiss",
  remove: "lvis:routines:v2:remove",
  triggerNow: "lvis:routines:v2:trigger-now",
  fired: "lvis:routines:v2:fired",
  pendingResults: "lvis:routines:v2:pending-results",
  acknowledgeResult: "lvis:routines:v2:ack-result",
  listSessions: "lvis:routines:v2:list-sessions",
  // Running indicator events (renderer reflects LLM session progress)
  runningStarted: "lvis:routines:v2:running-started",
  runningFinished: "lvis:routines:v2:running-finished",
  // Emitted when an LLM session errors out so renderer can clear running state
  failed: "lvis:routines:v2:failed",
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
  // User-approval store
  userApprovalRecord: "lvis:permissions:user-approval-record",
  userApprovalRevoke: "lvis:permissions:user-approval-revoke",
  userApprovalList: "lvis:permissions:user-approval-list",
  // 4.1: memory-hit auto-approve disclosure (main → renderer)
  userApprovalHit: "lvis:permissions:user-approval-hit",
  // Broadcast: directory config changed (main → all renderers). Emitted
  // when allowed-directories list mutates (session-add, slash-allow,
  // PermissionsTab dirDispatch). Multi-window PermissionsTab subscribes
  // to refresh its "session additions" view without manual reload.
  configChanged: "lvis:permissions:config-changed",
} as const;

export const SETTINGS = {
  updated: "lvis:settings:updated",
  /** Persist the manual host-resolver map then relaunch to apply it. */
  applyHostMap: "lvis:settings:apply-host-map",
} as const;

export const UI = {
  assistantContextMenu: "lvis:ui:assistant-context-menu",
  assistantContextAction: "lvis:ui:assistant-context-action",
} as const;

export const SUGGESTED_REPLIES = {
  updated: "lvis:chat:suggested-replies-updated",
} as const;
