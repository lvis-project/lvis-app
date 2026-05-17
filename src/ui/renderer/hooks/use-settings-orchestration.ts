import { useCallback, useEffect, useRef, useState } from "react";
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
  /**
   * #893 — Top-level auth mode toggle. Persisted in `llm.authMode`.
   * `"login"` collapses the vendor dropdown + per-vendor settings down to a
   * single Login button; `"manual"` (default) shows the full per-vendor
   * form.
   */
  authMode: "manual" | "login";
  setAuthMode: (mode: "manual" | "login") => void;
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
  idlePreferenceRefresh: boolean;
  setIdlePreferenceRefresh: (v: boolean) => void;
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
  /**
   * Last save failure surface. Cleared on the next successful save.
   * SettingsDialog renders this as a banner so silent IPC failures
   * (network drop, locked settings file, schema reject) become
   * visible — without this, an auto-save that silently rejected
   * would leave the user thinking a toggle persisted when it did not.
   */
  lastSaveError: { tab: string; message: string } | null;
  /** Programmatic clear — used when the user opens the dialog fresh. */
  clearLastSaveError: () => void;
  /**
   * Persist current draft for the named tab. Errors surface via
   * `lastSaveError`, not via promise rejection (the debounced caller
   * does `void s.save(tab)`). Resolves to `true` on success so explicit
   * Save handlers can render a "저장되었습니다" toast.
   *
   * The save NEVER closes the dialog. Multi-tab Settings modals (VS Code,
   * Linear, Raycast) keep the dialog open after Save so the user can
   * verify the change and edit a sibling tab. Close lives on the
   * Dialog X / Esc — same as every other modal.
   */
  save: (tab: string) => Promise<boolean>;
  vendorInfo: (typeof VENDORS)[number];
}

