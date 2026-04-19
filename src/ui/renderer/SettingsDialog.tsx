import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Badge } from "../../components/ui/badge.js";
import { Input } from "../../components/ui/input.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import type { LvisApi } from "./types.js";
import { REASONING_EFFORT_STEPS, VENDORS, WEB_PROVIDERS, budgetToEffortIndex } from "./constants.js";
import { RolesTab } from "./tabs/RolesTab.js";
import { PermissionsTab } from "./tabs/PermissionsTab.js";
import { AuditTab } from "./tabs/AuditTab.js";
import { UsageDashboard } from "./components/UsageDashboard.js";
import { PluginPerfTab } from "./tabs/PluginPerfTab.js";

export function SettingsDialog({ open, onOpenChange, api, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; api: LvisApi; onSaved: () => void }) {
  const [tab, setTab] = useState("llm");
  const [vendor, setVendor] = useState("claude");
  const [keyInput, setKeyInput] = useState("");
  const [model, setModel] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [autoCompact, setAutoCompact] = useState(true);
  const [enableThinking, setEnableThinking] = useState(true);
  const [thinkingBudget, setThinkingBudget] = useState(10_000);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const [webProvider, setWebProvider] = useState("duckduckgo");
  const [webKeyInput, setWebKeyInput] = useState("");
  const [hasWebKey, setHasWebKey] = useState(false);

  // Per-vendor baseUrl (Azure AI Foundry requires it; OpenAI/Copilot proxy optional).
  const [baseUrl, setBaseUrl] = useState("");

  // Vertex AI — GCP project + region (vendor uses service account / ADC, not apiKey).
  const [vertexProject, setVertexProject] = useState("");
  const [vertexLocation, setVertexLocation] = useState("");

  // Sprint 3-A: proactive Daily Briefing toggle (§7, §14.4 feature flag).
  const [enableDailyBriefing, setEnableDailyBriefing] = useState(false);

  // Sprint A — advanced generation controls.
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxOutputTokens, setMaxOutputTokens] = useState<number>(4096);
  const [seedInput, setSeedInput] = useState<string>("");
  const [responseFormat, setResponseFormat] = useState<"text" | "json">("text");
  const [stopSequencesText, setStopSequencesText] = useState<string>("");
  const [streamSmoothing, setStreamSmoothing] = useState<"none" | "word" | "char">("none");

  // Sprint E §3 — PII 리댁트 토글 (기본 OFF).
  const [piiRedactEnabled, setPiiRedactEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  const vendorInfo = VENDORS.find((v) => v.id === vendor) ?? VENDORS[0];
  const webInfo = WEB_PROVIDERS.find((p) => p.id === webProvider) ?? WEB_PROVIDERS[0];

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
      setEnableDailyBriefing(s.proactive?.enableDailyBriefing ?? false);
      setPiiRedactEnabled(s.privacy?.piiRedactEnabled ?? false);
      setSettingsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  // 벤더 변경 시 해당 벤더의 키 상태 확인 및 모델 추천
  useEffect(() => {
    if (!open) return;
    const v = VENDORS.find((x) => x.id === vendor);
    if (!v) return;
    let cancelled = false;
    void api.hasApiKey(vendor).then((k) => {
      if (!cancelled) setHasKey(k);
    });
    void api.getSettings().then((s) => {
      if (cancelled) return;
      if (s.llm.provider !== vendor) setModel(v.defaultModel);
      else setModel(s.llm.model);
      setBaseUrl((s.llm.baseUrls ?? {})[vendor as any] ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [vendor, open, api]);

  // 웹 프로바이더 변경 시 키 상태 확인
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api.hasWebApiKey(webProvider).then((k) => {
      if (!cancelled) setHasWebKey(k);
    });
    return () => {
      cancelled = true;
    };
  }, [webProvider, open, api]);

  const save = async () => {
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
        // Merge per-vendor baseUrl so we don't lose other vendors' saved endpoints.
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
            stopSequences: stopSequencesText
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
            streamSmoothing,
          } as any,
          webSearch: { provider: webProvider as any },
          chat: { autoCompact },
          proactive: { enableDailyBriefing } as any,
          privacy: { piiRedactEnabled },
        } as any);
      }
      // permissions 탭: 각 항목이 즉시 저장되므로 별도 save 불필요
      if (tab !== "permissions") { onSaved(); onOpenChange(false); }
      else { onOpenChange(false); }
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>설정</DialogTitle><DialogDescription>앱 환경, 채팅 동작, 검색 엔진, 권한 정책을 설정합니다.</DialogDescription></DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 [&>*]:!grow-0 [&>*]:!shrink-0 [&>*]:!basis-auto">
            <TabsTrigger value="llm">지능 (LLM)</TabsTrigger>
            <TabsTrigger value="advanced">고급</TabsTrigger>
            <TabsTrigger value="chat">채팅</TabsTrigger>
            <TabsTrigger value="web">검색 (Web)</TabsTrigger>
            <TabsTrigger value="proactive">브리핑</TabsTrigger>
            <TabsTrigger value="privacy">프라이버시</TabsTrigger>
            <TabsTrigger value="permissions">권한</TabsTrigger>
            <TabsTrigger value="roles">역할</TabsTrigger>
            <TabsTrigger value="usage">사용량</TabsTrigger>
            <TabsTrigger value="audit">감사</TabsTrigger>
            <TabsTrigger value="plugin-perf">플러그인 성능</TabsTrigger>
          </TabsList>

          <TabsContent value="llm" className="space-y-4 pt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="vendor-select">벤더</label>
              <select
                id="vendor-select"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
              >
                {VENDORS.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </div>
            {vendor !== "vertex-ai" && (vendorInfo.needsBaseUrl || vendor === "openai" || vendor === "copilot") && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Endpoint (baseUrl){vendorInfo.needsBaseUrl ? " *" : " (선택)"}
                </label>
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
                  <label className="text-xs text-muted-foreground">GCP Project ID *</label>
                  <Input
                    value={vertexProject}
                    onChange={(e) => setVertexProject(e.target.value)}
                    placeholder="my-gcp-project"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Location (region) — 선택</label>
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
                <label className="text-sm font-medium">{vendorInfo.label} API 키</label>
                <div className="flex items-center gap-2">
                  {hasKey ? <Badge variant="default" className="text-xs">설정됨</Badge> : <Badge variant="secondary" className="text-xs">미설정</Badge>}
                  {hasKey && <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => void api.deleteApiKey(vendor).then(() => { setHasKey(false); onSaved(); })}>삭제</Button>}
                </div>
                <Input type="password" placeholder={hasKey ? "새 키로 교체" : vendorInfo.placeholder} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
              </div>
            )}
            <div className="space-y-2"><label className="text-sm font-medium">모델</label><Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={vendorInfo.defaultModel} /></div>
            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-center justify-between text-sm font-medium">
                <span>Extended Thinking / Reasoning</span>
                <input type="checkbox" className="h-4 w-4" checked={enableThinking} onChange={(e) => setEnableThinking(e.target.checked)} />
              </label>
              <p className="text-[11px] text-muted-foreground">모델 내부 추론 과정을 스트리밍으로 표시합니다. Claude는 명시 활성화(Sonnet 4.5+/Opus 4+), OpenAI o-계열·gpt-5는 Responses API 자동, Gemini 2.0+는 모델 지원 시 자동.</p>
              {enableThinking && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-muted-foreground">Reasoning Effort</label>
                    <span className="text-xs font-medium tabular-nums">
                      {REASONING_EFFORT_STEPS[budgetToEffortIndex(thinkingBudget)]!.label}
                      <span className="ml-2 text-muted-foreground">· {thinkingBudget.toLocaleString()} tokens</span>
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={REASONING_EFFORT_STEPS.length - 1}
                    step={1}
                    value={budgetToEffortIndex(thinkingBudget)}
                    onChange={(e) =>
                      setThinkingBudget(
                        REASONING_EFFORT_STEPS[Number(e.target.value)]!.budget,
                      )
                    }
                    className="w-full accent-primary"
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
          </TabsContent>

          <TabsContent value="advanced" className="space-y-4 pt-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Temperature</label>
                <span className="text-xs tabular-nums text-muted-foreground">{temperature.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
                className="w-full accent-primary"
                aria-label="Temperature"
              />
              <p className="text-[11px] text-muted-foreground">0에 가까울수록 결정적, 높을수록 창의적.</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Max Output Tokens</label>
                <span className="text-xs tabular-nums text-muted-foreground">{maxOutputTokens.toLocaleString()}</span>
              </div>
              <input
                type="range"
                min={128}
                max={8192}
                step={128}
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
                className="w-full accent-primary"
                aria-label="Max output tokens"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Seed</label>
              <Input
                type="number"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                placeholder="비워 두면 랜덤"
              />
              <p className="text-[11px] text-muted-foreground">정수 입력 시 벤더가 지원하면 결정론적 샘플링.</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Response Format</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                value={responseFormat}
                onChange={(e) => setResponseFormat(e.target.value as "text" | "json")}
              >
                <option value="text">Text</option>
                <option value="json">JSON</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Stop Sequences</label>
              <textarea
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
                value={stopSequencesText}
                onChange={(e) => setStopSequencesText(e.target.value)}
                placeholder="한 줄에 하나씩"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Stream Smoothing</label>
              <div className="flex gap-4 text-sm">
                {(["none", "word", "char"] as const).map((opt) => (
                  <label key={opt} className="flex items-center gap-1">
                    <input
                      type="radio"
                      name="stream-smoothing"
                      value={opt}
                      checked={streamSmoothing === opt}
                      onChange={() => setStreamSmoothing(opt)}
                    />
                    {opt === "none" ? "None" : opt === "word" ? "Word" : "Char"}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">출력 스트림을 단어/문자 단위로 부드럽게 표시합니다.</p>
            </div>
          </TabsContent>

          <TabsContent value="chat" className="space-y-4 pt-4">
            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">대화 최적화</p>
                <p className="text-[11px] text-muted-foreground">긴 대화에서 이전 히스토리를 자동으로 요약해 컨텍스트를 절약합니다.</p>
              </div>
              <div className="flex items-center gap-3 rounded-md border px-3 py-3">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={autoCompact}
                  className={`relative h-5 w-5 flex-shrink-0 rounded border-2 transition-colors ${autoCompact ? "border-primary bg-primary" : "border-muted-foreground"} cursor-pointer hover:border-primary/60`}
                  onClick={() => setAutoCompact((prev) => !prev)}
                >
                  {autoCompact && (
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">✓</span>
                  )}
                </button>
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">자동 컴팩트 활성화</p>
                  <p className="text-[11px] text-muted-foreground">끄면 자동 요약은 중단되고, 수동 `/compact`만 사용할 수 있습니다.</p>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="web" className="space-y-4 pt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">검색 엔진</label>
              <div className="grid grid-cols-2 gap-2">
                {WEB_PROVIDERS.map((p) => (
                  <Button key={p.id} size="sm" variant={webProvider === p.id ? "default" : "outline"} className="justify-start text-xs" onClick={() => setWebProvider(p.id)}>
                    {p.label}
                  </Button>
                ))}
              </div>
            </div>
            {webInfo.needsKey && (
              <div className="space-y-2">
                <label className="text-sm font-medium">{webInfo.label} API 키</label>
                <div className="flex items-center gap-2">
                  {hasWebKey ? <Badge variant="default" className="text-xs">설정됨</Badge> : <Badge variant="secondary" className="text-xs">미설정</Badge>}
                  {hasWebKey && <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => void api.deleteWebApiKey(webProvider).then(() => { setHasWebKey(false); onSaved(); })}>삭제</Button>}
                </div>
                <Input type="password" placeholder={hasWebKey ? "새 키로 교체" : webInfo.placeholder} value={webKeyInput} onChange={(e) => setWebKeyInput(e.target.value)} />
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">Tavily와 Serper는 AI 에이전트용 고성능 검색 기능을 제공합니다.</p>
          </TabsContent>

          <TabsContent value="proactive" className="space-y-4 pt-4">
            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">데일리 브리핑</p>
                <p className="text-[11px] text-muted-foreground">장기간 idle 상태일 때 태스크·일정·메모를 종합한 일일 브리핑을 LLM으로 요약해 알려줍니다. 하루 1회, 사용자가 닫으면 24시간 재표시 안 함.</p>
              </div>
              <div className="flex items-center gap-3 rounded-md border px-3 py-3">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={enableDailyBriefing}
                  aria-labelledby="daily-briefing-toggle-label"
                  className={`relative h-5 w-5 flex-shrink-0 rounded border-2 transition-colors ${enableDailyBriefing ? "border-primary bg-primary" : "border-muted-foreground"} cursor-pointer hover:border-primary/60`}
                  onClick={() => setEnableDailyBriefing((prev) => !prev)}
                >
                  {enableDailyBriefing && (
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">✓</span>
                  )}
                </button>
                <div className="space-y-0.5">
                  <p id="daily-briefing-toggle-label" className="text-sm font-medium">데일리 브리핑 활성화</p>
                  <p className="text-[11px] text-muted-foreground">기본값은 꺼짐입니다. 켜면 idle scan 중 요약이 생성됩니다.</p>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="privacy" className="space-y-4 pt-4">
            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">PII 리댁트</p>
                <p className="text-[11px] text-muted-foreground">활성화 시 LLM으로 전송 전에 이메일·전화·신용카드 등 개인정보를 [REDACTED:*]로 치환합니다. 기본값은 꺼짐.</p>
              </div>
              <div className="flex items-center gap-3 rounded-md border px-3 py-3">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={piiRedactEnabled}
                  aria-labelledby="pii-redact-toggle-label"
                  className={`relative h-5 w-5 flex-shrink-0 rounded border-2 transition-colors ${piiRedactEnabled ? "border-primary bg-primary" : "border-muted-foreground"} cursor-pointer hover:border-primary/60`}
                  onClick={() => setPiiRedactEnabled((prev) => !prev)}
                >
                  {piiRedactEnabled && (
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">✓</span>
                  )}
                </button>
                <div className="space-y-0.5">
                  <p id="pii-redact-toggle-label" className="text-sm font-medium">PII 리댁트 활성화 (기본 OFF)</p>
                  <p className="text-[11px] text-muted-foreground">전송 직전 이메일/전화번호/주민번호/카드번호를 `[REDACTED:*]`로 치환하고, 리댁트 발생 시 응답 영역에 🔒 알림을 잠시 표시합니다. 감사 로그에도 건수가 기록됩니다.</p>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="permissions">
            <PermissionsTab />
          </TabsContent>

          <TabsContent value="roles">
            <RolesTab />
          </TabsContent>

          <TabsContent value="usage">
            <UsageDashboard api={api} />
          </TabsContent>

          <TabsContent value="audit">
            <AuditTab />
          </TabsContent>

          <TabsContent value="plugin-perf">
            <PluginPerfTab api={api} />
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>닫기</Button>
          {tab !== "permissions" && tab !== "usage" && tab !== "roles" && tab !== "audit" && tab !== "plugin-perf" && (
            <Button onClick={() => void save()} disabled={saving || !settingsLoaded}>{saving ? "저장 중..." : "저장"}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
