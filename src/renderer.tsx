import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Search, MoreHorizontal, Command as CommandIcon, KeyRound, Plus, Loader2, Wrench, PanelsTopLeft, ChevronDown, ChevronRight, Star, Download, Pencil, GitBranch, RefreshCw, X as XIcon, Paperclip, Globe, User } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import {
  DEFAULT_ROLE_PRESETS,
  buildPresetPrefix,
  loadRolePresets,
  saveRolePresets,
  resetRolePresets,
  type RolePreset,
} from "./data/role-presets.js";
import { costTier, estimateTurnCost, formatCostBadge } from "./lib/cost-estimator.js";

// Minimal renderer-side pricing lookup (mirrors engine/llm/pricing.ts). Renderer is
// browser-bundled and must not import the engine module (it references process.env).
const RENDERER_PRICING: Record<string, Record<string, { inputPer1M: number; outputPer1M: number }>> = {
  claude: {
    "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
    "claude-sonnet-4-5": { inputPer1M: 3, outputPer1M: 15 },
    "claude-opus-4-6":   { inputPer1M: 15, outputPer1M: 75 },
    "claude-opus-4-5":   { inputPer1M: 15, outputPer1M: 75 },
    "claude-haiku-4-5":  { inputPer1M: 1, outputPer1M: 5 },
  },
  openai: {
    "gpt-5.4":      { inputPer1M: 1.25, outputPer1M: 10 },
    "gpt-5.4-mini": { inputPer1M: 1.25, outputPer1M: 10 },
    "gpt-5.4-nano": { inputPer1M: 0.5,  outputPer1M: 4 },
    "gpt-5.4-pro":  { inputPer1M: 5,    outputPer1M: 40 },
    "gpt-5":        { inputPer1M: 1.25, outputPer1M: 10 },
    "gpt-4.1":      { inputPer1M: 2,    outputPer1M: 8 },
    "gpt-4.1-mini": { inputPer1M: 0.4,  outputPer1M: 1.6 },
  },
  gemini:  { "gemini-2.5-flash": { inputPer1M: 0, outputPer1M: 0 }, "gemini-2.5-pro": { inputPer1M: 0, outputPer1M: 0 } },
  copilot: { "gpt-4.1": { inputPer1M: 0, outputPer1M: 0 } },
};
function rendererPricing(vendor: string, model: string): { inputPer1M: number; outputPer1M: number } {
  const table = RENDERER_PRICING[vendor] ?? {};
  if (table[model]) return table[model];
  for (const k of Object.keys(table)) if (model.startsWith(k)) return table[k];
  return { inputPer1M: 0, outputPer1M: 0 };
}
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
import { PluginUiHostView, type PluginUiExtensionView } from "./plugin-ui-host.js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { approvalQueueReducer } from "./lib/approval-queue-reducer.js";
import {
  appendUserEntry,
  applyToolEnd,
  applyToolStart,
  finalizeStreamingReasoning,
  finalizeStreamingAssistant,
  setAssistantError,
  type ChatEntry,
  type StreamEvent,
  upsertStreamingReasoning,
  upsertStreamingAssistant,
} from "./lib/chat-stream-state.js";

// ─── Types ──────────────────────────────────────────

type MarketplaceItem = { id: string; name: string; description: string; packageSpec: string; installed: boolean; enabled: boolean; isManaged?: boolean };
type PluginUiExtension = PluginUiExtensionView;
type Task = { id: string; title: string; description?: string; source: "email"|"meeting"|"calendar"|"teams"|"manual"; priority: "high"|"medium"|"low"; status: "pending"|"done"|"snoozed"; dueAt?: string; createdAt: string; updatedAt: string };
type AppSettings = { llm: { provider: string; model: string; enableThinking?: boolean; thinkingBudgetTokens?: number; baseUrls?: Record<string, string>; vertexProject?: string; vertexLocation?: string }; chat: { systemPrompt: string; autoCompact: boolean }; webSearch: { provider: string }; proactive?: { enableDailyBriefing: boolean; lastBriefingAt?: string; lastDismissedAt?: string } };

// ─── Usage types (Sprint 4.B) ───────────────────────
type UsageTotals = { inputTokens: number; outputTokens: number; totalTokens: number; cost: number };
type UsagePerX = UsageTotals & { vendor: string; model: string };
type UsageTrendPt = UsageTotals & { date: string };
type UsageConv = UsageTotals & { sessionId: string; turns: number; firstInput?: string };
type UsageSummaryShape = {
  today: UsageTotals; thisWeek: UsageTotals; thisMonth: UsageTotals;
  perVendor: UsagePerX[]; perModel: UsagePerX[];
  trend: UsageTrendPt[]; topConversations: UsageConv[]; generatedAt: string;
};

export type BriefingPayload = {
  generatedAt: string;
  items: Array<{ category: string; priority: string; title: string; detail?: string }>;
  summary?: string;
};

