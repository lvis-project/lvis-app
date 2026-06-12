/**
 * Settings domain IPC handlers.
 * Covers: lvis:settings:*, lvis:shell:open-external, lvis:telemetry:consent-answer
 */
import { app, ipcMain } from "electron";
import { validateExternalUrl } from "../../shared/external-url.js";
import { SETTINGS } from "../../shared/ipc-channels.js";
import { validateSender, validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { sendToWindow } from "../safe-send.js";
import { setLocale } from "../../i18n/index.js";
import type { IpcDeps } from "../types.js";
import type { LLMSettings } from "../../data/settings-store.js";

/** Minor-1: extracted helper — 6 handlers share identical 5-line broadcast. */
function broadcastSettingsSnapshot(deps: IpcDeps): void {
  const snapshot = deps.settingsService.getAll();
  // Keep the main-process UI locale in sync with the persisted language so
  // dialogs/menus/notifications shown after a language switch use it too.
  // Optional-chain `appearance` — a partial snapshot (e.g. a test double or a
  // pre-migration settings file) must not crash the broadcast. setLocale
  // coerces undefined to the English default.
  setLocale(snapshot.appearance?.language);
  for (const win of deps.getAppWindows?.() ?? []) {
    sendToWindow(win, SETTINGS.updated, snapshot);
  }
}

function activeLlmIdentity(llm: LLMSettings): string {
  const provider = llm.provider;
  const block = llm.vendors?.[provider];
  return JSON.stringify({
    provider,
    model: block?.model ?? null,
    baseUrl: block?.baseUrl ?? null,
    vertexProject: block?.vertexProject ?? null,
    vertexLocation: block?.vertexLocation ?? null,
  });
}

export function registerSettingsHandlers(deps: IpcDeps): void {
  const { settingsService, conversationLoop, auditLogger } = deps;

  // read-only — no sender guard needed
  ipcMain.handle("lvis:settings:get", () => settingsService.getAll());

  ipcMain.handle("lvis:settings:update", async (e, partial) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:settings:update", e); return UNAUTHORIZED_FRAME; }
    const llmPatch = (partial as Record<string, unknown> | null | undefined)
      ?.llm as Record<string, unknown> | undefined;
    if (
      llmPatch &&
      Object.prototype.hasOwnProperty.call(llmPatch, "hostResolverMap")
    ) {
      return {
        ok: false,
        error: "host-map-requires-apply-host-map",
        message: "hostResolverMap must be changed via applyHostMap",
      };
    }
    // LOW: validate vendors["azure-foundry"].baseUrl at write time so an invalid
    // Foundry endpoint is rejected before it reaches the settings store.
    const foundryVendorPatch = (llmPatch?.vendors as Record<string, unknown> | undefined)
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
    // Reviewer LLM follows the active chat provider/model. Capture the
    // active identity before patching so provider/model/baseUrl/Vertex changes
    // can refresh reviewer wiring and cache scope immediately.
    const prevLlm = settingsService.get("llm");
    const prevActiveLlmIdentity = activeLlmIdentity(prevLlm);
    // MAJOR-2 legacy guard: still detect Foundry baseUrl changes even when
    // the active provider is not Foundry, preserving the prior explicit rewire.
    const prevBaseUrl = prevLlm.vendors?.["azure-foundry"]?.baseUrl ?? null;
    // PR #795 follow-up: the MarketplaceTab "즉시 적용" badge on the SSRF-bypass
    // toggle promised next-request activation, but the marketplace fetcher was
    // capturing the flag at boot only. Detect a change here and call the boot
    // closure that pushes the new value into the live fetcher instance.
    const prevAllowPrivate =
      settingsService.get("marketplace").cloudAllowPrivateNetwork ?? false;
    const result = await settingsService.patch(partial);
    const newLlm = settingsService.get("llm");
    const newActiveLlmIdentity = activeLlmIdentity(newLlm);
    const newBaseUrl = newLlm.vendors?.["azure-foundry"]?.baseUrl ?? null;
    const newAllowPrivate =
      settingsService.get("marketplace").cloudAllowPrivateNetwork ?? false;
    if (prevBaseUrl !== newBaseUrl || prevActiveLlmIdentity !== newActiveLlmIdentity) {
      try {
        deps.rewireReviewerAgent?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await settingsService.replaceLlm(prevLlm);
        } catch (rollbackErr) {
          const rollbackMessage =
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          return {
            ok: false,
            error: "reviewer-rewire-failed",
            message: `${message}; rollback failed: ${rollbackMessage}`,
          };
        }
        try {
          deps.rewireReviewerAgent?.();
        } catch {
          // The active LLM settings have been rolled back. Keep the IPC error
          // focused on the original failing rewire; a second failure leaves the
          // app on the same fail-closed reviewer path it had before the patch.
        }
        if (prevAllowPrivate !== newAllowPrivate) {
          deps.refreshMarketplaceFetcherConfig?.();
        }
        conversationLoop.refreshProvider();
        deps.refreshActiveLlmWildcard?.();
        broadcastSettingsSnapshot(deps);
        return { ok: false, error: "reviewer-rewire-failed", message };
      }
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

  // ─── Manual host-resolver map (requires relaunch) ─────────────────
  //
  // Chromium's `host-resolver-rules` command-line switch is frozen once
  // the network service starts (`app.whenReady()`). Updating it therefore
  // requires saving the new map then calling `app.relaunch()` + `app.exit()`
  // so the next process reads the updated settings and installs the switch
  // before any network service initialisation.
  //
  // The UI shows a confirm dialog before calling this IPC, so the user has
  // already acknowledged the restart. The main process reacts immediately.
  ipcMain.handle(SETTINGS.applyHostMap, async (e, hostResolverMap: unknown) => {
    // Sensitive + relaunch-triggering channel: use the stricter host-renderer
    // validator (fails closed on empty frame URLs, rejects plugin-ui-shell
    // frames) rather than the base `validateSender`.
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, SETTINGS.applyHostMap, e); return UNAUTHORIZED_FRAME; }
    // Payload guard — the renderer should only ever send a string, but reject
    // a malformed payload before it reaches the settings store.
    if (typeof hostResolverMap !== "string") {
      return { ok: false, error: "invalid-host-map", message: "hostResolverMap must be a string" };
    }
    // The host map is only honoured in manual auth mode (demo/login uses
    // LVIS_DEMO_HOST_MAP). Login-mode disables the field in the renderer, but
    // re-check here so a crafted IPC call cannot persist a map that the boot
    // path would ignore anyway — and cannot trigger an unwanted relaunch.
    if (settingsService.get("llm").authMode !== "manual") {
      return { ok: false, error: "auth-mode-not-manual", message: "host map is only editable in manual auth mode" };
    }
    // Persist the new map before relaunch so the next boot reads it.
    await settingsService.patch({ llm: { hostResolverMap } });
    broadcastSettingsSnapshot(deps);
    // Arm and execute the relaunch. `app.relaunch()` queues the new process
    // then `app.exit(0)` terminates the current one — same pattern used by
    // the demo activation path in demo.ts.
    app.relaunch();
    app.exit(0);
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
