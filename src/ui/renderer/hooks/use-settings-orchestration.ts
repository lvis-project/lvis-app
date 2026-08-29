import {
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  SUBAGENT_MAX_ROUNDS_MIN,
} from "../../../shared/subagent-policy.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isIpcErrorResult,
  type AppSettings,
  type DeepPartial,
  type LvisApi,
  type MemoryCaptureMode,
} from "../types.js";
import { ALL_VENDORS, getVendorOption, type VendorOption } from "../constants.js";
import { formatIpcError } from "../format-ipc-error.js";
import type {
  FallbackEntry,
  ProviderCredentialDraft,
  ProviderCredentialSave,
} from "../tabs/LlmTab.js";
import { t } from "../../../i18n/runtime.js";
import {
  DEFAULT_LLM_VENDOR,
  getLlmVendorSettings,
  isLLMVendor,
  llmRouteModel,
  type LLMVendor,
  type LLMVendorSettings,
} from "../../../shared/llm-vendor-defaults.js";
import {
  marketplaceProviderPresetSecretId,
  type MarketplaceInstalledProviderPreset,
} from "../../../shared/marketplace-package-assets.js";

/** A save that arrived while another was running. See `pendingSaves`. */
type PendingSave =
  | { kind: "tab"; tab: string }
  | {
    kind: "credential";
    input: ProviderCredentialSave;
    /** Settles the promise the card is still holding. */
    resolve: (ok: boolean) => void;
  };

export interface SettingsOrchestrationState {
  // LLM
  /** The provider chat runs on — `llm.provider`. Moved only by an explicit pick. */
  vendor: string;
  providerCredentialDraft: ProviderCredentialDraft | null;
  setProviderCredentialDraft: (next: ProviderCredentialDraft | null) => void;
  saveProviderCredential: (input: ProviderCredentialSave) => Promise<boolean>;
  model: string;
  setModel: (v: string) => void;
  /** Whether the ACTIVE provider has a stored key. Per-row facts are the tab's. */
  hasKey: boolean;
  setHasKey: (v: boolean) => void;
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
  enableThinking: boolean;
  setEnableThinking: (v: boolean) => void;
  thinkingBudget: number;
  setThinkingBudget: (v: number) => void;
  /** The ACTIVE provider's endpoint. A card's endpoint field edits the draft. */
  baseUrl: string;
  // Cross-vendor LLM controls (UI moved out of "Advanced")
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  fallbackChain: FallbackEntry[];
  setFallbackChain: (updater: FallbackEntry[] | ((c: FallbackEntry[]) => FallbackEntry[])) => void;
  fallbackOpen: boolean;
  setFallbackOpen: (updater: boolean | ((o: boolean) => boolean)) => void;
  // Web
  webProvider: AppSettings["webSearch"]["provider"];
  setWebProvider: (v: AppSettings["webSearch"]["provider"]) => void;
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
  idleMemoryConsolidation: boolean;
  setIdleMemoryConsolidation: (v: boolean) => void;
  memoryCaptureMode: MemoryCaptureMode;
  setMemoryCaptureMode: (v: MemoryCaptureMode) => void;
  subAgentAutonomousWake: boolean;
  subAgentMaxRounds: number;
  setSubAgentMaxRounds: (next: number) => void;
  setSubAgentAutonomousWake: (v: boolean) => void;
  // Marketplace
  marketplaceBaseUrl: string;
  setMarketplaceBaseUrl: (v: string) => void;
  marketplaceAllowPrivateNetwork: boolean;
  setMarketplaceAllowPrivateNetwork: (v: boolean) => void;
  hasMarketplaceApiKey: boolean;
  setHasMarketplaceApiKey: (v: boolean) => void;
  marketplaceApiKeyInput: string;
  setMarketplaceApiKeyInput: (v: string) => void;
  marketplaceProviderPresetId: string;
  marketplaceProviderPresets: readonly MarketplaceInstalledProviderPreset[];
  selectMarketplaceProviderPreset: (preset: MarketplaceInstalledProviderPreset) => void;
  /** Move vendor and model together when the chosen model belongs elsewhere. */
  selectApiVendorModel: (vendorId: string, modelId: string) => void;
  clearMarketplaceProviderPreset: () => void;
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



