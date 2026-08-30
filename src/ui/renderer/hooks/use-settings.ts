import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVendorOption } from "../constants.js";
import { llmRouteModel } from "../../../shared/llm-vendor-defaults.js";
import type { AppSettings, LvisApi } from "../types.js";
import {
  canUseLlmVendorWithoutApiKey,
  DEFAULT_LLM_VENDOR,
  getLlmVendorSettings,
  narrowLlmVendor,
  isLLMVendor,
  type LLMVendor,
} from "../../../shared/llm-vendor-defaults.js";
import {
  DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
  isSubscriptionRuntimeId,
  subscriptionRuntimeDescriptor,
  type SubscriptionChatRuntimeSelection,
  type SubscriptionRuntimeCapabilities,
  type SubscriptionRuntimeId,
} from "../../../shared/subscription-runtime.js";
import { selectSubscriptionRuntimeUiPolicy, type SubscriptionRuntimeUiPolicy } from "../utils/subscription-runtime-ui-policy.js";

function canUseSettingsWithoutApiKey(
  settings: Awaited<ReturnType<LvisApi["getSettings"]>>,
  provider: LLMVendor,
): boolean {
  const block = getLlmVendorSettings(settings.llm.vendors, provider);
  if (provider === "openai-compatible" && settings.llm.marketplaceProviderPresetId) {
    const preset = settings.marketplace?.installedProviderPresets?.find(
      (entry) => entry.providerId === settings.llm.marketplaceProviderPresetId,
    );
    const baseUrl = block.baseUrl?.trim() || preset?.baseUrl?.trim();
    return Boolean(
      preset &&
      preset.requiresApiKey === false &&
      baseUrl,
    );
  }
  return canUseLlmVendorWithoutApiKey(provider, block);
}

/**
 * Settings arrive over IPC, so narrow the selected runtime before it can
 * influence renderer readiness or attachment egress policy.
 */
function activeSubscriptionRuntimeFromSettings(
  settings: Awaited<ReturnType<LvisApi["getSettings"]>>,
): SubscriptionChatRuntimeSelection | null {
  const activeRuntime = settings.llm.activeChatRuntime;
  if (activeRuntime?.kind !== "subscription" || !isSubscriptionRuntimeId(activeRuntime.provider)) {
    return null;
  }
  const model = typeof activeRuntime.model === "string" ? activeRuntime.model.trim() : "";
  return model.length > 0
    ? { kind: "subscription", provider: activeRuntime.provider, model }
    : { kind: "subscription", provider: activeRuntime.provider };
}

function sameSubscriptionRuntime(
  left: SubscriptionChatRuntimeSelection | null,
  right: SubscriptionChatRuntimeSelection | null,
): boolean {
  return left?.provider === right?.provider
    && left?.model === right?.model;
}

/**
 * LLM settings cache hook.
 *
 * Centralises the chat-input-bar's read-through cache of LLM provider/model/
 * thinking state. Settings broadcasts are authoritative so provider changes
 * and marketplace installs take effect without a restart.
 */
export interface UseSettingsResult {
  /** Cached provider — narrowed to the LLMVendor union. */
  llmVendor: LLMVendor;
  /** Cached model id. */
  llmModel: string;
  /** True after an authoritative settings snapshot has been applied. */
  settingsLoaded: boolean;
  /** Cached `enableThinking` flag for the active vendor. */
  enableThinkingChat: boolean;
  /** True when the active vendor can run with no stored API key. */
  llmReadyWithoutApiKey: boolean;
  /** Single source of truth for selected subscription chat and attachment UX. */
  subscriptionRuntimePolicy: SubscriptionRuntimeUiPolicy;
  /** Active subscription runtime after untrusted settings boundary validation. */
  activeSubscriptionRuntime: SubscriptionChatRuntimeSelection | null;
  /** Whether the active subscription runtime has explicitly verified chat support. */
  subscriptionChatReady: boolean | null;
  /** Whether the active subscription runtime has explicitly verified raw image input support. */
  subscriptionImagesReady: boolean | null;
  /** Whether the active subscription runtime has explicitly verified file attachment support. */
  subscriptionFilesReady: boolean | null;
  /** Re-read settings from disk (call after SettingsContent save). */
  refresh: () => Promise<void>;
  /** Persist + optimistically update the thinking toggle. */
  toggleThinking: (next: boolean) => Promise<void>;
}

