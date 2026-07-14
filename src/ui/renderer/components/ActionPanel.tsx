import {
  Boxes,
  Cable,
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  FileText,
  Globe2,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import {
  useNativeContextMenu,
  type NativeContextMenuHandlers,
} from "../hooks/use-native-context-menu.js";

export interface ActionPanelActivityItem {
  id: string;
  label: string;
  detail?: string;
  target?: string;
  status?: "running" | "done" | "error";
}

export interface ActionPanelActivityState {
  readFileCount: number;
  writtenFileCount: number;
  mcpCallCount: number;
  pluginCallCount: number;
  toolCallCount: number;
  fetchedPageCount: number;
  readFiles: ActionPanelActivityItem[];
  writtenFiles: ActionPanelActivityItem[];
  pluginCalls: ActionPanelActivityItem[];
  mcpCalls: ActionPanelActivityItem[];
  fetchedPages: ActionPanelActivityItem[];
}

export interface ActionPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activity: ActionPanelActivityState;
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

const ACTIVITY_PREVIEW_LIMIT = 5;

function statusClass(status: ActionPanelActivityItem["status"]): string {
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

function statusLabel(status: ActionPanelActivityItem["status"], t: ReturnType<typeof useTranslation>["t"]): string {
  if (status === "running") return t("actionPanel.status.running");
  if (status === "error") return t("actionPanel.status.error");
  if (status === "done") return t("actionPanel.status.done");
  return "";
}

function ActivitySection({
  title,
  icon: Icon,
  items,
  onOpenItem,
  onOpenItemPinned,
  onOpenItemInSystemApp,
  web = false,
}: {
  title: string;
  icon: LucideIcon;
  items: ActionPanelActivityItem[];
  onOpenItem?: (target: string, web: boolean) => void;
  onOpenItemPinned?: (target: string, web: boolean) => void;
  onOpenItemInSystemApp?: (target: string, web: boolean) => void;
  web?: boolean;
}) {
  const { t } = useTranslation();
  const openNativeContextMenu = useNativeContextMenu();
  const visibleItems = items.slice(0, ACTIVITY_PREVIEW_LIMIT);
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
                  data-testid={"action-panel-activity-" + item.id}
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
                  data-testid={`action-panel-activity-${item.id}`}
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

function CompactDashboardStat({
  icon: Icon,
  label,
}: ActivityStat) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/(--opacity-faint) text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={label}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </div>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

function FloatingPanel({ children }: { children: ReactNode }) {
  const { t } = useTranslation();

  return (
    <aside
      aria-label={t("actionPanel.title")}
      className="lvis-surface-floating absolute right-4 top-2 z-50 flex w-[23rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl bg-card/(--opacity-solid) text-card-foreground backdrop-blur"
      data-testid="action-panel"
      style={{ maxHeight: "min(34rem, calc(100vh - 7rem))" }}
    >
      {children}
    </aside>
  );
}

export function ActionPanel({
  open,
  onOpenChange,
  activity,
  onOpenItem,
  onOpenItemPinned,
  onOpenItemInSystemApp,
}: ActionPanelProps) {
  const { t } = useTranslation();
  const allStats = [
    { icon: Wrench, label: t("actionPanel.toolCallsTitle"), count: activity.toolCallCount },
    { icon: Boxes, label: t("actionPanel.pluginCallsTitle"), count: activity.pluginCallCount },
    { icon: Cable, label: t("actionPanel.mcpCallsTitle"), count: activity.mcpCallCount },
    { icon: FileText, label: t("actionPanel.readFilesTitle"), count: activity.readFileCount },
    { icon: FilePenLine, label: t("actionPanel.writtenFilesTitle"), count: activity.writtenFileCount },
    { icon: Globe2, label: t("actionPanel.fetchedPagesTitle"), count: activity.fetchedPageCount },
  ];
  const populatedStats = allStats.filter((stat) => stat.count > 0);

  if (!open) {
    return (
      <aside
        aria-label={t("actionPanel.title")}
        className="pointer-events-none absolute right-4 top-2 z-50"
        data-testid="action-panel-rail"
      >
        <div
          className="lvis-surface-raised flex w-11 max-w-[calc(100vw-2rem)] flex-col items-center gap-1.5 rounded-xl bg-card/(--opacity-solid) p-1.5 text-card-foreground backdrop-blur"
          data-testid="action-panel-summary"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="pointer-events-auto h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={t("actionPanel.openAriaLabel")}
                aria-expanded={false}
                data-testid="action-panel-open"
                onClick={() => onOpenChange(true)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t("actionPanel.openTooltip")}</TooltipContent>
          </Tooltip>
          <div className="flex min-w-0 flex-col items-center gap-1" data-testid="action-panel-summary-list">
            {populatedStats.map((stat) => (
              <CompactDashboardStat key={stat.label} icon={stat.icon} label={stat.label} count={stat.count} />
            ))}
          </div>
        </div>
      </aside>
    );
  }

  return (
    <FloatingPanel>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-5">{t("actionPanel.title")}</h2>
            <p className="truncate text-[11px] leading-4 text-muted-foreground">{t("actionPanel.subtitle")}</p>
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
              <ChevronRight className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t("actionPanel.closeTooltip")}</TooltipContent>
        </Tooltip>
      </div>

      <StatsDashboard stats={allStats} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ActivitySection
          title={t("actionPanel.pluginCallsTitle")}
          icon={Boxes}
          items={activity.pluginCalls}
        />
        <ActivitySection
          title={t("actionPanel.mcpCallsTitle")}
          icon={Cable}
          items={activity.mcpCalls}
        />
        <ActivitySection
          title={t("actionPanel.readFilesTitle")}
          icon={FileText}
          items={activity.readFiles}
          onOpenItem={onOpenItem}
          onOpenItemPinned={onOpenItemPinned}
          onOpenItemInSystemApp={onOpenItemInSystemApp}
        />
        <ActivitySection
          title={t("actionPanel.writtenFilesTitle")}
          icon={FilePenLine}
          items={activity.writtenFiles}
          onOpenItem={onOpenItem}
          onOpenItemPinned={onOpenItemPinned}
          onOpenItemInSystemApp={onOpenItemInSystemApp}
        />
        <ActivitySection
          title={t("actionPanel.fetchedPagesTitle")}
          icon={Globe2}
          items={activity.fetchedPages}
          onOpenItem={onOpenItem}
          onOpenItemPinned={onOpenItemPinned}
          onOpenItemInSystemApp={onOpenItemInSystemApp}
          web
        />
      </div>
    </FloatingPanel>
  );
}