type LvisApi = {
  getSettings: () => Promise<AppSettings>;
  updateSettings: (p: Partial<AppSettings>) => Promise<AppSettings>;
  setApiKey: (vendor: string, k: string) => Promise<{ ok: true }>;
  hasApiKey: (vendor?: string) => Promise<boolean>;
  deleteApiKey: (vendor: string) => Promise<{ ok: true }>;
  setWebApiKey: (provider: string, k: string) => Promise<{ ok: true }>;
  hasWebApiKey: (provider: string) => Promise<boolean>;
  deleteWebApiKey: (provider: string) => Promise<{ ok: true }>;
  chatHasProvider: () => Promise<boolean>;
  chatSend: (input: string) => Promise<unknown>;
  chatNew: () => Promise<{ ok: true }>;
  onChatStream: (h: (e: StreamEvent) => void) => () => void;
  chatGetHistory: () => Promise<{ sessionId: string; messages: Array<{ index: number; role: string; content: string; toolName?: string; isError?: boolean }> }>;
  chatEditResend: (messageIndex: number, newText: string) => Promise<{ ok: boolean; error?: string }>;
  chatFork: (messageIndex: number) => Promise<{ ok: boolean; sessionId: string | null }>;
  chatRetryEffort: (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  chatExport: (format: "markdown" | "json") => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  starredList: () => Promise<Array<{ id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string }>>;
  starredAdd: (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => Promise<{ ok: boolean; entry?: { id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string } }>;
  starredRemove: (opts: { id?: string; sessionId?: string; messageIndex?: number }) => Promise<{ ok: boolean }>;
  memoryListNotes: () => Promise<Array<{ filename: string; title: string; content: string }>>;
  memorySaveNote: (t: string, c: string) => Promise<unknown>;
  memoryDeleteNote: (f: string) => Promise<void>;
  listMarketplacePlugins: () => Promise<MarketplaceItem[]>;
  installMarketplacePlugin: (id: string) => Promise<unknown>;
  uninstallMarketplacePlugin: (id: string) => Promise<unknown>;
  listPluginUiExtensions: () => Promise<PluginUiExtension[]>;
  callPluginMethod: (m: string, p?: unknown) => Promise<unknown>;
  addTask: (t: unknown) => Promise<Task>;
  queryTasks: (f?: unknown) => Promise<Task[]>;
  updateTask: (id: string, p: unknown) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  getTodayTasks: () => Promise<Task[]>;
  getOverdueTasks: () => Promise<Task[]>;
  getBriefing: () => Promise<string | null>;
  onProactiveBriefing: (h: (b: BriefingPayload) => void) => () => void;
  dismissBriefing: () => Promise<{ ok: boolean; debounced?: boolean }>;
  snoozeBriefing: () => Promise<{ ok: boolean; lastDismissedAt?: string }>;
  onViewActivate: (h: (k: string) => void) => () => void;
  getUsageSummary: (days?: number) => Promise<UsageSummaryShape>;
};

// ─── Approval types (mirrored from approval-gate.ts — no node import in renderer) ─

type ApprovalChoice = "allow-once" | "allow-always" | "deny-once" | "deny-always";
type ApprovalRequest = {
  id: string;
  category: "tool";
  toolName: string;
  args: unknown;
  reason: string;
  source?: "builtin" | "plugin" | "mcp";
  createdAt: number;
  /** PolicyFile.requireExplicitApproval — true: dismiss 차단, false: dismiss → deny-once */
  requireExplicit: boolean;
  /**
   * AF2: §S1 hard-block target. Populated by the tool executor so the
   * approval-gate can run the sensitive-path check. Shown as-is by the
   * dialog if present (UI enhancement is a separate follow-up).
   */
  target?: { filePath?: string };
  /**
   * AF2: §S4 read-only hint. When true and mode !== "plan", the gate
   * short-circuits without showing this dialog — so renderer only sees
   * a request with `isReadOnly=true` when the gate was bypassed (plan mode).
   */
  isReadOnly?: boolean;
  /**
   * AF2: permission mode at request time. "plan" still surfaces the dialog
   * even for read-only tools; "default" / "full_auto" auto-approve.
   */
  mode?: "default" | "plan" | "full_auto";
};
type ApprovalDecision = {
  requestId: string;
  choice: ApprovalChoice;
  rememberPattern?: string;
};

type LvisApprovalApi = {
  onRequest: (cb: (req: ApprovalRequest) => void) => () => void;
  respond: (decision: ApprovalDecision) => Promise<unknown>;
};

type PermissionRule = { pattern: string; action: "allow" | "deny"; source?: string };

type LvisPermissionApi = {
  getMode: () => Promise<{ mode: string }>;
  setMode: (mode: string) => Promise<{ ok: boolean; mode: string }>;
  listRules: () => Promise<PermissionRule[]>;
  addRule: (pattern: string, action: string) => Promise<{ ok: boolean }>;
  removeRule: (pattern: string, action: string) => Promise<{ ok: boolean }>;
};

type LvisPolicyApi = {
  get: () => Promise<{
    version: 1;
    requireExplicitApproval: boolean;
    managed: boolean;
    updatedAt: string;
    /** §C2 admin-dir source tracking */
    source: "defaults" | "user" | "admin" | "merged";
    adminOverrides?: string[];
    adminPath?: string;
  }>;
  set: (patch: unknown) => Promise<{ ok: boolean; policy?: unknown; error?: string; message?: string }>;
};

declare global {
  interface Window {
    lvisApi: LvisApi;
    lvis: {
      permission: LvisPermissionApi;
      approval: LvisApprovalApi;
      policy: LvisPolicyApi;
    };
  }
}

// ─── Constants ──────────────────────────────────────

const PRIORITY_CLASS: Record<Task["priority"], string> = { high: "text-red-400", medium: "text-amber-400", low: "text-slate-400" };
const SOURCE_LABEL: Record<Task["source"], string> = { email: "메일", meeting: "미팅", calendar: "일정", teams: "Teams", manual: "직접" };

// ─── BriefingCard (Sprint 3-A) ──────────────────────

const PRIORITY_EMOJI: Record<string, string> = { high: "🔴", medium: "🟡", low: "🔵" };

/**
 * Sprint 3-A: renders a dismissable daily briefing card.
 * Three prop variants exercised in tests:
 *   - items present (typical)
 *   - empty-state (items: [], summary provided by generateTextBriefing)
 *   - LLM-failed fallback (summary is the plain-text briefing)
 */
export function BriefingCard({
  briefing,
  onDismiss,
  onSnooze,
}: {
  briefing: BriefingPayload;
  onDismiss: () => void;
  onSnooze: () => void;
}) {
  const generatedLabel = useMemo(() => {
    try {
      return new Date(briefing.generatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    } catch {
      return briefing.generatedAt;
    }
  }, [briefing.generatedAt]);

  return (
    <Card data-testid="briefing-card" className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm">🗒️ 오늘의 브리핑</CardTitle>
            <CardDescription className="text-[11px]">{generatedLabel}</CardDescription>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onSnooze}>1시간 뒤 다시</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onDismiss}>닫기</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {briefing.summary && (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{briefing.summary}</p>
        )}
        {briefing.items.length === 0 ? (
          <p className="text-xs text-muted-foreground">표시할 항목이 없습니다.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {briefing.items.slice(0, 8).map((it, idx) => (
              // PR#44 HIGH: composite key (category:title) beats raw idx —
              // stable across reorder; idx fallback handles duplicate titles.
              <li key={`${it.category}:${it.title}:${idx}`} className="flex gap-1.5">
                <span>{PRIORITY_EMOJI[it.priority] ?? "•"}</span>
                <span className="flex-1">
                  <span className="font-medium">{it.title}</span>
                  {it.detail ? <span className="text-muted-foreground"> — {it.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

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
                        <Badge variant="outline" className="text-[10px]">{SOURCE_LABEL[t.source]}</Badge>
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

const VENDORS = [
  { id: "claude", label: "Anthropic Claude", placeholder: "sk-ant-...", defaultModel: "claude-sonnet-4-6", needsBaseUrl: false },
  { id: "openai", label: "OpenAI", placeholder: "sk-...", defaultModel: "gpt-4o", needsBaseUrl: false },
  { id: "gemini", label: "Google Gemini", placeholder: "AIza...", defaultModel: "gemini-2.0-flash", needsBaseUrl: false },
  { id: "copilot", label: "GitHub Copilot", placeholder: "ghp_...", defaultModel: "gpt-4o", needsBaseUrl: false },
  { id: "azure-foundry", label: "Azure AI Foundry", placeholder: "Azure API key...", defaultModel: "gpt-4o", needsBaseUrl: true, baseUrlPlaceholder: "https://{resource}.openai.azure.com/openai/deployments/{deployment}/" },
  { id: "vertex-ai", label: "Google Vertex AI", placeholder: "service account (unused — uses ADC)", defaultModel: "gemini-2.5-flash", needsBaseUrl: false },
] as const;

const WEB_PROVIDERS = [
  { id: "duckduckgo", label: "DuckDuckGo", placeholder: "키 불필요", needsKey: false },
  { id: "tavily", label: "Tavily AI", placeholder: "tvly-...", needsKey: true },
  { id: "serper", label: "Serper.dev", placeholder: "키 입력...", needsKey: true },
  { id: "google", label: "Google Search", placeholder: "API Key...", needsKey: true },
] as const;

// Reasoning effort slider steps. Budget values are chosen to land cleanly in
// both `mapReasoningEffort()` (OpenAI: ≤3000=low, ≤8000=medium, >8000=high)
// and `mapBudgetToEffort()` (Claude adaptive: ≤3000=low, ≤6000=medium,
// ≤16000=high, >16000=max) in vercel/adapter.ts. Keep values in sync if those
// thresholds change.
const REASONING_EFFORT_STEPS = [
  { label: "Low", budget: 2000 },
  { label: "Medium", budget: 6000 },
  { label: "High", budget: 12_000 },
  { label: "Max", budget: 24_000 },
] as const;

function budgetToEffortIndex(budget: number): number {
  let closest = 0;
  let minDiff = Math.abs(REASONING_EFFORT_STEPS[0]!.budget - budget);
  for (let i = 1; i < REASONING_EFFORT_STEPS.length; i++) {
    const diff = Math.abs(REASONING_EFFORT_STEPS[i]!.budget - budget);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  return closest;
}

// ─── PermissionsTab ─────────────────────────────────

type ExecMode = "default" | "strict" | "auto";

const EXEC_MODE_OPTIONS: { value: ExecMode; label: string; description: string }[] = [
  { value: "default", label: "기본 (Default)", description: "위험한 도구만 승인 요구" },
  { value: "strict",  label: "엄격 (Strict)",  description: "모든 도구 승인 요구" },
  { value: "auto",    label: "자동 (Auto)",    description: "신뢰도 기반 자동 허용 (builtin 자동, plugin 승인, mcp 차단)" },
];

function PermissionsTab() {
  // ── 로딩 상태 ─────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── 인라인 배너 (alert 대체 — §F9) ───────────────
  const [banner, setBanner] = useState<{ type: "error" | "warn"; msg: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showBanner = useCallback((type: "error" | "warn", msg: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ type, msg });
    bannerTimerRef.current = setTimeout(() => setBanner(null), 5000);
  }, []);

  // ── Section A: Execution Mode ─────────────────────
  const [mode, setMode] = useState<ExecMode>("default");

  // ── Section B: Explicit Approval Policy ──────────
  const [requireExplicit, setRequireExplicit] = useState(true);
  const [policyManaged, setPolicyManaged] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  /** §C2: admin-dir source tracking */
  const [policySource, setPolicySource] = useState<"defaults"|"user"|"admin"|"merged">("defaults");
  const [policyAdminPath, setPolicyAdminPath] = useState<string | undefined>(undefined);

  // ── Section C: Rule Editor ────────────────────────
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [newAction, setNewAction] = useState<"allow" | "deny">("allow");
  const [rulesBusy, setRulesBusy] = useState(false);

  // ── 초기 fetch (탭 진입 시) ───────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [modeRes, policyRes, rulesRes] = await Promise.all([
        window.lvis.permission.getMode(),
        window.lvis.policy.get(),
        window.lvis.permission.listRules(),
      ]);
      setMode((modeRes.mode as ExecMode) ?? "default");
      setRequireExplicit(policyRes.requireExplicitApproval);
      setPolicyManaged(policyRes.managed);
      setPolicySource((policyRes.source as "defaults"|"user"|"admin"|"merged") ?? "defaults");
      setPolicyAdminPath(policyRes.adminPath as string | undefined);
      setRules(rulesRes);
    } catch (e) {
      setError((e as Error).message ?? "데이터를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  // ── Section A handler ─────────────────────────────
  const handleModeChange = async (m: ExecMode) => {
    setMode(m);
    await window.lvis.permission.setMode(m);
  };

  // ── Section B handler ─────────────────────────────
  const handleExplicitToggle = async () => {
    if (policyManaged) return;
    setPolicyBusy(true);
    try {
      const next = !requireExplicit;
      const res = await window.lvis.policy.set({ requireExplicitApproval: next });
      if (res.ok) {
        setRequireExplicit(next);
      } else if (res.error === "managed") {
        showBanner("warn", "이 정책은 IT 관리자가 설정했습니다. 사용자가 변경할 수 없습니다.");
      } else {
        showBanner("error", res.message ?? "정책 변경에 실패했습니다.");
      }
    } finally {
      setPolicyBusy(false);
    }
  };

  // ── Section C handlers ────────────────────────────
  const refreshRules = async () => {
    const r = await window.lvis.permission.listRules();
    setRules(r);
  };

  const handleAddRule = async () => {
    const pattern = newPattern.trim();
    if (!pattern) return;
    setRulesBusy(true);
    try {
      await window.lvis.permission.addRule(pattern, newAction);
      setNewPattern("");
      await refreshRules();
    } finally {
      setRulesBusy(false);
    }
  };

  const handleRemoveRule = async (pattern: string, action: "allow" | "deny") => {
    setRulesBusy(true);
    try {
      await window.lvis.permission.removeRule(pattern, action);
      await refreshRules();
    } finally {
      setRulesBusy(false);
    }
  };

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">로딩 중...</div>;
  }
  if (error) {
    return <div className="py-4 text-sm text-destructive">{error}</div>;
  }

  return (
    <ScrollArea className="h-[420px] pr-2">
      <div className="space-y-6 pt-4">

        {/* ── 인라인 배너 (§F9 — alert 대체) ── */}
        {banner && (
          <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${banner.type === "error" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"}`}>
            <span className="mt-0.5 flex-shrink-0">{banner.type === "error" ? "⚠" : "🔒"}</span>
            <span>{banner.msg}</span>
            <button className="ml-auto flex-shrink-0 opacity-60 hover:opacity-100" onClick={() => setBanner(null)}>✕</button>
          </div>
        )}

        {/* ── Section A: Execution Mode ── */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">실행 모드</p>
            <p className="text-[11px] text-muted-foreground">AI 에이전트가 도구를 실행할 때 어떤 수준의 권한을 적용할지 결정합니다.</p>
          </div>
          <div className="space-y-1.5">
            {EXEC_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors ${mode === opt.value ? "border-primary bg-primary/10" : "border-muted hover:border-muted-foreground/40"}`}
                onClick={() => void handleModeChange(opt.value)}
              >
                <span className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 ${mode === opt.value ? "border-primary" : "border-muted-foreground"}`}>
                  {mode === opt.value && <span className="h-2 w-2 rounded-full bg-primary" />}
                </span>
                <span>
                  <span className="font-medium">{opt.label}</span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">{opt.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <Separator />

        {/* ── Section B: Explicit Approval Policy ── */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">명시적 승인 요구</p>
            <p className="text-[11px] text-muted-foreground">체크 시 승인 대화상자에서 모달 외부 클릭과 Escape 키가 차단되어 사용자가 반드시 명시적 버튼을 눌러야 합니다.</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              role="checkbox"
              aria-checked={requireExplicit}
              disabled={policyManaged || policyBusy}
              className={`relative h-5 w-5 flex-shrink-0 rounded border-2 transition-colors ${requireExplicit ? "border-primary bg-primary" : "border-muted-foreground"} ${policyManaged ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-primary/60"}`}
              onClick={() => void handleExplicitToggle()}
            >
              {requireExplicit && (
                <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">✓</span>
              )}
            </button>
            <span className="text-sm">{requireExplicit ? "활성화됨" : "비활성화됨"}</span>
            {policyManaged && <span className="text-base" title="IT 관리자 설정">🔒</span>}
          </div>
          {policyManaged && (
            <p className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-600 dark:text-yellow-400">
              {(policySource === "admin" || policySource === "merged") && policyAdminPath
                ? `이 정책은 회사 IT 관리자가 배포했습니다 (경로: ${policyAdminPath}). 사용자가 변경할 수 없습니다.`
                : "이 정책은 IT 관리자가 설정했습니다. 사용자가 변경할 수 없습니다."}
            </p>
          )}
        </div>

        <Separator />

        {/* ── Section C: Rule Editor ── */}
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">도구 규칙</p>
            <p className="text-[11px] text-muted-foreground">특정 도구 패턴에 대해 항상 허용 / 항상 거부를 설정합니다 (와일드카드 지원: <code className="text-[10px]">mcp_*</code>).</p>
          </div>

          {/* 규칙 테이블 */}
          {rules.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">저장된 규칙이 없습니다.</p>
          ) : (
            <div className="rounded-md border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-3 py-2 text-left font-medium">패턴</th>
                    <th className="px-3 py-2 text-left font-medium">동작</th>
                    <th className="px-3 py-2 text-left font-medium">소스</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={`${r.pattern}:${r.action}:${i}`} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-1.5 font-mono">{r.pattern}</td>
                      <td className="px-3 py-1.5">
                        <Badge variant={r.action === "allow" ? "default" : "secondary"} className={`text-[10px] ${r.action === "deny" ? "text-red-400" : ""}`}>
                          {r.action === "allow" ? "허용" : "거부"}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.source ?? "전체"}</td>
                      <td className="px-3 py-1.5 text-right">
                        <button
                          className="text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-40"
                          disabled={rulesBusy}
                          onClick={() => void handleRemoveRule(r.pattern, r.action)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 규칙 추가 */}
          <div className="flex items-center gap-2">
            <Input
              className="h-8 flex-1 text-xs"
              placeholder="패턴 (예: mcp_*, memory_save)"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newPattern.trim()) void handleAddRule(); }}
            />
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={newAction}
              onChange={(e) => setNewAction(e.target.value as "allow" | "deny")}
            >
              <option value="allow">허용</option>
              <option value="deny">거부</option>
            </select>
            <Button size="sm" className="h-8" onClick={() => void handleAddRule()} disabled={rulesBusy || !newPattern.trim()}>
              추가
            </Button>
          </div>
        </div>

        <Separator />

        {/* ── Section D: Audit Log Placeholder ── */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">감사 로그</p>
            <p className="text-[11px] text-muted-foreground">도구 실행 감사 로그 뷰어는 Phase 2 이후 추가됩니다.</p>
          </div>
          <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            곧 추가 예정
          </div>
        </div>

      </div>
    </ScrollArea>
  );
}

// ─── SettingsDialog ─────────────────────────────────

// ─── RolesTab (Sprint B) ────────────────────────────
function RolesTab() {
  const [list, setList] = useState<RolePreset[]>(() => loadRolePresets());
  const [draft, setDraft] = useState<RolePreset>({ id: "", name: "", systemPromptAdd: "", effort: "medium", temperature: 0.5 });
  const [editingId, setEditingId] = useState<string | null>(null);

  const persist = useCallback((next: RolePreset[]) => { setList(next); saveRolePresets(next); }, []);

  const startEdit = (p: RolePreset) => { setEditingId(p.id); setDraft({ ...p }); };
  const cancelEdit = () => { setEditingId(null); setDraft({ id: "", name: "", systemPromptAdd: "", effort: "medium", temperature: 0.5 }); };
  const saveDraft = () => {
    if (!draft.name.trim()) return;
    const id = editingId ?? draft.name.toLowerCase().replace(/\s+/g, "-") + "-" + Math.random().toString(36).slice(2, 6);
    const next = editingId
      ? list.map((p) => p.id === editingId ? { ...draft, id } : p)
      : [...list, { ...draft, id }];
    persist(next);
    cancelEdit();
  };
  const removePreset = (id: string) => {
    const target = list.find((p) => p.id === id);
    if (target?.isDefault) return;
    persist(list.filter((p) => p.id !== id));
  };
  const doReset = () => { setList(resetRolePresets()); cancelEdit(); };

  return (
    <div className="space-y-3 pt-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">프리셋은 전송할 때 시스템 프롬프트 앞에 주입됩니다.</p>
        <Button size="sm" variant="ghost" onClick={doReset}>기본값으로 리셋</Button>
      </div>
      <div className="space-y-2">
        {list.map((p) => (
          <div key={p.id} className="rounded-md border p-2">
            <div className="flex items-center justify-between">
              <div className="font-medium text-sm">{p.name} {p.isDefault ? <Badge variant="secondary" className="ml-1 text-[10px]">기본</Badge> : null}</div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => startEdit(p)}>편집</Button>
                {!p.isDefault && <Button size="sm" variant="ghost" className="h-7 text-[11px] text-destructive" onClick={() => removePreset(p.id)}>삭제</Button>}
              </div>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">effort: {p.effort} · temperature: {p.temperature}</div>
            {p.systemPromptAdd && <div className="mt-1 line-clamp-2 text-xs">{p.systemPromptAdd}</div>}
          </div>
        ))}
      </div>
      <div className="rounded-md border p-3 space-y-2">
        <div className="text-sm font-medium">{editingId ? "프리셋 편집" : "새 프리셋"}</div>
        <Input placeholder="이름" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <Textarea placeholder="systemPromptAdd — 시스템 프롬프트에 주입될 지시사항" value={draft.systemPromptAdd} onChange={(e) => setDraft({ ...draft, systemPromptAdd: e.target.value })} className="min-h-[80px]" />
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1">effort:
            <select className="rounded border bg-background px-1 py-0.5" value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value as any })}>
              <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </select>
          </label>
          <label className="flex items-center gap-1">temperature:
            <Input className="h-7 w-20" type="number" step="0.1" min="0" max="2" value={draft.temperature} onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })} />
          </label>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={saveDraft} disabled={!draft.name.trim()}>{editingId ? "업데이트" : "추가"}</Button>
          {editingId && <Button size="sm" variant="ghost" onClick={cancelEdit}>취소</Button>}
        </div>
      </div>
    </div>
  );
}

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
      setAutoCompact(s.chat.autoCompact ?? true);
      const apiKeySet = await api.hasApiKey(s.llm.provider);
      if (cancelled) return;
      setHasKey(apiKeySet);

      setWebProvider(s.webSearch.provider);
      const webApiKeySet = await api.hasWebApiKey(s.webSearch.provider);
      if (cancelled) return;
      setHasWebKey(webApiKeySet);
      setEnableDailyBriefing(s.proactive?.enableDailyBriefing ?? false);
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
          } as any,
          webSearch: { provider: webProvider as any },
          chat: { autoCompact },
          proactive: { enableDailyBriefing } as any,
        } as any);
      }
      // permissions 탭: 각 항목이 즉시 저장되므로 별도 save 불필요
      if (tab !== "permissions") { onSaved(); onOpenChange(false); }
      else { onOpenChange(false); }
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>설정</DialogTitle><DialogDescription>앱 환경, 채팅 동작, 검색 엔진, 권한 정책을 설정합니다.</DialogDescription></DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="llm" className="flex-1">지능 (LLM)</TabsTrigger>
            <TabsTrigger value="chat" className="flex-1">채팅</TabsTrigger>
            <TabsTrigger value="web" className="flex-1">검색 (Web)</TabsTrigger>
            <TabsTrigger value="proactive" className="flex-1">브리핑</TabsTrigger>
            <TabsTrigger value="permissions" className="flex-1">권한</TabsTrigger>
            <TabsTrigger value="roles" className="flex-1">역할</TabsTrigger>
            <TabsTrigger value="usage" className="flex-1">사용량</TabsTrigger>
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
                    이 설정은 Vercel SDK 경로 사용 시 프록시/커스텀 엔드포인트로만 사용됩니다.
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