export function useSettings(api: LvisApi): UseSettingsResult {
  const [llmVendor, setLlmVendor] = useState<LLMVendor>(DEFAULT_LLM_VENDOR);
  const [llmModel, setLlmModel] = useState<string>("");
  const [enableThinkingChat, setEnableThinkingChat] = useState<boolean>(true);
  const [llmReadyWithoutApiKey, setLlmReadyWithoutApiKey] = useState(false);
  const [activeSubscriptionRuntime, setActiveSubscriptionRuntime] =
    useState<SubscriptionChatRuntimeSelection | null>(null);
  const [subscriptionRuntimeCapabilities, setSubscriptionRuntimeCapabilities] =
    useState<SubscriptionRuntimeCapabilities | null>(null);
  const [subscriptionStatusRevision, setSubscriptionStatusRevision] = useState(0);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // Guard late callbacks firing after unmount (matches pattern in renderer.tsx
  // where this state lived before the hook extraction).
  const isMountedRef = useRef(true);
  const snapshotRevisionRef = useRef(0);
  const activeSubscriptionRuntimeRef = useRef<SubscriptionChatRuntimeSelection | null>(null);
  const subscriptionStatusRequestRef = useRef(0);
  const subscriptionStatusRevisionByProviderRef = useRef(new Map<string, number>());
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const applySettingsSnapshot = useCallback(
    (settings: Awaited<ReturnType<LvisApi["getSettings"]>>) => {
      if (!isMountedRef.current) return;
      const provider = narrowLlmVendor(settings.llm.provider);
      const block = getLlmVendorSettings(settings.llm.vendors, provider);
      setLlmVendor(provider);
      setLlmModel(llmRouteModel(
        block,
        provider === "openai-compatible" ? settings.llm.marketplaceProviderPresetId : undefined,
      ));
      setEnableThinkingChat(block.enableThinking);
      setLlmReadyWithoutApiKey(canUseSettingsWithoutApiKey(settings, provider));
      const nextSubscriptionRuntime = activeSubscriptionRuntimeFromSettings(settings);
      const runtimeChanged = !sameSubscriptionRuntime(
        activeSubscriptionRuntimeRef.current,
        nextSubscriptionRuntime,
      );
      activeSubscriptionRuntimeRef.current = nextSubscriptionRuntime;
      setActiveSubscriptionRuntime((current) =>
        sameSubscriptionRuntime(current, nextSubscriptionRuntime) ? current : nextSubscriptionRuntime,
      );
      if (runtimeChanged) {
        subscriptionStatusRequestRef.current += 1;
        setSubscriptionRuntimeCapabilities(null);
      }
      setSettingsLoaded(true);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const revisionAtReadStart = snapshotRevisionRef.current;
    try {
      const settings = await api.getSettings();
      if (revisionAtReadStart !== snapshotRevisionRef.current) return;
      applySettingsSnapshot(settings);
    } catch {
      /* ignore */
    }
  }, [api, applySettingsSnapshot]);

  // Subscribe before the initial read so a cross-window update cannot be missed
  // between getSettings() and listener registration. The revision guard prevents
  // a slow initial read from overwriting a newer broadcast snapshot.
  useEffect(() => {
    const unsubscribe = api.onSettingsUpdated((settings) => {
      snapshotRevisionRef.current += 1;
      applySettingsSnapshot(settings);
    });
    const revisionAtReadStart = snapshotRevisionRef.current;
    void api
      .getSettings()
      .then((settings) => {
        if (revisionAtReadStart !== snapshotRevisionRef.current) return;
        applySettingsSnapshot(settings);
      })
      .catch(() => {});
    return unsubscribe;
  }, [api, applySettingsSnapshot]);

  useEffect(() => {
    return api.onSubscriptionRuntimeStatusUpdated((event) => {
      const activeRuntime = activeSubscriptionRuntimeRef.current;
      if (!activeRuntime || activeRuntime.provider !== event.provider) return;
      const previousRevision =
        subscriptionStatusRevisionByProviderRef.current.get(event.provider) ?? 0;
      if (event.revision <= previousRevision) return;
      subscriptionStatusRevisionByProviderRef.current.set(event.provider, event.revision);
      // Invalidate synchronously before React schedules the re-probe. A status
      // response that was already in flight must not put stale capabilities
      // back after logout, login, verification, or a runtime reconfiguration.
      subscriptionStatusRequestRef.current += 1;
      setSubscriptionRuntimeCapabilities(null);
      setSubscriptionStatusRevision(event.revision);
    });
  }, [api]);

  useEffect(() => {
    if (!activeSubscriptionRuntime) {
      subscriptionStatusRequestRef.current += 1;
      setSubscriptionRuntimeCapabilities(null);
      return;
    }

    const requestId = ++subscriptionStatusRequestRef.current;
    setSubscriptionRuntimeCapabilities(null);
    void api.subscriptionRuntimeStatus(activeSubscriptionRuntime.provider)
      .then((result) => {
        if (!isMountedRef.current || requestId !== subscriptionStatusRequestRef.current) return;
        if (
          result.ok !== true
          || result.status.provider !== activeSubscriptionRuntime.provider
        ) {
          setSubscriptionRuntimeCapabilities(DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES);
          return;
        }
        setSubscriptionRuntimeCapabilities(
          result.status.capabilities ?? DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
        );
      })
      .catch(() => {
        if (isMountedRef.current && requestId === subscriptionStatusRequestRef.current) {
          setSubscriptionRuntimeCapabilities(DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES);
        }
      });
  }, [api, activeSubscriptionRuntime, subscriptionStatusRevision]);

  const toggleThinking = useCallback(
    async (next: boolean) => {
      // A subscription runtime owns its own effort controls. The renderer can
      // momentarily still hold API defaults while the authoritative settings
      // snapshot is loading, so do not let an old slider write to the inactive
      // API vendor during that window.
      if (!settingsLoaded || activeSubscriptionRuntimeRef.current !== null) return;
      try {
        const s = await api.getSettings();
        // The fresh disk snapshot and live broadcast ref must both still agree
        // that API-key chat is active before writing an API-vendor preference.
        if (
          activeSubscriptionRuntimeFromSettings(s) !== null
          || activeSubscriptionRuntimeRef.current !== null
        ) {
          return;
        }
        // Narrow before constructing the patch key. If `s.llm.provider`
        // is stale/corrupt (a since-removed vendor name), `mergeLlmPatch` would skip
        // the unknown vendor entry and the toggle would silently no-op.
        // The narrower's `DEFAULT_LLM_VENDOR` fallback guarantees the
        // update lands somewhere valid; if the user is actively on a
        // different vendor, the next settings load will re-narrow and
        // the toggle re-targets correctly.
        const provider = narrowLlmVendor(s.llm.provider);
        setEnableThinkingChat(next);
        await api.updateSettings({
          llm: { vendors: { [provider]: { enableThinking: next } } },
        });
      } catch {
        /* ignore */
      }
    },
    [api, settingsLoaded],
  );

  const subscriptionRuntimePolicy = useMemo(
    () => selectSubscriptionRuntimeUiPolicy({
      activeSubscriptionRuntime,
      settingsLoaded,
      capabilities: subscriptionRuntimeCapabilities,
    }),
    [activeSubscriptionRuntime, settingsLoaded, subscriptionRuntimeCapabilities],
  );

  return {
    llmVendor,
    llmModel,
    enableThinkingChat,
    llmReadyWithoutApiKey,
    subscriptionRuntimePolicy,
    activeSubscriptionRuntime: subscriptionRuntimePolicy.activeSubscriptionRuntime,
    subscriptionChatReady: subscriptionRuntimePolicy.chatReady,
    subscriptionImagesReady: subscriptionRuntimePolicy.imagesReady,
    subscriptionFilesReady: subscriptionRuntimePolicy.filesReady,
    refresh,
    toggleThinking,
    settingsLoaded,
  };
}

