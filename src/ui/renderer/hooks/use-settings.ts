import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import {
  canUseLlmVendorWithoutApiKey,
  DEFAULT_LLM_VENDOR,
  getLlmVendorSettings,
  isLLMVendor,
  type LLMVendor,
} from "../../../shared/llm-vendor-defaults.js";
import {
  DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
  isSubscriptionRuntimeId,
  type SubscriptionChatRuntimeSelection,
  type SubscriptionRuntimeCapabilities,
} from "../../../shared/subscription-runtime.js";
import { selectSubscriptionRuntimeUiPolicy, type SubscriptionRuntimeUiPolicy } from "../utils/subscription-runtime-ui-policy.js";

/**
 * External-boundary narrowing helper. Lives at module scope so its
 * identity is stable — `useCallback` / `useEffect` closures that call
 * this never change identity because of render churn, which keeps the
 * `react-hooks/exhaustive-deps` lint happy and prevents false-positive
 * stale-closure churn. Pure: depends only on the module-level
 * `isLLMVendor` import.
 */
function narrowVendor(raw: unknown): LLMVendor {
  return isLLMVendor(raw) ? raw : DEFAULT_LLM_VENDOR;
}

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
 * from detached windows and marketplace installs take effect without a restart.
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
      const provider = narrowVendor(settings.llm.provider);
      const block = getLlmVendorSettings(settings.llm.vendors, provider);
      setLlmVendor(provider);
      setLlmModel(block.model);
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
        const provider = narrowVendor(s.llm.provider);
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
