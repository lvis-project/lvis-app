import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Search, MoreHorizontal, Command as CommandIcon, KeyRound, Plus, Loader2, PanelsTopLeft, ChevronDown, Star, Download, Pencil, GitBranch, X as XIcon, Paperclip, Globe, User, History } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import {
  DEFAULT_ROLE_PRESETS,
  ROLE_PRESETS_CHANGED_EVENT,
  buildPresetPrefix,
  loadRolePresets,
  type RolePreset,
} from "./data/role-presets.js";
import { costTier, estimateTurnCost, formatCostBadge } from "./lib/cost-estimator.js";
import { lookupPricing } from "./shared/pricing-data.js";
import { vendorSupportsThinking as vendorSupportsThinkingShared } from "./shared/vendor-capabilities.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Badge } from "./components/ui/badge.js";
import { Input } from "./components/ui/input.js";
import { Textarea } from "./components/ui/textarea.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip.js";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./components/ui/command.js";
import { ScrollArea } from "./components/ui/scroll-area.js";
import { Separator } from "./components/ui/separator.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "./components/ui/sheet.js";
import { PluginUiHostView } from "./plugin-ui-host.js";
import { approvalQueueReducer } from "./lib/approval-queue-reducer.js";
import {
  appendUserEntry,
  applyToolEnd,
  applyToolStart,
  finalizeStreamingReasoning,
  finalizeStreamingAssistant,
  setAssistantError,
  type ChatEntry,
  upsertStreamingReasoning,
  upsertStreamingAssistant,
} from "./lib/chat-stream-state.js";

// ─── Phase 2 split: types / constants / helpers / components / tabs ──
import type {
  ApprovalChoice,
  ApprovalRequest,
  BriefingPayload,
  LvisApi,
  MarketplaceItem,
  PluginCardSummary,
  PluginUiExtension,
  Task,
} from "./ui/renderer/types.js";
import {
  PRIORITY_CLASS,
  REASONING_EFFORT_STEPS,
  VENDORS,
  WEB_PROVIDERS,
  budgetToEffortIndex,
  formatTaskSource,
} from "./ui/renderer/constants.js";
import { getApi, getPluginViewLabel, toViewKey } from "./ui/renderer/api-client.js";
import { highlightText } from "./ui/renderer/utils/html-preview.js";
import { historyToEntries } from "./ui/renderer/utils/history.js";
import { BriefingCard } from "./ui/renderer/components/BriefingCard.js";
import { AssistantCard } from "./ui/renderer/components/AssistantCard.js";
import { UserMessageEditor } from "./ui/renderer/components/UserMessageEditor.js";
import { ReasoningCard } from "./ui/renderer/components/ReasoningCard.js";
import { ToolApprovalDialog } from "./ui/renderer/components/ToolApprovalDialog.js";
import { ToolGroupCard } from "./ui/renderer/components/ToolGroupCard.js";
import { ChatSearchOverlay } from "./ui/renderer/components/ChatSearchOverlay.js";
import { UsageDashboard } from "./ui/renderer/components/UsageDashboard.js";
import { RolesTab } from "./ui/renderer/tabs/RolesTab.js";
import { PermissionsTab } from "./ui/renderer/tabs/PermissionsTab.js";
import { useSettings } from "./ui/renderer/hooks/use-settings.js";
import { useChatState } from "./ui/renderer/hooks/use-chat-state.js";

// Phase 1 tests import `BriefingCard` from this module; preserve the export.
export { BriefingCard } from "./ui/renderer/components/BriefingCard.js";

// ─── TaskView ───────────────────────────────────────

