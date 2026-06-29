import {
  Activity,
  Bot,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileDiff,
  Globe2,
  Gauge,
  Layers3,
  ListChecks,
  MessageSquare,
  MonitorPlay,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { PersistentItem, ToastItem } from "../hooks/use-status-bar.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import type { PluginEntry } from "./PluginGridButton.js";
import type { QuickAction } from "./CommandPopover.js";
import type { SkillBadgeProps } from "./SkillBadge.js";
import type { SubAgentSpawn } from "./SubAgentCard.js";

type ActionPanelTab = "work" | "tools" | "status";

export interface ActionPanelContextState {
  usedTokens: number;
  effectiveBudget: number;
  contextOverflowPct: number;
  tpmPct: number;
  isTpmOverflow: boolean;
  llmVendor: string;
  llmModel: string;
}

export interface ActionPanelExecutionState {
  approvalCount: number;
  permissionReviewCount: number;
  runningToolCount: number;
  failedToolCount: number;
  toolCallCount: number;
  fileChangeCount: number;
  terminalToolCount: number;
  browserToolCount: number;
  pluginUiResultCount: number;
  checkpointCount: number;
}

export interface ActionPanelProps {
  actions: QuickAction[];
  activeView: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSessionId: string;
  currentSessionKind: "main" | "routine";
  currentSessionTitle?: string;
  sessions: SessionSummary[];
  onOpenSession: (sessionId: string) => void | boolean | Promise<void | boolean>;
  streaming: boolean;
  askQuestionCount: number;
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  subAgentSpawns: SubAgentSpawn[];
  loadedSkills: SkillBadgeProps[];
  statusItems: PersistentItem[];
  visibleToast: ToastItem | null;
  pendingToastCount: number;
  context: ActionPanelContextState;
  execution: ActionPanelExecutionState;
  onOpenDeferredQueue: () => void;
}

const TAB_ORDER: ActionPanelTab[] = ["work", "tools", "status"];

function percent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function shortId(value: string): string {
  if (!value) return "-";
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(severity: PersistentItem["severity"] | ToastItem["severity"]): string {
  switch (severity) {
    case "success":
      return "border-success/(--opacity-medium) bg-success/(--opacity-faint) text-success";
    case "warning":
      return "border-warning/(--opacity-medium) bg-warning/(--opacity-faint) text-warning";
    case "error":
      return "border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint) text-destructive";
    default:
      return "border-info/(--opacity-medium) bg-info/(--opacity-faint) text-info";
  }
}

function TabIcon({ tab }: { tab: ActionPanelTab }) {
  if (tab === "tools") return <Boxes className="h-3.5 w-3.5" aria-hidden="true" />;
  if (tab === "status") return <Gauge className="h-3.5 w-3.5" aria-hidden="true" />;
  return <Layers3 className="h-3.5 w-3.5" aria-hidden="true" />;
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 border-b border-border px-3 py-3 last:border-b-0">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <h3 className="truncate text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">
          {title}
        </h3>
        {typeof count === "number" && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

export function ActionPanel({
  actions,
  activeView,
  open,
  onOpenChange,
  currentSessionId,
  currentSessionKind,
  currentSessionTitle,
  sessions,
  onOpenSession,
  streaming,
  askQuestionCount,
  plugins,
  onSelectPlugin,
  subAgentSpawns,
  loadedSkills,
  statusItems,
  visibleToast,
  pendingToastCount,
  context,
  execution,
  onOpenDeferredQueue,
}: ActionPanelProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ActionPanelTab>("work");

  const runningSubagents = useMemo(
    () => subAgentSpawns.filter((spawn) => spawn.status === "running").length,
    [subAgentSpawns],
  );
  const recentSessions = useMemo(
    () => sessions.filter((session) => session.id !== currentSessionId).slice(0, 5),
    [currentSessionId, sessions],
  );
  const contextPct = percent(context.contextOverflowPct);
  const tpmPct = percent(context.tpmPct);
  const attentionCount =
    askQuestionCount + execution.approvalCount + execution.failedToolCount + pendingToastCount;

  const runAction = useCallback((action: QuickAction) => {
    void Promise.resolve(action.run()).catch((err) => {
      console.error("[action-panel] action failed", err);
    });
  }, []);

  const openSession = useCallback((sessionId: string) => {
    void Promise.resolve(onOpenSession(sessionId)).catch((err) => {
      console.error("[action-panel] open session failed", err);
    });
  }, [onOpenSession]);

  const openWorkBoard = useCallback(() => {
    const action = actions.find((candidate) => candidate.id === "work-board") ?? actions[0];
    if (action) runAction(action);
  }, [actions, runAction]);

  if (!open) {
    return (
      <aside
        aria-label={t("actionPanel.railAriaLabel")}
        className="flex w-12 shrink-0 flex-col items-center border-l border-border bg-card/80 pt-2 text-card-foreground"
        data-testid="action-panel-rail"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t("actionPanel.openAriaLabel")}
              aria-expanded={false}
              data-testid="action-panel-open"
              onClick={() => onOpenChange(true)}
            >
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t("actionPanel.openTooltip")}</TooltipContent>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside
      aria-label={t("actionPanel.panelAriaLabel")}
      className="flex w-[22rem] max-w-[40vw] shrink-0 flex-col border-l border-border bg-card text-card-foreground shadow-[-12px_0_30px_rgba(15,23,42,0.08)]"
      data-testid="action-panel"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-5">{t("actionPanel.title")}</h2>
            <p className="truncate text-[11px] leading-4 text-muted-foreground">
              {t("actionPanel.subtitle", {
                actionCount: actions.length,
                pluginCount: plugins.length,
              })}
            </p>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={t("actionPanel.closeAriaLabel")}
              aria-expanded={true}
              data-testid="action-panel-close"
              onClick={() => onOpenChange(false)}
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t("actionPanel.closeTooltip")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="grid shrink-0 grid-cols-3 border-b border-border p-1" role="tablist" aria-label={t("actionPanel.tabsAriaLabel")}>
        {TAB_ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`flex h-8 items-center justify-center gap-1.5 rounded text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              activeTab === tab
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
            data-testid={`action-panel-tab-${tab}`}
            onClick={() => setActiveTab(tab)}
          >
            <TabIcon tab={tab} />
            <span className="truncate">{t(`actionPanel.tab.${tab}`)}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel" data-testid={`action-panel-tabpanel-${activeTab}`}>
        {activeTab === "work" && (
          <>
            <Section title={t("actionPanel.currentWorkTitle")}>
              <div className="rounded-md border border-border bg-background px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {currentSessionTitle || t("actionPanel.untitledSession")}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      {t("actionPanel.sessionMeta", {
                        kind: t(`actionPanel.sessionKind.${currentSessionKind}`),
                        id: shortId(currentSessionId),
                      })}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded px-2 py-1 text-[11px] ${streaming ? "bg-warning/(--opacity-faint) text-warning" : "bg-success/(--opacity-faint) text-success"}`}>
                    {streaming ? t("actionPanel.statusStreaming") : t("actionPanel.statusIdle")}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1 text-center text-[11px]">
                  <div className="rounded bg-muted px-1 py-1">
                    <div className="font-medium">{askQuestionCount}</div>
                    <div className="truncate text-muted-foreground">{t("actionPanel.askQueueMetric")}</div>
                  </div>
                  <div className="rounded bg-muted px-1 py-1">
                    <div className="font-medium">{runningSubagents}</div>
                    <div className="truncate text-muted-foreground">{t("actionPanel.agentMetric")}</div>
                  </div>
                  <div className="rounded bg-muted px-1 py-1">
                    <div className="font-medium">{attentionCount}</div>
                    <div className="truncate text-muted-foreground">{t("actionPanel.attentionMetric")}</div>
                  </div>
                </div>
              </div>
            </Section>

            <Section title={t("actionPanel.controlsTitle")}>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  className="flex min-h-10 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="action-panel-review-queue"
                  onClick={onOpenDeferredQueue}
                >
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.openReviewQueue")}</span>
                  <span className="font-medium">{execution.approvalCount}</span>
                </button>
                <button
                  type="button"
                  className="flex min-h-10 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="action-panel-work-board"
                  onClick={openWorkBoard}
                >
                  <ListChecks className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.openWorkBoard")}</span>
                  <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              </div>
            </Section>

            <Section title={t("actionPanel.actionsTitle")} count={actions.length}>
              <ul className="flex flex-col gap-1" aria-label={t("actionPanel.actionListAriaLabel")}>
                {actions.map((action, index) => {
                  const isActive = action.id === activeView || action.id === `v:${activeView}`;
                  return (
                    <li key={action.id}>
                      <button
                        type="button"
                        aria-current={isActive ? "page" : undefined}
                        className={`group flex min-h-10 w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          isActive
                            ? "border-primary bg-primary/(--opacity-faint)"
                            : "border-transparent hover:border-border hover:bg-accent"
                        }`}
                        data-testid={`action-panel-item-${action.id}`}
                        onClick={() => runAction(action)}
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-medium text-muted-foreground group-hover:text-foreground">
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{action.label}</span>
                        <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-70" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Section>

            <Section title={t("actionPanel.sessionsTitle")} count={recentSessions.length}>
              {recentSessions.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {recentSessions.map((session, index) => (
                    <li key={session.id}>
                      <button
                        type="button"
                        className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`action-panel-session-${index}`}
                        onClick={() => openSession(session.id)}
                      >
                        <Clock3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{session.title || t("actionPanel.untitledSession")}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {formatSessionTime(session.modifiedAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t("actionPanel.noRecentSessions")}</p>
              )}
            </Section>
          </>
        )}

        {activeTab === "tools" && (
          <>
            <Section title={t("actionPanel.pluginsTitle")} count={plugins.length}>
              {plugins.length > 0 ? (
                <div className="grid grid-cols-2 gap-1.5">
                  {plugins.map((plugin) => (
                    <button
                      key={plugin.viewKey}
                      type="button"
                      className="flex min-h-10 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid={`action-panel-plugin-${plugin.viewKey}`}
                      onClick={() => onSelectPlugin(plugin.viewKey)}
                    >
                      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold ${plugin.unauthed ? "text-warning" : "text-muted-foreground"}`}>
                        {plugin.iconText || plugin.label.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{plugin.label}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("actionPanel.noPlugins")}</p>
              )}
            </Section>

            <Section title={t("actionPanel.skillsTitle")} count={loadedSkills.length}>
              {loadedSkills.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {loadedSkills.slice(0, 6).map((skill, index) => (
                    <li key={`${skill.name}:${index}`} className="flex min-w-0 items-start gap-2 rounded-md bg-muted px-2 py-1.5 text-xs">
                      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{skill.name}</span>
                        <span className="block truncate text-muted-foreground">{skill.description}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t("actionPanel.noSkills")}</p>
              )}
            </Section>

            <Section title={t("actionPanel.agentsTitle")} count={subAgentSpawns.length}>
              {subAgentSpawns.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {subAgentSpawns.slice(0, 6).map((spawn) => (
                    <li key={spawn.spawnId} className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
                      <Bot className={`h-3.5 w-3.5 shrink-0 ${spawn.status === "error" ? "text-destructive" : spawn.status === "running" ? "text-warning" : "text-success"}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{spawn.title}</span>
                        <span className="block truncate text-muted-foreground">
                          {t("actionPanel.agentStatus", {
                            status: t(`actionPanel.agentStatus.${spawn.status}`),
                            turns: spawn.turns.length,
                            tools: spawn.toolCallCount,
                          })}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t("actionPanel.noAgents")}</p>
              )}
            </Section>

            <Section title={t("actionPanel.executionSurfacesTitle")}>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="flex min-h-10 items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.terminalSurfaceLabel")}</span>
                  <span className="font-medium">{execution.terminalToolCount}</span>
                </div>
                <div className="flex min-h-10 items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <Globe2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.browserSurfaceLabel")}</span>
                  <span className="font-medium">{execution.browserToolCount}</span>
                </div>
                <div className="flex min-h-10 items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <MonitorPlay className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.sidebarSurfaceLabel")}</span>
                  <span className="font-medium">{execution.pluginUiResultCount}</span>
                </div>
                <div className="flex min-h-10 items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.toolStreamLabel")}</span>
                  <span className="font-medium">{execution.toolCallCount}</span>
                </div>
              </div>
            </Section>
          </>
        )}

        {activeTab === "status" && (
          <>
            <Section title={t("actionPanel.contextTitle")}>
              <div className="space-y-3 rounded-md border border-border bg-background p-3">
                <div>
                  <div className="mb-1 flex justify-between gap-2 text-xs">
                    <span className="truncate">{t("actionPanel.contextBudget")}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatTokens(context.usedTokens)} / {formatTokens(context.effectiveBudget)}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full ${contextPct >= 90 ? "bg-destructive" : contextPct >= 70 ? "bg-warning" : "bg-primary"}`}
                      style={{ width: `${contextPct}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="mb-1 flex justify-between gap-2 text-xs">
                    <span className="truncate">{t("actionPanel.tpmBudget")}</span>
                    <span className="shrink-0 text-muted-foreground">{tpmPct}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full ${context.isTpmOverflow ? "bg-destructive" : tpmPct >= 70 ? "bg-warning" : "bg-success"}`}
                      style={{ width: `${tpmPct}%` }}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1 text-xs">
                  <div className="rounded bg-muted px-2 py-1">
                    <div className="text-muted-foreground">{t("actionPanel.vendorLabel")}</div>
                    <div className="truncate font-medium">{context.llmVendor}</div>
                  </div>
                  <div className="rounded bg-muted px-2 py-1">
                    <div className="text-muted-foreground">{t("actionPanel.modelLabel")}</div>
                    <div className="truncate font-medium">{context.llmModel}</div>
                  </div>
                </div>
              </div>
            </Section>

            <Section title={t("actionPanel.statusItemsTitle")} count={statusItems.length}>
              {statusItems.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {statusItems.map((item) => (
                    <li key={item.id} className={`min-w-0 rounded-md border px-2 py-1.5 text-xs ${statusTone(item.severity)}`}>
                      <div className="flex min-w-0 items-center gap-2">
                        {item.severity === "error" ? <CircleAlert className="h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                        <span className="min-w-0 truncate font-medium">{item.label || item.a11yLabel || item.id}</span>
                      </div>
                      {item.value && <div className="mt-0.5 truncate pl-5 opacity-80">{item.value}</div>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t("actionPanel.noStatusItems")}</p>
              )}
            </Section>

            <Section title={t("actionPanel.reviewGatesTitle")}>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.approvalsLabel")}</span>
                  <span className="font-medium">{execution.approvalCount}</span>
                </div>
                <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.permissionReviewLabel")}</span>
                  <span className="font-medium">{execution.permissionReviewCount}</span>
                </div>
                <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <FileDiff className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.fileChangesLabel")}</span>
                  <span className="font-medium">{execution.fileChangeCount}</span>
                </div>
                <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <RotateCcw className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.checkpointsLabel")}</span>
                  <span className="font-medium">{execution.checkpointCount}</span>
                </div>
              </div>
            </Section>

            <Section title={t("actionPanel.toastTitle")} count={visibleToast ? pendingToastCount + 1 : pendingToastCount}>
              {visibleToast ? (
                <div className={`rounded-md border px-2 py-1.5 text-xs ${statusTone(visibleToast.severity)}`}>
                  <div className="flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate font-medium">{visibleToast.message}</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("actionPanel.noToasts")}</p>
              )}
            </Section>

            <Section title={t("actionPanel.queueTitle")}>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.askQueueLabel")}</span>
                  <span className="font-medium">{askQuestionCount}</span>
                </div>
                <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.statusQueueLabel")}</span>
                  <span className="font-medium">{pendingToastCount}</span>
                </div>
                <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.agentQueueLabel")}</span>
                  <span className="font-medium">{runningSubagents}</span>
                </div>
                <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-2 text-xs">
                  <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t("actionPanel.toolQueueLabel")}</span>
                  <span className="font-medium">{execution.runningToolCount}</span>
                </div>
              </div>
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}
