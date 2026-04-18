import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";

/**
 * Phase 3.1: LLM settings cache hook.
 *
 * Centralises the chat-input-bar's read-through cache of LLM provider/model/
 * thinking toggle, plus the context-overflow provider/model snapshot loaded
 * once at mount. Exposes a `refresh` callback invoked after SettingsDialog
 * saves so the chat bar reflects changes without a restart.
 */
export interface UseSettingsResult {
  /** Cached provider (e.g. "claude", "openai", "gemini"). */
  llmVendor: string;
  /** Cached model id. */
  llmModel: string;
  /** Cached `settings.llm.enableThinking` flag. */
  enableThinkingChat: boolean;
  /** One-shot snapshot of {provider, model} used for context overflow %. */
  currentLlmSettings: { provider: string; model: string } | null;
  /** Re-read settings from disk (call after SettingsDialog save). */
  refresh: () => Promise<void>;
  /** Persist + optimistically update the thinking toggle. */
  toggleThinking: (next: boolean) => Promise<void>;
}

export function useSettings(api: LvisApi): UseSettingsResult {
  const [llmVendor, setLlmVendor] = useState<string>("claude");
  const [llmModel, setLlmModel] = useState<string>("");
  const [enableThinkingChat, setEnableThinkingChat] = useState<boolean>(true);
  const [currentLlmSettings, setCurrentLlmSettings] = useState<
    { provider: string; model: string } | null
  >(null);

  // Guard late callbacks firing after unmount (matches pattern in renderer.tsx
  // where setCurrentLlmSettings used isMountedRef before this extraction).
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getSettings();
      if (!isMountedRef.current) return;
      setLlmVendor(s.llm.provider);
      setLlmModel(s.llm.model);
      setEnableThinkingChat(s.llm.enableThinking ?? true);
    } catch {
      /* ignore */
    }
  }, [api]);

  // Mount: load vendor/model/thinking cache + context overflow snapshot in one call.
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        if (!isMountedRef.current) return;
        setLlmVendor(s.llm.provider);
        setLlmModel(s.llm.model);
        setEnableThinkingChat(s.llm.enableThinking ?? true);
        setCurrentLlmSettings({ provider: s.llm.provider, model: s.llm.model });
      })
      .catch(() => {});
  }, [api]);

  const toggleThinking = useCallback(
    async (next: boolean) => {
      setEnableThinkingChat(next);
      try {
        await api.updateSettings({ llm: { enableThinking: next } });
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
