import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
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
  } = props;
  const vendorInfo = VENDORS.find((v) => v.id === vendor) ?? VENDORS[0];

  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-2">
        <Label htmlFor="vendor-select" className="flex items-center gap-2">
          벤더
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            즉시 적용
          </span>
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
          {vendor === "azure-foundry" && (
            <p className="text-[11px] text-muted-foreground">
              Azure AI Foundry 엔드포인트 형식:
              {" "}<code>https://{"{resource}"}.openai.azure.com/openai/deployments/{"{deployment}"}/</code>
              {" "}— 모델 필드에는 deployment 이름을 입력합니다.
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
          <Input type="password" placeholder={hasKey ? "새 키로 교체" : vendorInfo.placeholder} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
        </div>
      )}
      <div className="space-y-2"><Label className="text-sm font-medium">모델</Label><Input data-testid="llm-model-input" value={model} onChange={(e) => setModel(e.target.value)} placeholder={vendorInfo.defaultModel} /></div>
      <div className="space-y-2 rounded-md border p-3">
        <Label className="flex items-center justify-between text-sm font-medium">
          <span className="flex items-center gap-2">
            Extended Thinking / Reasoning
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              즉시 적용
            </span>
          </span>
          <Switch
            checked={enableThinking}
            onCheckedChange={(c) => {
              setEnableThinking(c);
              onImmediateChange?.();
            }}
            aria-label="Extended Thinking / Reasoning"
          />
        </Label>
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
      <div className="space-y-2 rounded-md border" data-testid="fallback-chain-section">
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-between rounded-none px-3 py-2 text-sm font-medium"
          onClick={() => setFallbackOpen((o) => !o)}
        >
          <span>장애 복구 (Fallback Chain)</span>
          <span className="text-muted-foreground">{fallbackOpen ? "▲" : "▼"}</span>
        </Button>
        {fallbackOpen && (
          <div className="space-y-2 px-3 pb-3">
            <p className="text-[11px] text-muted-foreground">첫 응답이 1초 안에 오지 않거나 5xx/429/네트워크 오류가 나면 같은 모델을 5회 시도한 뒤 순서대로 전환할 벤더·모델 목록입니다.</p>
            {fallbackChain.map((entry, idx) => (
              <div key={idx} className="flex gap-2">
                <Select
                  value={entry.provider}
                  onValueChange={(value) => {
                    const next = [...fallbackChain];
                    next[idx] = { ...next[idx]!, provider: value };
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
                <Input
                  className="h-8 text-xs"
                  value={entry.model}
                  placeholder="모델 이름"
                  onChange={(e) => {
                    const next = [...fallbackChain];
                    next[idx] = { ...next[idx]!, model: e.target.value };
                    setFallbackChain(next);
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-destructive"
                  onClick={() => setFallbackChain((c) => c.filter((_, i) => i !== idx))}
                >
                  삭제
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => setFallbackChain((c) => [...c, { provider: "openai", model: "" }])}
            >
              + 추가
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
