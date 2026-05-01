/**
 * Usage domain IPC handlers.
 * Covers: lvis:usage:*
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";

export function registerUsageHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  // read-only, sender guard optional
  ipcMain.handle("lvis:usage:summary", async (_e, days?: number) => {
    const { getUsageSummary } = await import("../../engine/usage-stats.js");
    return getUsageSummary(typeof days === "number" ? days : 60);
  });

  // read-only; sender guard optional but added for cross-window consistency
  ipcMain.handle("lvis:usage:range", async (e, opts: { dateFrom: string; dateTo: string }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:usage:range", e); return UNAUTHORIZED_FRAME; }
    const { getUsageRange } = await import("../../engine/usage-stats.js");
    return getUsageRange(opts);
  });

  ipcMain.handle("lvis:usage:export-csv", async (e, rows: Array<Record<string, string | number>>) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:usage:export-csv", e); return UNAUTHORIZED_FRAME; }
    const { dialog, BrowserWindow } = await import("electron");
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath: "lvis-usage.csv", filters: [{ name: "CSV", extensions: ["csv"] }] })
      : await dialog.showSaveDialog({ defaultPath: "lvis-usage.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const { writeFileSync } = await import("node:fs");
    const headers = ["date", "vendor", "model", "inputTokens", "outputTokens", "totalTokens", "cost"];
    const lines = [
      headers.join(","),
      ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? "")).join(",")),
    ];
    writeFileSync(result.filePath, lines.join("\n"), "utf-8");
    return { ok: true, filePath: result.filePath };
  });
}
