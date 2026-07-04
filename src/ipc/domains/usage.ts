/**
 * Usage domain IPC handlers.
 * Covers: lvis:usage:*
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { handleUsageSummary, handleUsageRange, handleUsageDailySummary, type UsageDailySummaryInput } from "../handlers/usage.js";

export function registerUsageHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  // read-only, sender guard optional
  ipcMain.handle(CHANNELS.usage.summary, async (_e, days?: number) => handleUsageSummary(days));

  // read-only; sender guard optional but added for cross-window consistency
  ipcMain.handle(CHANNELS.usage.range, async (e, opts: { dateFrom: string; dateTo: string }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.usage.range, e); return UNAUTHORIZED_FRAME; }
    return handleUsageRange(opts);
  });

  ipcMain.handle(CHANNELS.usage.dailySummary, async (e, input: UsageDailySummaryInput) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.usage.dailySummary, e); return UNAUTHORIZED_FRAME; }
    return handleUsageDailySummary(deps.conversationLoop, input);
  });

  ipcMain.handle(CHANNELS.usage.exportCsv, async (e, rows: Array<Record<string, string | number>>) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.usage.exportCsv, e); return UNAUTHORIZED_FRAME; }
    const { dialog, BrowserWindow } = await import("electron");
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath: "lvis-usage.csv", filters: [{ name: "CSV", extensions: ["csv"] }] })
      : await dialog.showSaveDialog({ defaultPath: "lvis-usage.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const { writeFileSync } = await import("node:fs");
    const headers = [
      "date",
      "vendor",
      "model",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "totalTokens",
      "cost",
      "unknownCostTurns",
    ];
    const lines = [
      headers.join(","),
      ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? "")).join(",")),
    ];
    writeFileSync(result.filePath, lines.join("\n"), "utf-8");
    return { ok: true, filePath: result.filePath };
  });
}
