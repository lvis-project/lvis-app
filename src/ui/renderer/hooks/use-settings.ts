import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import {
  DEFAULT_LLM_VENDOR,
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

/**
 * Phase 3.1: LLM settings cache hook.
 *
 * Centralises the chat-input-bar's read-through cache of LLM provider/model/
 * thinking toggle, plus the context-overflow provider/model snapshot loaded
 * once at mount. Exposes a `refresh` callback invoked after SettingsDialog
 * saves so the chat bar reflects changes without a restart.
 */
export interface UseSettingsResult {
  /** Cached provider — narrowed to the LLMVendor union. */
  llmVendor: LLMVendor;
  /** Cached model id. */
  llmModel: string;
  /** Cached `enableThinking` flag for the active vendor. */
  enableThinkingChat: boolean;
  /** One-shot snapshot of {provider, model} used for context overflow %. */
  currentLlmSettings: { provider: LLMVendor; model: string } | null;
  /** Re-read settings from disk (call after SettingsDialog save). */
  refresh: () => Promise<void>;
  /** Persist + optimistically update the thinking toggle. */
  toggleThinking: (next: boolean) => Promise<void>;
}

export function useSettings(api: LvisApi): UseSettingsResult {
  const [llmVendor, setLlmVendor] = useState<LLMVendor>(DEFAULT_LLM_VENDOR);
  const [llmModel, setLlmModel] = useState<string>("");
  const [enableThinkingChat, setEnableThinkingChat] = useState<boolean>(true);
  const [currentLlmSettings, setCurrentLlmSettings] = useState<
    { provider: LLMVendor; model: string } | null
  >(null);

  // Guard late callbacks firing after unmount (matches pattern in renderer.tsx
  // where setCurrentLlmSettings used isMountedRef before this extraction).
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // External-boundary validation lives in the module-scope `narrowVendor`
  // helper above. Each call site below applies it to the IPC-loaded
  // `s.llm.provider` so the renderer never holds a vendor outside the
  // LLMVendor union.
  const refresh = useCallback(async () => {
    try {
      const s = await api.getSettings();
      if (!isMountedRef.current) return;
      const provider = narrowVendor(s.llm.provider);
      const block = s.llm.vendors[provider];
      setLlmVendor(provider);
      setLlmModel(block.model);
      setEnableThinkingChat(block.enableThinking);
    } catch {
      /* ignore */
    }
  }, [api]);

  // Mount: load vendor/model/thinking cache + context overflow snapshot in one call.
  useEffect(() => {
    void api
      .getSettings()
      .then((s) => {
        if (!isMountedRef.current) return;
        const provider = narrowVendor(s.llm.provider);
        const block = s.llm.vendors[provider];
        setLlmVendor(provider);
        setLlmModel(block.model);
        setEnableThinkingChat(block.enableThinking);
        setCurrentLlmSettings({ provider, model: block.model });
      })
      .catch(() => {});
  }, [api]);

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
    currentLlmSettings,
    refresh,
    toggleThinking,
  };
}
