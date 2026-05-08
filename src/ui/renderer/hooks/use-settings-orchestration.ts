import { useEffect, useState } from "react";
import type { AppSettings, LvisApi } from "../types.js";
import { VENDORS } from "../constants.js";
import type { FallbackEntry } from "../tabs/LlmTab.js";

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
  // Cross-vendor LLM controls (UI moved out of "Advanced")
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
  // Privacy
  piiRedactEnabled: boolean;
  setPiiRedactEnabled: (v: boolean) => void;
  // Experimental feature flags
  experimentalContinuousBackend: boolean;
  setExperimentalContinuousBackend: (v: boolean) => void;
  // Marketplace
  marketplaceBaseUrl: string;
  setMarketplaceBaseUrl: (v: string) => void;
  marketplaceAllowPrivateNetwork: boolean;
  setMarketplaceAllowPrivateNetwork: (v: boolean) => void;
  hasMarketplaceApiKey: boolean;
  setHasMarketplaceApiKey: (v: boolean) => void;
  marketplaceApiKeyInput: string;
  setMarketplaceApiKeyInput: (v: string) => void;
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
  const [streamSmoothing, setStreamSmoothing] = useState<"none" | "word" | "char">("none");
  const [fallbackChain, setFallbackChain] = useState<FallbackEntry[]>([]);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [webProvider, setWebProvider] = useState("duckduckgo");
  const [webKeyInput, setWebKeyInput] = useState("");
  const [hasWebKey, setHasWebKey] = useState(false);
  const [piiRedactEnabled, setPiiRedactEnabled] = useState(false);
  const [experimentalContinuousBackend, setExperimentalContinuousBackend] = useState(false);
  const [marketplaceBaseUrl, setMarketplaceBaseUrl] = useState("");
  const [marketplaceAllowPrivateNetwork, setMarketplaceAllowPrivateNetwork] = useState(true);
  const [hasMarketplaceApiKey, setHasMarketplaceApiKey] = useState(false);
  const [marketplaceApiKeyInput, setMarketplaceApiKeyInput] = useState("");
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
      const block = s.llm.vendors[s.llm.provider];
      setVendor(s.llm.provider);
      hydrateVendorBlock(block);
      setStreamSmoothing(s.llm.streamSmoothing);
      setAutoCompact(s.chat.autoCompact ?? true);
      const apiKeySet = await api.hasApiKey(s.llm.provider);
      if (cancelled) return;
      setHasKey(apiKeySet);
      setWebProvider(s.webSearch.provider);
      const webApiKeySet = await api.hasWebApiKey(s.webSearch.provider);
      if (cancelled) return;
      setHasWebKey(webApiKeySet);
      setPiiRedactEnabled(s.privacy?.piiRedactEnabled ?? false);
      setExperimentalContinuousBackend(s.features?.experimentalContinuousBackend ?? false);
      setMarketplaceBaseUrl(s.marketplace?.realCloudBaseUrl ?? "");
      setMarketplaceAllowPrivateNetwork(s.marketplace?.realCloudAllowPrivateNetwork ?? false);
      const marketplaceKeySet = await api.hasMarketplaceApiKey();
      if (cancelled) return;
      setHasMarketplaceApiKey(marketplaceKeySet);
      setFallbackChain(s.llm.fallbackChain.map((e) => ({ provider: e.provider, model: e.model })));
      setSettingsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [open, api]);

  // Re-hydrate every vendor-specific field when the active vendor changes.
  useEffect(() => {
    if (!open) return;
    if (!VENDORS.some((x) => x.id === vendor)) return;
    let cancelled = false;
    void api.hasApiKey(vendor).then((k) => { if (!cancelled) setHasKey(k); });
    void api.getSettings().then((s) => {
      if (cancelled) return;
      hydrateVendorBlock(s.llm.vendors[vendor]);
    });
    return () => { cancelled = true; };
  }, [vendor, open, api]);

  function hydrateVendorBlock(block: AppSettings["llm"]["vendors"][string]): void {
    setModel(block.model);
    setBaseUrl(block.baseUrl ?? "");
    setVertexProject(block.vertexProject ?? "");
    setVertexLocation(block.vertexLocation ?? "");
    setEnableThinking(block.enableThinking);
    setThinkingBudget(block.thinkingBudgetTokens);
  }

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
        if (marketplaceApiKeyInput.trim()) {
          await api.setMarketplaceApiKey(marketplaceApiKeyInput.trim());
          setMarketplaceApiKeyInput("");
          setHasMarketplaceApiKey(true);
        }
        const trimmedBaseUrl = baseUrl.trim();
        const trimmedVertexProject = vertexProject.trim();
        const trimmedVertexLocation = vertexLocation.trim();
        const activeBlock: AppSettings["llm"]["vendors"][string] = {
          model: model.trim() || vendorInfo.defaultModel,
          baseUrl: trimmedBaseUrl || undefined,
          vertexProject: trimmedVertexProject || undefined,
          vertexLocation: trimmedVertexLocation || undefined,
          enableThinking,
          thinkingBudgetTokens: thinkingBudget,
        };
        await api.updateSettings({
          llm: {
            provider: vendor as any,
            vendors: { [vendor]: activeBlock } as any,
            streamSmoothing,
            fallbackChain: fallbackChain.filter((e) => e.provider && e.model).map((e) => ({ provider: e.provider, model: e.model })),
          },
          webSearch: { provider: webProvider as any },
          chat: { autoCompact },
          privacy: { piiRedactEnabled },
          marketplace: {
            realCloudBaseUrl: marketplaceBaseUrl.trim() || undefined,
            realCloudAllowPrivateNetwork: marketplaceAllowPrivateNetwork,
          },
          features: { experimentalContinuousBackend },
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
    streamSmoothing, setStreamSmoothing,
    fallbackChain, setFallbackChain,
    fallbackOpen, setFallbackOpen,
    webProvider, setWebProvider,
    webKeyInput, setWebKeyInput,
    hasWebKey, setHasWebKey,
    piiRedactEnabled, setPiiRedactEnabled,
    experimentalContinuousBackend, setExperimentalContinuousBackend,
    marketplaceBaseUrl, setMarketplaceBaseUrl,
    marketplaceAllowPrivateNetwork, setMarketplaceAllowPrivateNetwork,
    hasMarketplaceApiKey, setHasMarketplaceApiKey,
    marketplaceApiKeyInput, setMarketplaceApiKeyInput,
    settingsLoaded,
    saving,
    save,
    vendorInfo,
  };
}
