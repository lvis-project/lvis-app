import {
  Activity,
  Boxes,
  Cable,
  FilePenLine,
  FileText,
  Globe2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { formatDuration } from "../../../lib/turn-summary-format.js";
import type { FileChangeOperation } from "../utils/tool-input-paths.js";
import {
  useNativeContextMenu,
  type NativeContextMenuHandlers,
} from "../hooks/use-native-context-menu.js";

export interface ToolActivityItem {
  id: string;
  label: string;
  detail?: string;
  target?: string;
  status?: "running" | "done" | "error" | "cancelled";
  /** What a file-change row did to its file; absent on every other row. */
  operation?: FileChangeOperation;
}

/** One tool call of the session, as the activity tab lists it. */
export interface ToolCallActivityItem {
  id: string;
  name: string;
  status: NonNullable<ToolActivityItem["status"]>;
  source: string;
  pluginId?: string;
  mcpServerId?: string;
  /** Wall clock at start. Live-only: a persisted session carries no clock, so a reloaded row has none. */
  startedAt?: number;
  durationMs?: number;
  /** The first path or URL the call named — what it acted on. */
  argument?: string;
}

export interface ToolActivityState {
  readFileCount: number;
  changedFileCount: number;
  mcpCallCount: number;
  pluginCallCount: number;
  toolCallCount: number;
  fetchedPageCount: number;
  readFiles: ToolActivityItem[];
  changedFiles: ToolActivityItem[];
  pluginCalls: ToolActivityItem[];
  mcpCalls: ToolActivityItem[];
  toolCalls: ToolCallActivityItem[];
  fetchedPages: ToolActivityItem[];
}

export interface ToolActivityRouting {
  /**
   * Left-click a row → route the item in-app (§6.10.5). `web` distinguishes a
   * web URL (→ browser tab) from a local file path (→ file-browser preview).
   */
  onOpenItem?: (target: string, web: boolean) => void;
  /**
   * Double-click a row → open (and keep) the item as a pinned tab (VS Code
   * preview-tab model: single-click = ephemeral, double-click = pinned).
   */
  onOpenItemPinned?: (target: string, web: boolean) => void;
  /** Right-click "open in system app". Only offered for web rows (see §5). */
  onOpenItemInSystemApp?: (target: string, web: boolean) => void;
}

/** How many rows the compact body (the empty launcher) shows per list. */
const ACTIVITY_PREVIEW_LIMIT = 5;

function statusClass(status: ToolActivityItem["status"]): string {
  switch (status) {
    case "running":
      return "bg-warning/(--opacity-faint) text-warning";
    case "error":
      return "bg-destructive/(--opacity-faint) text-destructive";
    case "done":
      return "bg-success/(--opacity-faint) text-success";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function statusLabel(status: ToolActivityItem["status"], t: ReturnType<typeof useTranslation>["t"]): string {
  if (status === "running") return t("toolActivity.status.running");
  if (status === "error") return t("toolActivity.status.error");
  if (status === "done") return t("toolActivity.status.done");
  return "";
}

/** The badge a file-change row wears: the change, not the tool. */
function operationClass(operation: FileChangeOperation): string {
  switch (operation) {
    case "create":
      return "bg-success/(--opacity-faint) text-success";
    case "delete":
      return "bg-destructive/(--opacity-faint) text-destructive";
    default:
      return "bg-primary/(--opacity-faint) text-primary";
  }
}

function ActivitySection({
  title,
  icon: Icon,
  items,
  limit,
  onOpenItem,
  onOpenItemPinned,
  onOpenItemInSystemApp,
  web = false,
}: {
  title: string;
  icon: LucideIcon;
  items: ToolActivityItem[];
  /** Rows shown; every row when absent. */
  limit?: number;
  web?: boolean;
} & ToolActivityRouting) {
  const { t } = useTranslation();
  const openNativeContextMenu = useNativeContextMenu();
  const visibleItems = limit == null ? items : items.slice(0, limit);
  if (visibleItems.length === 0) return null;

  return (
    <section className="border-t border-border px-3 py-2.5">
      <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          <h3 className="truncate text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">
            {title}
          </h3>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {visibleItems.length}
        </span>
      </div>
      <ul className="space-y-1">
        {visibleItems.map((item) => {
          const label = statusLabel(item.status, t);
          const titleText = item.detail ? `${item.label}\n${item.detail}` : item.label;
          const rowContent = (
            <>
              {web ? (
                <Globe2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              ) : (
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate leading-4 text-foreground">{item.label}</span>
                {!web && item.detail && (
                  <span className="block truncate text-[10px] leading-4 text-muted-foreground">
                    {item.detail}
                  </span>
                )}
              </span>
              {item.operation && (
                <span
                  className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${operationClass(item.operation)}`}
                  data-testid="tool-activity-operation"
                >
                  {t(`chatPreviewRail.fileOperation.${item.operation}`)}
                </span>
              )}
              {label && (
                <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${statusClass(item.status)}`}>
                  {label}
                </span>
              )}
            </>
          );
          const canCopy = Boolean(item.target);
          const canOpenInSystemApp = Boolean(item.target && web && onOpenItemInSystemApp);
          return (
            <li key={item.id}>
              {item.target && onOpenItem ? (
                <button
                  type="button"
                  className="flex w-full min-w-0 items-start gap-2 rounded-md bg-muted/(--opacity-faint) px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={"tool-activity-item-" + item.id}
                  title={titleText}
                  onClick={() => onOpenItem(item.target!, web)}
                  onDoubleClick={() => (onOpenItemPinned ?? onOpenItem)(item.target!, web)}
                  onContextMenu={(event) => openNativeContextMenu(event, "action-item", {
                    ...(canOpenInSystemApp
                      ? { "action.open-system": () => onOpenItemInSystemApp?.(item.target!, web) }
                      : {}),
                    ...(canCopy
                      ? {
                          [web ? "action.copy-url" : "action.copy-path"]: () =>
                            void navigator.clipboard?.writeText(item.target!),
                        }
                      : {}),
                  } as NativeContextMenuHandlers)}
                >
                  {rowContent}
                </button>
              ) : (
                <div
                  className="flex min-w-0 items-start gap-2 rounded-md bg-muted/(--opacity-faint) px-2 py-1.5 text-xs"
                  data-testid={`tool-activity-item-${item.id}`}
                  title={titleText}
                >
                  {rowContent}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface ActivityStat {
  icon: LucideIcon;
  label: string;
  count: number;
}

function DashboardStat({
  icon: Icon,
  label,
  count,
}: ActivityStat) {
  return (
    <div className="min-w-0 bg-card px-1.5 py-1">
      <div className="flex items-center justify-center gap-1">
        <Icon className="h-2.5 w-2.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-mono text-[10px] font-medium tabular-nums">{count}</span>
      </div>
      <span className="mt-0.5 block truncate text-center text-[8px] leading-3 text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function StatsDashboard({ stats }: { stats: ActivityStat[] }) {
  if (stats.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-border px-3 py-1.5">
      <div className="grid grid-cols-6 gap-px overflow-hidden rounded-md border border-border bg-border">
        {stats.map((stat) => (
          <DashboardStat key={stat.label} icon={stat.icon} label={stat.label} count={stat.count} />
        ))}
      </div>
    </div>
  );
}

/**
 * The compact report the work panel's empty launcher shows: the six counters,
 * then the newest few items by category, and the way to the activity tab that
 * lists everything.
 */
export function ToolActivityBody({
  activity,
  onOpenItem,
  onOpenItemPinned,
  onOpenItemInSystemApp,
  onOpenActivityTab,
}: {
  activity: ToolActivityState;
  /** Open the activity tab — the full plugin and tool call lists. */
  onOpenActivityTab?: () => void;
} & ToolActivityRouting) {
  const { t } = useTranslation();
  const allStats = [
    { icon: Wrench, label: t("toolActivity.toolCallsTitle"), count: activity.toolCallCount },
    { icon: Boxes, label: t("toolActivity.pluginCallsTitle"), count: activity.pluginCallCount },
    { icon: Cable, label: t("toolActivity.mcpCallsTitle"), count: activity.mcpCallCount },
    { icon: FileText, label: t("toolActivity.readFilesTitle"), count: activity.readFileCount },
    { icon: FilePenLine, label: t("toolActivity.changedFilesTitle"), count: activity.changedFileCount },
    { icon: Globe2, label: t("toolActivity.fetchedPagesTitle"), count: activity.fetchedPageCount },
  ];
  return (
    <>
      <StatsDashboard stats={allStats} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ActivitySection
          title={t("toolActivity.pluginCallsTitle")}
          icon={Boxes}
          items={activity.pluginCalls}
          limit={ACTIVITY_PREVIEW_LIMIT}
        />
        <ActivitySection
          title={t("toolActivity.mcpCallsTitle")}
          icon={Cable}
          items={activity.mcpCalls}
          limit={ACTIVITY_PREVIEW_LIMIT}
        />
        <ActivitySection
          title={t("toolActivity.readFilesTitle")}
          icon={FileText}
          items={activity.readFiles}
          limit={ACTIVITY_PREVIEW_LIMIT}
          onOpenItem={onOpenItem}
          onOpenItemPinned={onOpenItemPinned}
          onOpenItemInSystemApp={onOpenItemInSystemApp}
        />
        <ActivitySection
          title={t("toolActivity.changedFilesTitle")}
          icon={FilePenLine}
          items={activity.changedFiles}
          limit={ACTIVITY_PREVIEW_LIMIT}
          onOpenItem={onOpenItem}
          onOpenItemPinned={onOpenItemPinned}
          onOpenItemInSystemApp={onOpenItemInSystemApp}
        />
        <ActivitySection
          title={t("toolActivity.fetchedPagesTitle")}
          icon={Globe2}
          items={activity.fetchedPages}
          limit={ACTIVITY_PREVIEW_LIMIT}
          onOpenItem={onOpenItem}
          onOpenItemPinned={onOpenItemPinned}
          onOpenItemInSystemApp={onOpenItemInSystemApp}
          web
        />
      </div>
      {onOpenActivityTab ? (
        <div className="shrink-0 border-t border-border px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-xs"
            data-testid="tool-activity-open-tab"
            onClick={onOpenActivityTab}
          >
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            {t("toolActivity.openAll")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** How much the session did, in one number for the badge: the populated counters summed. */
export function toolActivityTotal(activity: ToolActivityState): number {
  return activity.toolCallCount + activity.pluginCallCount + activity.mcpCallCount
    + activity.readFileCount + activity.changedFileCount + activity.fetchedPageCount;
}

function formatStartedAt(startedAt: number): string {
  return new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function toolCallSourceLabel(call: ToolCallActivityItem): string {
  if (call.pluginId) return `plugin:${call.pluginId}`;
  if (call.mcpServerId) return `mcp:${call.mcpServerId}`;
  return call.source;
}

function ToolCallRow({ call }: { call: ToolCallActivityItem }) {
  const { t } = useTranslation();
  const label = statusLabel(call.status, t);
  const meta = [
    toolCallSourceLabel(call),
    call.startedAt != null ? formatStartedAt(call.startedAt) : null,
    call.durationMs != null ? formatDuration(call.durationMs) : null,
  ].filter((part): part is string => Boolean(part));
  return (
    <li
      className="flex min-w-0 items-start gap-2 rounded-md bg-muted/(--opacity-faint) px-2 py-1.5 text-xs"
      data-testid="chat-side-panel-activity-tool-row"
      title={call.argument ? `${call.name}\n${call.argument}` : call.name}
    >
      <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono leading-4 text-foreground">{call.name}</span>
        <span className="block truncate text-[10px] leading-4 text-muted-foreground">{meta.join(" · ")}</span>
        {call.argument && (
          <span className="block truncate text-[10px] leading-4 text-muted-foreground">{call.argument}</span>
        )}
      </span>
      {label && (
        <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${statusClass(call.status)}`}>
          {label}
        </span>
      )}
    </li>
  );
}

/**
 * The activity tab: every plugin the session called and every tool call it
 * made, newest first, with no row limit — the compact launcher body keeps the
 * newest few, this tab keeps them all. The file and web lists have tabs of
 * their own (the file browser's changed-files segment, the browser's visited
 * list), so they are not repeated here.
 */
export function ToolActivityWorkspace({ activity }: { activity: ToolActivityState }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-y-auto" data-testid="chat-side-panel-activity-workspace">
      <div data-testid="chat-side-panel-activity-plugins">
        {activity.pluginCalls.length > 0 ? (
          <ActivitySection
            title={t("toolActivity.pluginCallsTitle")}
            icon={Boxes}
            items={activity.pluginCalls}
          />
        ) : (
          <section className="border-t border-border px-3 py-2.5">
            <h3 className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">
              {t("toolActivity.pluginCallsTitle")}
            </h3>
            <p className="text-xs text-muted-foreground">{t("toolActivity.noPluginCalls")}</p>
          </section>
        )}
      </div>
      <section className="border-t border-border px-3 py-2.5" data-testid="chat-side-panel-activity-tools">
        <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Wrench className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            <h3 className="truncate text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">
              {t("toolActivity.toolCallsTitle")}
            </h3>
          </div>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {activity.toolCalls.length}
          </span>
        </div>
        {activity.toolCalls.length > 0 ? (
          <ul className="space-y-1">
            {activity.toolCalls.map((call) => (
              <ToolCallRow key={call.id} call={call} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t("toolActivity.noToolCalls")}</p>
        )}
      </section>
    </div>
  );
}
