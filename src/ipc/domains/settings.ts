/**
 * Settings domain IPC handlers.
 * Covers: lvis:settings:*, lvis:shell:open-external, lvis:telemetry:consent-answer
 */
import { app, ipcMain } from "electron";
import { validateExternalUrl } from "../../shared/external-url.js";
import { SETTINGS } from "../../shared/ipc-channels.js";
import { validateSender, validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { sendToWindow } from "../safe-send.js";
import { normalizeLocale, setLocale, tryLoadLocaleMessages } from "../../i18n/index.js";
import { reconcileGlobalShortcuts } from "../../main/global-shortcuts.js";
import {
  reconcileStartupLaunch,
  notifyStartupLaunchFailureIfNeeded,
} from "../../main/startup-launch.js";
import {
  isLLMVendor,
  isMarketplaceEligibleLLMVendor,
} from "../../shared/llm-vendor-defaults.js";
import {
  MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES,
  isMarketplaceProviderPresetId,
  marketplaceProviderPresetIdFromSecretId,
  marketplaceProviderPresetSecretKey,
  type MarketplaceInstalledProviderPreset,
  type MarketplaceProviderModelDiscoveryPolicy,
} from "../../shared/marketplace-package-assets.js";
import type { LlmModelListRequest } from "../../shared/llm-model-list.js";
import type { IpcDeps } from "../types.js";
import type { LLMSettings, ShortcutSettings } from "../../data/settings-store.js";

/** Authoritative remote route lineage is main-only and never projected to the renderer. */
function rendererSettingsSnapshot(snapshot: ReturnType<IpcDeps["settingsService"]["getAll"]>) {
  const projected = structuredClone(snapshot) as Partial<typeof snapshot>;
  delete projected.a2aRemote;
  return projected;
}

/** Minor-1: extracted helper — 6 handlers share identical 5-line broadcast. */
async function broadcastSettingsSnapshot(deps: IpcDeps): Promise<void> {
  const snapshot = deps.settingsService.getAll();
  // Keep the main-process UI locale in sync with the persisted language so
  // dialogs/menus/notifications shown after a language switch use it too.
  // Optional-chain `appearance` — a partial snapshot (e.g. a test double or a
  // pre-migration settings file) must not crash the broadcast. setLocale
  // coerces undefined to the English default.
  const nextLocale = normalizeLocale(snapshot.appearance?.language);
  if (await tryLoadLocaleMessages(nextLocale)) {
    setLocale(nextLocale);
  }
  for (const win of deps.getAppWindows?.() ?? []) {
    sendToWindow(win, SETTINGS.updated, rendererSettingsSnapshot(snapshot));
  }
}

/**
 * Stable signature of EVERY vendor block's configured `baseUrl` (order-stable by
 * vendor id). The ASRT shared network union includes the host-resolved DYNAMIC
 * endpoint hostnames derived from these user-configured baseUrls, so ANY
 * vendor's baseUrl change — not just the active one or Foundry — must trigger a
 * sandbox network live-refresh. Used to detect that change across a settings
 * patch and call `refreshSandboxNetworkConfig`.
 */
function vendorBaseUrlSignature(llm: LLMSettings): string {
  const vendors = llm.vendors ?? {};
  const entries = Object.keys(vendors)
    .sort()
    .map((id) => `${id}=${vendors[id as keyof typeof vendors]?.baseUrl ?? ""}`);
  return entries.join("|");
}

/**
 * E4 — stable signature of the shortcut + startup-launch inputs so the
 * `settings.update` handler can detect when a patch actually changed them and
 * only then re-register the global shortcut / re-sync the OS login item. Mirrors
 * the `activeLlmIdentity` change-detection pattern used for reviewer rewiring.
 */
function shortcutStartupSignature(
  shortcuts: ShortcutSettings,
  system: { launchAtStartup?: boolean; launchMinimized?: boolean },
): string {
  // NOTE: only the two launch-* fields of `system` are covered here on purpose —
  // they are the sole `system` inputs the OS reconcilers (login item + hidden
  // start) consume. Other `system` fields must NOT gate the shortcut/startup
  // reconcile, so they are deliberately excluded from this signature.
  return JSON.stringify({
    toggleWindow: shortcuts.toggleWindow,
    enabled: shortcuts.enabled,
    launchAtStartup: system.launchAtStartup ?? false,
    launchMinimized: system.launchMinimized ?? false,
  });
}

function activeLlmIdentity(llm: LLMSettings): string {
  const provider = llm.provider;
  const block = llm.vendors?.[provider];
  return JSON.stringify({
    provider,
    marketplaceProviderPresetId:
      provider === "openai-compatible"
        ? (llm.marketplaceProviderPresetId ?? null)
        : null,
    model: block?.model ?? null,
    baseUrl: block?.baseUrl ?? null,
    vertexProject: block?.vertexProject ?? null,
    vertexLocation: block?.vertexLocation ?? null,
  });
}

async function finishProviderPresetMarketplaceMutation(
  deps: IpcDeps,
  prevLlm: LLMSettings,
): Promise<{ ok: false; error: string; message: string } | null> {
  const newLlm = deps.settingsService.get("llm");
  let rewireError: { ok: false; error: string; message: string } | null = null;
  if (activeLlmIdentity(prevLlm) !== activeLlmIdentity(newLlm)) {
    try {
      deps.rewireReviewerAgent?.();
    } catch (err) {
      rewireError = {
        ok: false,
        error: "reviewer-rewire-failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  deps.conversationLoop.refreshProvider();
  deps.refreshActiveLlmWildcard?.();
  if (vendorBaseUrlSignature(prevLlm) !== vendorBaseUrlSignature(newLlm)) {
    deps.refreshSandboxNetworkConfig?.();
  }
  await broadcastSettingsSnapshot(deps);
  return rewireError;
}

function isProviderEnabledForSecrets(deps: IpcDeps, vendor: unknown): vendor is string {
  if (!isLLMVendor(vendor)) return false;
  if (!isMarketplaceEligibleLLMVendor(vendor)) return true;
  const installedProviderIds =
    deps.settingsService.get("marketplace").installedProviderIds ?? [];
  return installedProviderIds.includes(vendor);
}

function isMarketplaceProviderPresetInstalled(deps: IpcDeps, providerId: string): boolean {
  return marketplaceProviderPresetForId(deps, providerId) !== undefined;
}

function marketplaceProviderPresetForId(
  deps: IpcDeps,
  providerId: string,
): MarketplaceInstalledProviderPreset | undefined {
  const installedProviderPresets =
    deps.settingsService.get("marketplace").installedProviderPresets ?? [];
  return installedProviderPresets.find((preset) => preset.providerId === providerId);
}

function normalizeModelDiscoveryPolicy(value: unknown): MarketplaceProviderModelDiscoveryPolicy | undefined {
  return typeof value === "string" &&
    (MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES as readonly string[]).includes(value)
    ? value as MarketplaceProviderModelDiscoveryPolicy
    : undefined;
}

function modelDiscoveryPolicyForListRequest(
  deps: IpcDeps,
  request: LlmModelListRequest,
  vendor: string,
  credentialScope?: string,
): MarketplaceProviderModelDiscoveryPolicy | undefined {
  if (vendor === "openai-compatible" && credentialScope && isMarketplaceProviderPresetId(credentialScope)) {
    const preset = marketplaceProviderPresetForId(deps, credentialScope);
    if (preset?.modelDiscoveryPolicy) return preset.modelDiscoveryPolicy;
  }
  if (vendor === "openai-compatible") {
    const llm = deps.settingsService.get("llm");
    if (llm.provider === "openai-compatible" && llm.marketplaceProviderPresetId) {
      const preset = marketplaceProviderPresetForId(deps, llm.marketplaceProviderPresetId);
      if (preset?.modelDiscoveryPolicy) return preset.modelDiscoveryPolicy;
    }
  }
  return normalizeModelDiscoveryPolicy(request?.modelDiscoveryPolicy);
}

function llmSecretKeyForInput(deps: IpcDeps, vendor?: unknown): string | undefined {
  if (typeof vendor === "string") {
    const providerPresetId = marketplaceProviderPresetIdFromSecretId(vendor);
    if (providerPresetId) {
      return isMarketplaceProviderPresetInstalled(deps, providerPresetId)
        ? marketplaceProviderPresetSecretKey(providerPresetId)
        : undefined;
    }
    return isProviderEnabledForSecrets(deps, vendor)
      ? `llm.apiKey.${vendor}`
      : undefined;
  }

  const llm = deps.settingsService.get("llm");
  if (llm.provider === "openai-compatible" && llm.marketplaceProviderPresetId) {
    return isMarketplaceProviderPresetInstalled(deps, llm.marketplaceProviderPresetId)
      ? marketplaceProviderPresetSecretKey(llm.marketplaceProviderPresetId)
      : undefined;
  }
  return isProviderEnabledForSecrets(deps, llm.provider)
    ? `llm.apiKey.${llm.provider}`
    : undefined;
}

function llmSecretKeyForDeleteInput(deps: IpcDeps, vendor: unknown): string | undefined {
  if (typeof vendor !== "string") return undefined;
  const providerPresetId = marketplaceProviderPresetIdFromSecretId(vendor);
  if (providerPresetId) {
    const llm = deps.settingsService.get("llm");
    const activePreset =
      llm.provider === "openai-compatible" &&
      llm.marketplaceProviderPresetId === providerPresetId;
    return activePreset || isMarketplaceProviderPresetInstalled(deps, providerPresetId)
      ? marketplaceProviderPresetSecretKey(providerPresetId)
      : undefined;
  }
  return isLLMVendor(vendor) ? `llm.apiKey.${vendor}` : undefined;
}

export function registerSettingsHandlers(deps: IpcDeps): void {
  const { settingsService, conversationLoop, auditLogger } = deps;

  // read-only — no sender guard needed
  ipcMain.handle(CHANNELS.settings.get, () => rendererSettingsSnapshot(settingsService.getAll()));

  ipcMain.handle(CHANNELS.settings.update, async (e, partial) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.update, e); return UNAUTHORIZED_FRAME; }
    if (partial && typeof partial === "object" && Object.prototype.hasOwnProperty.call(partial, "a2aRemote")) {
      return { ok: false, error: "a2a-remote-settings-main-owned" };
    }
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
    // ASRT dynamic-endpoint union: capture EVERY vendor baseUrl so a change to
    // any user-configured endpoint (e.g. the indexer's Azure OpenAI resource)
    // triggers a sandbox network live-refresh, not just an active/Foundry change.
    const prevVendorBaseUrlSig = vendorBaseUrlSignature(prevLlm);
    // PR #795 follow-up: the MarketplaceTab "즉시 적용" badge on the SSRF-bypass
    // toggle promised next-request activation, but the marketplace fetcher was
    // capturing the flag at boot only. Detect a change here and call the boot
    // closure that pushes the new value into the live fetcher instance.
    const prevAllowPrivate =
      settingsService.get("marketplace").cloudAllowPrivateNetwork ?? false;
    // E4 — capture shortcut/startup signature so we only re-register on change.
    const prevShortcutStartupSig = shortcutStartupSignature(
      settingsService.get("shortcuts"),
      settingsService.get("system"),
    );
    const result = await settingsService.patch(partial);
    // E4 (security M1 drift) — reconcile the OS-level global shortcut + login
    // item when the shortcut/startup fields actually changed. Defined as a
    // closure and invoked on BOTH the success path AND the reviewer-rewire
    // failure early-return: the shortcuts/system fields are already persisted by
    // the `patch` above, so a subsequent rewire failure must NOT skip syncing
    // the OS state to what is now on disk. Idempotent + gated by the signature,
    // so calling it once per handler invocation is correct on either path.
    // Contract (side-effect ordering): only that it runs AFTER `patch` commits.
    let reconciledShortcutStartup = false;
    const reconcileShortcutStartupIfChanged = (): void => {
      if (reconciledShortcutStartup) return;
      reconciledShortcutStartup = true;
      const newShortcuts = settingsService.get("shortcuts");
      const newSystem = settingsService.get("system");
      if (shortcutStartupSignature(newShortcuts, newSystem) === prevShortcutStartupSig) return;
      // Registration failure is surfaced inside reconcileGlobalShortcuts
      // (No-Fallback: notified, not swallowed).
      reconcileGlobalShortcuts(newShortcuts);
      const launchInput = {
        launchAtStartup: newSystem.launchAtStartup ?? false,
        launchMinimized: newSystem.launchMinimized ?? false,
      };
      // security M2 / critic M2 — a login-item registration that the OS did not
      // apply is surfaced to the user, mirroring the shortcut-conflict path,
      // instead of the `applied:false` result being silently dropped.
      const launchState = reconcileStartupLaunch(launchInput);
      notifyStartupLaunchFailureIfNeeded(launchInput, launchState);
    };
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
        // security M1 drift — the shortcuts/system fields were already persisted
        // by `patch`; reconcile the OS state to disk even though the reviewer
        // rewire failed, so a combined patch doesn't leave the accelerator /
        // login item out of sync with what the user just saved.
        reconcileShortcutStartupIfChanged();
        await broadcastSettingsSnapshot(deps);
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
    // ASRT dynamic-endpoint union: when any vendor baseUrl changed, recompute the
    // shared strict-union and live-swap the ASRT network config so the new
    // endpoint host is enforced/allowed (and the old one dropped) without a
    // restart. No-op inside the closure when the sandbox gate is OFF.
    if (vendorBaseUrlSignature(newLlm) !== prevVendorBaseUrlSig) {
      deps.refreshSandboxNetworkConfig?.();
    }
    // E4 — reconcile the OS-level global accelerator + login item to the newly
    // persisted shortcut/startup fields (no-op when unchanged; see closure).
    reconcileShortcutStartupIfChanged();
    await broadcastSettingsSnapshot(deps);
    return result;
  });

  ipcMain.handle(CHANNELS.settings.marketplaceInstallProviderPreset, async (e, preset) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.marketplaceInstallProviderPreset, e);
      return UNAUTHORIZED_FRAME;
    }
    const prevLlm = settingsService.get("llm");
    try {
      const result = await settingsService.installMarketplaceProviderPreset(
        preset as MarketplaceInstalledProviderPreset,
      );
      const finishError = await finishProviderPresetMarketplaceMutation(deps, prevLlm);
      return finishError ?? result;
    } catch (err) {
      return {
        ok: false,
        error: "marketplace-provider-preset-install-failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(CHANNELS.settings.marketplaceUninstallProviderPreset, async (e, providerId) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.marketplaceUninstallProviderPreset, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof providerId !== "string") {
      return {
        ok: false,
        error: "invalid-provider-preset-id",
        message: "Provider preset id must be a string.",
      };
    }
    const prevLlm = settingsService.get("llm");
    try {
      const result = await settingsService.uninstallMarketplaceProviderPreset(providerId);
      const finishError = await finishProviderPresetMarketplaceMutation(deps, prevLlm);
      return finishError ?? result;
    } catch (err) {
      return {
        ok: false,
        error: "marketplace-provider-preset-uninstall-failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(CHANNELS.settings.setApiKey, async (e, vendor: string, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.setApiKey, e); return UNAUTHORIZED_FRAME; }
    const secretKey = llmSecretKeyForInput(deps, vendor);
    if (!secretKey) {
      return {
        ok: false,
        error: "provider-not-installed",
        message: "Install this marketplace provider before saving its API key.",
      };
    }
    await settingsService.setSecret(secretKey, apiKey);
    conversationLoop.refreshProvider();
    // MAJOR-2: rewire reviewer when provider key changes so cacheScope refreshes.
    deps.rewireReviewerAgent?.();
    // #893 — refresh plugin wildcard with the new key for the active vendor.
    deps.refreshActiveLlmWildcard?.();
    // Broadcast settings snapshot so reviewer tab can auto-unlock without a full reload.
    await broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  // read-only — sender guard optional
  ipcMain.handle(CHANNELS.settings.hasApiKey, (_e, vendor?: string) => {
    const secretKey = llmSecretKeyForInput(deps, vendor);
    return secretKey ? settingsService.getSecret(secretKey) !== null : false;
  });

  ipcMain.handle(CHANNELS.settings.deleteApiKey, async (e, vendor: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.deleteApiKey, e); return UNAUTHORIZED_FRAME; }
    const secretKey = llmSecretKeyForDeleteInput(deps, vendor);
    if (!secretKey) {
      return {
        ok: false,
        error: "unknown-provider",
        message: "Unknown LLM provider.",
      };
    }
    await settingsService.deleteSecret(secretKey);
    conversationLoop.refreshProvider();
    // MAJOR-2: rewire reviewer when provider key is removed so cacheScope refreshes.
    deps.rewireReviewerAgent?.();
    // #893 — refresh plugin wildcard so the now-missing key is cleared.
    deps.refreshActiveLlmWildcard?.();
    await broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.settings.listLlmModels, async (e, request: LlmModelListRequest) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.listLlmModels, e); return UNAUTHORIZED_FRAME; }
    const vendor = request && typeof request.vendor === "string"
      ? request.vendor
      : settingsService.get("llm").provider;
    if (!isProviderEnabledForSecrets(deps, vendor)) {
      return {
        ok: false,
        error: isLLMVendor(vendor) ? "provider-not-installed" : "invalid-provider",
        message: isLLMVendor(vendor)
          ? "Install this marketplace provider before syncing its models."
          : "Unknown LLM provider.",
      };
    }
    const baseUrl = request && typeof request.baseUrl === "string"
      ? request.baseUrl
      : undefined;
    const credentialScope = request && typeof request.credentialScope === "string"
      ? request.credentialScope
      : undefined;
    const modelDiscoveryPolicy = modelDiscoveryPolicyForListRequest(
      deps,
      request,
      vendor,
      credentialScope,
    );
    const { listLlmModelsFromSettings } = await import("../../engine/llm/model-list.js");
    return listLlmModelsFromSettings(settingsService, {
      vendor,
      baseUrl,
      credentialScope,
      ...(modelDiscoveryPolicy ? { modelDiscoveryPolicy } : {}),
    });
  });

  // ─── Marketplace API Key ──────────────────────
  ipcMain.handle(CHANNELS.settings.marketplaceSetApiKey, async (e, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.marketplaceSetApiKey, e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret("marketplace.apiKey", apiKey);
    await broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.settings.marketplaceHasApiKey, () =>
    settingsService.getSecret("marketplace.apiKey") != null,
  );

  ipcMain.handle(CHANNELS.settings.marketplaceDeleteApiKey, async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.marketplaceDeleteApiKey, e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret("marketplace.apiKey");
    await broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  // ─── Shell external link ───────────────────────────
  ipcMain.handle(CHANNELS.shell.openExternal, async (e, url: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.shell.openExternal, e); return UNAUTHORIZED_FRAME; }
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
  ipcMain.handle(CHANNELS.settings.setWebApiKey, async (e, provider: string, apiKey: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.setWebApiKey, e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret(`web.apiKey.${provider}`, apiKey);
    await broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  // read-only — sender guard optional
  ipcMain.handle(CHANNELS.settings.hasWebApiKey, (_e, provider: string) => {
    return settingsService.getSecret(`web.apiKey.${provider}`) !== null;
  });

  ipcMain.handle(CHANNELS.settings.deleteWebApiKey, async (e, provider: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.deleteWebApiKey, e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret(`web.apiKey.${provider}`);
    await broadcastSettingsSnapshot(deps);
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
    // Persist the new map before relaunch so the next boot reads it.
    await settingsService.patch({ llm: { hostResolverMap } });
    await broadcastSettingsSnapshot(deps);
    // Arm and execute the relaunch. `app.relaunch()` queues the new process
    // then `app.exit(0)` terminates the current process so the new map is
    // applied before its network service starts.
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  // ─── Telemetry consent ────────────────────────
  ipcMain.handle(CHANNELS.telemetry.consentAnswer, async (e, accepted: boolean) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.telemetry.consentAnswer, e); return UNAUTHORIZED_FRAME; }
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
