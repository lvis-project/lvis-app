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
import { REASONING_EFFORT_STEPS, VENDORS, budgetToEffortIndex } from "../constants.js";
import type { LvisApi } from "../types.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";

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
   * `"login"` collapses everything down to status + a single Login button
   * whose backend decides the vendor (see `LVIS_DEMO_VENDOR`). Persisted
   * at `llm.authMode` (top-level, not per-vendor).
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
  return (
    <div className="flex justify-end border-t border-border/40 pt-2">
      <Button
        size="sm"
        onClick={onSave}
        disabled={saving || !settingsLoaded}
        data-testid={testId}
      >
        {saving ? "저장 중…" : "저장"}
      </Button>
    </div>
  );
}

/** Inline badge for "즉시 적용" label. */
function ImmediateBadge() {
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
      즉시 적용
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
    onSaved,
    onImmediateChange,
    onSave,
    saving = false,
    settingsLoaded = true,
  } = props;
  const vendorInfo = getVendorInfo(vendor);
  const hasOnSave = typeof onSave === "function";
  const activeModelValue = model.trim() || vendorInfo.defaultModel;
  const activeModelOptions = modelOptionsFor(vendor, activeModelValue);

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="모델"
        description="AI 공급자와 모델, API 키, 폴백 체인을 설정합니다"
      />

      {/* Section A — 공급자 구성.
          #893 top-level authMode toggle: when `login`, the vendor dropdown
          and every per-vendor field collapse out of the DOM — only status +
          Login button remain. Manual mode renders the full per-vendor form
          (baseUrl / vertex / API key / model) deferred to the section's
          저장 button. */}
      <SettingsSection
        title="공급자 구성"
        id="llm-providers"
      >
        <div
          className="space-y-3"
          data-testid="llm-tab:section-providers"
        >
          <div className="space-y-2">
            <Label className="text-sm font-medium">인증 방식</Label>
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
                <Label htmlFor="auth-mode-manual" className="text-xs">API 키 직접 입력</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="login" id="auth-mode-login" />
                <Label htmlFor="auth-mode-login" className="text-xs">Login</Label>
              </div>
            </RadioGroup>
          </div>

          {authMode === "login" ? (
            <div className="space-y-2" data-testid="llm-tab:login-section">
              <p className="text-[11px] text-muted-foreground">
                현재 활성 벤더: <code>{vendorInfo.label}</code> ({model || vendorInfo.defaultModel})
              </p>
              <div className="flex items-center gap-2">
                {hasKey ? (
                  <Badge variant="default" className="text-xs">로그인됨</Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs">로그인 필요</Badge>
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
                로그인 시 벤더 선택 · API 키 · 엔드포인트 · 모델이 자동으로 설정됩니다.
              </p>
            </div>
          ) : (
            <div className="space-y-3" data-testid="llm-tab:manual-section">
              <div className="space-y-2">
                <Label htmlFor="vendor-select" className="flex items-center gap-2">
                  벤더
                  <ImmediateBadge />
                </Label>
                <Select
                  value={vendor}
                  onValueChange={(v) => {
                    setVendor(v);
                    onImmediateChange?.();
                  }}
                >
                  <SelectTrigger id="vendor-select" className="w-full">
                    <SelectValue placeholder="벤더 선택" />
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
                    Endpoint (baseUrl){vendorInfo.needsBaseUrl ? " *" : " (선택)"}
                  </Label>
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={(vendorInfo as any).baseUrlPlaceholder ?? "https://..."}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    ⓘ 저장 전 벤더 변경 시 현재 입력이 폐기됩니다.
                  </p>
                  {vendor === "azure-foundry" && (
                    <p className="text-[11px] text-muted-foreground">
                      Azure AI Foundry 엔드포인트 형식:
                      {" "}<code>https://{"{resource}"}.openai.azure.com/openai/v1/</code>
                      {" "}— 모델 값에는 Azure deployment 이름을 입력합니다.
                    </p>
                  )}
                  {(vendor === "openai" || vendor === "copilot") && (
                    <p className="text-[11px] text-muted-foreground">
                      프록시 또는 커스텀 엔드포인트를 사용하는 경우에만 입력합니다.
                    </p>
                  )}
                </div>
              )}
              {vendor === "vertex-ai" && (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-sm font-medium">Google Vertex AI</p>
                  <p className="text-[11px] text-muted-foreground">
                    서비스 계정 또는 ADC(<code>gcloud auth application-default login</code>)로 인증합니다.
                    API 키는 사용하지 않으며, <code>GOOGLE_APPLICATION_CREDENTIALS</code> 환경 변수로 서비스 계정 JSON 경로를 지정할 수 있습니다.
                  </p>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">GCP Project ID *</Label>
                    <Input
                      value={vertexProject}
                      onChange={(e) => setVertexProject(e.target.value)}
                      placeholder="my-gcp-project"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Location (region) — 선택</Label>
                    <Input
                      value={vertexLocation}
                      onChange={(e) => setVertexLocation(e.target.value)}
                      placeholder="us-central1 (기본값)"
                    />
                  </div>
                </div>
              )}
              {vendor !== "vertex-ai" && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">{vendorInfo.label} API 키</Label>
                  <div className="flex items-center gap-2">
                    {hasKey ? <Badge variant="default" className="text-xs">설정됨</Badge> : <Badge variant="secondary" className="text-xs">미설정</Badge>}
                    {hasKey && <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => void api.deleteApiKey(vendor).then(() => { setHasKey(false); onSaved(); })}>삭제</Button>}
                  </div>
                  <Input data-testid="llm-api-key-input" type="password" placeholder={hasKey ? "새 키로 교체" : vendorInfo.placeholder} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="model-select" className="text-sm font-medium">모델</Label>
                <Select value={activeModelValue} onValueChange={setModel}>
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
          )}
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
          <p className="text-[11px] text-muted-foreground">모델 내부 추론 과정을 스트리밍으로 표시합니다. Claude는 명시 활성화(Sonnet 4.5+/Opus 4+), OpenAI o-계열·gpt-5는 Responses API 자동, Gemini 2.0+는 모델 지원 시 자동.</p>
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
                높을수록 더 많은 사고 토큰을 사용해 꼼꼼히 추론하지만 지연 시간과 비용이 증가합니다. 현재 이 설정은 Claude·OpenAI에 적용되며, Gemini는 모델이 지원하는 경우 추론 표시만 자동으로 동작하고 이 예산 값은 적용되지 않습니다.
              </p>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Section C — Fallback Chain */}
      <SettingsSection
        title="장애 복구 (Fallback Chain)"
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
            <span className="text-muted-foreground text-xs">첫 응답이 1초 안에 오지 않거나 5xx/429/네트워크 오류 시 순서대로 전환할 벤더·모델 목록</span>
            <span className="text-muted-foreground">{fallbackOpen ? "▲" : "▼"}</span>
          </Button>
          {fallbackOpen && (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">첫 응답이 1초 안에 오지 않거나 5xx/429/네트워크 오류가 나면 같은 모델을 5회 시도한 뒤 순서대로 전환할 벤더·모델 목록입니다.</p>
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
                      삭제
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
                + 추가
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