interface ApiModelCardChoice {
  kind: "api";
  vendor: LLMVendor;
  vendorLabel: string;
  modelId: string;
  /** The model the chat is on right now. */
  current: boolean;
}

/**
 * The card's row for an active subscription runtime. A subscription session
 * has exactly one active route, and this is it — it is never one of several
 * candidates, so `current` is always `true` and it is never clickable.
 * `modelId` is null when the runtime has no model of its own to name (see
 * `SubscriptionRuntimeDescriptor.supportsModelSelection`).
 */
interface SubscriptionModelCardChoice {
  kind: "subscription";
  provider: SubscriptionRuntimeId;
  vendorLabel: string;
  modelId: string | null;
  current: true;
}

export type ModelCardChoice = ApiModelCardChoice | SubscriptionModelCardChoice;

/**
 * What the composer's model card lists: the route the chat is on right now,
 * then the pinned API models, resolved to the vendor that offers each.
 *
 * The current route is always there, pinned or not — the card is where a
 * person looks to see what they are talking to, and a list that omits it
 * answers the wrong question. When the chat is on a subscription runtime
 * (`llm.activeChatRuntime`), that provider — not an API model — is the
 * checked row; API models are listed as alternatives, none of them checked,
 * because switching to one leaves the subscription runtime (see
 * `subscriptionUseApiForChat` at the call site). Otherwise the current API
 * model leads when it is not itself pinned; otherwise it sits where the pin
 * order puts it.
 *
 * `pinnedModels` stores ids only, so a stored id is matched against what is
 * actually offered — the active vendor's curated line plus every synced
 * catalogue — and one that nothing offers simply does not appear. That is
 * the chooser's own rule (see `UnifiedModelSelect`), applied here so the
 * composer's card and the settings chooser cannot disagree about what a pin
 * points at. Pinned order is kept: it is the order the user reaches for.
 */
