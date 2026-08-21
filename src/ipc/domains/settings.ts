/**
 * Settings domain IPC handlers.
 * Covers: lvis:settings:*, lvis:shell:open-external, lvis:telemetry:consent-answer
 */
import { dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { validateExternalUrl } from "../../shared/external-url.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { SETTINGS } from "../../shared/ipc-channels.js";
import { envForcedSettingsPaths } from "../../shared/env-backed-settings.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { sendToWindow } from "../safe-send.js";
import { normalizeLocale, setLocale, tryLoadLocaleMessages } from "../../i18n/index.js";
import { reconcileGlobalShortcuts } from "../../main/global-shortcuts.js";
import { publishAppPreferenceChange } from "../../boot/steps/plugin-runtime/app-preference.js";
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
import type {
  CodexSubscriptionActionResult,
  CodexSubscriptionDeviceCodeResult,
  CodexSubscriptionErrorCode,
  CodexSubscriptionModelsResult,
  CodexSubscriptionStatus,
} from "../../shared/codex-subscription.js";
import {
  isAcpSubscriptionProviderId,
  type AcpSubscriptionActionResult,
  type AcpSubscriptionErrorCode,
  type AcpSubscriptionProviderId,
  type AcpSubscriptionStatus,
} from "../../shared/acp-subscription.js";
import {
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  isSubscriptionRuntimeId,
  subscriptionRuntimeDescriptor,
  type SubscriptionLoginMethod,
  type SubscriptionRuntimeActionResult,
  type SubscriptionRuntimeErrorCode,
  type SubscriptionRuntimeId,
  type SubscriptionRuntimeModelsResult,
  type SubscriptionRuntimeStatus,
  type SubscriptionRuntimeStatusUpdatedEvent,
} from "../../shared/subscription-runtime.js";
import {
  getSubscriptionRuntimeService,
  subscriptionRuntimeErrorCode,
  SubscriptionRuntimeServiceError,
  type SubscriptionRuntimeService,
} from "../../main/subscription-runtime-service.js";

let subscriptionRuntimeStatusRevision = 0;

function codexStatusFromSubscription(status: SubscriptionRuntimeStatus | undefined): CodexSubscriptionStatus {
  if (!status) {
    return {
      runtime: "ready",
      connection: "signed-out",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    };
  }
  return {
    runtime: status.runtime === "unavailable" ? "unavailable" : "ready",
    connection: status.connection === "connected" || status.connection === "pending"
      ? status.connection
      : "signed-out",
    planType: status.planType,
    pendingLogin: status.pendingLogin === "browser" || status.pendingLogin === "device-code"
      ? status.pendingLogin
      : null,
    pendingDeviceCode: status.pendingDeviceCode,
  };
}

function acpStatusFromSubscription(
  provider: AcpSubscriptionProviderId,
  status: SubscriptionRuntimeStatus | undefined,
): AcpSubscriptionStatus {
  return {
    provider,
    runtime: status?.runtime ?? "not-configured",
    connection: status?.connection ?? "unknown",
    pendingLogin: status?.pendingLogin === "device-code" ? "device-code" : null,
    pendingDeviceCode: status?.pendingDeviceCode ?? null,
    canOpenVerificationUrl: status?.canOpenVerificationUrl ?? false,
    version: status?.version ?? null,
    // The legacy ACP status must remain a safe projection of the common
    // runtime contract. Do not expose the ACP initialize payload here:
    // the common status already reflects host-verified attachment/file flows.
    promptCapabilities: {
      image: status?.capabilities.images === true,
      embeddedContext: status?.capabilities.files === true,
    },
  };
}

function legacyCodexErrorCode(code: SubscriptionRuntimeErrorCode): CodexSubscriptionErrorCode {
  switch (code) {
    case "subscription-runtime-unavailable":
      return "codex-runtime-unavailable";
    case "subscription-login-in-progress":
      return "codex-login-in-progress";
    case "subscription-login-failed":
      return "codex-login-failed";
    default:
      return "codex-operation-failed";
  }
}

function legacyAcpErrorCode(code: SubscriptionRuntimeErrorCode): AcpSubscriptionErrorCode {
  switch (code) {
    case "subscription-provider-not-supported":
      return "acp-provider-not-supported";
    case "subscription-runtime-not-configured":
      return "acp-runtime-not-configured";
    case "subscription-runtime-unavailable":
      return "acp-runtime-unavailable";
    case "subscription-login-in-progress":
      return "acp-login-in-progress";
    case "subscription-login-failed":
      return "acp-login-failed";
    case "subscription-verification-url-unavailable":
      return "acp-verification-url-unavailable";
    case "subscription-logout-not-supported":
      return "acp-logout-not-supported";
    default:
      return "acp-operation-failed";
  }
}

function legacyCodexActionResult(result: SubscriptionRuntimeActionResult): CodexSubscriptionActionResult {
  if (result.ok) return { ok: true, status: codexStatusFromSubscription(result.status) };
  return {
    ok: false,
    error: legacyCodexErrorCode(result.error),
    status: codexStatusFromSubscription(result.status),
  };
}

function legacyCodexDeviceCodeResult(
  result: SubscriptionRuntimeActionResult,
): CodexSubscriptionDeviceCodeResult {
  const status = codexStatusFromSubscription(result.status);
  if (!result.ok) {
    return { ok: false, error: legacyCodexErrorCode(result.error), status };
  }
  if (!result.status.pendingDeviceCode) {
    return { ok: false, error: "codex-login-failed", status };
  }
  return { ok: true, status, userCode: result.status.pendingDeviceCode };
}

function legacyCodexModelsResult(result: SubscriptionRuntimeModelsResult): CodexSubscriptionModelsResult {
  if (!result.ok) {
    return {
      ok: false,
      error: legacyCodexErrorCode(result.error),
      status: codexStatusFromSubscription(result.status),
    };
  }
  return {
    ok: true,
    status: codexStatusFromSubscription(result.status),
    models: result.models.map((model) => ({ ...model, inputModalities: [] })),
  };
}

function legacyAcpActionResult(
  provider: AcpSubscriptionProviderId,
  result: SubscriptionRuntimeActionResult,
): AcpSubscriptionActionResult {
  if (result.ok) return { ok: true, status: acpStatusFromSubscription(provider, result.status) };
  return {
    ok: false,
    error: legacyAcpErrorCode(result.error),
    ...(result.status ? { status: acpStatusFromSubscription(provider, result.status) } : {}),
  };
}

function normalizeSubscriptionLoginMethod(value: unknown): SubscriptionLoginMethod | null {
  return value === "browser" || value === "device-code" ? value : null;
}

function normalizeSubscriptionModel(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model && model.length <= MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(model)
    ? model
    : null;
}

/** Authoritative remote route lineage is main-only and never projected to the renderer. */
function rendererSettingsSnapshot(snapshot: ReturnType<IpcDeps["settingsService"]["getAll"]>) {
  const projected = structuredClone(snapshot) as Partial<typeof snapshot>;
  delete projected.a2aRemote;
  return projected;
}

/** Shared by every handler that mutates settings and must re-broadcast the
 *  projected snapshot to all windows. */
async function broadcastSettingsSnapshot(
  deps: IpcDeps,
  shouldBroadcast: () => boolean = () => true,
): Promise<void> {
  const snapshot = deps.settingsService.getAll();
  // Plugins, not just windows. `hostApi.getAppPreference` reads live settings
  // in process, but an ISOLATED plugin answers it from a host-pushed snapshot
  // that has to be re-pushed to stay true — this is the announcement that
  // re-pushes it. Called BEFORE the locale await below and outside its
  // staleness guard: that guard suppresses a superseded RENDERER snapshot, and
  // suppressing the preference announcement instead of superseding it would
  // drop the change rather than re-order it. `publishAppPreferenceChange`
  // compares the allow-listed values itself, so calling it on every settings
  // broadcast announces only the saves that moved one.
  publishAppPreferenceChange(deps.settingsService);
  const snapshotSignature = canonicalStringify(snapshot);
  // Keep the main-process UI locale in sync with the persisted language so
  // dialogs/menus/notifications shown after a language switch use it too.
  // Optional-chain `appearance` — a partial snapshot (e.g. a test double or a
  // pre-migration settings file) must not crash the broadcast. setLocale
  // coerces undefined to the English default.
  const nextLocale = normalizeLocale(snapshot.appearance?.language);
  const localeLoaded = await tryLoadLocaleMessages(nextLocale);
  // Locale loading yields. Suppress stale snapshots (and their locale side
  // effect) if any settings mutation or a caller-specific ownership hand-off
  // occurred while it was in flight.
  if (
    !shouldBroadcast()
    || snapshotSignature !== canonicalStringify(deps.settingsService.getAll())
  ) {
    return;
  }
  if (localeLoaded) setLocale(nextLocale);
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
 * Stable signature of the shortcut + startup-launch inputs so the
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


function sameLlmSettings(left: LLMSettings, right: LLMSettings): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

/** Keep main and side-chat provider instances on the same persisted settings. */
function refreshChatRuntimeProviders(
  deps: Pick<IpcDeps, "conversationLoop" | "sideChatConversationLoop">,
): void {
  // Refresh each binding even if another one fails. ConversationLoop clears
  // its provider before rebuilding, so this leaves no stale API-key transport
  // live under a subscription selection.
  let failed = false;
  let firstError: unknown;
  try {
    deps.conversationLoop.refreshProvider();
  } catch (error) {
    failed = true;
    firstError = error;
  }
  try {
    deps.sideChatConversationLoop?.refreshProvider();
  } catch (error) {
    failed = true;
    firstError ??= error;
  }
  if (failed) throw firstError;
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
  refreshChatRuntimeProviders(deps);
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
  let activeChatRuntimeTransitionRevision = 0;
  // Handler-start ownership prevents a slow verify/model lookup from applying
  // an older subscription choice after a newer provider/API selection.
  let activeChatRuntimeSelectionIntentRevision = 0;
  const publishSubscriptionRuntimeStatusUpdated = (provider: SubscriptionRuntimeId): void => {
    const event: SubscriptionRuntimeStatusUpdatedEvent = {
      provider,
      revision: ++subscriptionRuntimeStatusRevision,
    };
    for (const win of deps.getAppWindows?.() ?? []) {
      sendToWindow(win, CHANNELS.settings.subscriptionRuntimeStatusUpdated, event);
    }
  };

  const auditSubscriptionMutation = (
    action: string,
    provider: SubscriptionRuntimeId | "api" | "invalid",
    outcome: "succeeded" | "failed" | "cancelled" | "rejected",
    error?: SubscriptionRuntimeErrorCode,
  ): void => {
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "subscription-runtime",
      type: outcome === "succeeded" || outcome === "cancelled" ? "info" : "warn",
      input: JSON.stringify({ action, provider, outcome, ...(error ? { error } : {}) }),
    });
  };
  const openSubscriptionExternal = async (url: string): Promise<void> => {
    const validated = validateExternalUrl(url);
    if (!validated.ok) {
      throw new SubscriptionRuntimeServiceError("subscription-verification-url-unavailable");
    }
    await shell.openExternal(validated.url);
  };
  const getSubscriptionRuntime = (): Promise<SubscriptionRuntimeService> =>
    getSubscriptionRuntimeService(openSubscriptionExternal, {
      audit: (event) => {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "subscription-runtime",
          type: "warn",
          input: JSON.stringify({
            provider: event.provider,
            outcome: event.outcome,
            ...(event.requestKind ? { requestKind: event.requestKind } : {}),
          }),
        });
      },
    });
  const runSubscriptionAction = async (
    provider: SubscriptionRuntimeId,
    operation: (
      runtime: SubscriptionRuntimeService,
      runtimeId: SubscriptionRuntimeId,
    ) => Promise<SubscriptionRuntimeStatus>,
  ): Promise<SubscriptionRuntimeActionResult> => {
    let runtime: SubscriptionRuntimeService | null = null;
    try {
      runtime = await getSubscriptionRuntime();
      return { ok: true, status: await operation(runtime, provider) };
    } catch (error) {
      const status = runtime?.getCachedStatus(provider);
      return {
        ok: false,
        error: subscriptionRuntimeErrorCode(error),
        ...(status ? { status } : {}),
      };
    }
  };
  const runSubscriptionMutation = async (
    provider: SubscriptionRuntimeId,
    operation: (
      runtime: SubscriptionRuntimeService,
      runtimeId: SubscriptionRuntimeId,
    ) => Promise<SubscriptionRuntimeStatus>,
  ): Promise<SubscriptionRuntimeActionResult> => {
    const result = await runSubscriptionAction(provider, operation);
    publishSubscriptionRuntimeStatusUpdated(provider);
    return result;
  };
  const runSubscriptionModels = async (
    provider: SubscriptionRuntimeId,
  ): Promise<SubscriptionRuntimeModelsResult> => {
    let runtime: SubscriptionRuntimeService | null = null;
    try {
      runtime = await getSubscriptionRuntime();
      const result = await runtime.listModels(provider);
      return { ok: true, ...result };
    } catch (error) {
      const status = runtime?.getCachedStatus(provider);
      return {
        ok: false,
        error: subscriptionRuntimeErrorCode(error),
        ...(status ? { status } : {}),
      };
    }
  };
  const sameActiveChatRuntime = (
    left: LLMSettings["activeChatRuntime"],
    right: LLMSettings["activeChatRuntime"],
  ): boolean => {
    if (left.kind !== right.kind) return false;
    if (left.kind === "api") return true;
    return right.kind === "subscription"
      && left.provider === right.provider
      && left.model === right.model;
  };
  const rollbackActiveChatRuntime = async (
    previousActiveChatRuntime: LLMSettings["activeChatRuntime"],
    failedActiveChatRuntime: LLMSettings["activeChatRuntime"],
    transitionRevision: number,
  ): Promise<boolean> => {
    // Only the request that still owns the active selection may undo it. This
    // preserves unrelated LLM updates and a newer multi-window selection.
    if (
      transitionRevision !== activeChatRuntimeTransitionRevision
      || !sameActiveChatRuntime(settingsService.get("llm").activeChatRuntime, failedActiveChatRuntime)
    ) {
      return false;
    }
    const persistRestoration = settingsService.patch({
      llm: { activeChatRuntime: previousActiveChatRuntime },
    });
    // SettingsService mutates memory before its first await. Restore every
    // executable binding in that same synchronous turn; waiting for disk here
    // would leave the failed API/subscription provider reachable meanwhile.
    try {
      refreshChatRuntimeProviders(deps);
    } catch {
      // Each loop was still cleared/rebuilt independently above.
    }
    try {
      deps.rewireReviewerAgent?.();
    } catch {
      // The restored selection remains authoritative; preserve the original
      // selection error instead of masking it with a best-effort rewire error.
    }
    try {
      deps.refreshActiveLlmWildcard?.();
    } catch {
      // See reviewer rewire above.
    }
    try {
      await persistRestoration;
    } catch {
      return false;
    }
    const ownsRestoration = (): boolean => (
      transitionRevision === activeChatRuntimeTransitionRevision
      && sameActiveChatRuntime(
        settingsService.get("llm").activeChatRuntime,
        previousActiveChatRuntime,
      )
    );
    if (!ownsRestoration()) return false;

    await broadcastSettingsSnapshot(deps, ownsRestoration);
    return ownsRestoration();
  };
  const setActiveChatRuntime = async (
    activeChatRuntime: LLMSettings["activeChatRuntime"],
  ): Promise<void> => {
    const previousLlm = settingsService.get("llm");
    const previousSubscriptionProvider = previousLlm.activeChatRuntime?.kind === "subscription"
      ? previousLlm.activeChatRuntime.provider
      : null;
    const nextSubscriptionProvider = activeChatRuntime?.kind === "subscription"
      ? activeChatRuntime.provider
      : null;
    if (!sameActiveChatRuntime(previousLlm.activeChatRuntime, activeChatRuntime)) {
      // A provider selection is an authentication-boundary change. Abort both
      // interactive loops before exposing the new selection so a prior API
      // tool round cannot issue another request after subscription activation.
      const reason = new Error("active chat runtime changed");
      conversationLoop.abortCurrentTurn?.(reason);
      deps.sideChatConversationLoop?.abortCurrentTurn?.(reason);
    }
    const persistSelection = settingsService.patch({ llm: { activeChatRuntime } });
    const transitionRevision = ++activeChatRuntimeTransitionRevision;
    const ownsTransition = (): boolean => (
      transitionRevision === activeChatRuntimeTransitionRevision
      && sameActiveChatRuntime(settingsService.get("llm").activeChatRuntime, activeChatRuntime)
    );

    try {
      // SettingsService has synchronously applied the new active runtime at
      // this point. Bind all execution consumers before awaiting disk so no
      // API-key provider can be observed while subscription is active.
      refreshChatRuntimeProviders(deps);
      deps.rewireReviewerAgent?.();
      deps.refreshActiveLlmWildcard?.();
      await persistSelection;
    } catch {
      // If a synchronous binding failed, wait for the in-flight write to settle
      // before issuing the guarded restoration. This prevents an older write
      // from racing the rollback on disk.
      await persistSelection.catch(() => undefined);
      let restored = false;
      try {
        restored = await rollbackActiveChatRuntime(
          previousLlm.activeChatRuntime,
          activeChatRuntime,
          transitionRevision,
        );
      } catch {
        // The renderer must never be told that the new runtime became active
        // when its exact persisted predecessor could not be restored.
      }
      if (restored && previousSubscriptionProvider) {
        publishSubscriptionRuntimeStatusUpdated(previousSubscriptionProvider);
      }
      throw new SubscriptionRuntimeServiceError("subscription-operation-failed");
    }
    // A newer multi-window selection may have persisted while this write
    // awaited disk. It owns all following broadcast/status effects; its
    // executable bindings were already applied synchronously by its own call.
    if (!ownsTransition()) return;

    await broadcastSettingsSnapshot(deps, ownsTransition);
    if (!ownsTransition()) return;
    if (previousSubscriptionProvider && previousSubscriptionProvider !== nextSubscriptionProvider) {
      publishSubscriptionRuntimeStatusUpdated(previousSubscriptionProvider);
    }
    if (nextSubscriptionProvider) {
      publishSubscriptionRuntimeStatusUpdated(nextSubscriptionProvider);
    }
  };
  const hostAcpSubscriptionHandler = (
    channel: string,
    action: string,
    operation: (
      runtime: SubscriptionRuntimeService,
      provider: AcpSubscriptionProviderId,
    ) => Promise<SubscriptionRuntimeStatus>,
    notifyStatusUpdated = true,
  ) => async (e: IpcMainInvokeEvent, providerValue: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, channel, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!isAcpSubscriptionProviderId(providerValue)) {
      auditSubscriptionMutation(action, "invalid", "rejected", "subscription-provider-not-supported");
      return { ok: false as const, error: "acp-provider-not-supported" as const };
    }
    const run = notifyStatusUpdated ? runSubscriptionMutation : runSubscriptionAction;
    const result = await run(
      providerValue,
      (runtime, runtimeId) => operation(runtime, runtimeId as AcpSubscriptionProviderId),
    );
    auditSubscriptionMutation(
      action,
      providerValue,
      result.ok ? "succeeded" : "failed",
      result.ok ? undefined : result.error,
    );
    return legacyAcpActionResult(providerValue, result);
  };

  // read-only — no sender guard needed
  ipcMain.handle(CHANNELS.settings.get, () => rendererSettingsSnapshot(settingsService.getAll()));

  // Read-only, and presence only: the answer is a list of settings paths the
  // environment is forcing ON, never the value of any variable. A control that
  // showed the saved value alone would be describing a state the running app is
  // not in, since every one of these gates resolves as `settings || env`.
  ipcMain.handle(CHANNELS.settings.envForcedSettings, () => envForcedSettingsPaths());

  ipcMain.handle(CHANNELS.settings.update, async (e, partial) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.update, e); return UNAUTHORIZED_FRAME; }
    if (partial && typeof partial === "object" && Object.prototype.hasOwnProperty.call(partial, "a2aRemote")) {
      return { ok: false, error: "a2a-remote-settings-main-owned" };
    }
    const llmPatch = (partial as Record<string, unknown> | null | undefined)
      ?.llm as Record<string, unknown> | undefined;
    if (llmPatch && Object.prototype.hasOwnProperty.call(llmPatch, "activeChatRuntime")) {
      auditSubscriptionMutation("direct-settings-update", "invalid", "rejected", "subscription-operation-failed");
      return {
        ok: false,
        error: "active-chat-runtime-requires-subscription-selection",
      };
    }
    // LOW: validate vendors["azure-foundry"].baseUrl at write time so an invalid
    // Foundry endpoint is rejected before it reaches the settings store.
    const foundryVendorPatch = (llmPatch?.vendors as Record<string, unknown> | undefined)
      ?.["azure-foundry"] as Record<string, unknown> | undefined;
    if (foundryVendorPatch?.baseUrl !== undefined) {
      // Reject non-string values explicitly before String() coercion.
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
    // Legacy guard: still detect Foundry baseUrl changes even when
    // the active provider is not Foundry, preserving the prior explicit rewire.
    const prevBaseUrl = prevLlm.vendors?.["azure-foundry"]?.baseUrl ?? null;
    // ASRT dynamic-endpoint union: capture EVERY vendor baseUrl so a change to
    // any user-configured endpoint (e.g. the indexer's Azure OpenAI resource)
    // triggers a sandbox network live-refresh, not just an active/Foundry change.
    const prevVendorBaseUrlSig = vendorBaseUrlSignature(prevLlm);
    // The MarketplaceTab "즉시 적용" badge on the SSRF-bypass
    // toggle promised next-request activation, but the marketplace fetcher was
    // capturing the flag at boot only. Detect a change here and call the boot
    // closure that pushes the new value into the live fetcher instance.
    const prevAllowPrivate =
      settingsService.get("marketplace").cloudAllowPrivateNetwork ?? false;
    // Capture shortcut/startup signature so we only re-register on change.
    const prevShortcutStartupSig = shortcutStartupSignature(
      settingsService.get("shortcuts"),
      settingsService.get("system"),
    );
    const persistSettings = settingsService.patch(partial);
    // SettingsService applies its merge before awaiting disk persistence. Capture
    // this request's exact LLM snapshot before another renderer can supersede it.
    const appliedLlm = settingsService.get("llm");
    const result = await persistSettings;
    // Reconcile the OS-level global shortcut + login item when the
    // shortcut/startup fields actually changed. Defined as a
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
      // A login-item registration the OS did not apply is surfaced to the user,
      // mirroring the shortcut-conflict path, instead of the `applied:false`
      // result being silently dropped.
      const launchState = reconcileStartupLaunch(launchInput);
      notifyStartupLaunchFailureIfNeeded(launchInput, launchState);
    };
    const newLlm = appliedLlm;
    const ownsAppliedLlm = sameLlmSettings(settingsService.get("llm"), appliedLlm);
    const newActiveLlmIdentity = activeLlmIdentity(newLlm);
    const newBaseUrl = newLlm.vendors?.["azure-foundry"]?.baseUrl ?? null;
    const newAllowPrivate =
      settingsService.get("marketplace").cloudAllowPrivateNetwork ?? false;
    if (
      ownsAppliedLlm
      && (prevBaseUrl !== newBaseUrl || prevActiveLlmIdentity !== newActiveLlmIdentity)
    ) {
      try {
        deps.rewireReviewerAgent?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A nested/parallel renderer mutation may have taken ownership while
        // reviewer construction ran. Restore the full predecessor only when
        // this request's captured snapshot is still current; otherwise a full
        // replacement would discard the newer window's LLM settings.
        if (sameLlmSettings(settingsService.get("llm"), newLlm)) {
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
        }
        if (prevAllowPrivate !== newAllowPrivate) {
          deps.refreshMarketplaceFetcherConfig?.();
        }
        refreshChatRuntimeProviders(deps);
        deps.refreshActiveLlmWildcard?.();
        // The shortcuts/system fields were already persisted
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
    refreshChatRuntimeProviders(deps);
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
    // Reconcile the OS-level global accelerator + login item to the newly
    // persisted shortcut/startup fields (no-op when unchanged; see closure).
    reconcileShortcutStartupIfChanged();
    await broadcastSettingsSnapshot(deps);
    return result;
  });

  ipcMain.handle(CHANNELS.settings.marketplaceInstallProviderPreset, async (e, preset) => {
    if (!validateHostRendererSender(e)) {
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
    if (!validateHostRendererSender(e)) {
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
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.setApiKey, e); return UNAUTHORIZED_FRAME; }
    const secretKey = llmSecretKeyForInput(deps, vendor);
    if (!secretKey) {
      return {
        ok: false,
        error: "provider-not-installed",
        message: "Install this marketplace provider before saving its API key.",
      };
    }
    await settingsService.setSecret(secretKey, apiKey);
    refreshChatRuntimeProviders(deps);
    // Rewire the reviewer when the provider key changes so cacheScope refreshes.
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
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.deleteApiKey, e); return UNAUTHORIZED_FRAME; }
    const secretKey = llmSecretKeyForDeleteInput(deps, vendor);
    if (!secretKey) {
      return {
        ok: false,
        error: "unknown-provider",
        message: "Unknown LLM provider.",
      };
    }
    await settingsService.deleteSecret(secretKey);
    refreshChatRuntimeProviders(deps);
    // Rewire the reviewer when the provider key is removed so cacheScope refreshes.
    deps.rewireReviewerAgent?.();
    // #893 — refresh plugin wildcard so the now-missing key is cleared.
    deps.refreshActiveLlmWildcard?.();
    await broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.settings.listLlmModels, async (e, request: LlmModelListRequest) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.listLlmModels, e); return UNAUTHORIZED_FRAME; }
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

  // ─── Common subscription runtimes ───────────────────────────────────
  // All providers pass through this host-only boundary. The renderer can name
  // only a static provider id; executable paths, verification URLs, credentials,
  // and raw runtime output remain main-owned.
  ipcMain.handle(CHANNELS.settings.subscriptionRuntimeStatus, async (e, providerValue: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionRuntimeStatus, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!isSubscriptionRuntimeId(providerValue)) {
      return { ok: false as const, error: "subscription-provider-not-supported" as const };
    }
    return runSubscriptionAction(providerValue, (runtime, provider) => runtime.getStatus(provider));
  });
  ipcMain.handle(CHANNELS.settings.subscriptionChooseRuntime, async (e, providerValue: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionChooseRuntime, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!isSubscriptionRuntimeId(providerValue)) {
      auditSubscriptionMutation("choose-runtime", "invalid", "rejected", "subscription-provider-not-supported");
      return { ok: false as const, error: "subscription-provider-not-supported" as const };
    }
    if (!subscriptionRuntimeDescriptor(providerValue).requiresExecutable) {
      auditSubscriptionMutation("choose-runtime", providerValue, "rejected", "subscription-provider-not-supported");
      return { ok: false as const, error: "subscription-provider-not-supported" as const };
    }
    const selected = await dialog.showOpenDialog({
      title: providerValue === "kimi-code" ? "Select Kimi Code executable" : "Select Grok Build executable",
      properties: ["openFile", "dontAddToRecent"],
      ...(process.platform === "win32"
        ? { filters: [{ name: "Executable", extensions: ["exe"] }] }
        : {}),
    });
    const executable = selected.filePaths[0];
    const result = selected.canceled || !executable
      ? await runSubscriptionMutation(providerValue, (runtime, provider) => runtime.getStatus(provider))
      : await runSubscriptionMutation(providerValue, (runtime, provider) => runtime.chooseExecutable(provider, executable));
    auditSubscriptionMutation(
      "choose-runtime",
      providerValue,
      (selected.canceled || !executable) && result.ok ? "cancelled" : result.ok ? "succeeded" : "failed",
      result.ok ? undefined : result.error,
    );
    return result;
  });
  ipcMain.handle(CHANNELS.settings.subscriptionForgetRuntime, async (e, providerValue: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionForgetRuntime, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!isSubscriptionRuntimeId(providerValue)) {
      auditSubscriptionMutation("forget-runtime", "invalid", "rejected", "subscription-provider-not-supported");
      return { ok: false as const, error: "subscription-provider-not-supported" as const };
    }
    const result = await runSubscriptionMutation(providerValue, (runtime, provider) => runtime.forgetExecutable(provider));
    auditSubscriptionMutation("forget-runtime", providerValue, result.ok ? "succeeded" : "failed", result.ok ? undefined : result.error);
    return result;
  });
  ipcMain.handle(CHANNELS.settings.subscriptionVerifyRuntime, async (e, providerValue: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionVerifyRuntime, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!isSubscriptionRuntimeId(providerValue)) {
      auditSubscriptionMutation("verify-runtime", "invalid", "rejected", "subscription-provider-not-supported");
      return { ok: false as const, error: "subscription-provider-not-supported" as const };
    }
    const result = await runSubscriptionMutation(providerValue, (runtime, provider) => runtime.verify(provider));
    auditSubscriptionMutation("verify-runtime", providerValue, result.ok ? "succeeded" : "failed", result.ok ? undefined : result.error);
    return result;
  });
  ipcMain.handle(
    CHANNELS.settings.subscriptionStartLogin,
    async (e, providerValue: unknown, methodValue: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionStartLogin, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!isSubscriptionRuntimeId(providerValue)) {
        auditSubscriptionMutation("start-login", "invalid", "rejected", "subscription-provider-not-supported");
        return { ok: false as const, error: "subscription-provider-not-supported" as const };
      }
      const method = normalizeSubscriptionLoginMethod(methodValue);
      if (!method || !subscriptionRuntimeDescriptor(providerValue).loginMethods.includes(method)) {
        auditSubscriptionMutation("start-login", providerValue, "rejected", "subscription-provider-not-supported");
        return { ok: false as const, error: "subscription-provider-not-supported" as const };
      }
      const result = await runSubscriptionMutation(
        providerValue,
        (runtime, provider) => runtime.startLogin(provider, method),
      );
      auditSubscriptionMutation("start-login", providerValue, result.ok ? "succeeded" : "failed", result.ok ? undefined : result.error);
      return result;
    },
  );
  ipcMain.handle(CHANNELS.settings.subscriptionOpenLoginBrowser, async (e, providerValue: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionOpenLoginBrowser, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!isSubscriptionRuntimeId(providerValue)) {
      auditSubscriptionMutation("open-login-browser", "invalid", "rejected", "subscription-provider-not-supported");
      return { ok: false as const, error: "subscription-provider-not-supported" as const };
    }
    const result = await runSubscriptionMutation(
      providerValue,
      (runtime, provider) => runtime.openPendingVerificationUrl(provider, openSubscriptionExternal),
    );
    auditSubscriptionMutation("open-login-browser", providerValue, result.ok ? "succeeded" : "failed", result.ok ? undefined : result.error);
    return result;
  });
  ipcMain.handle(CHANNELS.settings.subscriptionCancelLogin, async (e, providerValue: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionCancelLogin, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!isSubscriptionRuntimeId(providerValue)) {
      auditSubscriptionMutation("cancel-login", "invalid", "rejected", "subscription-provider-not-supported");
      return { ok: false as const, error: "subscription-provider-not-supported" as const };
    }
    const result = await runSubscriptionMutation(providerValue, (runtime, provider) => runtime.cancelLogin(provider));
    auditSubscriptionMutation("cancel-login", providerValue, result.ok ? "succeeded" : "failed", result.ok ? undefined : result.error);
    return result;
  });
  ipcMain.handle(CHANNELS.settings.subscriptionLogout, async (e, providerValue: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionLogout, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!isSubscriptionRuntimeId(providerValue)) {
      auditSubscriptionMutation("logout", "invalid", "rejected", "subscription-provider-not-supported");
      return { ok: false as const, error: "subscription-provider-not-supported" as const };
    }
    if (!subscriptionRuntimeDescriptor(providerValue).supportsManagedLogout) {
      auditSubscriptionMutation("logout", providerValue, "rejected", "subscription-logout-not-supported");
      return { ok: false as const, error: "subscription-logout-not-supported" as const };
    }
    if (providerValue === "grok-build") {
      const confirmation = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Cancel", "Sign out"],
        defaultId: 0,
        cancelId: 0,
        message: "Sign out of Grok Build?",
        detail: "This clears only LVIS's isolated Grok Build session. Other provider sessions are unchanged.",
      });
      if (confirmation.response !== 1) {
        const status = await runSubscriptionMutation(providerValue, (runtime, provider) => runtime.getStatus(provider));
        auditSubscriptionMutation("logout", providerValue, status.ok ? "cancelled" : "failed", status.ok ? undefined : status.error);
        return status;
      }
    }
    const result = await runSubscriptionMutation(providerValue, (runtime, provider) => runtime.logout(provider));
    auditSubscriptionMutation("logout", providerValue, result.ok ? "succeeded" : "failed", result.ok ? undefined : result.error);
    return result;
  });
  ipcMain.handle(CHANNELS.settings.subscriptionListModels, async (e, providerValue: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionListModels, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!isSubscriptionRuntimeId(providerValue)) {
      return { ok: false as const, error: "subscription-provider-not-supported" as const };
    }
    return runSubscriptionModels(providerValue);
  });
  ipcMain.handle(
    CHANNELS.settings.subscriptionUseForChat,
    async (e, providerValue: unknown, modelValue: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionUseForChat, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!isSubscriptionRuntimeId(providerValue)) {
        auditSubscriptionMutation("use-for-chat", "invalid", "rejected", "subscription-provider-not-supported");
        return { ok: false as const, error: "subscription-provider-not-supported" as const };
      }
      const model = normalizeSubscriptionModel(modelValue);
      const descriptor = subscriptionRuntimeDescriptor(providerValue);
      if (model === null || (model !== undefined && !descriptor.supportsModelSelection)) {
        auditSubscriptionMutation("use-for-chat", providerValue, "rejected", "subscription-chat-unavailable");
        return { ok: false as const, error: "subscription-chat-unavailable" as const };
      }
      const selectionIntentRevision = ++activeChatRuntimeSelectionIntentRevision;
      const verified = await runSubscriptionMutation(providerValue, (runtime, provider) => runtime.verify(provider));
      if (!verified.ok) {
        auditSubscriptionMutation("use-for-chat", providerValue, "failed", verified.error);
        return verified;
      }
      let status = verified.status;
      if (model !== undefined) {
        const models = await runSubscriptionModels(providerValue);
        if (!models.ok) {
          const failure: SubscriptionRuntimeActionResult = {
            ok: false,
            error: models.error,
            ...(models.status ? { status: models.status } : {}),
          };
          auditSubscriptionMutation("use-for-chat", providerValue, "failed", failure.error);
          return failure;
        }
        if (!models.models.some((candidate) => candidate.id === model)) {
          const failure: SubscriptionRuntimeActionResult = {
            ok: false,
            error: "subscription-chat-unavailable",
            status: models.status,
          };
          auditSubscriptionMutation("use-for-chat", providerValue, "rejected", failure.error);
          return failure;
        }
        status = models.status;
      }
      if (status.capabilities?.chat !== true) {
        const failure: SubscriptionRuntimeActionResult = {
          ok: false,
          error: "subscription-chat-unavailable",
          status,
        };
        auditSubscriptionMutation("use-for-chat", providerValue, "failed", failure.error);
        return failure;
      }
      if (selectionIntentRevision !== activeChatRuntimeSelectionIntentRevision) {
        // Another chat selection began while this runtime was verifying or
        // listing models. It must not revive this older selection afterwards.
        const failure: SubscriptionRuntimeActionResult = {
          ok: false,
          error: "subscription-operation-failed",
          status,
        };
        auditSubscriptionMutation("use-for-chat", providerValue, "cancelled", failure.error);
        return failure;
      }
      try {
        await setActiveChatRuntime({
          kind: "subscription",
          provider: providerValue,
          ...(model ? { model } : {}),
        });
        auditSubscriptionMutation("use-for-chat", providerValue, "succeeded");
        return { ok: true as const, status };
      } catch (error) {
        const failure: SubscriptionRuntimeActionResult = {
          ok: false,
          error: subscriptionRuntimeErrorCode(error),
          status,
        };
        auditSubscriptionMutation("use-for-chat", providerValue, "failed", failure.error);
        return failure;
      }
    },
  );
  ipcMain.handle(CHANNELS.settings.subscriptionUseApiForChat, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.subscriptionUseApiForChat, e);
      return UNAUTHORIZED_FRAME;
    }
    // API and subscription selections share one handler-start intent order.
    ++activeChatRuntimeSelectionIntentRevision;
    try {
      await setActiveChatRuntime({ kind: "api" });
      auditSubscriptionMutation("use-api-for-chat", "api", "succeeded");
      return { ok: true as const };
    } catch (error) {
      const code = subscriptionRuntimeErrorCode(error);
      auditSubscriptionMutation("use-api-for-chat", "api", "failed", code);
      return { ok: false as const, error: code };
    }
  });

  // ─── Legacy compatibility adapters ─────────────────────────────────
  // Older renderer bundles retain these names, but never get a second client
  // or a bypass around common safety verification and URL validation.
  const hostCodexSubscriptionHandler = (
    channel: string,
    action: string,
    operation: (runtime: SubscriptionRuntimeService) => Promise<SubscriptionRuntimeStatus>,
    notifyStatusUpdated = true,
  ) => async (e: IpcMainInvokeEvent) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, channel, e);
      return UNAUTHORIZED_FRAME;
    }
    const run = notifyStatusUpdated ? runSubscriptionMutation : runSubscriptionAction;
    const result = await run("codex", (runtime) => operation(runtime));
    auditSubscriptionMutation(action, "codex", result.ok ? "succeeded" : "failed", result.ok ? undefined : result.error);
    return legacyCodexActionResult(result);
  };
  ipcMain.handle(
    CHANNELS.settings.codexSubscriptionStatus,
    hostCodexSubscriptionHandler(CHANNELS.settings.codexSubscriptionStatus, "legacy-status", (runtime) => runtime.getStatus("codex"), false),
  );
  ipcMain.handle(
    CHANNELS.settings.codexSubscriptionStartBrowserLogin,
    hostCodexSubscriptionHandler(CHANNELS.settings.codexSubscriptionStartBrowserLogin, "legacy-start-login", (runtime) => runtime.startLogin("codex", "browser")),
  );
  ipcMain.handle(CHANNELS.settings.codexSubscriptionStartDeviceCodeLogin, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.codexSubscriptionStartDeviceCodeLogin, e);
      return UNAUTHORIZED_FRAME;
    }
    const result = await runSubscriptionMutation("codex", (runtime) => runtime.startLogin("codex", "device-code"));
    auditSubscriptionMutation("legacy-start-login", "codex", result.ok ? "succeeded" : "failed", result.ok ? undefined : result.error);
    return legacyCodexDeviceCodeResult(result);
  });
  ipcMain.handle(
    CHANNELS.settings.codexSubscriptionCancelLogin,
    hostCodexSubscriptionHandler(CHANNELS.settings.codexSubscriptionCancelLogin, "legacy-cancel-login", (runtime) => runtime.cancelLogin("codex")),
  );
  ipcMain.handle(
    CHANNELS.settings.codexSubscriptionLogout,
    hostCodexSubscriptionHandler(CHANNELS.settings.codexSubscriptionLogout, "legacy-logout", (runtime) => runtime.logout("codex")),
  );
  ipcMain.handle(CHANNELS.settings.codexSubscriptionListModels, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.settings.codexSubscriptionListModels, e);
      return UNAUTHORIZED_FRAME;
    }
    return legacyCodexModelsResult(await runSubscriptionModels("codex"));
  });
  ipcMain.handle(
    CHANNELS.settings.acpSubscriptionStatus,
    hostAcpSubscriptionHandler(CHANNELS.settings.acpSubscriptionStatus, "legacy-status", (runtime, provider) => runtime.getStatus(provider), false),
  );
  ipcMain.handle(
    CHANNELS.settings.acpSubscriptionChooseRuntime,
    hostAcpSubscriptionHandler(CHANNELS.settings.acpSubscriptionChooseRuntime, "legacy-choose-runtime", async (runtime, provider) => {
      const selected = await dialog.showOpenDialog({
        title: provider === "kimi-code" ? "Select Kimi Code executable" : "Select Grok Build executable",
        properties: ["openFile", "dontAddToRecent"],
        ...(process.platform === "win32"
          ? { filters: [{ name: "Executable", extensions: ["exe"] }] }
          : {}),
      });
      const executable = selected.filePaths[0];
      return selected.canceled || !executable
        ? runtime.getStatus(provider)
        : runtime.chooseExecutable(provider, executable);
    }),
  );
  ipcMain.handle(
    CHANNELS.settings.acpSubscriptionForgetRuntime,
    hostAcpSubscriptionHandler(CHANNELS.settings.acpSubscriptionForgetRuntime, "legacy-forget-runtime", (runtime, provider) => runtime.forgetExecutable(provider)),
  );
  ipcMain.handle(
    CHANNELS.settings.acpSubscriptionVerify,
    hostAcpSubscriptionHandler(CHANNELS.settings.acpSubscriptionVerify, "legacy-verify-runtime", (runtime, provider) => runtime.verify(provider)),
  );
  ipcMain.handle(
    CHANNELS.settings.acpSubscriptionStartLogin,
    hostAcpSubscriptionHandler(CHANNELS.settings.acpSubscriptionStartLogin, "legacy-start-login", (runtime, provider) => runtime.startLogin(provider, "device-code")),
  );
  ipcMain.handle(
    CHANNELS.settings.acpSubscriptionOpenLoginBrowser,
    hostAcpSubscriptionHandler(CHANNELS.settings.acpSubscriptionOpenLoginBrowser, "legacy-open-login-browser", (runtime, provider) => runtime.openPendingVerificationUrl(provider, openSubscriptionExternal)),
  );
  ipcMain.handle(
    CHANNELS.settings.acpSubscriptionCancelLogin,
    hostAcpSubscriptionHandler(CHANNELS.settings.acpSubscriptionCancelLogin, "legacy-cancel-login", (runtime, provider) => runtime.cancelLogin(provider)),
  );
  ipcMain.handle(
    CHANNELS.settings.acpSubscriptionLogout,
    hostAcpSubscriptionHandler(CHANNELS.settings.acpSubscriptionLogout, "legacy-logout", async (runtime, provider) => {
      if (provider === "grok-build") {
        const confirmation = await dialog.showMessageBox({
          type: "warning",
          buttons: ["Cancel", "Sign out"],
          defaultId: 0,
          cancelId: 0,
          message: "Sign out of Grok Build?",
          detail: "This clears only LVIS's isolated Grok Build session. Other provider sessions are unchanged.",
        });
        if (confirmation.response !== 1) return runtime.getStatus(provider);
      }
      return runtime.logout(provider);
    }),
  );
  // ─── Marketplace API Key ──────────────────────
  ipcMain.handle(CHANNELS.settings.marketplaceSetApiKey, async (e, apiKey: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.marketplaceSetApiKey, e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret("marketplace.apiKey", apiKey);
    await broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.settings.marketplaceHasApiKey, () =>
    settingsService.getSecret("marketplace.apiKey") != null,
  );

  ipcMain.handle(CHANNELS.settings.marketplaceDeleteApiKey, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.marketplaceDeleteApiKey, e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret("marketplace.apiKey");
    await broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  // ─── Shell external link ───────────────────────────
  ipcMain.handle(CHANNELS.shell.openExternal, async (e, url: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.shell.openExternal, e); return UNAUTHORIZED_FRAME; }
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
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.setWebApiKey, e); return UNAUTHORIZED_FRAME; }
    await settingsService.setSecret(`web.apiKey.${provider}`, apiKey);
    await broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  // read-only — sender guard optional
  ipcMain.handle(CHANNELS.settings.hasWebApiKey, (_e, provider: string) => {
    return settingsService.getSecret(`web.apiKey.${provider}`) !== null;
  });

  ipcMain.handle(CHANNELS.settings.deleteWebApiKey, async (e, provider: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.settings.deleteWebApiKey, e); return UNAUTHORIZED_FRAME; }
    await settingsService.deleteSecret(`web.apiKey.${provider}`);
    await broadcastSettingsSnapshot(deps);
    return { ok: true };
  });

  // ─── Telemetry consent ────────────────────────
  ipcMain.handle(CHANNELS.telemetry.consentAnswer, async (e, accepted: boolean) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.telemetry.consentAnswer, e); return UNAUTHORIZED_FRAME; }
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
