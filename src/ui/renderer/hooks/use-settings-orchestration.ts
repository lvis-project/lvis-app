import { useEffect, useState } from "react";
import type { LvisApi } from "../types.js";
import { VENDORS } from "../constants.js";
import type { FallbackEntry } from "../tabs/AdvancedTab.js";

export interface SettingsOrchestrationState {
  // LLM
  vendor: string;
  setVendor: (v: string) => void;
  keyInput: string;
  setKeyInput: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  hasKey: boolean;
  setHasKey: (v: boolean) => void;
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
  enableThinking: boolean;
  setEnableThinking: (v: boolean) => void;
  thinkingBudget: number;
  setThinkingBudget: (v: number) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  vertexProject: string;
  setVertexProject: (v: string) => void;
  vertexLocation: string;
  setVertexLocation: (v: string) => void;
  // Advanced
  temperature: number;
  setTemperature: (v: number) => void;
  maxOutputTokens: number;
  setMaxOutputTokens: (v: number) => void;
  seedInput: string;
  setSeedInput: (v: string) => void;
  responseFormat: "text" | "json";
  setResponseFormat: (v: "text" | "json") => void;
  stopSequencesText: string;
  setStopSequencesText: (v: string) => void;
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  fallbackChain: FallbackEntry[];
  setFallbackChain: (updater: FallbackEntry[] | ((c: FallbackEntry[]) => FallbackEntry[])) => void;
  fallbackOpen: boolean;
  setFallbackOpen: (updater: boolean | ((o: boolean) => boolean)) => void;
  // Web
  webProvider: string;
  setWebProvider: (v: string) => void;
  webKeyInput: string;
  setWebKeyInput: (v: string) => void;
  hasWebKey: boolean;
  setHasWebKey: (v: boolean) => void;
  // Proactive / Privacy
  enableWakeupRoutine: boolean;
  setEnableWakeupRoutine: (updater: boolean | ((prev: boolean) => boolean)) => void;
  piiRedactEnabled: boolean;
  setPiiRedactEnabled: (v: boolean) => void;
  // Lifecycle
  settingsLoaded: boolean;
  saving: boolean;
  save: (tab: string) => Promise<void>;
  vendorInfo: (typeof VENDORS)[number];
}

