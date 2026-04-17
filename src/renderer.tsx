import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Search, MoreHorizontal, Command as CommandIcon, KeyRound, Plus, Loader2, Wrench, PanelsTopLeft, ChevronDown, ChevronRight } from "lucide-react";
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
type AppSettings = { llm: { provider: string; model: string }; chat: { systemPrompt: string; autoCompact: boolean }; webSearch: { provider: string } };

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
  onViewActivate: (h: (k: string) => void) => () => void;
};

// ─── Approval types (mirrored from approval-gate.ts — no node import in renderer) ─

type ApprovalChoice = "allow-once" | "allow-always" | "deny-once" | "deny-always";
type ApprovalRequest = {
  id: string;
  category: "tool" | "agent-action";
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
  { id: "claude", label: "Anthropic Claude", placeholder: "sk-ant-...", defaultModel: "claude-sonnet-4-20250514" },
  { id: "openai", label: "OpenAI", placeholder: "sk-...", defaultModel: "gpt-4o" },
  { id: "gemini", label: "Google Gemini", placeholder: "AIza...", defaultModel: "gemini-2.0-flash" },
  { id: "copilot", label: "GitHub Copilot", placeholder: "ghp_...", defaultModel: "gpt-4o" },
] as const;

const WEB_PROVIDERS = [
  { id: "duckduckgo", label: "DuckDuckGo", placeholder: "키 불필요", needsKey: false },
  { id: "tavily", label: "Tavily AI", placeholder: "tvly-...", needsKey: true },
  { id: "serper", label: "Serper.dev", placeholder: "키 입력...", needsKey: true },
  { id: "google", label: "Google Search", placeholder: "API Key...", needsKey: true },
] as const;

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
        await api.updateSettings({
          llm: {
            provider: vendor as any,
            model: model.trim() || vendorInfo.defaultModel,
            enableThinking,
            thinkingBudgetTokens: thinkingBudget,
          },
          webSearch: { provider: webProvider as any },
          chat: { autoCompact },
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
            <TabsTrigger value="permissions" className="flex-1">권한</TabsTrigger>
          </TabsList>

          <TabsContent value="llm" className="space-y-4 pt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">벤더</label>
              <div className="grid grid-cols-2 gap-2">
                {VENDORS.map((v) => (
                  <Button key={v.id} size="sm" variant={vendor === v.id ? "default" : "outline"} className="justify-start text-xs" onClick={() => setVendor(v.id)}>
                    {v.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{vendorInfo.label} API 키</label>
              <div className="flex items-center gap-2">
                {hasKey ? <Badge variant="default" className="text-xs">설정됨</Badge> : <Badge variant="secondary" className="text-xs">미설정</Badge>}
                {hasKey && <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => void api.deleteApiKey(vendor).then(() => { setHasKey(false); onSaved(); })}>삭제</Button>}
              </div>
              <Input type="password" placeholder={hasKey ? "새 키로 교체" : vendorInfo.placeholder} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
            </div>
            <div className="space-y-2"><label className="text-sm font-medium">모델</label><Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={vendorInfo.defaultModel} /></div>
            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-center justify-between text-sm font-medium">
                <span>Extended Thinking / Reasoning</span>
                <input type="checkbox" className="h-4 w-4" checked={enableThinking} onChange={(e) => setEnableThinking(e.target.checked)} />
              </label>
              <p className="text-[11px] text-muted-foreground">모델 내부 추론 과정을 스트리밍으로 표시합니다. Claude는 명시 활성화(Sonnet 4.5+/Opus 4+), OpenAI o-계열(o1/o3/reasoning)은 자동, Gemini 2.0+는 모델 지원 시 자동.</p>
              {enableThinking && vendor === "claude" && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Thinking Budget (tokens) — Claude 전용</label>
                  <Input
                    type="number"
                    min={1024}
                    max={32000}
                    step={1000}
                    value={thinkingBudget}
                    onChange={(e) => setThinkingBudget(Math.max(1024, Math.min(32000, Number(e.target.value) || 10_000)))}
                  />
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

          <TabsContent value="permissions">
            <PermissionsTab />
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>닫기</Button>
          {tab !== "permissions" && (
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

  const title =
    request.category === "agent-action" ? "작업 승인 필요" : "도구 승인 필요";
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

function AssistantCard({ entry }: { entry: Extract<ChatEntry, { kind: "assistant" }> }) {
  const title = entry.streaming ? "LVIS 응답 작성 중" : "LVIS 응답";

  return (
    <div className="max-w-[85%] rounded-md border bg-card px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        {title}
        {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      </div>

      <div className="prose prose-sm prose-invert max-w-none break-words">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {entry.text || (entry.streaming ? "응답을 작성하는 중..." : "")}
        </ReactMarkdown>
      </div>
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
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([]);
  const approvalQueueRef = useRef<ApprovalRequest[]>([]);
  useEffect(() => { approvalQueueRef.current = approvalQueue; }, [approvalQueue]);

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);
  const checkApiKey = useCallback(async () => { const h = await api.hasApiKey(); setHasApiKey(h); return h; }, [api]);

  // ─── Chat ─────────────────────────────────────
  const handleAsk = useCallback(async (q: string) => {
    const t = q.trim(); if (!t || streaming) return;
    if (!(await checkApiKey())) { setSettingsOpen(true); return; }
    setQuestion("");
    // User entry
    setEntries((p) => appendUserEntry(p, t));
    streamRef.current = "";
    thoughtRef.current = "";
    setStreaming(true);
    try {
      await api.chatSend(t);
      // Final state set by stream events + done
    } catch (err) {
      setEntries((p) => setAssistantError(p, `오류: ${(err as Error).message}`, thoughtRef.current));
      streamRef.current = "";
      thoughtRef.current = "";
    } finally { setStreaming(false); }
  }, [api, streaming, checkApiKey]);

  const handleNewChat = useCallback(async () => { await api.chatNew(); setEntries([]); }, [api]);

  // ─── Plugin actions ───────────────────────────
  const refreshViews = async () => { const v = (await api.listPluginUiExtensions()).filter((i) => i.extension.slot === "sidebar"); setPluginViews(v); return v; };
  const refreshMarketplace = async () => { try { setMarketStatus("로딩 중..."); const l = await api.listMarketplacePlugins(); setMarketplace(l); setMarketStatus(`플러그인 ${l.length}개`); } catch (e) { setMarketStatus(`실패: ${(e as Error).message}`); } };
  const installPlugin = async (id: string) => { setWorking(true); try { await api.installMarketplacePlugin(id); await refreshMarketplace(); await refreshViews(); } finally { setWorking(false); } };
  const uninstallPlugin = async (id: string) => { setWorking(true); try { await api.uninstallMarketplacePlugin(id); await refreshMarketplace(); await refreshViews(); } finally { setWorking(false); } };

  // ─── Effects ──────────────────────────────────
  useEffect(() => {
    void refreshMarketplace(); void refreshViews(); void checkApiKey();

    // 앱 시작 시 데일리 브리핑을 채팅 메시지로 전달
    api.getBriefing().then((text) => {
      if (text) setEntries([{ kind: "assistant", text }]);
    }).catch(() => {});
    const dv = api.onViewActivate((k) => setActiveView(k));
    const ds = api.onChatStream((ev) => {
      console.log("[lvis:chat:stream]", ev);
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
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCommandOpen(true); } };
    window.addEventListener("keydown", onKey);
    return () => { dv(); ds(); window.removeEventListener("keydown", onKey); };
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
                {pluginViews.map((i) => <TabsTrigger key={toViewKey(i)} value={toViewKey(i)}>{getPluginViewLabel(i)}</TabsTrigger>)}
              </TabsList></Tabs>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void handleNewChat()}><Plus className="mr-1 h-4 w-4" />새 대화</Button>
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
          {activeView === "tasks" ? <TaskView api={api} /> : activeView === "home" ? (
            <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto]">
              {hasApiKey === false && (
                <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
                  <Card className="w-[400px]"><CardHeader className="text-center"><KeyRound className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><CardTitle>API 키 설정 필요</CardTitle><CardDescription>채팅을 시작하려면 Claude API 키를 설정해 주세요.</CardDescription></CardHeader>
                    <CardContent className="flex justify-center"><Button onClick={() => setSettingsOpen(true)}><KeyRound className="mr-2 h-4 w-4" />설정 열기</Button></CardContent>
                  </Card>
                </div>
              )}
              <ScrollArea className="h-full p-4"><div className="space-y-3">
                {entries.length === 0 && hasApiKey !== false && <div className="py-12 text-center text-sm text-muted-foreground">LVIS 에이전트가 준비되었습니다. 질문을 입력하거나 /command를 사용하세요.</div>}
                {entries.map((entry, idx) => {
                  if (entry.kind === "user") return <div key={idx} className="ml-auto max-w-[85%] rounded-md border bg-primary px-3 py-2 text-sm text-primary-foreground"><div className="mb-1 text-[11px] text-muted-foreground">나</div><div className="whitespace-pre-wrap">{entry.text}</div></div>;
                  if (entry.kind === "reasoning") return <ReasoningCard key={idx} entry={entry} />;
                  if (entry.kind === "tool_group") return <ToolGroupCard key={entry.groupId} group={entry} />;
                  return <AssistantCard key={idx} entry={entry} />;
                })}
                <div ref={chatEndRef} />
              </div></ScrollArea>
              <div className="grid grid-cols-[1fr_auto] gap-2 border-t bg-card p-3">
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
                <Button onClick={() => void handleAsk(question)} disabled={streaming || !question.trim()}>{streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : "전송"}</Button>
              </div>
            </div>
          ) : (
            <PluginUiHostView view={activePluginView ?? null} callPluginMethod={(m, p) => api.callPluginMethod(m, p)} onAskInHomeChat={async (q) => { setActiveView("home"); await handleAsk(q); }} onAddTask={(t) => api.addTask(t)} />
          )}
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} api={api} onSaved={() => void checkApiKey()} />
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
