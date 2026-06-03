/**
 * Audit domain IPC handlers.
 * Covers: lvis:audit:*, lvis:dlp:*
 */
import { ipcMain } from "electron";
import type { IpcDeps } from "../types.js";

export function registerAuditHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  // read-only, sender guard optional
  ipcMain.handle("lvis:audit:search", async (_e, filter: Parameters<typeof auditLogger.search>[0]) => {
    return auditLogger.search(filter);
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:audit:stats", async (_e, lastDays: number) => {
    return auditLogger.getStats(typeof lastDays === "number" ? lastDays : 7);
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:dlp:stats", async (_e, days: number) => {
    const { getDlpStats } = await import("../../audit/dlp-stats.js");
    return getDlpStats(typeof days === "number" ? days : 7);
  });
}
