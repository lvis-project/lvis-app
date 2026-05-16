/**
 * Settings domain IPC handlers.
 * Covers: lvis:settings:*, lvis:shell:open-external, lvis:telemetry:consent-answer
 */
import { ipcMain } from "electron";
import { validateExternalUrl } from "../../shared/external-url.js";
import { SETTINGS } from "../../shared/ipc-channels.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { sendToWindow } from "../safe-send.js";
import type { IpcDeps } from "../types.js";

export function registerSettingsHandlers(deps: IpcDeps): void {
  const { settingsService, conversationLoop, auditLogger, getAppWindows } = deps;

  // read-only — no sender guard needed
  ipcMain.handle("lvis:settings:get", () => settingsService.getAll());

  ipcMain.handle("lvis:settings:update", async (e, partial) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:update", e); return UNAUTHORIZED_FRAME; }
    const result = await settingsService.patch(partial);
    conversationLoop.refreshProvider();
    for (const win of getAppWindows?.() ?? []) {
      sendToWindow(win, SETTINGS.updated, result);
    }
    return result;
  });

  ipcMain.handle("lvis:settings:set-api-key", async (e, vendor: string, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:set-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret(`llm.apiKey.${vendor}`, apiKey);
    conversationLoop.refreshProvider();
    // Broadcast settings snapshot so reviewer tab can auto-unlock without a full reload.
    const snapshot = settingsService.getAll();
    for (const win of getAppWindows?.() ?? []) {
      sendToWindow(win, SETTINGS.updated, snapshot);
    }
    return { ok: true };
  });

  // read-only — sender guard optional
  ipcMain.handle("lvis:settings:has-api-key", (_e, vendor?: string) => {
    const v = vendor ?? settingsService.get("llm").provider;
    return settingsService.getSecret(`llm.apiKey.${v}`) !== null;
  });

  ipcMain.handle("lvis:settings:delete-api-key", async (e, vendor: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:delete-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret(`llm.apiKey.${vendor}`);
    conversationLoop.refreshProvider();
    // Broadcast settings snapshot so reviewer tab reflects key removal immediately.
    const snapshot = settingsService.getAll();
    for (const win of getAppWindows?.() ?? []) {
      sendToWindow(win, SETTINGS.updated, snapshot);
    }
    return { ok: true };
  });

  // ─── Marketplace API Key ──────────────────────
  ipcMain.handle("lvis:settings:marketplace:set-api-key", async (e, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:marketplace:set-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret("marketplace.apiKey", apiKey);
    return { ok: true };
  });

  ipcMain.handle("lvis:settings:marketplace:has-api-key", () =>
    settingsService.getSecret("marketplace.apiKey") != null,
  );

  ipcMain.handle("lvis:settings:marketplace:delete-api-key", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:marketplace:delete-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret("marketplace.apiKey");
    return { ok: true };
  });

  // ─── Shell external link ───────────────────────────
  ipcMain.handle("lvis:shell:open-external", async (e, url: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:shell:open-external", e); return UNAUTHORIZED_FRAME; }
    const { shell } = await import("electron");
    const validated = validateExternalUrl(url);
    if (!validated.ok) return validated;
    try {
      await shell.openExternal(validated.url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "open-failed", message: (err as Error)?.message };
    }
  });

  // ─── Web Search Keys ───────────────────────────
  ipcMain.handle("lvis:settings:set-web-api-key", async (e, provider: string, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:set-web-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret(`web.apiKey.${provider}`, apiKey);
    return { ok: true };
  });

  // read-only — sender guard optional
  ipcMain.handle("lvis:settings:has-web-api-key", (_e, provider: string) => {
    return settingsService.getSecret(`web.apiKey.${provider}`) !== null;
  });

  ipcMain.handle("lvis:settings:delete-web-api-key", async (e, provider: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:delete-web-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret(`web.apiKey.${provider}`);
    return { ok: true };
  });

  // ─── Telemetry consent ────────────────────────
  ipcMain.handle("lvis:telemetry:consent-answer", async (e, accepted: boolean) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:telemetry:consent-answer", e); return UNAUTHORIZED_FRAME; }
    await settingsService.patch({
      telemetry: {
        ...settingsService.get("telemetry"),
        telemetryPromptAnswered: true,
        enabled: accepted === true,
      },
    });
    return { ok: true };
  });
}