// ─── ToolApprovalDialog ─────────────────────────────

const SOURCE_BADGE: Record<string, string> = {
  builtin: "내장",
  plugin: "플러그인",
  mcp: "MCP",
};

function ToolApprovalDialog({
  open,
  request,
  pendingCount = 1,
  onDecide,
}: {
  open: boolean;
  request: ApprovalRequest | null;
  pendingCount?: number;
  onDecide: (choice: ApprovalChoice, pattern?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // 키보드 단축키
  useEffect(() => {
    if (!open || !request) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onDecide("allow-once");
      } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onDecide("deny-once");
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onDecide("allow-once");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, request, onDecide]);

  if (!request) return null;

  const title = "도구 승인 필요";
  const argsStr = JSON.stringify(request.args, null, 2) ?? "";
  const argsTruncated = argsStr.length > 500 && !expanded;
  const argsDisplay = argsTruncated ? argsStr.slice(0, 500) + "\n…" : argsStr;
  const sourceBadge = request.source ? SOURCE_BADGE[request.source] ?? request.source : "알 수 없음";

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="max-w-lg"
        onInteractOutside={(e) => {
          if (request.requireExplicit) {
            e.preventDefault();
          } else {
            void onDecide("deny-once");
          }
        }}
        onEscapeKeyDown={(e) => {
          if (request.requireExplicit) {
            e.preventDefault();
          } else {
            void onDecide("deny-once");
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {title}
            {pendingCount > 1 && (
              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                대기 중 {pendingCount - 1}개
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            AI 에이전트가 아래 도구를 실행하려 합니다. 허용하시겠습니까?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* 도구 이름 + 소스 배지 */}
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 text-sm font-mono">
              {request.toolName}
            </code>
            <Badge variant="outline" className="text-[11px]">{sourceBadge}</Badge>
          </div>

          {/* 사유 */}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">승인 사유</p>
            <p className="text-sm">{request.reason}</p>
          </div>

          {/* 인자 미리보기 */}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">인자</p>
            <pre className="max-h-40 overflow-auto rounded border bg-muted/50 p-2 text-[11px]">
              {argsDisplay}
            </pre>
            {argsStr.length > 500 && (
              <button
                className="mt-1 text-[11px] text-primary underline"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "접기" : "모두 보기"}
              </button>
            )}
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            size="sm"
            variant="default"
            onClick={() => onDecide("allow-once")}
            title="단축키: A 또는 Enter"
          >
            한 번만 허용
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDecide("allow-always", request.toolName)}
          >
            항상 허용
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onDecide("deny-once")}
            title="단축키: D"
          >
            거부
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onDecide("deny-always", request.toolName)}
          >
            항상 거부
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ────────────────────────────────────────

function getApi(): LvisApi { if (!window.lvisApi) throw new Error("lvisApi not initialized"); return window.lvisApi; }
function toViewKey(item: PluginUiExtension) { return `plugin:${item.pluginId}:${item.extension.id}`; }
function getPluginViewLabel(item: PluginUiExtension) { return item.extension.displayName?.trim() || item.extension.title || item.pluginId; }

function ToolGroupCard({ group }: { group: Extract<ChatEntry, { kind: "tool_group" }> }) {
  const [open, setOpen] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const doneCount = group.tools.filter((t) => t.status !== "running").length;
  const hasError = group.tools.some((t) => t.status === "error");
  const groupStatus = group.status === "running"
    ? "running"
    : hasError ? "error" : "done";
  const groupTitle = groupStatus === "running" ? "도구 사용 중" : "도구 사용 결과";

  function toggleTool(id: string) {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const tools = [...group.tools].sort((a, b) => a.displayOrder - b.displayOrder);

  return (
    <div className="mx-4 rounded border border-dashed text-xs text-muted-foreground">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-muted/30"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <Wrench className="h-3 w-3 flex-shrink-0" />
        <span className="font-medium">{groupTitle}</span>
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          {groupStatus === "running" ? `${doneCount}/${group.tools.length}` : `${group.tools.length}개`}
        </Badge>
        {groupStatus === "running" ? (
          <Loader2 className="ml-auto h-3 w-3 animate-spin" />
        ) : (
          <Badge
            variant={groupStatus === "error" ? "secondary" : "default"}
            className={`ml-auto px-1 py-0 text-[10px] ${groupStatus === "error" ? "text-red-400" : ""}`}
          >
            {groupStatus === "error" ? "오류 있음" : "완료"}
          </Badge>
        )}
      </button>
      {open && (
        <div className="space-y-1 border-t px-3 py-1.5">
          {tools.map((tool) => {
            const isExpanded = expandedTools.has(tool.toolUseId);
            return (
              <div key={tool.toolUseId} className="rounded border border-dashed/50">
                <button
                  className="flex w-full items-center gap-2 px-2 py-1 hover:bg-muted/20"
                  onClick={() => toggleTool(tool.toolUseId)}
                >
                  {isExpanded ? <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" /> : <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" />}
                  <span className="font-mono">{tool.name}</span>
                  {tool.status === "running" ? (
                    <Loader2 className="ml-auto h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <Badge
                      variant={tool.status === "error" ? "secondary" : "default"}
                      className={`ml-auto px-1 py-0 text-[10px] ${tool.status === "error" ? "text-red-400" : ""}`}
                    >
                      {tool.status === "error" ? "실패" : "완료"}
                    </Badge>
                  )}
                </button>
                {isExpanded && (
                  <div className="space-y-1 border-t px-2 py-1 font-mono text-[10px]">
                    {tool.input && (
                      <div>
                        <div className="mb-0.5 text-[9px] uppercase opacity-60">입력</div>
                        <pre className="whitespace-pre-wrap break-all opacity-80">{JSON.stringify(tool.input, null, 2)}</pre>
                      </div>
                    )}
                    {tool.result !== undefined && (
                      <div>
                        <div className={`mb-0.5 text-[9px] uppercase opacity-60 ${tool.status === "error" ? "text-red-400" : ""}`}>
                          {tool.status === "error" ? "오류" : "결과"}
                        </div>
                        <pre className={`whitespace-pre-wrap break-all opacity-80 ${tool.status === "error" ? "text-red-400" : ""}`}>{tool.result}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReasoningCard({ entry }: { entry: Extract<ChatEntry, { kind: "reasoning" }> }) {
  const title = entry.streaming ? "생각 정리 중" : "생각 정리";

  return (
    <div className="max-w-[85%] rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        {title}
        {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      </div>
      <div className="whitespace-pre-wrap text-[12px] italic leading-5">
        {entry.text || (entry.streaming ? "생각을 정리하는 중..." : "")}
      </div>
    </div>
  );
}

function AssistantCard({
  entry,
  highlightQuery,
  actions,
  isStarred,
}: {
  entry: Extract<ChatEntry, { kind: "assistant" }>;
  highlightQuery?: string;
  actions?: { onRetry?: () => void; onFork?: () => void; onToggleStar?: () => void };
  isStarred?: boolean;
}) {
  const title = entry.streaming ? "LVIS 응답 작성 중" : "LVIS 응답";
  const highlighted = highlightText(entry.text, highlightQuery);
  // Sprint 4.B: rough token estimate for tooltip (~4 chars/token)
  const outputTokens = Math.ceil(entry.text.length / 4);
  return (
    <div className="group relative max-w-[85%] rounded-md border bg-card px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        {title}
        {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {isStarred ? <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" /> : null}
        {!entry.streaming && outputTokens > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-auto cursor-default rounded bg-muted/60 px-1 text-[10px] text-muted-foreground">
                ~{outputTokens >= 1000 ? `${(outputTokens / 1000).toFixed(1)}k` : outputTokens} tok
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <div>출력 토큰(추정): {outputTokens.toLocaleString()}</div>
              <div className="text-muted-foreground">실제값은 감사 로그에서 확인 가능</div>
            </TooltipContent>
          </Tooltip>
        )}
        {actions && !entry.streaming ? (
          <div className="hidden gap-1 group-hover:flex">
            {actions.onRetry && (
              <Tooltip><TooltipTrigger asChild>
                <button className="rounded p-0.5 hover:bg-muted" onClick={actions.onRetry} title="다시 시도 (깊이: high)">
                  <RefreshCw className="h-3 w-3" />
                </button>
              </TooltipTrigger><TooltipContent>다시 시도 (깊이: high)</TooltipContent></Tooltip>
            )}
            {actions.onFork && (
              <button className="rounded p-0.5 hover:bg-muted" onClick={actions.onFork} title="분기"><GitBranch className="h-3 w-3" /></button>
            )}
            {actions.onToggleStar && (
              <button className="rounded p-0.5 hover:bg-muted" onClick={actions.onToggleStar} title="즐겨찾기">
                <Star className={`h-3 w-3 ${isStarred ? "fill-yellow-400 text-yellow-400" : ""}`} />
              </button>
            )}
          </div>
        ) : null}
      </div>

      <div className="prose prose-sm prose-invert max-w-none break-words">
        {highlightQuery && highlighted ? (
          <div className="whitespace-pre-wrap">{highlighted}</div>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {entry.text || (entry.streaming ? "응답을 작성하는 중..." : "")}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}

// ─── Sprint 4.C helpers ─────────────────────────────

function highlightText(text: string, query?: string): React.ReactNode {
  if (!query || !text) return null;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const found = lower.indexOf(q, i);
    if (found < 0) { parts.push(text.slice(i)); break; }
    if (found > i) parts.push(text.slice(i, found));
    parts.push(<mark key={found} className="bg-yellow-300/60 text-foreground">{text.slice(found, found + query.length)}</mark>);
    i = found + query.length;
  }
  return <>{parts}</>;
}

/**
 * Sprint 4.C: Inline editor for resending a user message. Renders as a
 * compact Textarea over the original bubble with Save/Cancel controls.
 */
function UserMessageEditor({
  initialText,
  onCancel,
  onSave,
  busy,
}: {
  initialText: string;
  onCancel: () => void;
  onSave: (next: string) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(initialText);
  return (
    <div className="ml-auto w-full max-w-[85%] rounded-md border bg-primary/5 p-2 text-sm">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-[60px] text-sm"
        autoFocus
      />
      <div className="mt-1 flex justify-end gap-1">
        <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onCancel} disabled={busy}>취소</Button>
        <Button size="sm" className="h-6 text-xs" onClick={() => onSave(draft)} disabled={busy || !draft.trim()}>저장 후 재전송</Button>
      </div>
    </div>
  );
}

/**
 * Sprint 4.C: Ctrl/Cmd+F overlay for in-conversation search. Scans
 * user + assistant entries. Parent owns the query state so message
 * rendering can re-highlight matches.
 */
function ChatSearchOverlay({
  open,
  query,
  caseSensitive,
  matchCount,
  currentIdx,
  onChangeQuery,
  onToggleCase,
  onNext,
  onPrev,
  onClose,
}: {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  matchCount: number;
  currentIdx: number;
  onChangeQuery: (v: string) => void;
  onToggleCase: () => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="absolute right-4 top-2 z-20 flex items-center gap-2 rounded-md border bg-card px-2 py-1 shadow-md">
      <Search className="h-3.5 w-3.5 text-muted-foreground" />
      <Input
        autoFocus
        value={query}
        onChange={(e) => onChangeQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) onPrev(); else onNext(); }
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}
        placeholder="대화 검색..."
        className="h-7 w-48 text-xs"
      />
      <span className="text-[10px] text-muted-foreground tabular-nums">{matchCount === 0 ? "0/0" : `${currentIdx + 1}/${matchCount}`}</span>
      <button
        className={`rounded px-1 text-[10px] ${caseSensitive ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
        onClick={onToggleCase}
        title="대소문자 구분"
      >Aa</button>
      <button className="rounded p-0.5 hover:bg-muted" onClick={onPrev} title="이전"><ChevronRight className="h-3 w-3 rotate-180" /></button>
      <button className="rounded p-0.5 hover:bg-muted" onClick={onNext} title="다음"><ChevronRight className="h-3 w-3" /></button>
      <button className="rounded p-0.5 hover:bg-muted" onClick={onClose} title="닫기"><XIcon className="h-3 w-3" /></button>
    </div>
  );
}

// ─── Usage Dashboard (Sprint 4.B) ──────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
function formatCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function Sparkline({ points, width = 260, height = 48 }: { points: number[]; width?: number; height?: number }) {
  if (points.length === 0) return <div className="text-xs text-muted-foreground">데이터 없음</div>;
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const path = points
    .map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(height - (v / max) * (height - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} className="block">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-primary" />
    </svg>
  );
}

function UsageDashboard({ api }: { api: LvisApi }) {
  const [summary, setSummary] = useState<UsageSummaryShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<7 | 30>(7);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getUsageSummary(60).then((s) => { if (active) { setSummary(s); setLoading(false); } }).catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);

  if (loading) return <div className="py-6 text-center text-sm text-muted-foreground">로딩 중...</div>;
  if (!summary) return <div className="py-6 text-center text-sm text-muted-foreground">사용량 데이터를 불러올 수 없습니다.</div>;

  const trendSlice = summary.trend.slice(-range);
  const sparkPoints = trendSlice.map((p) => p.totalTokens);

  return (
    <div className="space-y-4 pt-4">
      <div className="grid grid-cols-3 gap-2">
        {([
          { label: "오늘", v: summary.today },
          { label: "이번 주", v: summary.thisWeek },
          { label: "이번 달", v: summary.thisMonth },
        ] as const).map(({ label, v }) => (
          <Card key={label}>
            <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">{label}</CardTitle></CardHeader>
            <CardContent className="space-y-0.5 px-3 pb-3">
              <div className="text-lg font-semibold">{formatTokens(v.totalTokens)}</div>
              <div className="text-xs text-muted-foreground">in {formatTokens(v.inputTokens)} / out {formatTokens(v.outputTokens)}</div>
              <div className="text-xs font-medium">{formatCost(v.cost)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3 flex-row items-center justify-between">
          <CardTitle className="text-xs text-muted-foreground">토큰 추이</CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant={range === 7 ? "default" : "outline"} onClick={() => setRange(7)} className="h-6 px-2 text-[11px]">7d</Button>
            <Button size="sm" variant={range === 30 ? "default" : "outline"} onClick={() => setRange(30)} className="h-6 px-2 text-[11px]">30d</Button>
          </div>
        </CardHeader>
        <CardContent className="px-3 pb-3"><Sparkline points={sparkPoints} /></CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">벤더별 사용량</CardTitle></CardHeader>
        <CardContent className="px-3 pb-3">
          {summary.perVendor.length === 0 ? <div className="text-xs text-muted-foreground">데이터 없음</div> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1">벤더</th><th>토큰</th><th>비용</th></tr></thead>
              <tbody>
                {summary.perVendor.map((v) => (
                  <tr key={v.vendor} className="border-t"><td className="py-1 font-mono">{v.vendor}</td><td>{formatTokens(v.totalTokens)}</td><td>{formatCost(v.cost)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">비용 상위 대화 5</CardTitle></CardHeader>
        <CardContent className="px-3 pb-3">
          {summary.topConversations.length === 0 ? <div className="text-xs text-muted-foreground">데이터 없음</div> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1">세션</th><th>턴</th><th>토큰</th><th>비용</th></tr></thead>
              <tbody>
                {summary.topConversations.map((c) => (
                  <tr key={c.sessionId} className="border-t">
                    <td className="py-1 max-w-[120px] truncate font-mono" title={c.firstInput ?? c.sessionId}>{c.sessionId.slice(0, 12)}</td>
                    <td>{c.turns}</td><td>{formatTokens(c.totalTokens)}</td><td>{formatCost(c.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── App ────────────────────────────────────────────

function App() {
  const api = useMemo(() => getApi(), []);

  // Chat state
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const streamRef = useRef("");
  const thoughtRef = useRef("");
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
  useEffect(() => { setRolePresets(loadRolePresets()); }, []);
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

  // Sprint 4.C — conversation UX state
  const [editingEntryIdx, setEditingEntryIdx] = useState<number | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCase, setSearchCase] = useState(false);
  const [searchIdx, setSearchIdx] = useState(0);
  const [starred, setStarred] = useState<Array<{ id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string }>>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>("");

  const refreshStarred = useCallback(async () => {
    try { const list = await api.starredList(); setStarred(list); } catch { /* ignore */ }
  }, [api]);
  const refreshSessionId = useCallback(async () => {
    try { const h = await api.chatGetHistory(); setCurrentSessionId(h.sessionId); } catch { /* ignore */ }
  }, [api]);

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

  // ─── Edit & resend ─────────────────────────────
  const handleEditSave = useCallback(async (entryIdx: number, newText: string) => {
    const histIdx = entryIndexToHistoryIndex.get(entryIdx);
    if (histIdx === undefined) return;
    setEditBusy(true);
    const prevEntries = entries;
    let failed = false;
    try {
      // Truncate renderer entries up to (but not including) the edited user
      // bubble; the streaming response will repopulate from there.
      setEntries((p) => [...p.slice(0, entryIdx), { kind: "user", text: newText }]);
      streamRef.current = "";
      thoughtRef.current = "";
      setStreaming(true);
      const res = await api.chatEditResend(histIdx, newText);
      if (!res?.ok) {
        failed = true;
        // Restore the prior entries so the user doesn't lose context, and
        // surface the failure via the existing assistant-error channel.
        setEntries(setAssistantError(prevEntries, `편집 실패: ${res?.error ?? "알 수 없는 오류"}`, thoughtRef.current));
      }
    } catch (err) {
      failed = true;
      setEntries((p) => setAssistantError(p, `오류: ${(err as Error).message}`, thoughtRef.current));
    } finally {
      setEditBusy(false);
      setStreaming(false);
      // Only exit editing mode on success; on failure keep the editor open
      // so the user can retry without losing their draft.
      if (!failed) setEditingEntryIdx(null);
    }
  }, [api, entries, entryIndexToHistoryIndex]);

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

  // ─── Retry with deeper thinking ────────────────
  const handleRetryEffort = useCallback(async () => {
    const prevEntries = entries;
    // Strip the last assistant+reasoning so streaming replaces them cleanly.
    setEntries((p) => {
      const next = [...p];
      while (next.length > 0 && (next[next.length - 1].kind === "assistant" || next[next.length - 1].kind === "reasoning" || next[next.length - 1].kind === "tool_group")) {
        next.pop();
      }
      return next;
    });
    streamRef.current = "";
    thoughtRef.current = "";
    setStreaming(true);
    try {
      const res = await api.chatRetryEffort({ enableThinking: true, thinkingBudgetTokens: 20000 });
      if (!res?.ok) {
        // Restore the prior entries + surface failure via existing status.
        setEntries(setAssistantError(prevEntries, `재시도 실패: ${res?.error ?? "알 수 없는 오류"}`, thoughtRef.current));
      }
    } catch (err) {
      setEntries((p) => setAssistantError(p, `오류: ${(err as Error).message}`, thoughtRef.current));
    } finally {
      setStreaming(false);
    }
  }, [api, entries]);

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

  // Sprint 4.B — context overflow tracking
  const [currentLlmSettings, setCurrentLlmSettings] = useState<{ provider: string; model: string } | null>(null);

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

  // Cached LLM settings for chat input bar (vendor + thinking toggle + context budget).
  const [llmVendor, setLlmVendor] = useState<string>("claude");
  const [llmModel, setLlmModel] = useState<string>("");
  const [enableThinkingChat, setEnableThinkingChat] = useState<boolean>(true);
  const refreshLlmSettings = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setLlmVendor(s.llm.provider);
      setLlmModel(s.llm.model);
      setEnableThinkingChat(s.llm.enableThinking ?? false);
    } catch { /* ignore */ }
  }, [api]);
  useEffect(() => { void refreshLlmSettings(); }, [refreshLlmSettings]);

  // Rough per-model context budget (input+output tokens) used to show % filled.
  // NOTE: 1M context for Claude Sonnet 4.6 is a beta feature gated on a specific
  // API beta header — currently we assume the default 200k for all Claude models;
  // 1M beta detection is tracked as a followup.
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
  const vendorSupportsThinking = useMemo(() => {
    if (llmVendor === "claude") return true;
    if (llmVendor === "gemini") return true;
    if (llmVendor === "vertex-ai") return true;
    if (llmVendor === "openai" || llmVendor === "copilot" || llmVendor === "azure-foundry") {
      const m = (llmModel || "").toLowerCase();
      return m.includes("gpt-5") || m.includes("o1") || m.includes("o3") || m.includes("o4");
    }
    return false;
  }, [llmVendor, llmModel]);
  const toggleThinking = useCallback(async (next: boolean) => {
    setEnableThinkingChat(next);
    try { await api.updateSettings({ llm: { enableThinking: next } } as any); } catch { /* ignore */ }
  }, [api]);

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
      const tries = ["page_index_list_documents", "pageindex_list_documents", "com.lge.pageindex.listDocuments"];
      let result: unknown = null;
      for (const m of tries) {
        try { result = await api.callPluginMethod(m, {}); if (result) break; } catch { /* try next */ }
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
  const costEstimate = useMemo(() => {
    const pricing = rendererPricing(llmVendor, llmModel);
    const historySerialized = entries.map((e) => {
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
    const draft = question ? composeOutgoing(question) : "";
    return estimateTurnCost({ historySerialized, draft, maxOutputTokens, pricing });
  }, [entries, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing]);
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

    // Sprint 4.B: load LLM settings for context overflow calculation
    api.getSettings().then((s) => {
      if (isMountedRef.current) setCurrentLlmSettings({ provider: s.llm.provider, model: s.llm.model });
    }).catch(() => {});

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
      } else if (ev.type === "compact_notice") {
        const n = ev.removedMessages ?? 0;
        setEntries((p) => [...p, { kind: "system", text: `💾 이전 ${n}개 대화를 요약했습니다 (목표·결정사항 보존)` }]);
      } else if (ev.type === "done") {
        if (streamRef.current || thoughtRef.current) {
          setEntries((p) => {
            let next = finalizeStreamingReasoning(p, thoughtRef.current);
            next = finalizeStreamingAssistant(next, streamRef.current);
            return next;
          });
          streamRef.current = "";
          thoughtRef.current = "";
        }
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
                                // Jump to that message in context — load the session,
                                // then switch to home so it's visible.
                                if (s.sessionId !== currentSessionId) {
                                  // no public IPC for load-session yet beyond the existing
                                  // lvis:chat:load-session — leave as future enhancement.
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
                    onDismiss={() => {
                      // PR#44 Copilot: await IPC result; hide only on ok:true.
                      // debounced/error keeps card visible so user can retry.
                      void api.dismissBriefing().then((r) => {
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
const root = document.getElementById("root");
if (!root) throw new Error("root not found");
createRoot(root).render(<App />);
