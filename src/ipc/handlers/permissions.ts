/**
 * permissions.ts (handlers) — transport-agnostic PUBLIC permission handler logic
 * (#1409 C10).
 *
 * Pure `handle*` function behind the PUBLIC `permission get-mode` channel. READ
 * ONLY — permission MUTATION stays internal + gesture-gated in
 * `domains/permissions.ts` and is deliberately never exposed here. Imports
 * NOTHING from the electron transport.
 */
import type { IpcDeps } from "../types.js";

/** PUBLIC `lvis:permission:get-mode` — current permission mode (read-only). */
export function handleGetMode(deps: IpcDeps): { mode: string } {
  const mode = deps.conversationLoop.permissionManager?.getMode() ?? "default";
  return { mode };
}