export function useSettingsOrchestration(
  open: boolean,
  api: LvisApi,
  onSaved: () => void,
): SettingsOrchestrationState {
  const [vendor, setVendor] = useState("claude");
  const [keyInput, setKeyInput] = useState("");
  const [model, setModel] = useState("");
  const [hasKey, setHasKey] = useState(false);
  // #893 — Top-level auth mode. Hydrated from `settings.llm.authMode`.
  const [authMode, setAuthMode] = useState<"manual" | "login">("manual");
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
  const [idlePreferenceRefresh, setIdlePreferenceRefresh] = useState(false);
  const [marketplaceBaseUrl, setMarketplaceBaseUrl] = useState("");
  const [marketplaceAllowPrivateNetwork, setMarketplaceAllowPrivateNetwork] = useState(true);
  const [hasMarketplaceApiKey, setHasMarketplaceApiKey] = useState(false);
  const [marketplaceApiKeyInput, setMarketplaceApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastSaveError, setLastSaveError] = useState<{ tab: string; message: string } | null>(null);
  const clearLastSaveError = useCallback(() => setLastSaveError(null), []);
  const [settingsSnapshot, setSettingsSnapshot] = useState<AppSettings | null>(null);
  const hydratedVendorRef = useRef<string | null>(null);
  const hydratedWebProviderRef = useRef<string | null>(null);

  const vendorInfo = VENDORS.find((v) => v.id === vendor) ?? VENDORS[0];

  // Load all settings when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSettingsLoaded(false);
    void (async () => {
      const s = await api.getSettings();
      const [apiKeySet, webApiKeySet, marketplaceKeySet] = await Promise.all([
        api.hasApiKey(s.llm.provider),
        api.hasWebApiKey(s.webSearch.provider),
        api.hasMarketplaceApiKey(),
      ]);
      if (cancelled) return;
      const block = s.llm.vendors[s.llm.provider];
      hydratedVendorRef.current = s.llm.provider;
      hydratedWebProviderRef.current = s.webSearch.provider;
      setSettingsSnapshot(s);
      setVendor(s.llm.provider);
      // #893 — top-level authMode hydration. Legacy installs (per-vendor
      // authMode) were migrated up in the settings store at load time, so
      // by the time the renderer reads `s.llm.authMode` the field is
      // authoritative.
      setAuthMode(s.llm.authMode === "login" ? "login" : "manual");
      hydrateVendorBlock(block);
      setStreamSmoothing(s.llm.streamSmoothing);
      setAutoCompact(s.chat.autoCompact ?? true);
      setHasKey(apiKeySet);
      setWebProvider(s.webSearch.provider);
      setHasWebKey(webApiKeySet);
      setPiiRedactEnabled(s.privacy?.piiRedactEnabled ?? false);
      setIdlePreferenceRefresh(s.features?.idlePreferenceRefresh ?? false);
      setMarketplaceBaseUrl(s.marketplace?.realCloudBaseUrl ?? "");
      setMarketplaceAllowPrivateNetwork(s.marketplace?.realCloudAllowPrivateNetwork ?? false);
      setHasMarketplaceApiKey(marketplaceKeySet);
      setFallbackChain(s.llm.fallbackChain.map((e) => ({ provider: e.provider, model: e.model })));
      setSettingsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [open, api]);

  // Stay in sync with cross-window settings broadcasts. Without this, a sibling
  // window (e.g. the native settings BrowserWindow) saving while this dialog
  // is open would leave `settingsSnapshot` stale — the vendor-switch path
  // below reads `settingsSnapshot.llm.vendors[vendor]` and would hydrate the
  // form back to pre-save values. The `userTouchedRef`-style guards in this
  // hook protect in-flight form edits; updating the snapshot only refreshes
  // the cached source that the vendor-switch effect consults.
  useEffect(() => {
    if (!open) return;
    return api.onSettingsUpdated((next) => {
      setSettingsSnapshot(next);
      setIdlePreferenceRefresh(next.features?.idlePreferenceRefresh ?? false);
    });
  }, [open, api]);

  // Re-hydrate every vendor-specific field when the active vendor changes.
  useEffect(() => {
    if (!open) return;
    if (!settingsLoaded) return;
    if (!VENDORS.some((x) => x.id === vendor)) return;
    if (hydratedVendorRef.current === vendor) {
      hydratedVendorRef.current = null;
      return;
    }
    let cancelled = false;
    void api.hasApiKey(vendor).then((k) => { if (!cancelled) setHasKey(k); });
    const block = settingsSnapshot?.llm.vendors[vendor];
    if (block) hydrateVendorBlock(block);
    return () => { cancelled = true; };
  }, [vendor, open, api, settingsLoaded, settingsSnapshot]);

  function hydrateVendorBlock(block: AppSettings["llm"]["vendors"][string]): void {
    setModel(block.model);
    setBaseUrl(block.baseUrl ?? "");
    setVertexProject(block.vertexProject ?? "");
    setVertexLocation(block.vertexLocation ?? "");
    setEnableThinking(block.enableThinking);
    setThinkingBudget(block.thinkingBudgetTokens);
    // #893 — authMode is no longer per-vendor; the top-level value is set by
    // the open-time snapshot read (see effect above) and survives vendor
    // switches.
  }

  // Re-check web key when webProvider changes
  useEffect(() => {
    if (!open) return;
    if (!settingsLoaded) return;
    if (hydratedWebProviderRef.current === webProvider) {
      hydratedWebProviderRef.current = null;
      return;
    }
    let cancelled = false;
    void api.hasWebApiKey(webProvider).then((k) => { if (!cancelled) setHasWebKey(k); });
    return () => { cancelled = true; };
  }, [webProvider, open, api, settingsLoaded]);

  // In-flight guard + pending re-fire: if a debounced save lands while a
  // previous save is still in flight (cross-tab race), mark it pending
  // and re-fire after the current call resolves. Without this, two
  // overlapping saves would race in settingsService and `setSaving`
  // would flicker (the first call's `finally` clears the flag while the
  // second is still running).
  const savingRef = useRef(false);
  const pendingSavePayload = useRef<null | { tab: string }>(null);
  // Latest-`save` ref: the running save closure captures values from its
  // own render. When `finally` re-fires the pending payload, it must
  // call the LATEST `save` (with the latest closures) — otherwise
  // toggles that landed between the call and the re-fire are silently
  // dropped from the second save's payload. The ref is updated via
  // `useEffect` (canonical latest-ref pattern) so a discarded concurrent
  // render does not leave a dangling closure here.
  const saveRef = useRef<(tab: string) => Promise<boolean>>(null!);
  const save = async (tab: string): Promise<boolean> => {
    if (!settingsLoaded) return false;
    if (savingRef.current) {
      pendingSavePayload.current = { tab };
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    let ok = false;
    try {
      if (tab !== "permissions") {
        const secretUpdates: Array<Promise<unknown>> = [];
        if (keyInput.trim()) {
          secretUpdates.push(
            api.setApiKey(vendor, keyInput.trim()).then(() => {
              setKeyInput("");
              setHasKey(true);
            }),
          );
        }
        if (webKeyInput.trim()) {
          secretUpdates.push(
            api.setWebApiKey(webProvider, webKeyInput.trim()).then(() => {
              setWebKeyInput("");
              setHasWebKey(true);
            }),
          );
        }
        if (marketplaceApiKeyInput.trim()) {
          secretUpdates.push(
            api.setMarketplaceApiKey(marketplaceApiKeyInput.trim()).then(() => {
              setMarketplaceApiKeyInput("");
              setHasMarketplaceApiKey(true);
            }),
          );
        }
        await Promise.all(secretUpdates);
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
            // #893 — top-level authMode persisted alongside provider.
            authMode,
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
        } as any);
      }
      if (tab !== "permissions") onSaved();
      setLastSaveError(null);
      ok = true;
    } catch (err) {
      // Surface via state so SettingsDialog can render an inline banner —
      // debounced callers do `void s.save(tab)` and would otherwise lose
      // the rejection in an unhandled-promise warning, leaving the user
      // thinking a toggle persisted when it did not.
      const message =
        err instanceof Error && err.message ? err.message : "설정 저장 실패";
      setLastSaveError({ tab, message });
    } finally {
      savingRef.current = false;
      setSaving(false);
      // If a debounced save was coalesced while we were running, fire it
      // now via the LATEST `save` closure (saveRef) so the re-fire reads
      // the most recent state, not the stale closure of the original
      // call. Without this the second save would silently drop any
      // toggles that landed between the original call and the re-fire.
      const pending = pendingSavePayload.current;
      if (pending) {
        pendingSavePayload.current = null;
        void saveRef.current(pending.tab);
      }
    }
    return ok;
  };
  useEffect(() => {
    saveRef.current = save;
  });

  const setIdlePreferenceRefreshLive = useCallback((next: boolean) => {
    const previous = idlePreferenceRefresh;
    setIdlePreferenceRefresh(next);
    if (!settingsLoaded) return;
    void api
      .updateSettings({ features: { idlePreferenceRefresh: next } })
      .then((updated) => {
        setSettingsSnapshot(updated);
        onSaved();
      })
      .catch(() => {
        setIdlePreferenceRefresh(previous);
      });
  }, [api, idlePreferenceRefresh, onSaved, settingsLoaded]);

  return {
    lastSaveError,
    clearLastSaveError,
    vendor, setVendor,
    keyInput, setKeyInput,
    model, setModel,
    hasKey, setHasKey,
    authMode, setAuthMode,
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
    idlePreferenceRefresh, setIdlePreferenceRefresh: setIdlePreferenceRefreshLive,
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
