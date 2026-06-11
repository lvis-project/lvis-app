import { useCallback, useEffect, useRef, useState } from "react";
import { isIpcErrorResult, type AppSettings, type DeepPartial, type LvisApi } from "../types.js";
import { VENDORS } from "../constants.js";
import { formatIpcError } from "../format-ipc-error.js";
import type { FallbackEntry } from "../tabs/LlmTab.js";
import { t } from "../../../i18n/runtime.js";

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
   * Manual-mode host-resolver map text (/etc/hosts-style, one "IP host" per
   * line). Changes to this field require a relaunch — the UI calls
   * `api.applyHostMap()` which persists + restarts. Only editable when
   * `authMode === "manual"`.
   */
  hostResolverMap: string;
  setHostResolverMap: (v: string) => void;
  /**
   * The host-resolver map as last hydrated from persisted settings. The LlmTab
   * compares the editable `hostResolverMap` against this to decide whether the
   * Apply (Save and Restart) button is enabled — an unchanged map keeps it
   * disabled so an Apply click can never trigger a needless relaunch.
   */
  loadedHostResolverMap: string;
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
   * SettingsContent renders this as a banner so silent IPC failures
   * (network drop, locked settings file, schema reject) become
   * visible — without this, an auto-save that silently rejected
   * would leave the user thinking a toggle persisted when it did not.
   */
  lastSaveError: { tab: string; message: string } | null;
  /** Programmatic clear — used when the user opens the dialog fresh. */
  clearLastSaveError: () => void;
  /**
   * Rehydrate the in-memory LLM draft from a freshly-read settings snapshot.
   * Used by host-managed login so the renderer cache and visible fields move
   * together after the backend writes provider/model/key state.
   */
  hydrateLlmFromSettings: (settings: AppSettings) => void;
  /**
   * Invalidates LLM draft saves that were already scheduled before the user
   * entered the host-managed login flow. Used to stop stale manual-mode
   * payloads from landing after login owns provider/model/key state.
   */
  invalidateLlmDraftSaves: () => void;
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
  api: LvisApi,
  onSaved: () => void,
): SettingsOrchestrationState {
  // Initialize vendor to "" (empty) rather than "claude" so the UI never
  // flashes the wrong vendor label before the settings load effect hydrates
  // the correct persisted value. The `settingsLoaded` guard prevents any
  // save from firing before hydration completes.
  const [vendor, setVendor] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [hostResolverMap, setHostResolverMap] = useState("");
  // Snapshot of the persisted host map at hydration time. LlmTab compares the
  // editable `hostResolverMap` against this to gate the Apply button so an
  // unchanged map cannot trigger a relaunch.
  const [loadedHostResolverMap, setLoadedHostResolverMap] = useState("");
  const [model, setModel] = useState("");
  const [hasKey, setHasKey] = useState(false);
  // #893 — Top-level auth mode. Hydrated from `settings.llm.authMode`.
  const [authMode, setAuthModeState] = useState<"manual" | "login">("manual");
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
  const authModeRef = useRef<"manual" | "login">("manual");
  const llmDraftGenerationRef = useRef(0);

  const invalidateLlmDraftSaves = useCallback(() => {
    llmDraftGenerationRef.current += 1;
  }, []);

  const setAuthMode = useCallback((mode: "manual" | "login") => {
    authModeRef.current = mode;
    if (mode === "login") {
      invalidateLlmDraftSaves();
      setKeyInput("");
    }
    setAuthModeState(mode);
  }, [invalidateLlmDraftSaves]);

  const vendorInfo = VENDORS.find((v) => v.id === vendor) ?? VENDORS[0];

  // Load all settings on mount. (Before the BrowserWindow conversion this
  // was gated on `open`; that's now always true while the window exists.)
  useEffect(() => {
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
      setMarketplaceBaseUrl(s.marketplace?.cloudBaseUrl ?? "");
      setMarketplaceAllowPrivateNetwork(s.marketplace?.cloudAllowPrivateNetwork ?? false);
      setHasMarketplaceApiKey(marketplaceKeySet);
      setFallbackChain(s.llm.fallbackChain.map((e) => ({ provider: e.provider, model: e.model })));
      setHostResolverMap(s.llm.hostResolverMap ?? "");
      setLoadedHostResolverMap(s.llm.hostResolverMap ?? "");
      setSettingsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [api, setAuthMode]);

  // Stay in sync with cross-window settings broadcasts. Updating the snapshot
  // refreshes the cached source that the vendor-switch effect consults; the
  // userTouchedRef-style guards in this hook protect in-flight form edits.
  useEffect(() => {
    return api.onSettingsUpdated((next) => {
      setSettingsSnapshot(next);
      setIdlePreferenceRefresh(next.features?.idlePreferenceRefresh ?? false);
      if (next.llm.authMode === "login") {
        const nextVendor = next.llm.provider;
        const block = next.llm.vendors[nextVendor];
        hydratedVendorRef.current = nextVendor;
        setVendor(nextVendor);
        setAuthMode("login");
        hydrateVendorBlock(block);
        void api.hasApiKey(nextVendor).then((k) => setHasKey(k));
      }
    });
  }, [api, setAuthMode]);

  // Re-hydrate every vendor-specific field when the active vendor changes.
  useEffect(() => {
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
  }, [vendor, api, settingsLoaded, settingsSnapshot]);

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

  function hydrateLlmFromSettings(next: AppSettings): void {
    const nextVendor = next.llm.provider;
    const block = next.llm.vendors[nextVendor];
    hydratedVendorRef.current = nextVendor;
    setSettingsSnapshot(next);
    setVendor(nextVendor);
    setAuthMode(next.llm.authMode === "login" ? "login" : "manual");
    hydrateVendorBlock(block);
    setStreamSmoothing(next.llm.streamSmoothing);
    setFallbackChain(next.llm.fallbackChain.map((e) => ({ provider: e.provider, model: e.model })));
    setHostResolverMap(next.llm.hostResolverMap ?? "");
    setLoadedHostResolverMap(next.llm.hostResolverMap ?? "");
  }

  // Re-check web key when webProvider changes
  useEffect(() => {
    if (!settingsLoaded) return;
    if (hydratedWebProviderRef.current === webProvider) {
      hydratedWebProviderRef.current = null;
      return;
    }
    let cancelled = false;
    void api.hasWebApiKey(webProvider).then((k) => { if (!cancelled) setHasWebKey(k); });
    return () => { cancelled = true; };
  }, [webProvider, api, settingsLoaded]);

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
    const isLlmSave = tab === "llm";
    const llmDraftGeneration = llmDraftGenerationRef.current;
    savingRef.current = true;
    setSaving(true);
    let ok = false;
    try {
      if (tab !== "permissions") {
        const secretUpdates: Array<Promise<unknown>> = [];
        const latestAuthMode = authModeRef.current;
        const trimmedKeyInput = keyInput.trim();
        const shouldPersistLlmKey =
          isLlmSave &&
          latestAuthMode !== "login" &&
          trimmedKeyInput.length > 0;
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
        if (isLlmSave && llmDraftGeneration !== llmDraftGenerationRef.current) {
          return false;
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
        const llmPatch: DeepPartial<AppSettings["llm"]> = {
          // #893 — top-level authMode persisted alongside provider.
          authMode: latestAuthMode,
          provider: vendor,
          streamSmoothing,
          fallbackChain: fallbackChain.filter((e) => e.provider && e.model).map((e) => ({ provider: e.provider, model: e.model })),
        };
        if (latestAuthMode !== "login") {
          // In login mode, provider-specific fields are host-managed by the
          // login IPC. Persisting the hidden manual draft here can race the
          // login response and overwrite demo/model/baseUrl with stale values.
          llmPatch.vendors = { [vendor]: activeBlock };
        }
        const updateResult = await api.updateSettings({
          llm: llmPatch,
          webSearch: { provider: webProvider },
          chat: { autoCompact },
          privacy: { piiRedactEnabled },
          marketplace: {
            cloudBaseUrl: marketplaceBaseUrl.trim() || undefined,
            cloudAllowPrivateNetwork: marketplaceAllowPrivateNetwork,
          },
        });
        if (isIpcErrorResult(updateResult)) {
          throw new Error(formatIpcError(updateResult.error, updateResult.message));
        }
        if (shouldPersistLlmKey) {
          if (llmDraftGeneration !== llmDraftGenerationRef.current) {
            return false;
          }
          await api.setApiKey(vendor, trimmedKeyInput);
          setKeyInput("");
          setHasKey(true);
        }
      }
      if (tab !== "permissions") onSaved();
      setLastSaveError(null);
      ok = true;
    } catch (err) {
      // Surface via state so SettingsContent can render an inline banner —
      // debounced callers do `void s.save(tab)` and would otherwise lose
      // the rejection in an unhandled-promise warning, leaving the user
      // thinking a toggle persisted when it did not.
      const message =
        err instanceof Error && err.message ? err.message : t("useSettingsOrchestration.saveFailed");
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
        if (isIpcErrorResult(updated)) throw new Error(updated.message ?? updated.error);
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
    hydrateLlmFromSettings,
    invalidateLlmDraftSaves,
    vendor, setVendor,
    keyInput, setKeyInput,
    model, setModel,
    hasKey, setHasKey,
    authMode, setAuthMode,
    hostResolverMap, setHostResolverMap,
    loadedHostResolverMap,
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
