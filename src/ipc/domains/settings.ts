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

/** Minor-1: extracted helper — 6 handlers share identical 5-line broadcast. */
function broadcastSettingsSnapshot(deps: IpcDeps): void {
  const snapshot = deps.settingsService.getAll();
  for (const win of deps.getAppWindows?.() ?? []) {
    sendToWindow(win, SETTINGS.updated, snapshot);
  }
}

export function registerSettingsHandlers(deps: IpcDeps): void {
  const { settingsService, conversationLoop, auditLogger } = deps;

  // read-only — no sender guard needed
  ipcMain.handle("lvis:settings:get", () => settingsService.getAll());

  ipcMain.handle("lvis:settings:update", async (e, partial) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:update", e); return UNAUTHORIZED_FRAME; }
    // LOW-2: validate vendors["azure-foundry"].baseUrl at write time so an invalid
    // Foundry endpoint is rejected before it reaches the settings store.
    const foundryPatch = (partial as Record<string, unknown> | null | undefined)
      ?.llm as Record<string, unknown> | undefined;
    const foundryVendorPatch = (foundryPatch?.vendors as Record<string, unknown> | undefined)
      ?.["azure-foundry"] as Record<string, unknown> | undefined;
    if (foundryVendorPatch?.baseUrl !== undefined) {
      // Minor-4: reject non-string values explicitly before String() coercion.
      if (typeof foundryVendorPatch.baseUrl !== "string") {
        return { ok: false, error: "invalid-foundry-endpoint", message: "baseUrl must be a string" };
      }
      const { validateFoundryEndpoint } = await import(
        "../../permissions/reviewer/provider-adapters.js"
      );
      try {
        validateFoundryEndpoint(foundryVendorPatch.baseUrl);
      } catch (err) {
        return { ok: false, error: "invalid-foundry-endpoint", message: (err as Error).message };
      }
    }
    // MAJOR-2: detect baseUrl change before patching so cacheScope.endpoint refreshes.
    const prevBaseUrl = settingsService.get("llm").vendors?.["azure-foundry"]?.baseUrl ?? null;
    // PR #795 follow-up: the MarketplaceTab "즉시 적용" badge on the SSRF-bypass
    // toggle promised next-request activation, but the marketplace fetcher was
    // capturing the flag at boot only. Detect a change here and call the boot
    // closure that pushes the new value into the live fetcher instance.
    const prevAllowPrivate =
      settingsService.get("marketplace").realCloudAllowPrivateNetwork ?? false;
    const result = await settingsService.patch(partial);
    const newBaseUrl = settingsService.get("llm").vendors?.["azure-foundry"]?.baseUrl ?? null;
    const newAllowPrivate =
      settingsService.get("marketplace").realCloudAllowPrivateNetwork ?? false;
    if (prevBaseUrl !== newBaseUrl) {
      deps.rewireReviewerAgent?.();
    }
    if (prevAllowPrivate !== newAllowPrivate) {
      deps.refreshMarketplaceFetcherConfig?.();
    }
    conversationLoop.refreshProvider();
    // #893 — vendor/baseUrl may have changed; re-sync the plugin wildcard so
    // `hostApi.config.get("hostApiKey")` stays consistent with the active vendor.
    deps.refreshActiveLlmWildcard?.();
    broadcastSettingsSnapshot(deps);
    return result;
  });

  ipcMain.handle("lvis:settings:set-api-key", async (e, vendor: string, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:set-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret(`llm.apiKey.${vendor}`, apiKey);
    conversationLoop.refreshProvider();
    // MAJOR-2: rewire reviewer when provider key changes so cacheScope refreshes.
    deps.rewireReviewerAgent?.();
    // #893 — refresh plugin wildcard with the new key for the active vendor.
    deps.refreshActiveLlmWildcard?.();
    // Broadcast settings snapshot so reviewer tab can auto-unlock without a full reload.
    broadcastSettingsSnapshot(deps);
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
    // MAJOR-2: rewire reviewer when provider key is removed so cacheScope refreshes.
    deps.rewireReviewerAgent?.();
    // #893 — refresh plugin wildcard so the now-missing key is cleared.
    deps.refreshActiveLlmWildcard?.();
    broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  // ─── Marketplace API Key ──────────────────────
  ipcMain.handle("lvis:settings:marketplace:set-api-key", async (e, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:marketplace:set-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret("marketplace.apiKey", apiKey);
    broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  ipcMain.handle("lvis:settings:marketplace:has-api-key", () =>
    settingsService.getSecret("marketplace.apiKey") != null,
  );

  ipcMain.handle("lvis:settings:marketplace:delete-api-key", async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:marketplace:delete-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret("marketplace.apiKey");
    broadcastSettingsSnapshot(deps);
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
    broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  // read-only — sender guard optional
  ipcMain.handle("lvis:settings:has-web-api-key", (_e, provider: string) => {
    return settingsService.getSecret(`web.apiKey.${provider}`) !== null;
  });

  ipcMain.handle("lvis:settings:delete-web-api-key", async (e, provider: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:delete-web-api-key", e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret(`web.apiKey.${provider}`);
    broadcastSettingsSnapshot(deps);
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
