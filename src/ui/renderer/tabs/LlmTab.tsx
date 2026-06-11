import { useCallback, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.js";
import { Slider } from "../../../components/ui/slider.js";
import { Switch } from "../../../components/ui/switch.js";
import { Textarea } from "../../../components/ui/textarea.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { REASONING_EFFORT_STEPS, VENDORS, budgetToEffortIndex } from "../constants.js";
import { parseHostResolverMap } from "../../../shared/host-resolver-map.js";
import type { LvisApi } from "../types.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useTranslation } from "../../../i18n/react.js";

export interface FallbackEntry {
  provider: string;
  model: string;
}

export interface LlmTabProps {
  api: LvisApi;
  vendor: string;
  setVendor: (v: string) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  vertexProject: string;
  setVertexProject: (v: string) => void;
  vertexLocation: string;
  setVertexLocation: (v: string) => void;
  hasKey: boolean;
  setHasKey: (v: boolean) => void;
  keyInput: string;
  setKeyInput: (v: string) => void;
  /**
   * #893 — Top-level auth mode. `"manual"` (default) renders the vendor
   * dropdown + full per-vendor form (API key, baseUrl, model, vertex…);
   * `"login"` renders the same fields but in a disabled state showing the
   * active login-session values. Persisted at `llm.authMode` (top-level,
   * not per-vendor).
   */
  authMode: "manual" | "login";
  setAuthMode: (mode: "manual" | "login") => void;
  /** Fired when the user clicks the "Login" button in the auth-mode section. */
  onOpenLogin?: () => void;
  model: string;
  setModel: (v: string) => void;
  enableThinking: boolean;
  setEnableThinking: (v: boolean) => void;
  thinkingBudget: number;
  setThinkingBudget: (v: number) => void;
  fallbackChain: FallbackEntry[];
  setFallbackChain: (updater: FallbackEntry[] | ((c: FallbackEntry[]) => FallbackEntry[])) => void;
  fallbackOpen: boolean;
  setFallbackOpen: (updater: boolean | ((o: boolean) => boolean)) => void;
  /** Manual-mode host-resolver map (persisted /etc/hosts-style text). */
  hostResolverMap: string;
  setHostResolverMap: (v: string) => void;
  /**
   * The host-resolver map value as last hydrated from persisted settings.
   * Used to detect whether the textarea has actually changed — the Apply
   * (Save and Restart) button is only enabled when the current draft differs
   * from this, so an unchanged Apply click can never trigger a needless
   * relaunch (requirement D).
   */
  loadedHostResolverMap: string;
  onSaved: () => void;
  /**
   * Called after the user changes an immediate-apply control (vendor /
   * thinking toggle / reasoning slider). The dialog debounces these and
   * persists via `s.save("llm")` so the user gets immediate-feel
   * application without spamming saves.
   */
  onImmediateChange?: () => void;
  /**
   * Section-anchored explicit save handler. Both the 공급자 구성 and
   * Fallback Chain sections render their own Save button that calls
   * this — the orchestration save() persists the whole `llm` payload,
   * so the two buttons are functionally identical and the visual
   * placement just anchors each Save to its inputs.
   */
  onSave?: () => void;
  saving?: boolean;
  settingsLoaded?: boolean;
}

/**
 * Inline save bar for a LlmTab subsection. Both 공급자 구성 and Fallback
 * Chain reuse this; the Extended Thinking section is fully immediate-apply
 * (Switch + Slider auto-save via onImmediateChange) and renders no bar.
 */
function SectionSaveBar({
  onSave,
  saving,
  settingsLoaded,
  testId,
}: {
  onSave: () => void;
  saving: boolean;
  settingsLoaded: boolean;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end border-t border-border/40 pt-2">
      <Button
        size="sm"
        onClick={onSave}
        disabled={saving || !settingsLoaded}
        data-testid={testId}
      >
        {saving ? t("llmTab.saving") : t("llmTab.save")}
      </Button>
    </div>
  );
}

/** Inline badge for "즉시 적용" label. */
function ImmediateBadge() {
  const { t } = useTranslation();
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
      {t("llmTab.immediateApply")}
    </span>
  );
}

function getVendorInfo(vendorId: string): (typeof VENDORS)[number] {
  return VENDORS.find((v) => v.id === vendorId) ?? VENDORS[0]!;
}

