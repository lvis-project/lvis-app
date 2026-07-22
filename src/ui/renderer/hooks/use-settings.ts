import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import {
  canUseLlmVendorWithoutApiKey,
  DEFAULT_LLM_VENDOR,
  getLlmVendorSettings,
  isLLMVendor,
  type LLMVendor,
} from "../../../shared/llm-vendor-defaults.js";

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
  /** Cached `enableThinking` flag for the active vendor. */
  enableThinkingChat: boolean;
  /** True when the active vendor can run with no stored API key. */
  llmReadyWithoutApiKey: boolean;
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
  // Guard late callbacks firing after unmount (matches pattern in renderer.tsx
  // where this state lived before the hook extraction).
  const isMountedRef = useRef(true);
  const snapshotRevisionRef = useRef(0);
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

  const toggleThinking = useCallback(
    async (next: boolean) => {
      setEnableThinkingChat(next);
      try {
        const s = await api.getSettings();
        // Narrow before constructing the patch key. If `s.llm.provider`
        // is stale/corrupt (a since-removed vendor name), `mergeLlmPatch` would skip
        // the unknown vendor entry and the toggle would silently no-op.
        // The narrower's `DEFAULT_LLM_VENDOR` fallback guarantees the
        // update lands somewhere valid; if the user is actively on a
        // different vendor, the next settings load will re-narrow and
        // the toggle re-targets correctly.
        const provider = narrowVendor(s.llm.provider);
        await api.updateSettings({
          llm: { vendors: { [provider]: { enableThinking: next } } },
        });
      } catch {
        /* ignore */
      }
    },
    [api],
  );

  return {
    llmVendor,
    llmModel,
    enableThinkingChat,
    llmReadyWithoutApiKey,
    refresh,
    toggleThinking,
  };
}
