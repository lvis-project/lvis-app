import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { cn } from "../../../lib/utils.js";
import type { WorkspaceTab, WorkspaceTabKind, WorkspaceTabsStore } from "../preview/workspace-tabs.js";
import {
  WORKSPACE_TAB_LAUNCHER,
  matchesLauncherShortcut,
} from "./command-actions.js";
import {
  Bot,
  LayoutGrid,
  Loader2,
  PanelRightClose,
  Pin,
  Plus,
  X,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { useTranslation } from "../../../i18n/react.js";
import { SIDE_PANEL_DEFAULT_WIDTH, SIDE_PANEL_MIN_WIDTH } from "../../../shared/side-panel.js";
import { EdgeResizeBar } from "./EdgeResizeBar.js";
import type { LvisApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { PtyTerminalView } from "./PtyTerminalView.js";
import { SideChatView } from "./SideChatView.js";
import { VerticalSplitLayout } from "./VerticalSplitLayout.js";
import { useVerticalSplit } from "../hooks/use-vertical-split.js";
import type { SubAgentSpawn } from "../subagents/types.js";
import { groupSubAgentSessions } from "../subagents/group-subagent-sessions.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { TranscriptRenderer } from "./TranscriptRenderer.js";
import { historyToEntries } from "../utils/history.js";
import {
  BrowserWorkspace,
  FileBrowserWorkspace,
  PreviewWorkspace,
} from "./chat-side-panel-workspaces.js";
import {
  BROWSER_TARGET_KINDS,
  FILE_TARGET_KINDS,
  TAB_DRAG_THRESHOLD_PX,
  DetailHeader,
  PreviewBody,
  UrlDocumentViewer,
  tabIcon,
} from "./chat-side-panel-preview.js";


/** Status tone for the sub-agent list row badge. */
function subAgentStatusTone(status: SubAgentSpawn["status"]): string {
  if (status === "error") return "text-destructive";
  if (status === "interrupted") return "text-warning";
  if (status === "waiting") return "text-warning";
  if (status === "done") return "text-muted-foreground";
  return "text-warning";
}

/**
 * One selectable row in the sub-agent list. Memoized so a live-updating spawn
 * (its turn count / status ticks as the agent runs) only re-renders its OWN row,
 * not every sibling — the list can hold many concurrent spawns.
 */
/** Localized status label for the sub-agent rail. */
function subAgentStatusLabel(status: SubAgentSpawn["status"], t: (key: string) => string): string {
  if (status === "error") return t("subAgentCard.statusError");
  if (status === "interrupted") return t("subAgentCard.statusInterrupted");
  if (status === "waiting") return t("subAgentCard.statusWaiting");
  if (status === "done") return t("subAgentCard.statusDone");
  return t("subAgentCard.statusRunning");
}

const SubAgentRow = memo(function SubAgentRow({
  spawn,
  active,
  onSelect,
}: {
  spawn: SubAgentSpawn;
  active: boolean;
  onSelect: (spawnId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    // role="option": this row lives in a role="listbox"; aria-selected is valid
    // only on a listbox option (not a bare button).
    <button
      type="button"
      role="option"
      data-testid="chat-side-panel-subagent-row"
      aria-selected={active}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted/(--opacity-muted)",
        active ? "bg-accent text-accent-foreground" : "",
      )}
      onClick={() => onSelect(spawn.spawnId)}
    >
      {spawn.status === "running" ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" aria-hidden="true" />
      ) : (
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate font-medium" title={spawn.title}>
        {spawn.title}
      </span>
      <span className={cn("shrink-0 text-[10px]", subAgentStatusTone(spawn.status))}>
        {subAgentStatusLabel(spawn.status, t)}
      </span>
    </button>
  );
});

function subAgentTranscriptEntries(spawn: SubAgentSpawn, sourceEntries: ChatEntry[] = spawn.entries): ChatEntry[] {
  const prompt = spawn.instructions?.trim();
  if (!prompt) return sourceEntries;
  const bodyEntries = sourceEntries[0]?.kind === "user" ? sourceEntries.slice(1) : sourceEntries;
  return [{ kind: "user", text: prompt }, ...bodyEntries];
}

function transcriptEntryFingerprint(entry: ChatEntry): string {
  return JSON.stringify(entry, (key, value) =>
    key === "createdAt" || key === "streaming" ? undefined : value,
  );
}

function mergeHydratedTranscriptWithLiveTail(hydratedEntries: ChatEntry[], liveEntries: ChatEntry[]): ChatEntry[] {
  if (hydratedEntries.length === 0) return liveEntries;
  if (liveEntries.length === 0) return hydratedEntries;
  const seen = new Set(hydratedEntries.map(transcriptEntryFingerprint));
  const tail = liveEntries.filter((entry) => !seen.has(transcriptEntryFingerprint(entry)));
  return tail.length > 0 ? [...hydratedEntries, ...tail] : hydratedEntries;
}

function SubAgentTranscriptDetail({
  api,
  parentSessionId,
  spawn,
}: {
  api: LvisApi;
  parentSessionId?: string;
  spawn: SubAgentSpawn;
}) {
  const { t } = useTranslation();
  const hydrationKey = `${parentSessionId ?? ""}\u0001${spawn.childSessionId ?? ""}`;
  const [hydrated, setHydrated] = useState<{ key: string; entries: ChatEntry[] } | null>(null);
  useEffect(() => {
    setHydrated(null);
    if (!parentSessionId || !spawn.childSessionId || typeof api.chatGetSubAgentTranscript !== "function") return;
    let cancelled = false;
    void api.chatGetSubAgentTranscript({
      originSessionId: parentSessionId,
      childSessionId: spawn.childSessionId,
    }).then((result) => {
      if (cancelled || !result.ok) return;
      setHydrated({ key: hydrationKey, entries: historyToEntries(result.messages) });
    }).catch(() => {
      // Fail closed for persisted transcript hydration. The child JSONL keyed by
      // childSessionId is the only persisted transcript SOT; parent tool results
      // are not used as a reconstruction source.
    });
    return () => {
      cancelled = true;
    };
  }, [api, parentSessionId, spawn.childSessionId, hydrationKey]);
  const sourceEntries = useMemo(() => {
    const hydratedEntries = hydrated?.key === hydrationKey ? hydrated.entries : [];
    if (spawn.childSessionId && hydratedEntries.length > 0) {
      return mergeHydratedTranscriptWithLiveTail(hydratedEntries, spawn.entries);
    }
    return spawn.entries;
  }, [hydrated, hydrationKey, spawn.childSessionId, spawn.entries]);
  const entries = useMemo(() => subAgentTranscriptEntries(spawn, sourceEntries), [spawn, sourceEntries]);
  const sessionId = spawn.childSessionId ?? spawn.spawnId;
  return (
    <div className="min-h-0 min-w-0 space-y-3 py-1" data-testid="chat-side-panel-subagent-transcript">
      {entries.length > 0 ? (
        <TranscriptRenderer
          entries={entries}
          streaming={spawn.status === "running"}
          currentSessionId={sessionId}
          workGroupsForceOpen
        />
      ) : (
        <div className="py-1 text-xs text-muted-foreground">
          {spawn.status === "running"
            ? t("subAgentCard.statusRunning")
            : spawn.status === "waiting"
              ? t("subAgentCard.statusWaiting")
              : t("subAgentCard.summaryLabel")}
        </div>
      )}
      {spawn.errorMessage ? (
        <div className="rounded border border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint) px-2 py-1 text-[11px] text-destructive">
          {spawn.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Sub-agent viewer tab (R4). Top pane = the list of this chat's sub-agent spawns
 * (live + completed); bottom pane = the SELECTED spawn's transcript/tool-activity
 * via a sub-agent-only expanded transcript renderer. Only the selected spawn is
 * rendered in detail (not every transcript), and the list rows are memoized, so a chat that fanned out many
 * agents stays cheap. The top↕bottom split persists via sidePanelSplitSubagentPercent.
 */
function SubAgentViewer({
  api,
  parentSessionId,
  subAgentSpawns,
}: {
  api: LvisApi;
  parentSessionId?: string;
  subAgentSpawns: SubAgentSpawn[];
}) {
  const { t } = useTranslation();
  const { topPercent, setTopPercent, commitTopPercent } = useVerticalSplit(api, "sidePanelSplitSubagentPercent");
  const [selectedSpawnId, setSelectedSpawnId] = useState<string | null>(null);
  // Unify each spawn with its resume segments (JOIN KEY = childSessionId) into a
  // single row with a concatenated transcript. The prop stays a FLAT list (one
  // spawn source of truth prop-drilled from ChatView) — grouping is a viewer-only
  // presentation concern applied here.
  const groupedSpawns = useMemo(() => groupSubAgentSessions(subAgentSpawns), [subAgentSpawns]);
  // Running spawns first (the user usually wants the live one), then completed.
  const orderedSpawns = useMemo(() => {
    const running = groupedSpawns.filter((spawn) => spawn.status === "running");
    const rest = groupedSpawns.filter((spawn) => spawn.status !== "running");
    return [...running, ...rest];
  }, [groupedSpawns]);
  // Pin the detail to the CHOSEN spawnId. The synchronous `?? orderedSpawns[0]`
  // fallback only applies while nothing is chosen yet (no first-render flash);
  // once a spawn resolves, `.find` keeps it, so a status flip that reorders the
  // list (running→done reshuffles `orderedSpawns`) can never silently jump the
  // viewed spawn out from under the user. The effect below persists the seed
  // into `selectedSpawnId` so the row highlight (`active`) matches the detail.
  const selectedSpawn = useMemo(
    () => orderedSpawns.find((spawn) => spawn.spawnId === selectedSpawnId) ?? orderedSpawns[0] ?? null,
    [orderedSpawns, selectedSpawnId],
  );

  useEffect(() => {
    if (orderedSpawns.length === 0) {
      if (selectedSpawnId !== null) setSelectedSpawnId(null);
      return;
    }
    // Seed / re-pin only when the current selection is absent — never when it
    // still resolves, so an in-place list reorder does not move the selection.
    if (!selectedSpawnId || !orderedSpawns.some((spawn) => spawn.spawnId === selectedSpawnId)) {
      setSelectedSpawnId(orderedSpawns[0].spawnId);
    }
  }, [orderedSpawns, selectedSpawnId]);

  if (orderedSpawns.length === 0) {
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col items-center justify-center p-6 text-center" data-testid="chat-side-panel-subagent-empty">
        <Bot className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <div className="mt-2 text-xs text-muted-foreground">{t("chatPreviewRail.subagentEmpty")}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="chat-side-panel-subagent-viewer">
      <VerticalSplitLayout
        topPercent={topPercent}
        onDragChange={setTopPercent}
        onCommit={commitTopPercent}
        ariaLabel={t("chatPreviewRail.resizeSubagentPanels")}
        testId="chat-side-panel-subagent-split-layout"
        separatorTestId="chat-side-panel-subagent-splitter"
        top={
          // role="listbox" makes each row's aria-selected valid (it is only
          // meaningful on option/row/tab/… children of a select container).
          <div
            role="listbox"
            aria-label={t("chatPreviewRail.subagentListLabel")}
            className="min-h-0 space-y-1 p-2"
            data-testid="chat-side-panel-subagent-list"
          >
            {orderedSpawns.map((spawn) => (
              <SubAgentRow
                key={spawn.spawnId}
                spawn={spawn}
                active={spawn.spawnId === selectedSpawn?.spawnId}
                onSelect={setSelectedSpawnId}
              />
            ))}
          </div>
        }
        bottom={
          <div className="min-h-0 p-3" data-testid="chat-side-panel-subagent-detail">
            {selectedSpawn ? (
              <SubAgentTranscriptDetail
                api={api}
                {...(parentSessionId ? { parentSessionId } : {})}
                spawn={selectedSpawn}
              />
            ) : (
              <div className="text-xs text-muted-foreground">{t("chatPreviewRail.subagentSelectHint")}</div>
            )}
          </div>
        }
      />
    </div>
  );
}


function tabLabelKey(kind: WorkspaceTabKind): string {
  switch (kind) {
    case "file-browser":
      return "chatPreviewRail.tab.fileBrowser";
    case "browser":
      return "chatPreviewRail.tab.browser";
    case "terminal":
      return "chatPreviewRail.tab.terminal";
    case "preview":
      return "chatPreviewRail.tab.preview";
    case "subagent":
      return "chatPreviewRail.tab.subagent";
    case "side-chat":
      return "chatPreviewRail.tab.sideChat";
  }
}

function tabTestId(kind: WorkspaceTabKind): string {
  switch (kind) {
    case "file-browser":
      return "chat-side-panel-tab-file-browser";
    case "browser":
      return "chat-side-panel-tab-browser";
    case "preview":
      return "chat-side-panel-tab-preview";
    case "terminal":
      return "chat-side-panel-tab-terminal";
    case "subagent":
      return "chat-side-panel-tab-subagent";
    case "side-chat":
      return "chat-side-panel-tab-side-chat";
  }
}

/**
 * Tab label: container tabs show `{kind}` alone, appending the `{ordinal}` (e.g.
 * "Browser 2") ONLY when `showOrdinal` is set — the caller sets it when 2+
 * container tabs of the same kind coexist, so a lone tab reads "Browser" with no
 * meaningless "1". Content tabs show the item they point at (preview-target
 * title, or the URL host) and ignore the ordinal entirely.
 */
function tabLabel(
  tab: WorkspaceTab,
  targetById: Map<string, ChatPreviewTarget>,
  t: (key: string) => string,
  showOrdinal: boolean,
): string {
  if (!tab.content) {
    const base = t(tabLabelKey(tab.kind));
    return showOrdinal ? `${base} ${tab.ordinal}` : base;
  }
  if (tab.content.source === "browser") {
    try {
      return new URL(tab.content.url).hostname || tab.content.url;
    } catch {
      return tab.content.url;
    }
  }
  return targetById.get(tab.content.targetId)?.title ?? t(tabLabelKey("preview"));
}

/**
 * Renders a CONTENT tab — a tab that points at one specific item. Browser
 * content reuses the sandboxed webview shell (`UrlDocumentViewer`); preview
 * content renders its target via the shared detail/body pair. Unlike container
 * tabs it does not carry the per-kind list — it shows exactly one thing.
 */
function ContentTabView({
  api,
  sessionId,
  tab,
  targetById,
}: {
  api: LvisApi;
  sessionId?: string;
  tab: WorkspaceTab;
  targetById: Map<string, ChatPreviewTarget>;
}) {
  const { t } = useTranslation();
  const content = tab.content;
  // Memoized synthetic url target for browser content tabs — rebuilding it every
  // render would remount the sandboxed webview on unrelated re-renders. The url
  // is already store-validated (normalizeContentRef) and re-validated by the
  // shared url-safety SOT inside UrlDocumentViewer; `new URL` here only derives
  // the display title, not a safety gate.
  const browserTarget = useMemo<Extract<ChatPreviewTarget, { kind: "url" }> | null>(() => {
    if (content?.source !== "browser") return null;
    let title: string;
    try {
      title = new URL(content.url).hostname || content.url;
    } catch {
      title = content.url;
    }
    return {
      id: `content-browser:${tab.id}`,
      kind: "url",
      title,
      sourceLabel: t("chatPreviewRail.manualUrlSource"),
      createdOrder: Number.MAX_SAFE_INTEGER,
      url: content.url,
    };
  }, [content, tab.id, t]);
  if (!content) return null;
  if (browserTarget) {
    return <UrlDocumentViewer api={api} target={browserTarget} />;
  }
  const target = content.source === "preview" ? targetById.get(content.targetId) : undefined;
  if (!target) {
    return (
      <div className="p-4 text-xs text-muted-foreground" data-testid="chat-side-panel-content-unavailable" data-tab-id={tab.id}>
        {t("chatPreviewRail.contentUnavailable")}
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-auto p-3" data-testid="chat-side-panel-content-view" data-tab-id={tab.id}>
      <div className="space-y-3">
        <DetailHeader target={target} />
        <PreviewBody api={api} sessionId={sessionId} target={target} />
      </div>
    </div>
  );
}

/**
 * The launcher item list (§6.10.3), rendered from the single SOT
 * `WORKSPACE_TAB_LAUNCHER` in `command-actions.ts`. It is used in TWO places —
 * the empty-state picker (`WorkspaceLauncher`) and the tab-bar "+" dropdown
 * (`WorkspaceLauncherMenu`) — so both surfaces share one list and one set of
 * shortcuts. `renderItem` lets each surface wrap a row in its own element
 * (a plain `button` for the inline list, a `DropdownMenuItem` for the menu).
 *
 * `사이드채팅` (side chat) is a planned launcher item but is DEFERRED — it is not
 * in `WORKSPACE_TAB_LAUNCHER` and no functional entry is added here.
 */
function LauncherItems({
  onOpen,
  renderItem,
}: {
  onOpen: (kind: WorkspaceTabKind) => void;
  renderItem: (item: (typeof WORKSPACE_TAB_LAUNCHER)[number], children: ReactElement, onSelect: () => void) => ReactElement;
}) {
  const { t } = useTranslation();
  return (
    <>
      {WORKSPACE_TAB_LAUNCHER.map((item) => {
        const Icon = item.icon;
        const label = t(item.labelKey);
        const row = (
          <>
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {item.shortcutHint ? (
              <kbd className="shrink-0 rounded bg-muted/(--opacity-muted) px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {item.shortcutHint}
              </kbd>
            ) : null}
          </>
        );
        return renderItem(item, row, () => onOpen(item.kind));
      })}
    </>
  );
}

/**
 * Empty-state launcher (§6.10.3). Renders when the workspace has no tabs — a
 * vertical, centered picker of the openable content kinds. Shares the item list
 * with the tab-bar "+" dropdown via `LauncherItems`.
 */
function WorkspaceLauncher({ onOpen }: { onOpen: (kind: WorkspaceTabKind) => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col items-center justify-center overflow-auto p-6"
      data-testid="chat-side-panel-launcher"
    >
      <div className="w-full max-w-xs space-y-3">
        <div className="flex flex-col items-center gap-1 text-center">
          <LayoutGrid className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <div className="text-sm font-semibold">{t("chatPreviewRail.launcher.title")}</div>
          <div className="text-[11px] text-muted-foreground">{t("chatPreviewRail.launcher.subtitle")}</div>
        </div>
        <div className="space-y-1" role="menu" aria-label={t("chatPreviewRail.launcher.title")}>
          <LauncherItems
            onOpen={onOpen}
            renderItem={(item, children, onSelect) => (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                data-testid={`chat-side-panel-launcher-${item.kind}`}
                className="flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-sm hover:bg-muted/(--opacity-muted)"
                onClick={onSelect}
              >
                {children}
              </button>
            )}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Tab-bar "+" button — opens the same launcher as a dropdown menu. Replaces the
 * old scattered per-kind add-tab buttons; the SOT list drives both this and the
 * empty-state picker.
 */
function WorkspaceLauncherMenu({ onOpen }: { onOpen: (kind: WorkspaceTabKind) => void }) {
  const { t } = useTranslation();
  const label = t("chatPreviewRail.launcher.addTab");
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="chat-side-panel-add-tab"
              aria-label={label}
              title={label}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52" data-testid="chat-side-panel-launcher-menu">
        <LauncherItems
          onOpen={onOpen}
          renderItem={(item, children, onSelect) => (
            <DropdownMenuItem
              key={item.kind}
              data-testid={`chat-side-panel-launcher-menu-${item.kind}`}
              className="flex items-center gap-3"
              onSelect={onSelect}
            >
              {children}
            </DropdownMenuItem>
          )}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ChatSidePanelProps {
  api: LvisApi;
  sessionId?: string;
  targets: ChatPreviewTarget[];
  files: WorkspaceFileItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  /**
   * Workspace-tab store, lifted out of this component (see
   * `preview/workspace-tabs.ts`). ChatSidePanel is unmounted whenever the rail
   * closes / the view leaves home / the session switches; owning tab state here
   * would destroy it on every such transition. The store lives at ChatView
   * level so tab state survives.
   */
  workspaceTabs: WorkspaceTabsStore;
  /**
   * This chat's sub-agent spawns (live + completed), sourced from ChatView's
   * spawn stream. Drives the subagent viewer tab (R4). Prop-drilled rather than
   * re-subscribed here so there is one spawn source of truth.
   */
  subAgentSpawns: SubAgentSpawn[];
  /** Docked panel width (px), owned by ChatView (useSidePanelWidth). */
  width: number;
  /** Drag-live width update — state only, no persist. */
  onWidthChange: (px: number) => void;
  /** Persist width (drag-end / keyboard step). */
  onWidthCommit: (px: number) => void;
  /**
   * Docked flex slot whose outer width is the persisted panel width. Live drag
   * writes target this slot so the card can reserve its `mr-2` inset without
   * overflowing into the chat column.
   */
  resizeElementRef?: { current: HTMLElement | null };
  /**
   * Docked variant applies the persisted width + drag handle. The narrow-screen
   * drawer variant sets this false: the sheet controls width (w-full), so the
   * inline width and left splitter are dropped.
   */
  resizable?: boolean;
  className?: string;
}

export function ChatSidePanel({
  api,
  sessionId,
  targets,
  files,
  selectedId,
  onSelect,
  onClose,
  workspaceTabs,
  subAgentSpawns,
  width,
  onWidthChange,
  onWidthCommit,
  resizeElementRef,
  resizable = true,
  className = "",
}: ChatSidePanelProps) {
  const { t } = useTranslation();

  // ─── Tab-bar horizontal scroll / drag-pan (diagnosis ②) ──────────────────
  const tabScrollElRef = useRef<HTMLDivElement | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  // dragging = pointer is down and tracked; moved = pan threshold crossed (so
  // the trailing click is swallowed instead of selecting/closing a tab).
  const tabDragRef = useRef({ dragging: false, startX: 0, startScroll: 0, moved: false });
  useEffect(() => () => wheelCleanupRef.current?.(), []);

  // Wheel (vertical → horizontal) + overflow tracking. Bound as a NON-passive
  // native listener via a callback ref: React's onWheel is passive, so its
  // preventDefault() is ignored (and the tab strip is conditionally rendered,
  // so useEffect([]) would miss the mount). ResizeObserver keeps overflow live.
  const attachTabScroll = useCallback((node: HTMLDivElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    tabScrollElRef.current = node;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (node.scrollWidth <= node.clientWidth) return; // no overflow → let it be
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      node.scrollLeft += delta;
      event.preventDefault(); // suppress ancestor vertical scroll / history back
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    wheelCleanupRef.current = () => node.removeEventListener("wheel", onWheel);
  }, []);

  const onTabPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Mouse-only: touch already gets native `overflow-x-auto` panning; a second
    // handler would double-scroll. Right/middle buttons never start a pan.
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const el = tabScrollElRef.current;
    if (!el) return;
    tabDragRef.current = { dragging: true, startX: event.clientX, startScroll: el.scrollLeft, moved: false };
  };
  const onTabPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const st = tabDragRef.current;
    const el = tabScrollElRef.current;
    if (!st.dragging || !el) return;
    const dx = event.clientX - st.startX;
    if (!st.moved && Math.abs(dx) > TAB_DRAG_THRESHOLD_PX) {
      st.moved = true;
      el.setPointerCapture?.(event.pointerId);
      el.dataset.dragging = "true"; // cursor: grabbing, no re-render
    }
    if (st.moved) el.scrollLeft = st.startScroll - dx;
  };
  const onTabPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const st = tabDragRef.current;
    const el = tabScrollElRef.current;
    if (st.moved && el) {
      el.releasePointerCapture?.(event.pointerId);
      delete el.dataset.dragging;
    }
    st.dragging = false; // st.moved kept so onClickCapture can swallow the click
  };
  const onTabClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (tabDragRef.current.moved) {
      event.preventDefault();
      event.stopPropagation();
      tabDragRef.current.moved = false;
    }
  };

  // Dynamic max width — 12rem viewport margin == the max-w-[calc(100vw-12rem)]
  // safety cap. Evaluated live (not memoized) so a window resize mid-drag is
  // picked up by the next drag/keyboard interaction.
  const resolveSidePanelMaxWidth = useCallback(
    () => Math.max(SIDE_PANEL_MIN_WIDTH, window.innerWidth - 192),
    [],
  );
  const {
    tabs,
    activeTabId,
    browserUrlByTab,
    setActiveTabId,
    addTab,
    promoteToPinned,
    closeTab,
    setBrowserTabUrl,
  } = workspaceTabs;

  // #1444: closing a terminal tab must also kill its live PTY in the main
  // process (the store only drops the tab record). Non-terminal tabs are
  // unaffected.
  const closeWorkspaceTab = useCallback(
    (id: string) => {
      const closing = tabs.find((tab) => tab.id === id);
      if (closing?.kind === "terminal") void api.terminal?.kill(id);
      closeTab(id);
    },
    [tabs, api, closeTab],
  );

  const targetById = useMemo(
    () => new Map(targets.map((target) => [target.id, target])),
    [targets],
  );
  const browserTargets = useMemo(
    () => targets.filter((target) => BROWSER_TARGET_KINDS.has(target.kind)),
    [targets],
  );
  // #1444: the terminal tab is now a REAL interactive PTY, so the read-only
  // tool-shell command outputs (formerly filtered into the old TerminalWorkspace)
  // are folded into the review/preview tab — nothing is lost, and the terminal
  // tab hosts a live shell instead.
  const previewTargets = useMemo(
    () => targets.filter((target) => !FILE_TARGET_KINDS.has(target.kind) && !BROWSER_TARGET_KINDS.has(target.kind)),
    [targets],
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;

  // Panel-scoped launcher shortcuts (§6.10.3). Bound only while the panel is
  // mounted so ⌘T/⌘P/⌃⇧G reach the workspace rail without stealing app-wide
  // keys (none of these three are bound elsewhere — verified). Ignored when a
  // text input/textarea/contenteditable is focused so typing is not hijacked.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement) {
        const tag = activeElement.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || activeElement.isContentEditable) return;
      }
      for (const item of WORKSPACE_TAB_LAUNCHER) {
        if (item.shortcut && matchesLauncherShortcut(item.shortcut, event)) {
          event.preventDefault();
          addTab(item.kind);
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [addTab]);

  // Keep the active tab in view when it changes / the strip resizes. Uses
  // getBoundingClientRect + manual scrollLeft (not scrollIntoView) so it never
  // nudges the ancestor vertical scroll.
  useEffect(() => {
    const el = tabScrollElRef.current;
    if (!el || !activeTab) return;
    const tabEl = el.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTab.id)}"]`);
    if (!tabEl) return;
    const c = el.getBoundingClientRect();
    const r = tabEl.getBoundingClientRect();
    if (r.left < c.left) el.scrollLeft -= (c.left - r.left) + 8;
    else if (r.right > c.right) el.scrollLeft += (r.right - c.right) + 8;
  }, [activeTab, tabs.length]);

  return (
    <aside
      data-testid="chat-side-panel"
      // `width` is the complete docked flex reservation. The floating card's
      // `mr-2` consumes 0.5rem of that reservation instead of overflowing it.
      style={resizable ? { width: `calc(${width}px - 0.5rem)` } : undefined}
      className={[
        "min-h-0 min-w-0 backdrop-blur",
        resizable
          ? // Docked (resizable) variant — a FLOATING card, matching the left
            // Sidebar's visual language: margin/gap off the canvas edges,
            // rounded-2xl, shadow-e2, surface-raised bg, hairline border-subtle.
            // Previously flush-docked (border-l, no radius, bg-background) —
            // this reads as a distinct depth-tier surface instead of a seam.
            // Rounding/clipping lives on the INNER chat-preview-rail wrapper
            // (below), not this <aside> — the aside stays overflow-visible so
            // the resize bar's straddled hit-strip and any content that
            // intentionally overflows (tooltips, drag cursor) are unaffected.
            "my-2 mr-2 rounded-2xl border border-border-subtle bg-card shadow-e2"
          : // Narrow-screen drawer variant fills its WorkspaceRailDrawer sheet —
            // no floating chrome (the sheet itself is already the surface).
            "bg-background/(--opacity-solid)",
        className,
      ].join(" ")}
    >
      {resizable ? (
        <EdgeResizeBar
          width={width}
          edge="start"
          onWidthChange={onWidthChange}
          onWidthCommit={onWidthCommit}
          min={SIDE_PANEL_MIN_WIDTH}
          max={resolveSidePanelMaxWidth}
          resetWidth={SIDE_PANEL_DEFAULT_WIDTH}
          applyElementRef={resizeElementRef}
          ariaLabel={t("chatPreviewRail.resizePanel")}
          data-testid="chat-side-panel-width-splitter"
        />
      ) : null}
      <div
        data-testid="chat-preview-rail"
        className={`flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden ${resizable ? "rounded-2xl" : ""}`}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <PanelRightClose className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{t("chatPreviewRail.title")}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="icon-xs" variant="ghost" title={t("chatPreviewRail.close")} aria-label={t("chatPreviewRail.close")} onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {tabs.length > 0 ? (
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-2 py-1">
          <div
            ref={attachTabScroll}
            role="tablist"
            aria-label={t("chatPreviewRail.tabsLabel")}
            data-testid="chat-side-panel-tab-scroll"
            className="min-w-0 flex-1 cursor-grab overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden data-[dragging=true]:cursor-grabbing"
            onPointerDown={onTabPointerDown}
            onPointerMove={onTabPointerMove}
            onPointerUp={onTabPointerEnd}
            onPointerCancel={onTabPointerEnd}
            onClickCapture={onTabClickCapture}
          >
          <div className="flex min-w-max gap-1">
            {tabs.map((tab) => {
              const Icon = tabIcon(tab.kind);
              const active = tab.id === activeTab?.id;
              // Ordinal disambiguates only when 2+ CONTAINER tabs (content: null)
              // of this kind coexist; a lone container tab drops the "1".
              const showOrdinal =
                !tab.content &&
                tabs.filter((other) => !other.content && other.kind === tab.kind).length > 1;
              const label = tabLabel(tab, targetById, t, showOrdinal);
              const isEphemeral = tab.mode === "ephemeral";
              return (
                // Layout wrapper only (role="presentation"): the pin/close
                // controls are SIBLINGS of the tab button, never nested inside
                // it — an interactive-in-interactive tree is invalid HTML and an
                // a11y violation. Each is a real <button> with native keyboard
                // activation; being siblings, their clicks don't select the tab.
                <div
                  key={tab.id}
                  role="presentation"
                  data-tab-id={tab.id}
                  data-tab-mode={tab.mode}
                  className={`group flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-xs transition-colors ${
                    active ? "bg-primary/(--opacity-subtle) text-primary" : "text-muted-foreground hover:bg-muted/(--opacity-muted) hover:text-foreground"
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={tab.content ? "chat-side-panel-tab" : tabTestId(tab.kind)}
                    className="flex min-w-0 items-center gap-1 rounded-sm text-inherit focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    onClick={() => setActiveTabId(tab.id)}
                    onDoubleClick={() => promoteToPinned(tab.id)}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className={`max-w-24 truncate ${isEphemeral ? "italic" : ""}`}>{label}</span>
                  </button>
                  {isEphemeral ? (
                    <button
                      type="button"
                      aria-label={t("chatPreviewRail.pinTab")}
                      data-testid="chat-side-panel-pin-tab"
                      className="ml-0.5 rounded p-0.5 hover:bg-background/(--opacity-muted) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                      onClick={() => promoteToPinned(tab.id)}
                    >
                      <Pin className="h-3 w-3" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={t("chatPreviewRail.closeTab")}
                    className="ml-0.5 rounded p-0.5 hover:bg-background/(--opacity-muted) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    onClick={() => closeWorkspaceTab(tab.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 border-l pl-2" data-testid="chat-side-panel-tab-actions">
            <WorkspaceLauncherMenu onOpen={addTab} />
          </div>
        </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden" data-active-tab-kind={activeTab?.kind} data-active-tab-mode={activeTab?.mode}>
          {activeTab == null ? (
            <WorkspaceLauncher onOpen={addTab} />
          ) : activeTab.content ? (
            <ContentTabView api={api} sessionId={sessionId} tab={activeTab} targetById={targetById} />
          ) : activeTab.kind === "file-browser" ? (
            <FileBrowserWorkspace
              api={api}
              sessionId={sessionId}
              files={files}
              targetById={targetById}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ) : activeTab.kind === "browser" ? (
            <BrowserWorkspace
              api={api}
              tabId={activeTab.id}
              targets={browserTargets}
              selectedId={selectedId}
              onSelect={onSelect}
              manualUrl={browserUrlByTab[activeTab.id] ?? null}
              onManualUrlChange={setBrowserTabUrl}
            />
          ) : activeTab.kind === "terminal" ? (
            <PtyTerminalView api={api} tabId={activeTab.id} />
          ) : activeTab.kind === "subagent" ? (
            <SubAgentViewer
              api={api}
              {...(sessionId ? { parentSessionId: sessionId } : {})}
              subAgentSpawns={subAgentSpawns}
            />
          ) : activeTab.kind === "side-chat" ? (
            // Side chat — a second, independently-streaming chat session driven
            // by a dedicated ConversationLoop in main. The view subscribes to the
            // DEDICATED side-chat IPC channel, fully isolated from the main chat.
            <SideChatView api={api} />
          ) : (
            <PreviewWorkspace api={api} sessionId={sessionId} targets={previewTargets} selectedId={selectedId} onSelect={onSelect} />
          )}
        </div>
      </div>
    </aside>
  );
}