function modelOptionsFor(vendorId: string, selectedModel: string): string[] {
  const info = getVendorInfo(vendorId);
  const options = [...info.modelOptions];
  const defaultModel = info.defaultModel.trim();
  if (defaultModel && !options.includes(defaultModel)) {
    options.unshift(defaultModel);
  }

  const currentModel = selectedModel.trim();
  if (currentModel && !options.includes(currentModel)) {
    options.unshift(currentModel);
  }

  return options;
}

export function LlmTab(props: LlmTabProps) {
  const {
    api,
    vendor,
    setVendor,
    baseUrl,
    setBaseUrl,
    vertexProject,
    setVertexProject,
    vertexLocation,
    setVertexLocation,
    hasKey,
    setHasKey,
    keyInput,
    setKeyInput,
    authMode,
    setAuthMode,
    onOpenLogin,
    model,
    setModel,
    enableThinking,
    setEnableThinking,
    thinkingBudget,
    setThinkingBudget,
    fallbackChain,
    setFallbackChain,
    fallbackOpen,
    setFallbackOpen,
    hostResolverMap,
    setHostResolverMap,
    loadedHostResolverMap,
    onSaved,
    onImmediateChange,
    onSave,
    saving = false,
    settingsLoaded = true,
  } = props;
  const { t } = useTranslation();
  const vendorInfo = getVendorInfo(vendor);
  // (B) Pre-hydration the parent initializes `vendor` to "" so the dropdown
  // never flashes the wrong vendor. `getVendorInfo("")` still falls back to
  // VENDORS[0], so reading `vendorInfo.label` directly would leak that stale
  // first-vendor name into the API-key heading before settings load. Render
  // the label only once a real vendor is hydrated; until then show nothing.
  const vendorLabelReady = vendor !== "" && settingsLoaded;
  const vendorLabel = vendorLabelReady ? vendorInfo.label : "";
  const hasOnSave = typeof onSave === "function";
  const activeModelValue = model.trim() || vendorInfo.defaultModel;
  const activeModelOptions = modelOptionsFor(vendor, activeModelValue);

  // Relaunch confirmation dialog state for host map changes.
  const [relaunchConfirmOpen, setRelaunchConfirmOpen] = useState(false);
  const [relaunchPending, setRelaunchPending] = useState(false);
  const [relaunchError, setRelaunchError] = useState<string | null>(null);

  const handleHostMapApply = useCallback(() => {
    setRelaunchError(null);
    setRelaunchConfirmOpen(true);
  }, []);

  const handleRelaunchConfirm = useCallback(async () => {
    setRelaunchPending(true);
    setRelaunchError(null);
    try {
      await api.applyHostMap(hostResolverMap);
      // On success the main process calls app.relaunch() + app.exit(0), so
      // this renderer terminates here — no further cleanup runs. We keep the
      // dialog open until then so the user never sees it close without a
      // restart actually happening.
    } catch {
      // Persisting the host map (or scheduling the relaunch) failed. Surface
      // it inline and keep the dialog open so the user can retry or cancel —
      // closing silently would falsely imply the change applied. Awaiting +
      // catching here also prevents an unhandled promise rejection.
      setRelaunchError(t("llmTab.relaunchConfirmError"));
      setRelaunchPending(false);
    }
  }, [api, hostResolverMap, t]);

  const isLoginMode = authMode === "login";
  // Requirement D — only allow Apply when the host map has ACTUALLY changed
  // from the last-persisted value. `loadedHostResolverMap` is the value
  // hydrated from settings; comparing against it means an unchanged textarea
  // leaves the Apply (Save and Restart) button disabled, so an unchanged
  // click can never trigger a needless relaunch.
  const hostMapChanged = hostResolverMap !== loadedHostResolverMap;
  const hostMapEntryCount = parseHostResolverMap(hostResolverMap).length;

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("llmTab.pageTitle")}
        description={t("llmTab.pageDescription")}
      />

      {/* Relaunch confirmation dialog — shown before applying host map changes */}
      <Dialog
        open={relaunchConfirmOpen}
        onOpenChange={(open) => {
          if (relaunchPending) return;
          if (!open) setRelaunchError(null);
          setRelaunchConfirmOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("llmTab.relaunchConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("llmTab.relaunchConfirmBody")}</DialogDescription>
          </DialogHeader>
          {relaunchError && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="llm-tab:relaunch-error"
            >
              {relaunchError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRelaunchError(null);
                setRelaunchConfirmOpen(false);
              }}
              disabled={relaunchPending}
            >
              {t("llmTab.relaunchConfirmCancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleRelaunchConfirm()}
              disabled={relaunchPending}
              data-testid="llm-tab:relaunch-confirm"
            >
              {relaunchPending ? t("llmTab.saving") : t("llmTab.relaunchConfirmOk")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Section A — 공급자 구성.
          When `authMode === "login"` the vendor dropdown and every per-vendor
          field are rendered in a visually disabled state showing the active
          login-session values — they are not removed from the DOM. This gives
          the user context about what is currently active and makes it clear
          that logging out will restore edit access. */}
      <SettingsSection
        title={t("llmTab.providerConfig")}
        id="llm-providers"
      >
        <div
          className="space-y-3"
          data-testid="llm-tab:section-providers"
        >
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t("llmTab.authMethod")}</Label>
            <RadioGroup
              value={authMode}
              onValueChange={(v) => {
                if (v === "manual" || v === "login") {
                  setAuthMode(v);
                  // Login success owns provider/model persistence; avoid a stale manual-mode autosave.
                  if (v === "manual") {
                    onImmediateChange?.();
                  }
                }
              }}
              className="flex gap-4"
              data-testid="llm-tab:auth-mode"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="manual" id="auth-mode-manual" />
                <Label htmlFor="auth-mode-manual" className="text-xs">{t("llmTab.authManual")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="login" id="auth-mode-login" />
                <Label htmlFor="auth-mode-login" className="text-xs">Login</Label>
              </div>
            </RadioGroup>
          </div>

          {/* Login-mode status + action row — shown only when authMode === "login" */}
          {isLoginMode && (
            <div className="space-y-2" data-testid="llm-tab:login-section">
              <div className="flex items-center gap-2">
                {hasKey ? (
                  <Badge variant="default" className="text-xs">{t("llmTab.loggedIn")}</Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs">{t("llmTab.loginRequired")}</Badge>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                data-testid="llm-tab:open-login"
                onClick={() => onOpenLogin?.()}
              >
                Login
              </Button>
              <p className="text-[11px] text-muted-foreground">
                {t("llmTab.loginAutoConfig")}
              </p>
              {/* Edit access is gated on logging out. Logout is owned by the
                  single GeneralTab.performLogout path (which deletes the active
                  vendor secret, clears the demo session, and persists
                  llm.authMode="manual"). We deliberately do NOT offer a local
                  authMode toggle here: setting renderer state to "manual"
                  without persisting would desync the UI from the stored
                  llm.authMode and revert on the next mount. Point the user at
                  the canonical logout instead. */}
              <p
                className="text-[11px] text-muted-foreground"
                data-testid="llm-tab:logout-hint"
              >
                {t("llmTab.logoutToEdit")}
              </p>
            </div>
          )}

          {/* Provider form — always rendered; disabled when authMode === "login" */}
          <div
            className={isLoginMode ? "pointer-events-none opacity-50 select-none space-y-3" : "space-y-3"}
            {...(isLoginMode ? { "aria-disabled": "true" as const } : {})}
            data-testid="llm-tab:manual-section"
          >
            {isLoginMode && (
              <p className="text-[11px] text-muted-foreground italic">
                {t("llmTab.loginModeDisabledHint")}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="vendor-select" className="flex items-center gap-2">
                {t("llmTab.vendor")}
                {!isLoginMode && <ImmediateBadge />}
              </Label>
              <Select
                value={vendor}
                onValueChange={(v) => {
                  if (isLoginMode) return;
                  setVendor(v);
                  onImmediateChange?.();
                }}
                disabled={isLoginMode}
              >
                <SelectTrigger id="vendor-select" className="w-full">
                  <SelectValue placeholder={t("llmTab.vendorPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {VENDORS.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {vendor !== "vertex-ai" && (vendorInfo.needsBaseUrl || vendor === "openai" || vendor === "copilot") && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Endpoint (baseUrl){vendorInfo.needsBaseUrl ? " *" : ` (${t("llmTab.optional")})`}
                </Label>
                <Input
                  data-testid="llm-base-url-input"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={(vendorInfo as any).baseUrlPlaceholder ?? "https://..."}
                  disabled={isLoginMode}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t("llmTab.baseUrlDiscardWarning")}
                </p>
                {vendor === "azure-foundry" && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("llmTab.azureEndpointFormat")}
                    {" "}<code>https://{"{resource}"}.openai.azure.com/openai/v1/</code>
                    {" "}— {t("llmTab.azureDeploymentNote")}
                  </p>
                )}
                {(vendor === "openai" || vendor === "copilot") && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("llmTab.proxyEndpointNote")}
                  </p>
                )}
              </div>
            )}
            {vendor === "vertex-ai" && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">Google Vertex AI</p>
                <p className="text-[11px] text-muted-foreground">
                  {t("llmTab.vertexAuthDesc1")}<code>gcloud auth application-default login</code>{t("llmTab.vertexAuthDesc2")}
                  {t("llmTab.vertexAuthDesc3")}<code>GOOGLE_APPLICATION_CREDENTIALS</code>{t("llmTab.vertexAuthDesc4")}
                </p>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">GCP Project ID *</Label>
                  <Input
                    value={vertexProject}
                    onChange={(e) => setVertexProject(e.target.value)}
                    placeholder="my-gcp-project"
                    disabled={isLoginMode}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Location (region) — {t("llmTab.optional")}</Label>
                  <Input
                    value={vertexLocation}
                    onChange={(e) => setVertexLocation(e.target.value)}
                    placeholder={t("llmTab.vertexLocationPlaceholder")}
                    disabled={isLoginMode}
                  />
                </div>
              </div>
            )}
            {vendor !== "vertex-ai" && (
              <div className="space-y-2">
                <Label className="text-sm font-medium" data-testid="llm-tab:api-key-label">
                  {vendorLabel ? `${vendorLabel} ` : ""}{t("llmTab.apiKey")}
                </Label>
                <div className="flex items-center gap-2">
                  {hasKey ? <Badge variant="default" className="text-xs">{t("llmTab.apiKeySet")}</Badge> : <Badge variant="secondary" className="text-xs">{t("llmTab.apiKeyNotSet")}</Badge>}
                  {hasKey && !isLoginMode && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-destructive"
                      onClick={() => void api.deleteApiKey(vendor).then(() => { setHasKey(false); onSaved(); })}
                    >
                      {t("llmTab.delete")}
                    </Button>
                  )}
                </div>
                <Input
                  data-testid="llm-api-key-input"
                  type="password"
                  placeholder={hasKey ? t("llmTab.replaceKey") : vendorInfo.placeholder}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  disabled={isLoginMode}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="model-select" className="text-sm font-medium">{t("llmTab.model")}</Label>
              <Select
                value={activeModelValue}
                onValueChange={setModel}
                disabled={isLoginMode}
              >
                <SelectTrigger
                  id="model-select"
                  className="w-full"
                  data-testid="llm-model-select"
                >
                  <SelectValue placeholder={vendorInfo.defaultModel} />
                </SelectTrigger>
                <SelectContent>
                  {activeModelOptions.map((option) => (
                    <SelectItem key={option} value={option}>{option}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {hasOnSave && (
            <SectionSaveBar
              onSave={onSave!}
              saving={saving}
              settingsLoaded={settingsLoaded}
              testId="llm-tab:save-providers"
            />
          )}
        </div>
      </SettingsSection>

      {/* Section — Host Resolver Map.
          Only editable in manual mode. In login mode the map is read-only
          (demo uses LVIS_DEMO_HOST_MAP and this field has no effect). A
          dedicated Apply button triggers the relaunch confirm dialog because
          host-resolver-rules cannot be changed at runtime. */}
      <SettingsSection
        title={t("llmTab.hostResolverMapTitle")}
        id="llm-host-resolver"
      >
        <div className="space-y-2" data-testid="llm-tab:host-resolver-section">
          {isLoginMode ? (
            <p className="text-[11px] text-muted-foreground italic">
              {t("llmTab.hostResolverMapLoginDisabled")}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {t("llmTab.hostResolverMapDesc")}
            </p>
          )}
          <Textarea
            data-testid="llm-host-resolver-map-input"
            value={hostResolverMap}
            onChange={(e) => setHostResolverMap(e.target.value)}
            placeholder={t("llmTab.hostResolverMapPlaceholder")}
            disabled={isLoginMode}
            rows={5}
            className="font-mono text-xs"
            aria-label={t("llmTab.hostResolverMapTitle")}
          />
          {!isLoginMode && hostMapEntryCount > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {hostMapEntryCount === 1
                ? t("llmTab.entryCountSingular", { count: hostMapEntryCount })
                : t("llmTab.entryCountPlural", { count: hostMapEntryCount })}
            </p>
          )}
          {!isLoginMode && (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={handleHostMapApply}
                disabled={saving || !settingsLoaded || !hostMapChanged}
                data-testid="llm-tab:apply-host-map"
              >
                {t("llmTab.hostResolverMapApply")}
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Section B — Extended Thinking / Reasoning */}
      <SettingsSection
        title="Extended Thinking / Reasoning"
        badge={<ImmediateBadge />}
        actions={
          <Switch
            checked={enableThinking}
            onCheckedChange={(c) => {
              setEnableThinking(c);
              onImmediateChange?.();
            }}
            aria-label="Extended Thinking / Reasoning"
          />
        }
        id="llm-thinking"
      >
        <div
          className="space-y-2"
          data-testid="llm-tab:section-thinking"
        >
          <p className="text-[11px] text-muted-foreground">{t("llmTab.thinkingDesc")}</p>
          {enableThinking && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Reasoning Effort</Label>
                <span className="text-xs font-medium tabular-nums">
                  {REASONING_EFFORT_STEPS[budgetToEffortIndex(thinkingBudget)]!.label}
                  <span className="ml-2 text-muted-foreground">· {thinkingBudget.toLocaleString()} tokens</span>
                </span>
              </div>
              <Slider
                min={0}
                max={REASONING_EFFORT_STEPS.length - 1}
                step={1}
                value={[budgetToEffortIndex(thinkingBudget)]}
                onValueChange={([value]) => {
                  setThinkingBudget(REASONING_EFFORT_STEPS[value ?? 0]!.budget);
                  onImmediateChange?.();
                }}
                aria-label="Reasoning effort"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                {REASONING_EFFORT_STEPS.map((s) => (
                  <span key={s.label}>{s.label}</span>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("llmTab.reasoningEffortDesc")}
              </p>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Section C — Fallback Chain */}
      <SettingsSection
        title={t("llmTab.fallbackTitle")}
        id="llm-fallback"
      >
        <div
          className="space-y-2"
          data-testid="fallback-chain-section"
        >
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-between rounded-none px-0 py-1 text-sm font-medium"
            onClick={() => setFallbackOpen((o) => !o)}
          >
            <span className="text-muted-foreground text-xs">{t("llmTab.fallbackSummary")}</span>
            <span className="text-muted-foreground">{fallbackOpen ? "▲" : "▼"}</span>
          </Button>
          {fallbackOpen && (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">{t("llmTab.fallbackDesc")}</p>
              {fallbackChain.map((entry, idx) => {
                const fallbackVendorInfo = getVendorInfo(entry.provider);
                const fallbackModelValue = entry.model.trim() || fallbackVendorInfo.defaultModel;
                const fallbackModelOptions = modelOptionsFor(entry.provider, fallbackModelValue);
                return (
                  <div key={idx} className="flex gap-2">
                    <Select
                      value={entry.provider}
                      onValueChange={(value) => {
                        const nextVendorInfo = getVendorInfo(value);
                        const next = [...fallbackChain];
                        next[idx] = {
                          ...next[idx]!,
                          provider: value,
                          model: nextVendorInfo.defaultModel,
                        };
                        setFallbackChain(next);
                      }}
                    >
                      <SelectTrigger className="w-36 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VENDORS.map((v) => <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select
                      value={fallbackModelValue}
                      onValueChange={(value) => {
                        const next = [...fallbackChain];
                        next[idx] = { ...next[idx]!, model: value };
                        setFallbackChain(next);
                      }}
                    >
                      <SelectTrigger className="min-w-0 flex-1 text-xs">
                        <SelectValue placeholder={fallbackVendorInfo.defaultModel} />
                      </SelectTrigger>
                      <SelectContent>
                        {fallbackModelOptions.map((option) => (
                          <SelectItem key={option} value={option}>{option}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs text-destructive"
                      onClick={() => setFallbackChain((c) => c.filter((_, i) => i !== idx))}
                    >
                      {t("llmTab.delete")}
                    </Button>
                  </div>
                );
              })}
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => setFallbackChain((c) => [
                  ...c,
                  { provider: "openai", model: getVendorInfo("openai").defaultModel },
                ])}
              >
                {t("llmTab.addEntry")}
              </Button>
              {hasOnSave && (
                <SectionSaveBar
                  onSave={onSave!}
                  saving={saving}
                  settingsLoaded={settingsLoaded}
                  testId="llm-tab:save-fallback"
                />
              )}
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