function TaskView({ api }: { api: LvisApi }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<"pending"|"today"|"overdue"|"done">("pending");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      let r: Task[];
      if (filter === "today") r = await api.getTodayTasks();
      else if (filter === "overdue") r = await api.getOverdueTasks();
      else if (filter === "done") r = await api.queryTasks({ status: "done" });
      else r = await api.queryTasks({ status: "pending" });
      setTasks(r);
    } catch { setTasks([]); } finally { setLoading(false); }
  }, [filter, api]);
  useEffect(() => { void load(); }, [load]);
  const isDone = filter === "done";
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <Card className="flex h-full min-h-0 flex-col">
        <CardHeader>
          <div className="flex items-center justify-between"><CardTitle>태스크</CardTitle><Button size="sm" variant="outline" onClick={() => void load()}>새로고침</Button></div>
          <CardDescription>이메일·미팅에서 수집된 할 일 목록</CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <TabsList className="w-full">
              <TabsTrigger value="pending" className="flex-1">진행중</TabsTrigger>
              <TabsTrigger value="today" className="flex-1">오늘 마감</TabsTrigger>
              <TabsTrigger value="overdue" className="flex-1">기한 초과</TabsTrigger>
              <TabsTrigger value="done" className="flex-1">완료됨</TabsTrigger>
            </TabsList>
          </Tabs>
          <ScrollArea className="flex-1">
            {loading ? <div className="py-8 text-center text-sm text-muted-foreground">로딩 중...</div> : tasks.length === 0 ? <div className="py-8 text-center text-sm text-muted-foreground">태스크가 없습니다.</div> : (
              <div className="space-y-2 pr-2">
                {tasks.map((t) => (
                  <div key={t.id} className={`flex items-start gap-2 rounded-md border p-3 ${isDone ? "opacity-60" : ""}`}>
                    <button className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded border ${isDone ? "border-primary bg-primary" : "border-muted-foreground hover:border-primary"}`}
                      onClick={() => void api.updateTask(t.id, { status: isDone ? "pending" : "done" }).then(() => load())}>
                      {isDone ? <span className="flex h-full w-full items-center justify-center text-[8px] text-primary-foreground">✓</span> : null}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`text-sm font-medium ${isDone ? "line-through" : ""}`}>{t.title}</span>
                        <Badge variant="outline" className="text-[10px]">{formatTaskSource(t.source)}</Badge>
                        <span className={`text-[10px] font-semibold ${PRIORITY_CLASS[t.priority]}`}>{t.priority}</span>
                      </div>
                      {t.description ? <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{t.description}</p> : null}
                    </div>
                    <button className="flex-shrink-0 text-[10px] text-muted-foreground hover:text-destructive" onClick={() => void api.deleteTask(t.id).then(() => load())}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── SettingsDialog ─────────────────────────────────

function SettingsDialog({ open, onOpenChange, api, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; api: LvisApi; onSaved: () => void }) {
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
    if (v) {
      void api.hasApiKey(vendor).then(setHasKey);
      void api.getSettings().then(s => {
        if (s.llm.provider !== vendor) setModel(v.defaultModel);
        else setModel(s.llm.model);
        setBaseUrl((s.llm.baseUrls ?? {})[vendor as any] ?? "");
      });
    }
  }, [vendor, open, api]);

  // 웹 프로바이더 변경 시 키 상태 확인
  useEffect(() => {
    if (!open) return;
    void api.hasWebApiKey(webProvider).then(setHasWebKey);
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
        </Tabs>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>닫기</Button>
          {tab !== "permissions" && tab !== "usage" && tab !== "roles" && (
            <Button onClick={() => void save()} disabled={saving || !settingsLoaded}>{saving ? "저장 중..." : "저장"}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── App ────────────────────────────────────────────

export function App() {
  const api = useMemo(() => getApi(), []);

  // Chat state — Phase 3.2 hook
  const {
    entries,
    setEntries,
    streaming,
    setStreaming,
    streamRef,
    thoughtRef,
    editingEntryIdx,
    setEditingEntryIdx,
    editBusy,
    handleEditSave: chatHandleEditSave,
    handleRetryEffort,
    finalizeLeftoverStream,
  } = useChatState(api);
  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // App state
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [marketplace, setMarketplace] = useState<MarketplaceItem[]>([]);
  const [pluginViews, setPluginViews] = useState<PluginUiExtension[]>([]);
  const [activeView, setActiveView] = useState("home");
  const [marketStatus, setMarketStatus] = useState("로딩 중...");
  const [installTarget, setInstallTarget] = useState<MarketplaceItem | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<MarketplaceItem | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [briefing, setBriefing] = useState<BriefingPayload | null>(null);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([]);
  const approvalQueueRef = useRef<ApprovalRequest[]>([]);
  useEffect(() => { approvalQueueRef.current = approvalQueue; }, [approvalQueue]);

  // Sprint B — role preset, cost preview, attached docs, language lock
  const [rolePresets, setRolePresets] = useState<RolePreset[]>(() => DEFAULT_ROLE_PRESETS);
  useEffect(() => {
    setRolePresets(loadRolePresets());
    // Keep the App-level preset list in sync with edits made in the Settings
    // "역할" tab — saveRolePresets / resetRolePresets dispatch this event so
    // the chat preset dropdown reflects edits without requiring a restart.
    const onChanged = () => setRolePresets(loadRolePresets());
    window.addEventListener(ROLE_PRESETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ROLE_PRESETS_CHANGED_EVENT, onChanged);
  }, []);
  const [activePresetId, setActivePresetId] = useState<string>("default");
  const activePreset = useMemo(
    () => rolePresets.find((p) => p.id === activePresetId) ?? rolePresets[0] ?? null,
    [rolePresets, activePresetId],
  );
  const [attachedDocs, setAttachedDocs] = useState<Array<{ id: string; name: string }>>([]);
  const [docPopoverOpen, setDocPopoverOpen] = useState(false);
  const [indexedDocs, setIndexedDocs] = useState<Array<{ id: string; name: string }>>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [langLock, setLangLock] = useState<"off" | "ko" | "en">("off");
  const [maxOutputTokens] = useState<number>(4096);

  // Sprint 4.C — conversation UX state (editingEntryIdx / editBusy now in useChatState)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCase, setSearchCase] = useState(false);
  const [searchIdx, setSearchIdx] = useState(0);
  const [starred, setStarred] = useState<Array<{ id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string }>>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const [sessions, setSessions] = useState<Array<{ id: string; modifiedAt: string }>>([]);

  const refreshStarred = useCallback(async () => {
    try { const list = await api.starredList(); setStarred(list); } catch { /* ignore */ }
  }, [api]);
  const refreshSessionId = useCallback(async () => {
    try { const h = await api.chatGetHistory(); setCurrentSessionId(h.sessionId); } catch { /* ignore */ }
  }, [api]);
  const refreshSessions = useCallback(async () => {
    try {
      const r = await api.chatSessions();
      setSessions(r.sessions);
      setCurrentSessionId(r.current);
    } catch { /* ignore */ }
  }, [api]);
  const handleLoadSession = useCallback(async (sessionId: string) => {
    // Don't swap sessions mid-stream — ConversationLoop.runTurn() has no
    // concurrency guard, so replacing history while a turn is writing to it
    // would race. The "기록" button is also disabled during streaming, but
    // keep this guard here too for programmatic callers (e.g. starred jump).
    if (streaming) return;
    try {
      const res = await api.chatLoadSession(sessionId);
      if (!res?.ok) return;
      const h = await api.chatGetHistory();
      setEntries(historyToEntries(h.messages));
      setCurrentSessionId(h.sessionId);
    } catch { /* ignore */ }
  }, [api, streaming]);

  // Map renderer `entries` (which include reasoning/tool_group/system) to
  // backend history indices which only track user + assistant messages.
  // This lets edit/fork/star carry the correct `messageIndex`.
  const entryIndexToHistoryIndex = useMemo(() => {
    const map = new Map<number, number>();
    let backend = 0;
    entries.forEach((e, i) => {
      if (e.kind === "user" || e.kind === "assistant") {
        map.set(i, backend);
        backend += 1;
      }
    });
    return map;
  }, [entries]);

  const isEntryStarred = useCallback((entryIdx: number): string | null => {
    const histIdx = entryIndexToHistoryIndex.get(entryIdx);
    if (histIdx === undefined) return null;
    const match = starred.find((s) => s.sessionId === currentSessionId && s.messageIndex === histIdx);
    return match?.id ?? null;
  }, [starred, currentSessionId, entryIndexToHistoryIndex]);

  // ─── Search (Ctrl/Cmd+F) ──────────────────────
  const searchMatches = useMemo(() => {
    if (!searchQuery) return [] as number[];
    const q = searchCase ? searchQuery : searchQuery.toLowerCase();
    const hits: number[] = [];
    entries.forEach((e, i) => {
      if (e.kind !== "user" && e.kind !== "assistant") return;
      const t = searchCase ? e.text : e.text.toLowerCase();
      if (t.includes(q)) hits.push(i);
    });
    return hits;
  }, [entries, searchQuery, searchCase]);
  // O(1) membership check for per-entry highlight in the big render loop.
  const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches]);
  useEffect(() => {
    if (searchIdx >= searchMatches.length) setSearchIdx(0);
  }, [searchMatches, searchIdx]);
  const searchHighlight = searchOpen ? searchQuery : "";

  // ─── Edit & resend (delegates to useChatState) ─────────────
  const handleEditSave = useCallback(
    (entryIdx: number, newText: string) =>
      chatHandleEditSave(entryIdx, newText, entryIndexToHistoryIndex),
    [chatHandleEditSave, entryIndexToHistoryIndex],
  );

  // ─── Fork ──────────────────────────────────────
  const handleFork = useCallback(async (entryIdx: number) => {
    const histIdx = entryIndexToHistoryIndex.get(entryIdx);
    if (histIdx === undefined) return;
    const res = await api.chatFork(histIdx);
    if (res.ok) {
      setEntries((p) => p.slice(0, entryIdx + 1));
      await refreshSessionId();
    }
  }, [api, entryIndexToHistoryIndex, refreshSessionId]);

  // ─── Retry with deeper thinking — provided by useChatState ─────

  // ─── Star toggle ───────────────────────────────
  const handleToggleStar = useCallback(async (entryIdx: number) => {
    const entry = entries[entryIdx];
    if (!entry || (entry.kind !== "user" && entry.kind !== "assistant")) return;
    const histIdx = entryIndexToHistoryIndex.get(entryIdx);
    if (histIdx === undefined) return;
    const existingId = isEntryStarred(entryIdx);
    if (existingId) {
      await api.starredRemove({ id: existingId });
    } else {
      await api.starredAdd({ sessionId: currentSessionId, messageIndex: histIdx, role: entry.kind, text: entry.text });
    }
    await refreshStarred();
  }, [entries, entryIndexToHistoryIndex, isEntryStarred, api, currentSessionId, refreshStarred]);

  // ─── Export ────────────────────────────────────
  const handleExport = useCallback(async (format: "markdown" | "json") => {
    try { await api.chatExport(format); } catch (err) { console.warn("[lvis] export failed:", (err as Error).message); }
  }, [api]);

  // Sprint 4.B — context overflow tracking + LLM settings cache (Phase 3.1 hook)
  const {
    llmVendor,
    llmModel,
    enableThinkingChat,
    currentLlmSettings,
    refresh: refreshLlmSettings,
    toggleThinking,
  } = useSettings(api);

  const contextOverflowPct = useMemo(() => {
    const CONTEXT_WINDOWS: Record<string, number> = {
      "claude-sonnet-4-6": 1_000_000, "claude-opus-4-6": 1_000_000,
      "claude-sonnet-4-5": 200_000, "claude-opus-4-5": 200_000,
      "gpt-5.4": 1_050_000, "gpt-5.4-mini": 1_050_000,
      "gpt-5": 400_000, "gpt-4.1": 1_000_000, "gpt-4.1-mini": 1_000_000,
      "gemini-2.5-flash": 1_000_000, "gemini-2.5-pro": 2_000_000,
    };
    const model = currentLlmSettings?.model ?? "";
    const contextWindow = CONTEXT_WINDOWS[model] ?? 128_000;
    const estimatedTokens = entries.reduce((sum, e) => {
      if (e.kind === "user" || e.kind === "assistant") return sum + Math.ceil(e.text.length / 4);
      return sum;
    }, 0);
    return estimatedTokens / contextWindow;
  }, [entries, currentLlmSettings]);

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);
  const checkApiKey = useCallback(async () => { const h = await api.hasApiKey(); setHasApiKey(h); return h; }, [api]);

  // Rough per-model context budget (input+output tokens) used to show % filled.
  // NOTE: we currently assume the default 200k for all Claude models. The
  // Anthropic 1M-context beta for Sonnet 4.6 requires an opt-in beta header
  // that the renderer doesn't know about; treat this as 200k until/unless
  // we wire model-ID detection. (The separate `contextOverflowPct` memo
  // uses exact per-model values for overflow warnings.)
  const contextBudget = useMemo(() => {
    const m = (llmModel || "").toLowerCase();
    if (m.includes("claude")) return 200_000;
    if (m.includes("gpt-5") || m.includes("gpt-4.1")) return 1_000_000;
    if (m.includes("gpt-4o") || m.includes("gpt-4")) return 128_000;
    if (m.includes("gemini")) return 1_000_000;
    if (m.includes("o1") || m.includes("o3") || m.includes("o4")) return 200_000;
    return 128_000;
  }, [llmModel]);

  // Estimated tokens — mirrors engine-side serializeMessageForEstimation heuristic
  // (see src/engine/llm/types.ts:85): per-message `Math.ceil(serializedLength / 4) + 1`.
  const usedTokens = useMemo(() => {
    let total = 0;
    for (const e of entries) {
      let serialized = "";
      if (e.kind === "user" || e.kind === "assistant" || e.kind === "reasoning" || e.kind === "system") {
        serialized = JSON.stringify({ kind: e.kind, text: e.text ?? "" });
      } else if (e.kind === "tool_group") {
        serialized = JSON.stringify({
          kind: "tool_group",
          tools: (e.tools ?? []).map((t: any) => ({
            input: t.input ?? {},
            result: t.result ?? "",
          })),
        });
      }
      if (serialized) total += Math.ceil(serialized.length / 4) + 1;
    }
    return total;
  }, [entries]);
  const contextPercent = Math.min(100, Math.round((usedTokens / contextBudget) * 100));
  const contextColor =
    contextPercent < 50 ? "text-emerald-500" :
    contextPercent < 80 ? "text-amber-500" : "text-red-500";
  const vendorSupportsThinking = useMemo(
    () => vendorSupportsThinkingShared(llmVendor, llmModel),
    [llmVendor, llmModel],
  );
  // ─── Sprint B: compose outgoing message with preset + language + attached docs ──
  const composeOutgoing = useCallback((raw: string): string => {
    const parts: string[] = [];
    const presetPrefix = buildPresetPrefix(activePreset);
    if (presetPrefix) parts.push(presetPrefix.trimEnd());
    if (attachedDocs.length > 0) {
      const lines = attachedDocs.map((d) => `- ${d.name} (id: ${d.id})`).join("\n");
      parts.push(`[Attached documents — use knowledge_search / document_structure to read them]\n${lines}`);
    }
    if (langLock === "ko") parts.push("Respond in Korean only.");
    else if (langLock === "en") parts.push("Respond in English only.");
    parts.push(raw);
    return parts.join("\n\n");
  }, [activePreset, attachedDocs, langLock]);

  // ─── Chat ─────────────────────────────────────
  const handleAsk = useCallback(async (q: string) => {
    const t = q.trim(); if (!t || streaming) return;
    if (!(await checkApiKey())) { setSettingsOpen(true); return; }
    setQuestion("");
    const outgoing = composeOutgoing(t);
    setEntries((p) => appendUserEntry(p, t));
    streamRef.current = "";
    thoughtRef.current = "";
    setStreaming(true);
    try {
      await api.chatSend(outgoing);
      // Final state set by stream events + done
    } catch (err) {
      setEntries((p) => setAssistantError(p, `오류: ${(err as Error).message}`, thoughtRef.current));
      streamRef.current = "";
      thoughtRef.current = "";
    } finally { setStreaming(false); }
  }, [api, streaming, checkApiKey, composeOutgoing]);

  // ─── Sprint B: PageIndex document list loader ───────────────
  const refreshIndexedDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const cards = await api.listPluginCards();
      const indexPlugin = cards.find((c) => c.capabilities.includes("knowledge-index"));
      const listTool = indexPlugin?.tools.find((t) => /list.*document/i.test(t));
      let result: unknown = null;
      if (listTool) {
        try { result = await api.callPluginMethod(listTool, {}); } catch { /* no-op */ }
      }
      const list = Array.isArray(result) ? result : (result as any)?.documents ?? (result as any)?.items ?? [];
      const normalized: Array<{ id: string; name: string }> = (list as any[])
        .map((d) => ({ id: String(d.id ?? d.docId ?? d.path ?? ""), name: String(d.name ?? d.title ?? d.filename ?? d.path ?? d.id ?? "") }))
        .filter((d) => d.id && d.name);
      setIndexedDocs(normalized);
    } catch {
      setIndexedDocs([]);
    } finally {
      setDocsLoading(false);
    }
  }, [api]);

  // ─── Sprint B: pre-send cost estimate ─────────────
  // Keystrokes in the input box re-run the cost memo via `question`, but the
  // expensive JSON.stringify over every prior entry only depends on `entries`.
  // Memoize it separately, keyed on length + last-entry identity, so typing a
  // draft in long sessions doesn't re-serialize the whole conversation.
  const historySerialized = useMemo(() => {
    return entries.map((e) => {
      if (e.kind === "user" || e.kind === "assistant" || e.kind === "reasoning" || e.kind === "system") {
        return JSON.stringify({ kind: e.kind, text: (e as any).text ?? "" });
      }
      if (e.kind === "tool_group") {
        return JSON.stringify({
          kind: "tool_group",
          tools: (e.tools ?? []).map((t: any) => ({ input: t.input ?? {}, result: t.result ?? "" })),
        });
      }
      return "";
    }).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, entries[entries.length - 1]]);
  const costEstimate = useMemo(() => {
    const pricing = lookupPricing(llmVendor, llmModel);
    const draft = question ? composeOutgoing(question) : "";
    return estimateTurnCost({ historySerialized, draft, maxOutputTokens, pricing });
  }, [historySerialized, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing]);
  const costBadgeClass = (() => {
    const t = costTier(costEstimate.total);
    if (t === "trivial") return "text-muted-foreground";
    if (t === "low") return "text-emerald-500";
    if (t === "medium") return "text-amber-500";
    return "text-red-500";
  })();

  const handleNewChat = useCallback(async () => { await api.chatNew(); setEntries([]); void refreshSessionId(); }, [api, refreshSessionId]);

  // ─── Plugin actions ───────────────────────────
  const refreshViews = async () => { const v = (await api.listPluginUiExtensions()).filter((i) => i.extension.slot === "sidebar"); setPluginViews(v); return v; };
  const refreshMarketplace = async () => { try { setMarketStatus("로딩 중..."); const l = await api.listMarketplacePlugins(); setMarketplace(l); setMarketStatus(`플러그인 ${l.length}개`); } catch (e) { setMarketStatus(`실패: ${(e as Error).message}`); } };
  const installPlugin = async (id: string) => { setWorking(true); try { await api.installMarketplacePlugin(id); await refreshMarketplace(); await refreshViews(); setMarketStatus(`설치 완료: ${id}`); } catch (e) { setMarketStatus(`설치 실패: ${(e as Error).message}`); } finally { setWorking(false); } };
  const uninstallPlugin = async (id: string) => { setWorking(true); try { await api.uninstallMarketplacePlugin(id); await refreshMarketplace(); await refreshViews(); setMarketStatus(`제거 완료: ${id}`); } catch (e) { setMarketStatus(`제거 실패: ${(e as Error).message}`); } finally { setWorking(false); } };

  // ─── Effects ──────────────────────────────────
  // PR#44 HIGH: guard setBriefing against late/async callbacks firing after
  // this component unmounts. The IPC unsubscribe (db()) runs in cleanup, but
  // the bridge may still invoke our handler once between the unmount and the
  // renderer hearing the IPC off. Keep a mounted flag we can check.
  const isMountedRef = useRef(true);
  useEffect(() => {
    void refreshMarketplace(); void refreshViews(); void checkApiKey();
    void refreshStarred(); void refreshSessionId();

    // 앱 시작 시 데일리 브리핑을 채팅 메시지로 전달
    api.getBriefing().then((text) => {
      if (text && isMountedRef.current) setEntries([{ kind: "assistant", text }]);
    }).catch(() => {});
    const dv = api.onViewActivate((k) => { if (isMountedRef.current) setActiveView(k); });
    const db = api.onProactiveBriefing((b) => { if (isMountedRef.current) setBriefing(b); });
    const ds = api.onChatStream((ev) => {
      if (process.env.NODE_ENV !== "production") console.log("[lvis:chat:stream]", ev);
      if (ev.type === "text_delta" && ev.text) {
        streamRef.current += ev.text;
        setEntries((p) => upsertStreamingAssistant(p, streamRef.current));
      } else if (ev.type === "reasoning_delta" && ev.text) {
        thoughtRef.current += ev.text;
        setEntries((p) => upsertStreamingReasoning(p, thoughtRef.current));
      } else if (ev.type === "assistant_round") {
        setEntries((p) => {
          let next = finalizeStreamingReasoning(p, ev.thought ?? thoughtRef.current);
          next = finalizeStreamingAssistant(next, ev.text ?? streamRef.current);
          return next;
        });
        streamRef.current = "";
        thoughtRef.current = "";
      } else if (ev.type === "tool_start" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, displayOrder = 0, name, input } = ev;
        setEntries((p) => applyToolStart(p, { groupId, toolUseId, displayOrder, name, input }));
      } else if (ev.type === "tool_end" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, result, isError } = ev;
        setEntries((p) => applyToolEnd(p, { groupId, toolUseId, result, isError }));
      } else if (ev.type === "error") {
        setEntries((p) => setAssistantError(p, `오류: ${ev.error || "알 수 없는 오류"}`, thoughtRef.current));
        streamRef.current = "";
        thoughtRef.current = "";
      } else if (ev.type === "redact_notice") {
        // Sprint E §3 — user draft 에서 PII 가 리댁트되었음을 알리는 시스템 배지.
        const count = (ev as unknown as { count?: number }).count ?? 0;
        const byKind = (ev as unknown as { byKind?: Record<string, number> }).byKind ?? {};
        const kindLabel = Object.entries(byKind)
          .map(([k, v]) => `${k}:${v}`)
          .join(", ");
        setEntries((p) => [
          ...p,
          { kind: "system", text: `🔒 전송 전 PII ${count}건 리댁트됨${kindLabel ? ` (${kindLabel})` : ""}` },
        ]);
      } else if (ev.type === "compact_notice") {
        const n = ev.removedMessages ?? 0;
        setEntries((p) => [...p, { kind: "system", text: `💾 이전 ${n}개 대화를 요약했습니다 (목표·결정사항 보존)` }]);
      } else if (ev.type === "done") {
        finalizeLeftoverStream();
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCommandOpen(true); }
      // Sprint 4.C: Ctrl/Cmd+F opens in-conversation search
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      isMountedRef.current = false;
      dv(); db(); ds();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [entries]);

  // ─── Approval Gate 구독 (C4: single-slot → FIFO queue) ──
  useEffect(() => {
    if (!window.lvis?.approval) return;
    const unsub = window.lvis.approval.onRequest((req) => {
      setApprovalQueue((q) => approvalQueueReducer(q, { type: "push", req }));
    });
    return unsub;
  }, []);

  const handleApprovalDecide = useCallback(async (choice: ApprovalChoice, pattern?: string) => {
    const current = approvalQueueRef.current[0];
    if (!current) return;
    // shift 먼저 — respond 완료 전에 다음 항목 표시
    setApprovalQueue((q) => approvalQueueReducer(q, { type: "shift" }));
    if (window.lvis?.approval) {
      await window.lvis.approval.respond({ requestId: current.id, choice, rememberPattern: pattern });
    }
  }, []);

  const commandActions = useMemo(() => [
    { id: "home", label: "홈으로 이동", run: () => setActiveView("home") },
    { id: "tasks", label: "태스크 보기", run: () => setActiveView("tasks") },
    { id: "settings", label: "설정 열기", run: () => setSettingsOpen(true) },
    { id: "new-chat", label: "새 대화 시작", run: () => void handleNewChat() },
    ...pluginViews.map((i) => ({ id: `v:${toViewKey(i)}`, label: `${getPluginViewLabel(i)} 열기`, run: () => setActiveView(toViewKey(i)) })),
  ], [pluginViews, handleNewChat]);

  // ─── Render ───────────────────────────────────
  return (
    <TooltipProvider>
      <div className="grid h-screen grid-cols-[320px_1fr]">
        {/* Sidebar */}
        <aside className="border-r bg-background p-4">
          <Card className="h-full"><CardHeader><CardTitle>LVIS Plugins</CardTitle><CardDescription>마켓플레이스</CardDescription></CardHeader>
            <CardContent className="space-y-3"><div className="text-xs text-muted-foreground">{marketStatus}</div>
              <ScrollArea className="h-[calc(100vh-180px)] pr-2"><div className="space-y-2">
                {marketplace.map((pl) => (
                  <Card key={pl.id} className={`border-muted ${pl.isManaged ? "bg-muted/40" : ""}`}><CardContent className="space-y-2 p-3">
                    <div className="flex items-center justify-between">
                      <div className="font-medium flex items-center gap-1">
                        {pl.isManaged ? <span title="관리형 플러그인 — 회사 IT가 배포/관리 (제거 불가)">🔒</span> : null}
                        {pl.name}
                      </div>
                      <Badge variant={pl.installed ? "default" : "secondary"}>{pl.installed ? "설치됨" : "미설치"}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{pl.description}</p>
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => setInstallTarget(pl)} disabled={working || pl.isManaged} className="h-8" title={pl.isManaged ? "관리형 플러그인은 재설치할 수 없습니다" : ""}>{pl.installed ? "재설치" : "설치"}</Button>
                      {pl.installed ? <Button size="sm" variant="destructive" onClick={() => setUninstallTarget(pl)} disabled={working || pl.isManaged} className="h-8" title={pl.isManaged ? "관리형 플러그인은 제거할 수 없습니다" : ""}>제거</Button> : null}
                      <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="outline" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => { const t = pluginViews.find((x) => x.pluginId === pl.id); if (t) setActiveView(toViewKey(t)); }}>UI 열기</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardContent></Card>
                ))}
              </div></ScrollArea>
            </CardContent>
          </Card>
        </aside>

        {/* Main */}
        <main className="flex min-h-0 flex-col">
          <div className="border-b bg-card px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <Tabs value={activeView} onValueChange={setActiveView}><TabsList>
                <TabsTrigger value="home">홈</TabsTrigger><TabsTrigger value="tasks">태스크</TabsTrigger>
                <TabsTrigger value="starred">즐겨찾기{starred.length > 0 ? <span className="ml-1 text-[10px] text-muted-foreground">({starred.length})</span> : null}</TabsTrigger>
                {pluginViews.map((i) => <TabsTrigger key={toViewKey(i)} value={toViewKey(i)}>{getPluginViewLabel(i)}</TabsTrigger>)}
              </TabsList></Tabs>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void handleNewChat()}><Plus className="mr-1 h-4 w-4" />새 대화</Button>
                <DropdownMenu onOpenChange={(open) => { if (open) void refreshSessions(); }}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={streaming}
                      title={streaming ? "응답 생성 중에는 세션을 바꿀 수 없습니다" : "대화 기록 불러오기"}
                    ><History className="mr-1 h-4 w-4" />기록</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-[480px] w-[300px] overflow-y-auto">
                    {sessions.length === 0 ? (
                      <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                        저장된 대화가 없습니다.
                      </DropdownMenuItem>
                    ) : (
                      sessions.map((s) => {
                        const isCurrent = s.id === currentSessionId;
                        return (
                          <DropdownMenuItem
                            key={s.id}
                            onClick={() => void handleLoadSession(s.id)}
                            className={isCurrent ? "bg-muted/50" : ""}
                          >
                            <div className="flex w-full flex-col">
                              <span className="text-xs tabular-nums">
                                {new Date(s.modifiedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                              </span>
                              <span className="font-mono text-[10px] opacity-60">#{s.id.slice(0, 8)}{isCurrent ? " · 현재" : ""}</span>
                            </div>
                          </DropdownMenuItem>
                        );
                      })
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" title="내보내기"><Download className="mr-1 h-4 w-4" />내보내기</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void handleExport("markdown")}>Markdown (.md)</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleExport("json")}>JSON (.json)</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" size="sm" onClick={() => setSearchOpen((v) => !v)} title="대화 검색 (Ctrl/Cmd+F)"><Search className="mr-1 h-4 w-4" />찾기</Button>
                <Sheet open={sheetOpen} onOpenChange={setSheetOpen}><SheetTrigger asChild><Button variant="outline" size="sm"><PanelsTopLeft className="mr-1 h-4 w-4" />뷰</Button></SheetTrigger>
                  <SheetContent side="right"><SheetHeader><SheetTitle>뷰 관리</SheetTitle><SheetDescription>빠른 이동</SheetDescription></SheetHeader><Separator className="my-4" />
                    <div className="space-y-2">
                      <Button variant={activeView === "home" ? "default" : "secondary"} className="w-full justify-start" onClick={() => { setActiveView("home"); setSheetOpen(false); }}>홈</Button>
                      <Button variant={activeView === "tasks" ? "default" : "secondary"} className="w-full justify-start" onClick={() => { setActiveView("tasks"); setSheetOpen(false); }}>태스크</Button>
                      {pluginViews.map((i) => { const k = toViewKey(i); return <Button key={k} variant={activeView === k ? "default" : "secondary"} className="w-full justify-start" onClick={() => { setActiveView(k); setSheetOpen(false); }}>{getPluginViewLabel(i)}</Button>; })}
                    </div>
                  </SheetContent>
                </Sheet>
                <Tooltip><TooltipTrigger asChild><Button variant={hasApiKey === false ? "destructive" : "outline"} size="sm" onClick={() => setSettingsOpen(true)}><KeyRound className="mr-1 h-4 w-4" />설정</Button></TooltipTrigger><TooltipContent>{hasApiKey ? "LLM 설정" : "API 키를 설정해 주세요"}</TooltipContent></Tooltip>
                <Tooltip><TooltipTrigger asChild><Button variant="outline" size="sm" onClick={() => setCommandOpen(true)}><CommandIcon className="mr-1 h-4 w-4" />Cmd</Button></TooltipTrigger><TooltipContent>Ctrl/Cmd + K</TooltipContent></Tooltip>
              </div>
            </div>
          </div>

          {/* Content */}
          {activeView === "tasks" ? <TaskView api={api} /> : activeView === "starred" ? (
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <Card className="flex h-full min-h-0 flex-col">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>즐겨찾기</CardTitle>
                    <Button size="sm" variant="outline" onClick={() => void refreshStarred()}>새로고침</Button>
                  </div>
                  <CardDescription>별표한 메시지는 전체 대화에서 모아볼 수 있습니다.</CardDescription>
                </CardHeader>
                <CardContent className="flex min-h-0 flex-1 flex-col">
                  <ScrollArea className="flex-1">
                    {starred.length === 0 ? (
                      <div className="py-8 text-center text-sm text-muted-foreground">즐겨찾기한 메시지가 없습니다.</div>
                    ) : (
                      <div className="space-y-2 pr-2">
                        {starred.map((s) => (
                          <div key={s.id} className="rounded-md border p-3 text-sm">
                            <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                              <Badge variant="outline" className="text-[10px]">{s.role}</Badge>
                              <span>{new Date(s.starredAt).toLocaleString("ko-KR")}</span>
                              <span className="font-mono opacity-60">#{s.sessionId.slice(0, 8)}</span>
                              <button className="ml-auto rounded p-0.5 hover:bg-muted" title="해제" onClick={() => { void api.starredRemove({ id: s.id }).then(() => refreshStarred()); }}>
                                <XIcon className="h-3 w-3" />
                              </button>
                            </div>
                            <button
                              className="w-full whitespace-pre-wrap break-words text-left text-sm hover:opacity-80"
                              onClick={async () => {
                                if (s.sessionId !== currentSessionId) {
                                  await handleLoadSession(s.sessionId);
                                }
                                setActiveView("home");
                              }}
                            >{s.text.slice(0, 300)}{s.text.length > 300 ? "…" : ""}</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          ) : activeView === "home" ? (
            <div className="relative grid min-h-0 flex-1 grid-rows-[1fr_auto]">
              <ChatSearchOverlay
                open={searchOpen}
                query={searchQuery}
                caseSensitive={searchCase}
                matchCount={searchMatches.length}
                currentIdx={searchIdx}
                onChangeQuery={(v) => { setSearchQuery(v); setSearchIdx(0); }}
                onToggleCase={() => setSearchCase((v) => !v)}
                onNext={() => setSearchIdx((i) => (searchMatches.length === 0 ? 0 : (i + 1) % searchMatches.length))}
                onPrev={() => setSearchIdx((i) => (searchMatches.length === 0 ? 0 : (i - 1 + searchMatches.length) % searchMatches.length))}
                onClose={() => { setSearchOpen(false); setSearchQuery(""); }}
              />
              {hasApiKey === false && (
                <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
                  <Card className="w-[400px]"><CardHeader className="text-center"><KeyRound className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><CardTitle>API 키 설정 필요</CardTitle><CardDescription>채팅을 시작하려면 Claude API 키를 설정해 주세요.</CardDescription></CardHeader>
                    <CardContent className="flex justify-center"><Button onClick={() => setSettingsOpen(true)}><KeyRound className="mr-2 h-4 w-4" />설정 열기</Button></CardContent>
                  </Card>
                </div>
              )}
              <ScrollArea className="h-full p-4"><div className="space-y-3">
                {briefing && (
                  <BriefingCard
                    briefing={briefing}
                    onDismiss={(feedback) => {
                      // PR#44 Copilot: await IPC result; hide only on ok:true.
                      // debounced/error keeps card visible so user can retry.
                      void api.dismissBriefing(feedback).then((r) => {
                        if (r?.ok) setBriefing(null);
                        else console.warn("[lvis] dismissBriefing skipped:", r);
                      }).catch((e: Error) => {
                        console.warn("[lvis] dismissBriefing failed:", e.message);
                      });
                    }}
                    onSnooze={() => {
                      void api.snoozeBriefing().then((r) => {
                        if (r?.ok) setBriefing(null);
                        else console.warn("[lvis] snoozeBriefing skipped:", r);
                      }).catch((e: Error) => {
                        console.warn("[lvis] snoozeBriefing failed:", e.message);
                      });
                    }}
                  />
                )}
                {entries.length === 0 && hasApiKey !== false && <div className="py-12 text-center text-sm text-muted-foreground">LVIS 에이전트가 준비되었습니다. 질문을 입력하거나 /command를 사용하세요.</div>}
                {entries.map((entry, idx) => {
                  const isMatch = searchMatchSet.has(idx);
                  const isCurrentMatch = searchOpen && searchMatches[searchIdx] === idx;
                  const ringCls = isCurrentMatch ? "ring-2 ring-primary" : isMatch ? "ring-1 ring-primary/40" : "";
                  if (entry.kind === "user") {
                    if (editingEntryIdx === idx) {
                      return (
                        <UserMessageEditor
                          key={idx}
                          initialText={entry.text}
                          busy={editBusy}
                          onCancel={() => setEditingEntryIdx(null)}
                          onSave={(next) => void handleEditSave(idx, next)}
                        />
                      );
                    }
                    const starId = isEntryStarred(idx);
                    const starActive = !!starId;
                    return (
                      <div key={idx} className={`group relative ml-auto max-w-[85%] rounded-md border bg-primary px-3 py-2 text-sm text-primary-foreground ${ringCls}`}>
                        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span>나</span>
                          {starActive ? <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" /> : null}
                          <div className="ml-auto hidden gap-1 group-hover:flex">
                            <button className="rounded p-0.5 hover:bg-black/20" title="편집" onClick={() => setEditingEntryIdx(idx)}><Pencil className="h-3 w-3" /></button>
                            <button className="rounded p-0.5 hover:bg-black/20" title="분기" onClick={() => void handleFork(idx)}><GitBranch className="h-3 w-3" /></button>
                            <button className="rounded p-0.5 hover:bg-black/20" title="즐겨찾기" onClick={() => void handleToggleStar(idx)}>
                              <Star className={`h-3 w-3 ${starActive ? "fill-yellow-400 text-yellow-400" : ""}`} />
                            </button>
                          </div>
                        </div>
                        <div className="whitespace-pre-wrap">{searchHighlight ? highlightText(entry.text, searchHighlight) : entry.text}</div>
                      </div>
                    );
                  }
                  if (entry.kind === "reasoning") return <ReasoningCard key={idx} entry={entry} />;
                  if (entry.kind === "tool_group") return <ToolGroupCard key={entry.groupId} group={entry} />;
                  if (entry.kind === "system") return <div key={idx} className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/50">{entry.text}</div>;
                  return (
                    <div key={idx} className={`${ringCls} rounded-md`}>
                      <AssistantCard
                        entry={entry}
                        highlightQuery={searchHighlight}
                        isStarred={!!isEntryStarred(idx)}
                        actions={{
                          onRetry: () => void handleRetryEffort(),
                          onFork: () => void handleFork(idx),
                          onToggleStar: () => void handleToggleStar(idx),
                        }}
                      />
                    </div>
                  );
                })}
                <div ref={chatEndRef} />
              </div></ScrollArea>
              {contextOverflowPct >= 0.95 && (
                <div className="border-t bg-destructive/10 px-3 py-1.5 text-xs text-destructive flex items-center gap-2">
                  <span className="font-semibold">컨텍스트 {Math.round(contextOverflowPct * 100)}% 사용</span>
                  <span>— 자동 압축이 필요합니다. 전송이 일시 차단됩니다.</span>
                </div>
              )}
              {contextOverflowPct >= 0.80 && contextOverflowPct < 0.95 && (
                <div className="border-t bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-2">
                  <span className="font-semibold">컨텍스트 {Math.round(contextOverflowPct * 100)}% 사용</span>
                  <span>— 곧 자동 압축됩니다.</span>
                </div>
              )}
              <div className="border-t bg-card p-3 space-y-2">
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <div className={`font-mono ${contextColor}`} title="추정 토큰 사용량 (대화 기반)">
                    {usedTokens.toLocaleString()} / {contextBudget.toLocaleString()} tokens ({contextPercent}%)
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Sprint B — Role preset dropdown */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px]" title="역할 프리셋 선택">
                          <User className="h-3 w-3" /> {activePreset?.name ?? "기본"} <ChevronDown className="h-3 w-3 opacity-60" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {rolePresets.map((p) => (
                          <DropdownMenuItem key={p.id} onClick={() => setActivePresetId(p.id)}>
                            <span className={activePresetId === p.id ? "font-semibold" : ""}>{p.name}</span>
                            {p.isDefault ? null : <span className="ml-2 text-[10px] text-muted-foreground">effort: {p.effort} · t {p.temperature}</span>}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {/* Sprint B — PageIndex attach */}
                    <Popover open={docPopoverOpen} onOpenChange={(o) => { setDocPopoverOpen(o); if (o) void refreshIndexedDocs(); }}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px]" title="문서 첨부">
                          <Paperclip className="h-3 w-3" />
                          {attachedDocs.length > 0 ? <span>{attachedDocs.length}</span> : null}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-72 p-2">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-xs font-medium">인덱싱된 문서</span>
                          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => void refreshIndexedDocs()}>새로고침</Button>
                        </div>
                        <div className="max-h-64 overflow-y-auto">
                          {docsLoading ? (
                            <div className="py-6 text-center text-xs text-muted-foreground">로딩 중...</div>
                          ) : indexedDocs.length === 0 ? (
                            <div className="py-6 text-center text-xs text-muted-foreground">문서가 없습니다. PageIndex 플러그인에서 먼저 인덱싱하세요.</div>
                          ) : (
                            <div className="space-y-1">
                              {indexedDocs.map((d) => {
                                const attached = attachedDocs.some((a) => a.id === d.id);
                                return (
                                  <button
                                    key={d.id}
                                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted ${attached ? "bg-muted" : ""}`}
                                    onClick={() => setAttachedDocs((prev) => attached ? prev.filter((a) => a.id !== d.id) : [...prev, d])}
                                  >
                                    <input type="checkbox" checked={attached} readOnly className="h-3 w-3" />
                                    <span className="truncate">{d.name}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                    {/* Sprint B — Language lock toggle */}
                    <Button
                      variant={langLock === "off" ? "outline" : "default"}
                      size="sm"
                      className="h-7 gap-1 text-[11px]"
                      title="응답 언어 강제"
                      onClick={() => setLangLock((v) => v === "off" ? "ko" : v === "ko" ? "en" : "off")}
                    >
                      <Globe className="h-3 w-3" />
                      {langLock === "off" ? "자동" : langLock === "ko" ? "한국어" : "English"}
                    </Button>
                    {vendorSupportsThinking && (
                      <label className="flex items-center gap-1.5 text-muted-foreground cursor-pointer select-none">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5"
                          checked={enableThinkingChat}
                          onChange={(e) => void toggleThinking(e.target.checked)}
                        />
                        <span>Thinking</span>
                      </label>
                    )}
                  </div>
                </div>
                {/* Sprint B — attached-doc chips */}
                {attachedDocs.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {attachedDocs.map((d) => (
                      <span key={d.id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]">
                        <span>🗎 {d.name}</span>
                        <button
                          className="rounded-full p-0.5 hover:bg-background"
                          onClick={() => setAttachedDocs((prev) => prev.filter((a) => a.id !== d.id))}
                          title="첨부 해제"
                        ><XIcon className="h-3 w-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <Textarea value={question} onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleAsk(question);
                      }
                    }}
                    placeholder={hasApiKey === false ? "API 키를 먼저 설정해 주세요..." : "질문 입력 (Enter 전송 / Shift+Enter 줄바꿈) · /command 사용 가능"}
                    className="min-h-[76px]" disabled={streaming} />
                  <div className="flex flex-col items-stretch gap-1">
                    <Button onClick={() => void handleAsk(question)} disabled={streaming || !question.trim() || contextOverflowPct >= 0.95}>{streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : "전송"}</Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className={`text-center text-[11px] font-mono ${costBadgeClass}`} title="예상 비용">
                          {formatCostBadge(costEstimate.total)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">
                        <div>입력: {costEstimate.inputTokens.toLocaleString()} tok · ${costEstimate.inputCost.toFixed(5)}</div>
                        <div>출력(추정): {costEstimate.outputTokens.toLocaleString()} tok · ${costEstimate.outputCost.toFixed(5)}</div>
                        <div className="font-semibold">합계: ${costEstimate.total.toFixed(5)}</div>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <PluginUiHostView view={activePluginView ?? null} callPluginMethod={(m, p) => api.callPluginMethod(m, p)} onAskInHomeChat={async (q) => { setActiveView("home"); await handleAsk(q); }} onAddTask={(t) => api.addTask(t)} />
          )}
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} api={api} onSaved={() => { void checkApiKey(); void refreshLlmSettings(); }} />
      <ToolApprovalDialog
        open={approvalQueue.length > 0}
        request={approvalQueue[0] ?? null}
        pendingCount={approvalQueue.length}
        onDecide={(choice, pattern) => void handleApprovalDecide(choice, pattern)}
      />
      <Dialog open={!!installTarget} onOpenChange={(o) => !o && setInstallTarget(null)}><DialogContent><DialogHeader><DialogTitle>플러그인 설치</DialogTitle><DialogDescription>{installTarget ? `'${installTarget.name}' 설치?` : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setInstallTarget(null)}>취소</Button><Button onClick={async () => { if (!installTarget) return; const id = installTarget.id; setInstallTarget(null); await installPlugin(id); }} disabled={working}>설치</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}><DialogContent><DialogHeader><DialogTitle>Command</DialogTitle><DialogDescription>빠른 실행</DialogDescription></DialogHeader><Command><CommandInput placeholder="검색..." value={commandQuery} onValueChange={setCommandQuery} /><CommandList><CommandEmpty>결과 없음</CommandEmpty><CommandGroup heading="Actions">{commandActions.filter((a) => !commandQuery || a.label.toLowerCase().includes(commandQuery.toLowerCase())).map((a) => <CommandItem key={a.id} onSelect={() => { setCommandOpen(false); setCommandQuery(""); void a.run(); }}><Search className="mr-2 h-4 w-4" />{a.label}</CommandItem>)}</CommandGroup></CommandList></Command></DialogContent></Dialog>
      <Dialog open={!!uninstallTarget} onOpenChange={(o) => !o && setUninstallTarget(null)}><DialogContent><DialogHeader><DialogTitle>플러그인 제거</DialogTitle><DialogDescription>{uninstallTarget ? `'${uninstallTarget.name}' 제거?` : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setUninstallTarget(null)}>취소</Button><Button variant="destructive" onClick={async () => { if (!uninstallTarget) return; const id = uninstallTarget.id; setUninstallTarget(null); await uninstallPlugin(id); }} disabled={working}>제거</Button></DialogFooter></DialogContent></Dialog>
    </TooltipProvider>
  );
}

// ─── Bootstrap ──────────────────────────────────────
// Guard with `typeof document` so importing <App /> from a jsdom test
// harness (no #root) doesn't double-mount or throw.
if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<App />);
}