  save: (tab: string) => Promise<boolean>;
  vendorInfo: VendorOption;
}

export function useSettingsOrchestration(
  api: LvisApi,
  onSaved: () => void,
): SettingsOrchestrationState {
  // Initialize vendor to "" (empty) rather than "claude" so the UI never
  // flashes the wrong vendor label before the settings load effect hydrates
  // the correct persisted value. The `settingsLoaded` guard prevents any
  // save from firing before hydration completes.
  const [vendor, setVendor] = useState<LLMVendor | "">("");
  const [providerCredentialDraft, setProviderCredentialDraft] =
    useState<ProviderCredentialDraft | null>(null);
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
  const [webProvider, setWebProvider] = useState<AppSettings["webSearch"]["provider"]>("duckduckgo");
  const [webKeyInput, setWebKeyInput] = useState("");
  const [hasWebKey, setHasWebKey] = useState(false);
  const [piiRedactEnabled, setPiiRedactEnabled] = useState(false);
  const [idlePreferenceRefresh, setIdlePreferenceRefresh] = useState(false);
  const [idleMemoryConsolidation, setIdleMemoryConsolidation] = useState(false);
  const [memoryCaptureMode, setMemoryCaptureMode] = useState<MemoryCaptureMode>("off");
  const [subAgentAutonomousWake, setSubAgentAutonomousWake] = useState(false);
  const [subAgentMaxRounds, setSubAgentMaxRounds] = useState(SUBAGENT_MAX_ROUNDS_DEFAULT);
  const [marketplaceBaseUrl, setMarketplaceBaseUrl] = useState("");
  const [marketplaceAllowPrivateNetwork, setMarketplaceAllowPrivateNetwork] = useState(true);
  const [hasMarketplaceApiKey, setHasMarketplaceApiKey] = useState(false);
  const [marketplaceApiKeyInput, setMarketplaceApiKeyInput] = useState("");
  const [marketplaceProviderPresetId, setMarketplaceProviderPresetId] = useState("");
  const [marketplaceProviderPresets, setMarketplaceProviderPresets] = useState<MarketplaceInstalledProviderPreset[]>([]);
  const [saving, setSaving] = useState(false);
  const [lastSaveError, setLastSaveError] = useState<{ tab: string; message: string } | null>(null);
  const clearLastSaveError = useCallback(() => setLastSaveError(null), []);
  const [settingsSnapshot, setSettingsSnapshot] = useState<AppSettings | null>(null);
  const hydratedVendorRef = useRef<string | null>(null);
  const hydratedWebProviderRef = useRef<string | null>(null);
  const vendorInfo = getVendorOption(vendor);

  const activeCredentialProviderId =
    vendor === "openai-compatible" && marketplaceProviderPresetId
      ? marketplaceProviderPresetSecretId(marketplaceProviderPresetId)
      : vendor;

  // Load all settings on mount. (Before the BrowserWindow conversion this
  // was gated on `open`; that's now always true while the window exists.)
  useEffect(() => {
    let cancelled = false;
    setSettingsLoaded(false);
    void (async () => {
      const s = await api.getSettings();
      const provider = isLLMVendor(s.llm.provider)
        ? s.llm.provider
        : DEFAULT_LLM_VENDOR;
      const providerPresetId = provider === "openai-compatible"
        ? s.llm.marketplaceProviderPresetId ?? ""
        : "";
      const [apiKeySet, webApiKeySet, marketplaceKeySet] = await Promise.all([
        api.hasApiKey(providerPresetId
          ? marketplaceProviderPresetSecretId(providerPresetId)
          : provider),
        api.hasWebApiKey(s.webSearch.provider),
        api.hasMarketplaceApiKey(),
      ]);
      if (cancelled) return;
      const block = getLlmVendorSettings(s.llm.vendors, provider);
      hydratedVendorRef.current = provider;
      hydratedWebProviderRef.current = s.webSearch.provider;
      setSettingsSnapshot(s);
      setVendor(provider);
      setMarketplaceProviderPresetId(providerPresetId);
      setMarketplaceProviderPresets(s.marketplace?.installedProviderPresets ?? []);
      hydrateVendorBlock(block, providerPresetId);
      setStreamSmoothing(s.llm.streamSmoothing);
      setAutoCompact(s.chat.autoCompact ?? true);
      setHasKey(apiKeySet);
      setWebProvider(s.webSearch.provider);
      setHasWebKey(webApiKeySet);
      setPiiRedactEnabled(s.privacy?.piiRedactEnabled ?? false);
      setIdlePreferenceRefresh(s.features?.idlePreferenceRefresh ?? false);
      setIdleMemoryConsolidation(s.features?.idleMemoryConsolidation ?? false);
      setMemoryCaptureMode(s.features?.memoryCaptureMode ?? "off");
      setSubAgentAutonomousWake(s.features?.subAgentAutonomousWake ?? false);
      setSubAgentMaxRounds(s.chat?.subAgentMaxRounds ?? SUBAGENT_MAX_ROUNDS_DEFAULT);
      setMarketplaceBaseUrl(s.marketplace?.cloudBaseUrl ?? "");
      setMarketplaceAllowPrivateNetwork(s.marketplace?.cloudAllowPrivateNetwork ?? false);
      setHasMarketplaceApiKey(marketplaceKeySet);
      setFallbackChain(s.llm.fallbackChain.map((e) => ({ provider: e.provider, model: e.model })));
      setSettingsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [api]);

  // Stay in sync with cross-window settings broadcasts. Updating the snapshot
  // refreshes the cached source that the vendor-switch effect consults; the
  // userTouchedRef-style guards in this hook protect in-flight form edits.
  useEffect(() => {
    return api.onSettingsUpdated((next) => {
      setSettingsSnapshot(next);
      setIdlePreferenceRefresh(next.features?.idlePreferenceRefresh ?? false);
      setIdleMemoryConsolidation(next.features?.idleMemoryConsolidation ?? false);
      setMemoryCaptureMode(next.features?.memoryCaptureMode ?? "off");
      setSubAgentAutonomousWake(next.features?.subAgentAutonomousWake ?? false);
      setSubAgentMaxRounds(next.chat?.subAgentMaxRounds ?? SUBAGENT_MAX_ROUNDS_DEFAULT);
      // The INSTALLED list is external state and tracks the broadcast. Which
      // preset the form is pointed at is not: it belongs to the same set of
      // fields as the vendor, the base URL and the model, which this handler
      // deliberately leaves alone so a broadcast cannot overwrite what the user
      // is editing. Deriving it from the PERSISTED provider did exactly that —
      // a form moved to another provider had its preset rewritten underneath
      // it on the next unrelated save, which is how a generic provider ended up
      // wearing a preset's endpoint lock.
      setMarketplaceProviderPresets(next.marketplace?.installedProviderPresets ?? []);
    });
  }, [api]);

  // Re-hydrate every vendor-specific field when the active vendor changes.
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!ALL_VENDORS.some((x) => x.id === vendor)) return;
    // Only a vendor CHANGE re-hydrates. This effect also re-runs whenever a
    // cross-window settings broadcast refreshes the snapshot, and hydrating
    // then would overwrite the fields the user is editing right now — the
    // chosen model, a half-typed base URL — with the persisted values.
    if (hydratedVendorRef.current === vendor) return;
    hydratedVendorRef.current = vendor;
    let cancelled = false;
    void api.hasApiKey(activeCredentialProviderId).then((k) => { if (!cancelled) setHasKey(k); });
    const block = isLLMVendor(vendor)
      ? getLlmVendorSettings(settingsSnapshot?.llm.vendors, vendor)
      : null;
    if (block) {
      hydrateVendorBlock(
        block,
        vendor === "openai-compatible" ? marketplaceProviderPresetId : "",
      );
    }
    return () => { cancelled = true; };
  }, [
    vendor, api, settingsLoaded, settingsSnapshot, activeCredentialProviderId,
    marketplaceProviderPresetId,
  ]);

  function hydrateVendorBlock(
    block: LLMVendorSettings,
    marketplaceProviderPresetIdForBlock = "",
  ): void {
    setModel(llmRouteModel(block, marketplaceProviderPresetIdForBlock));
    setBaseUrl(block.baseUrl ?? "");
    setVertexProject(block.vertexProject ?? "");
    setVertexLocation(block.vertexLocation ?? "");
    setEnableThinking(block.enableThinking);
    setThinkingBudget(block.thinkingBudgetTokens);
  }

  function hydrateLlmFromSettings(next: AppSettings): void {
    const nextVendor = isLLMVendor(next.llm.provider)
      ? next.llm.provider
      : DEFAULT_LLM_VENDOR;
    const block = getLlmVendorSettings(next.llm.vendors, nextVendor);
    const providerPresetId = nextVendor === "openai-compatible"
      ? next.llm.marketplaceProviderPresetId ?? ""
      : "";
    hydratedVendorRef.current = nextVendor;
    setSettingsSnapshot(next);
    setVendor(nextVendor);
    setMarketplaceProviderPresetId(providerPresetId);
    setMarketplaceProviderPresets(next.marketplace?.installedProviderPresets ?? []);
    hydrateVendorBlock(block, providerPresetId);
    setStreamSmoothing(next.llm.streamSmoothing);
    setFallbackChain(next.llm.fallbackChain.map((e) => ({ provider: e.provider, model: e.model })));
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

  /**
   * Choose a model that may belong to a different API vendor than the one the
   * configuration form is pointed at. The chooser spans every configured
   * vendor, so vendor and model have to move together — and the hydration
   * marker is stamped here so the vendor-change effect does not immediately
   * replace the chosen model with that vendor's persisted one.
   */
  const selectApiVendorModel = useCallback((vendorId: string, modelId: string) => {
    if (!isLLMVendor(vendorId)) return;
    const block = getLlmVendorSettings(settingsSnapshot?.llm.vendors, vendorId);
    hydratedVendorRef.current = vendorId;
    setVendor(vendorId);
    if (vendorId !== "openai-compatible") setMarketplaceProviderPresetId("");
    setBaseUrl(block.baseUrl ?? "");
    setVertexProject(block.vertexProject ?? "");
    setVertexLocation(block.vertexLocation ?? "");
    setEnableThinking(block.enableThinking);
    setThinkingBudget(block.thinkingBudgetTokens);
    setModel(modelId);
    void api.hasApiKey(vendorId).then((k) => setHasKey(k)).catch(() => setHasKey(false));
  }, [api, settingsSnapshot]);

  const selectMarketplaceProviderPreset = useCallback((preset: MarketplaceInstalledProviderPreset) => {
    const openaiCompatibleDefaults = getLlmVendorSettings(
      settingsSnapshot?.llm.vendors,
      "openai-compatible",
    );
    hydratedVendorRef.current = "openai-compatible";
    setMarketplaceProviderPresetId(preset.providerId);
    setVendor("openai-compatible");
    // This preset's own stored model, so switching between two presets restores
    // what each was last set to rather than resetting both to a seed.
    setModel(
      llmRouteModel(openaiCompatibleDefaults, preset.providerId) || preset.defaultModel,
    );
    // NOT `preset.baseUrl`: this field is the generic custom provider row's
    // stored endpoint and is written back on every save, so parking the
    // preset's address in it is how the two rows used to overwrite each other.
    // Consumers that need the preset's address resolve it from the preset.
    setBaseUrl(openaiCompatibleDefaults.baseUrl ?? "");
    setVertexProject("");
    setVertexLocation("");
    setEnableThinking(openaiCompatibleDefaults.enableThinking);
    setThinkingBudget(openaiCompatibleDefaults.thinkingBudgetTokens);
    void api
      .hasApiKey(marketplaceProviderPresetSecretId(preset.providerId))
      .then((k) => setHasKey(k))
      .catch(() => setHasKey(false));
  }, [api, settingsSnapshot]);

  const clearMarketplaceProviderPreset = useCallback(() => {
    setMarketplaceProviderPresetId("");
    if (vendor !== "openai-compatible") return;
    // The stored block, always. It used to be replaced with DEFAULTS whenever a
    // preset had been persisted — the only reason being that the block then
    // held the preset's mirrored address and had to be scrubbed. Nothing
    // mirrors any more, so the block is the generic row's own endpoint and
    // scrubbing it would throw away what the user saved.
    const genericBlock = getLlmVendorSettings(settingsSnapshot?.llm.vendors, "openai-compatible");
    hydrateVendorBlock(genericBlock);
    void api.hasApiKey("openai-compatible")
      .then((k) => setHasKey(k))
      .catch(() => setHasKey(false));
  }, [api, settingsSnapshot, vendor]);

  // In-flight guard + pending re-fire: if a debounced save lands while a
  // previous save is still in flight (cross-tab race), mark it pending
  // and re-fire after the current call resolves. Without this, two
  // overlapping saves would race in settingsService and `setSaving`
  // would flicker (the first call's `finally` clears the flag while the
  // second is still running).
  const savingRef = useRef(false);
  /**
   * Saves that arrived while another was in flight, in arrival order.
   *
   * A tab save and a provider card's credential save contend for the same
   * in-flight flag, so both queue here rather than one of them being dropped:
   * a card whose Save landed a beat after a debounced `llm` save used to
   * return false and go quiet, leaving the card looking committed when
   * nothing had been written. A queued credential save keeps its caller's
   * promise so the card learns what actually happened.
   */
  const pendingSaves = useRef<PendingSave[]>([]);
  // Latest-`save` ref: the running save closure captures values from its
  // own render. When `finally` re-fires the pending payload, it must
  // call the LATEST `save` (with the latest closures) — otherwise
  // toggles that landed between the call and the re-fire are silently
  // dropped from the second save's payload. The ref is updated via
  // `useEffect` (canonical latest-ref pattern) so a discarded concurrent
  // render does not leave a dangling closure here.
  const saveRef = useRef<(tab: string) => Promise<boolean>>(null!);
  const saveProviderCredentialRef =
    useRef<(input: ProviderCredentialSave) => Promise<boolean>>(null!);
  /**
   * Run the next queued save, if any.
   *
   * Called from the `finally` of whichever save just finished, so the flag it
   * checks is already clear. Each run drains the next in its own `finally`,
   * which is what keeps the queue moving without a second scheduler.
   */
  const drainPendingSaves = (): void => {
    const next = pendingSaves.current.shift();
    if (!next) return;
    if (next.kind === "tab") {
      void saveRef.current(next.tab);
      return;
    }
    void saveProviderCredentialRef.current(next.input).then(next.resolve, () => next.resolve(false));
  };
  const save = async (tab: string): Promise<boolean> => {
    if (!settingsLoaded) return false;
    if (savingRef.current) {
      // One pending entry per tab: the payload is read from state at run time,
      // so a second request for the same tab would write the same thing twice.
      if (!pendingSaves.current.some((entry) => entry.kind === "tab" && entry.tab === tab)) {
        pendingSaves.current.push({ kind: "tab", tab });
      }
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    let ok = false;
    try {
      if (tab !== "permissions") {
        const secretUpdates: Array<Promise<unknown>> = [];
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
        // The row's OWN endpoint, never the active preset's. A preset's
        // address belongs to the preset registry; writing it here would put it
        // in the generic custom provider's block, which is a different row.
        const trimmedBaseUrl = baseUrl.trim();
        const trimmedVertexProject = vertexProject.trim();
        const trimmedVertexLocation = vertexLocation.trim();
        // A marketplace preset's model goes in its own slot, keyed by preset,
        // and the block's single `model` is left untouched — that one belongs
        // to the generic custom-provider row, which is a different row reached
        // through the same vendor. Omitting a key leaves the stored value
        // intact, so the row not being edited keeps its model.
        const activePresetId = vendor === "openai-compatible"
          ? marketplaceProviderPresetId
          : "";
        const routeModel = model.trim() || vendorInfo.defaultModel;
        const activeBlock: DeepPartial<LLMVendorSettings> = {
          // This preset's key alone. The main side merges it into the stored
          // map (`mergeLlmPatch`), so a save here can never carry a stale copy
          // of another preset's model back over a newer one.
          ...(activePresetId
            ? { presetModels: { [activePresetId]: routeModel } }
            : { model: routeModel }),
          baseUrl: trimmedBaseUrl || undefined,
          vertexProject: trimmedVertexProject || undefined,
          vertexLocation: trimmedVertexLocation || undefined,
          enableThinking,
          thinkingBudgetTokens: thinkingBudget,
        };
        const llmPatch: DeepPartial<AppSettings["llm"]> = {
          provider: vendor || undefined,
          marketplaceProviderPresetId:
            vendor === "openai-compatible" ? marketplaceProviderPresetId : "",
          streamSmoothing,
          fallbackChain: fallbackChain.filter((e) => e.provider && e.model).map((e) => ({ provider: e.provider, model: e.model })),
        };
        llmPatch.vendors = { [vendor]: activeBlock };
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
      // If a save was coalesced while we were running, fire it now via the
      // LATEST closure (the refs) so the re-fire reads the most recent state,
      // not the stale closure of the original call. Without this the second
      // save would silently drop any toggles that landed between the original
      // call and the re-fire.
      drainPendingSaves();
    }
    return ok;
  };
  useEffect(() => {
    saveRef.current = save;
  });

  /**
   * Commit ONE provider card: its own vendor block, its own secret.
   *
   * Deliberately not part of `save("llm")`. That call writes `llm.provider`,
   * so routing a card's Save through it made storing a key for one provider
   * also switch chat to it. Which provider chat runs on is a separate decision
   * with its own control, and this call must never take it.
   *
   * The block is written BEFORE the secret, and a rejected write aborts: a key
   * that lands beside an endpoint the store refused would be a credential
   * pointing at an address nobody saved.
   */
  const saveProviderCredential = useCallback(async (
    input: ProviderCredentialSave,
  ): Promise<boolean> => {
    if (!settingsLoaded) return false;
    if (savingRef.current) {
      // Queue behind the in-flight save and hand the caller the outcome of
      // the run that actually happens, so the card stays dirty until then
      // instead of quietly reporting a failure it cannot explain.
      return new Promise<boolean>((resolve) => {
        pendingSaves.current.push({ kind: "credential", input, resolve });
      });
    }
    savingRef.current = true;
    setSaving(true);
    try {
      if (input.vendorBlock) {
        const updateResult = await api.updateSettings({
          llm: { vendors: { [input.vendorId]: input.vendorBlock } },
        });
        if (isIpcErrorResult(updateResult)) {
          throw new Error(formatIpcError(updateResult.error, updateResult.message));
        }
        // The active provider's mirrored fields feed the model-list handshake,
        // so editing that provider's own card has to move them here too.
        if (input.vendorId === vendor) {
          if (input.vendorBlock.baseUrl !== undefined) setBaseUrl(input.vendorBlock.baseUrl);
          if (input.vendorBlock.vertexProject !== undefined) {
            setVertexProject(input.vendorBlock.vertexProject);
          }
          if (input.vendorBlock.vertexLocation !== undefined) {
            setVertexLocation(input.vendorBlock.vertexLocation);
          }
        }
      }
      const trimmedKey = input.apiKey.trim();
      if (trimmedKey) {
        await api.setApiKey(input.credentialProviderId, trimmedKey);
        if (input.credentialProviderId === activeCredentialProviderId) setHasKey(true);
      }
      onSaved();
      setLastSaveError(null);
      return true;
    } catch (err) {
      const message = err instanceof Error && err.message
        ? err.message
        : t("useSettingsOrchestration.saveFailed");
      setLastSaveError({ tab: "llm", message });
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      drainPendingSaves();
    }
  }, [api, activeCredentialProviderId, onSaved, settingsLoaded, vendor]);
  useEffect(() => {
    saveProviderCredentialRef.current = saveProviderCredential;
  }, [saveProviderCredential]);

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

  const setIdleMemoryConsolidationLive = useCallback((next: boolean) => {
    const previous = idleMemoryConsolidation;
    setIdleMemoryConsolidation(next);
    if (!settingsLoaded) return;
    void api
      .updateSettings({ features: { idleMemoryConsolidation: next } })
      .then((updated) => {
        if (isIpcErrorResult(updated)) throw new Error(updated.message ?? updated.error);
        setSettingsSnapshot(updated);
        onSaved();
      })
      .catch(() => {
        setIdleMemoryConsolidation(previous);
      });
  }, [api, idleMemoryConsolidation, onSaved, settingsLoaded]);

  const setMemoryCaptureModeLive = useCallback((next: MemoryCaptureMode) => {
    const previous = memoryCaptureMode;
    setMemoryCaptureMode(next);
    if (!settingsLoaded) return;
    void api
      .updateSettings({ features: { memoryCaptureMode: next } })
      .then((updated) => {
        if (isIpcErrorResult(updated)) throw new Error(updated.message ?? updated.error);
        setSettingsSnapshot(updated);
        onSaved();
      })
      .catch(() => {
        setMemoryCaptureMode(previous);
      });
  }, [api, memoryCaptureMode, onSaved, settingsLoaded]);

  const setSubAgentAutonomousWakeLive = useCallback((next: boolean) => {
    const previous = subAgentAutonomousWake;
    setSubAgentAutonomousWake(next);
    if (!settingsLoaded) return;
    void api
      .updateSettings({ features: { subAgentAutonomousWake: next } })
      .then((updated) => {
        if (isIpcErrorResult(updated)) throw new Error(updated.message ?? updated.error);
        setSettingsSnapshot(updated);
        onSaved();
      })
      .catch(() => {
        setSubAgentAutonomousWake(previous);
      });
  }, [api, onSaved, settingsLoaded, subAgentAutonomousWake]);

  const setSubAgentMaxRoundsLive = useCallback((next: number) => {
    const previous = subAgentMaxRounds;
    // Floor only: below 1 an agent cannot finish a single tool round-trip.
    // No upper clamp — the engine runs whatever is stored, so narrowing here
    // would make the settings file disagree with what actually runs.
    const clamped = Math.max(SUBAGENT_MAX_ROUNDS_MIN, Math.floor(next));
    setSubAgentMaxRounds(clamped);
    if (!settingsLoaded) return;
    void api
      .updateSettings({ chat: { subAgentMaxRounds: clamped } })
      .then((updated) => {
        if (isIpcErrorResult(updated)) throw new Error(updated.message ?? updated.error);
        setSettingsSnapshot(updated);
        onSaved();
      })
      .catch(() => {
        setSubAgentMaxRounds(previous);
      });
  }, [api, onSaved, settingsLoaded, subAgentMaxRounds]);
  return {
    lastSaveError,
    clearLastSaveError,
    hydrateLlmFromSettings,
    vendor,
    providerCredentialDraft, setProviderCredentialDraft,
    saveProviderCredential,
    selectApiVendorModel,
    model, setModel,
    hasKey, setHasKey,
    autoCompact, setAutoCompact,
    enableThinking, setEnableThinking,
    thinkingBudget, setThinkingBudget,
    baseUrl,
    streamSmoothing, setStreamSmoothing,
    fallbackChain, setFallbackChain,
    fallbackOpen, setFallbackOpen,
    webProvider, setWebProvider,
    webKeyInput, setWebKeyInput,
    hasWebKey, setHasWebKey,
    piiRedactEnabled, setPiiRedactEnabled,
    idlePreferenceRefresh, setIdlePreferenceRefresh: setIdlePreferenceRefreshLive,
    idleMemoryConsolidation, setIdleMemoryConsolidation: setIdleMemoryConsolidationLive,
    memoryCaptureMode, setMemoryCaptureMode: setMemoryCaptureModeLive,
    subAgentAutonomousWake, setSubAgentAutonomousWake: setSubAgentAutonomousWakeLive,
    subAgentMaxRounds, setSubAgentMaxRounds: setSubAgentMaxRoundsLive,
    marketplaceBaseUrl, setMarketplaceBaseUrl,
    marketplaceAllowPrivateNetwork, setMarketplaceAllowPrivateNetwork,
    hasMarketplaceApiKey, setHasMarketplaceApiKey,
    marketplaceApiKeyInput, setMarketplaceApiKeyInput,
    marketplaceProviderPresetId,
    marketplaceProviderPresets,
    selectMarketplaceProviderPreset,
    clearMarketplaceProviderPreset,
    settingsLoaded,
    saving,
    save,
    vendorInfo,
  };
}
