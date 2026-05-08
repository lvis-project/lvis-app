/**
 * IPC channel name constants — single source of truth.
 *
 * All main-process handlers, preload bridges, and renderer callers
 * reference these constants so hardcoded channel strings are eliminated.
 */

export const ROUTINES_V2 = {
  list: "lvis:routines:v2:list",
  add: "lvis:routines:v2:add",
  dismiss: "lvis:routines:v2:dismiss",
  remove: "lvis:routines:v2:remove",
  triggerNow: "lvis:routines:v2:trigger-now",
  fired: "lvis:routines:v2:fired",
  listSessions: "lvis:routines:v2:list-sessions",
  readSession: "lvis:routines:v2:read-session",
} as const;