export function modelCardChoices(llm: AppSettings["llm"]): ModelCardChoice[] {
  const pinned = llm.pinnedModels ?? [];
  const offered = new Map<string, Set<LLMVendor>>();
  const offer = (vendor: LLMVendor, modelId: string) => {
    let models = offered.get(modelId);
    if (!models) {
      models = new Set();
      offered.set(modelId, models);
    }
    models.add(vendor);
  };
  const active = llm.provider;
  // Synced catalogues first: a model a provider actually answered with belongs
  // to THAT provider, and `offered` keeps insertion order — offering the active
  // vendor's bundled line first made a pin resolve to whichever vendor happens
  // to be active rather than to the one serving it.
  for (const entry of Object.values(llm.modelListCache ?? {})) {
    // The cache is persisted host data keyed by vendor string; only entries
    // naming a known vendor can be offered as a pick.
    if (!isLLMVendor(entry.vendor)) continue;
    for (const modelId of entry.models) offer(entry.vendor, modelId);
  }
  for (const modelId of getVendorOption(active).modelOptions) offer(active, modelId);
  const activeBlock = llm.vendors[active];
  const currentModel = activeBlock && llmRouteModel(
    activeBlock,
    active === "openai-compatible" ? llm.marketplaceProviderPresetId : undefined,
  );
  // `kind === "subscription"` alone decides the branch: an unrecognised
  // provider id must still keep the card off the API model it would
  // otherwise mismark as current. `isSubscriptionRuntimeId` below only
  // chooses how to *label* that provider — it never re-admits the API
  // branch.
  const activeRuntime = llm.activeChatRuntime;
  const subscription = activeRuntime?.kind === "subscription" ? activeRuntime : null;
  const choices: ModelCardChoice[] = [];
  for (const modelId of pinned) {
    for (const vendor of offered.get(modelId) ?? []) {
      choices.push({
        kind: "api",
        vendor,
        vendorLabel: getVendorOption(vendor).label,
        modelId,
        // A pinned API model can equal the vendor/model the settings still
        // hold for the API path even while a subscription runtime is what
        // the chat is actually on — that stale match is not "current".
        current: subscription === null && vendor === active && modelId === currentModel,
      });
    }
  }
  if (subscription === null && currentModel && !choices.some((choice) => choice.current)) {
    choices.unshift({ kind: "api", vendor: active, vendorLabel: getVendorOption(active).label, modelId: currentModel, current: true });
  }
  if (subscription) {
    const model = typeof subscription.model === "string" ? subscription.model.trim() : "";
    // `subscriptionRuntimeDescriptor` falls back to its first entry for an id
    // it does not recognise — fine for a lookup that only ever sees validated
    // ids, wrong here: an unrecognised id must show as itself, never borrow
    // another provider's label.
    const vendorLabel = isSubscriptionRuntimeId(subscription.provider)
      ? subscriptionRuntimeDescriptor(subscription.provider).label
      : subscription.provider;
    choices.unshift({
      kind: "subscription",
      provider: subscription.provider,
      vendorLabel,
      modelId: model.length > 0 ? model : null,
      current: true,
    });
  }
  return choices;
}
