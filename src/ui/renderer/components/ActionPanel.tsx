import {
  Boxes,
  Cable,
  FilePenLine,
  FileText,
  Globe2,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { FLOATING_LANE_ITEM_WIDTH } from "./FloatingRightLane.js";
import {
  useNativeContextMenu,
  type NativeContextMenuHandlers,
} from "../hooks/use-native-context-menu.js";

export interface ActionPanelActivityItem {
  id: string;
  label: string;
  detail?: string;
  target?: string;
  status?: "running" | "done" | "error" | "cancelled";
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

/**
 * What the panel says: the six counters, then the items by category. Shared
 * by the header popover and the workspace rail's empty launcher, so the two
 * never disagree about what a session did.
 */
export function ToolActivityBody({
  activity,
  onOpenItem,
  onOpenItemPinned,
  onOpenItemInSystemApp,
}: Pick<ActionPanelProps, "activity" | "onOpenItem" | "onOpenItemPinned" | "onOpenItemInSystemApp">) {
  const { t } = useTranslation();
  const allStats = [
    { icon: Wrench, label: t("actionPanel.toolCallsTitle"), count: activity.toolCallCount },
    { icon: Boxes, label: t("actionPanel.pluginCallsTitle"), count: activity.pluginCallCount },
    { icon: Cable, label: t("actionPanel.mcpCallsTitle"), count: activity.mcpCallCount },
    { icon: FileText, label: t("actionPanel.readFilesTitle"), count: activity.readFileCount },
    { icon: FilePenLine, label: t("actionPanel.writtenFilesTitle"), count: activity.writtenFileCount },
    { icon: Globe2, label: t("actionPanel.fetchedPagesTitle"), count: activity.fetchedPageCount },
  ];
  return (
    <>
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
    </>
  );
}

/** How much the session did, in one number for the badge: the populated counters summed. */
export function toolActivityTotal(activity: ActionPanelActivityState): number {
  return activity.toolCallCount + activity.pluginCallCount + activity.mcpCallCount
    + activity.readFileCount + activity.writtenFileCount + activity.fetchedPageCount;
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
  const populatedCount = toolActivityTotal(activity);

  // Anchored to the group header, opening DOWNWARD over the transcript.
  // It used to float over the top-right of the chat column, which put it at
  // the same point for every group on screen; a header-anchored disclosure
  // says which conversation it is reporting on by where it hangs from.
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative h-(--chrome-icon-button) w-(--chrome-icon-button) aspect-square shrink-0 p-0 text-muted-foreground hover:text-foreground"
              aria-label={open ? t("actionPanel.closeAriaLabel") : t("actionPanel.openAriaLabel")}
              aria-expanded={open}
              data-testid="action-panel-open"
            >
              <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
              {populatedCount > 0 && (
                // A count, not a dot: the panel's whole purpose is "how much
                // did it just do", and that is answerable without opening it.
                <span
                  className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-primary px-0.5 text-[8px] font-medium leading-3 tabular-nums text-primary-foreground"
                  data-testid="action-panel-badge"
                >
                  {populatedCount > 99 ? "99+" : populatedCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("actionPanel.title")}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        aria-label={t("actionPanel.title")}
        // The popover is one of the floating lane's occupants, so it takes the
        // lane's width rather than a copy of it — a copy is what would let the
        // panel and the overlay card below it step in and out by a few pixels.
        className={`flex ${FLOATING_LANE_ITEM_WIDTH} flex-col overflow-hidden p-0`}
        style={{ maxHeight: "min(34rem, calc(100vh - 7rem))" }}
        data-testid="action-panel"
      >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold leading-5">{t("actionPanel.title")}</h2>
          <p className="truncate text-[11px] leading-4 text-muted-foreground">{t("actionPanel.subtitle")}</p>
        </div>
      </div>
      <ToolActivityBody
        activity={activity}
        onOpenItem={onOpenItem}
        onOpenItemPinned={onOpenItemPinned}
        onOpenItemInSystemApp={onOpenItemInSystemApp}
      />
      </PopoverContent>
    </Popover>
  );
}