export function useSettingsOrchestration(
  open: boolean,
  api: LvisApi,
  onSaved: () => void,
  onOpenChange: (o: boolean) => void,
): SettingsOrchestrationState {
  const [vendor, setVendor] = useState("claude");
  const [keyInput, setKeyInput] = useState("");
  const [model, setModel] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [autoCompact, setAutoCompact] = useState(true);
  const [enableThinking, setEnableThinking] = useState(true);
  const [thinkingBudget, setThinkingBudget] = useState(10_000);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [vertexProject, setVertexProject] = useState("");
  const [vertexLocation, setVertexLocation] = useState("");
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxOutputTokens, setMaxOutputTokens] = useState<number>(4096);
  const [seedInput, setSeedInput] = useState<string>("");
  const [responseFormat, setResponseFormat] = useState<"text" | "json">("text");
  const [stopSequencesText, setStopSequencesText] = useState<string>("");
  const [streamSmoothing, setStreamSmoothing] = useState<"none" | "word" | "char">("none");
  const [fallbackChain, setFallbackChain] = useState<FallbackEntry[]>([]);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [webProvider, setWebProvider] = useState("duckduckgo");
  const [webKeyInput, setWebKeyInput] = useState("");
  const [hasWebKey, setHasWebKey] = useState(false);
  const [enableWakeupRoutine, setEnableWakeupRoutine] = useState(false);
  const [piiRedactEnabled, setPiiRedactEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  const vendorInfo = VENDORS.find((v) => v.id === vendor) ?? VENDORS[0];

  // Load all settings when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSettingsLoaded(false);
    void (async () => {
      const s = await api.getSettings();
      if (cancelled) return;
      setVendor(s.llm.provider);
      setModel(s.llm.model);
      setBaseUrl((s.llm.baseUrls ?? {})[s.llm.provider] ?? "");
      setVertexProject(s.llm.vertexProject ?? "");
      setVertexLocation(s.llm.vertexLocation ?? "");
      setEnableThinking(s.llm.enableThinking ?? true);
      setThinkingBudget(s.llm.thinkingBudgetTokens ?? 10_000);
      setTemperature(s.llm.temperature ?? 0.7);
      setMaxOutputTokens(s.llm.maxOutputTokens ?? 4096);
      setSeedInput(s.llm.seed !== undefined ? String(s.llm.seed) : "");
      setResponseFormat(s.llm.responseFormat ?? "text");
      setStopSequencesText((s.llm.stopSequences ?? []).join("\n"));
      setStreamSmoothing(s.llm.streamSmoothing ?? "none");
      setAutoCompact(s.chat.autoCompact ?? true);
      const apiKeySet = await api.hasApiKey(s.llm.provider);
      if (cancelled) return;
      setHasKey(apiKeySet);
      setWebProvider(s.webSearch.provider);
      const webApiKeySet = await api.hasWebApiKey(s.webSearch.provider);
      if (cancelled) return;
      setHasWebKey(webApiKeySet);
      setEnableWakeupRoutine(s.routine?.enableWakeupRoutine ?? false);
      setPiiRedactEnabled(s.privacy?.piiRedactEnabled ?? false);
      setFallbackChain((s.llm.fallbackChain ?? []).map((e) => ({ provider: e.provider, model: e.model })));
      setSettingsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [open, api]);

  // Re-check key and model when vendor changes
  useEffect(() => {
    if (!open) return;
    const v = VENDORS.find((x) => x.id === vendor);
    if (!v) return;
    let cancelled = false;
    void api.hasApiKey(vendor).then((k) => { if (!cancelled) setHasKey(k); });
    void api.getSettings().then((s) => {
      if (cancelled) return;
      if (s.llm.provider !== vendor) setModel(v.defaultModel);
      else setModel(s.llm.model);
      setBaseUrl((s.llm.baseUrls ?? {})[vendor as any] ?? "");
    });
    return () => { cancelled = true; };
  }, [vendor, open, api]);

  // Re-check web key when webProvider changes
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api.hasWebApiKey(webProvider).then((k) => { if (!cancelled) setHasWebKey(k); });
    return () => { cancelled = true; };
  }, [webProvider, open, api]);

  const save = async (tab: string) => {
    if (!settingsLoaded) return;
    setSaving(true);
    try {
      if (tab !== "permissions") {
        if (keyInput.trim()) {
          await api.setApiKey(vendor, keyInput.trim());
          setKeyInput("");
          setHasKey(true);
        }
        if (webKeyInput.trim()) {
          await api.setWebApiKey(webProvider, webKeyInput.trim());
          setWebKeyInput("");
          setHasWebKey(true);
        }
        const current = await api.getSettings();
        const mergedBaseUrls = { ...(current.llm.baseUrls ?? {}) } as Record<string, string>;
        const trimmed = baseUrl.trim();
        if (trimmed) mergedBaseUrls[vendor] = trimmed;
        else delete mergedBaseUrls[vendor];
        await api.updateSettings({
          llm: {
            provider: vendor as any,
            model: model.trim() || vendorInfo.defaultModel,
            baseUrls: mergedBaseUrls as any,
            enableThinking,
            thinkingBudgetTokens: thinkingBudget,
            vertexProject: vertexProject.trim() || undefined,
            vertexLocation: vertexLocation.trim() || undefined,
            temperature,
            maxOutputTokens,
            seed: (() => {
              const raw = seedInput.trim();
              if (raw === "") return undefined;
              const n = Number.parseInt(raw, 10);
              return Number.isFinite(n) ? n : undefined;
            })(),
            responseFormat,
            stopSequences: stopSequencesText.split("\n").map((s) => s.trim()).filter((s) => s.length > 0),
            streamSmoothing,
            fallbackChain: fallbackChain.filter((e) => e.provider && e.model).map((e) => ({ provider: e.provider as any, model: e.model })),
          } as any,
          webSearch: { provider: webProvider as any },
          chat: { autoCompact },
          routine: { enableWakeupRoutine } as any,
          privacy: { piiRedactEnabled },
        } as any);
      }
      if (tab !== "permissions") { onSaved(); onOpenChange(false); }
      else { onOpenChange(false); }
    } finally { setSaving(false); }
  };

  return {
    vendor, setVendor,
    keyInput, setKeyInput,
    model, setModel,
    hasKey, setHasKey,
    autoCompact, setAutoCompact,
    enableThinking, setEnableThinking,
    thinkingBudget, setThinkingBudget,
    baseUrl, setBaseUrl,
    vertexProject, setVertexProject,
    vertexLocation, setVertexLocation,
    temperature, setTemperature,
    maxOutputTokens, setMaxOutputTokens,
    seedInput, setSeedInput,
    responseFormat, setResponseFormat,
    stopSequencesText, setStopSequencesText,
    streamSmoothing, setStreamSmoothing,
    fallbackChain, setFallbackChain,
    fallbackOpen, setFallbackOpen,
    webProvider, setWebProvider,
    webKeyInput, setWebKeyInput,
    hasWebKey, setHasWebKey,
    enableWakeupRoutine, setEnableWakeupRoutine,
    piiRedactEnabled, setPiiRedactEnabled,
    settingsLoaded,
    saving,
    save,
    vendorInfo,
  };
}
