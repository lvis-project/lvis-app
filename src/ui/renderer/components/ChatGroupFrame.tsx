import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from "react";
import {
  Columns2, Download, Maximize2, Minimize2, PanelBottomClose, PanelBottomOpen,
  Pin, Rows2, Upload, X,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { MAIN_CHAT_GROUP_ID, MAX_CHAT_GROUPS } from "../../../contract/app-contract.js";
import { SIDE_PANEL_MIN_WIDTH } from "../../../shared/side-panel.js";
import { CHROME_GAP_TIGHT } from "../../../shared/shell-geometry.js";
import type { LvisApi } from "../types.js";
import { EdgeResizeBar } from "./EdgeResizeBar.js";
import { useMeasuredSize } from "../hooks/use-edge-resize.js";
import {
  CHAT_SESSION_DRAG_TYPE,
  dropIndicatorStyle,
  dropTargetAt,
  type DropTarget,
} from "./chat-group-drop.js";
import { AXIS_OF,
  closeLeaf,
  countLeaves,
  layoutBoxes,
  layoutGutters,
  leaf,
  leafIds,
  resizeGutter,
  splitLeaf,
  type ChatGroupBox,
  type ChatGroupGutter,
  type ChatGroupNode,
  type DropEdge,
  type SplitAxis,
} from "./chat-group-tree.js";
import { TEST_IDS } from "../../../shared/test-ids.js";

/**
 * The least a tile may be dragged down to, in px.
 *
 * Width is `SIDE_PANEL_MIN_WIDTH`: DESIGN.md's 448px is the narrowest any
 * surface must work at, and a tile is one more surface held to it.
 *
 * Height has no documented floor, so it is the measured one: what the frame
 * needs to be a header, a composer, and one visible turn, below which a tile is
 * a composer with no transcript above it. Measured on the running app by
 * shrinking the window with a single tile up and reading the transcript
 * viewport, the turn goes first: at a 290px frame the viewport is 11px, at
 * 270px it is 0 and the composer starts overflowing its column. 280px is the
 * frame that still holds all three, and it is where this floor belongs — the
 * number is what the tile CONTAINS, so it moves when the composer does, not
 * when the window does.
 */
export const CHAT_GROUP_MIN_WIDTH = SIDE_PANEL_MIN_WIDTH;
export const CHAT_GROUP_MIN_HEIGHT = 280;

/** The 1px hairline the frame draws itself with, on each of its four sides. */
const CHAT_GROUP_FRAME_BORDER = 1;

/**
 * What a cell's frame loses to the air around it: the half-gutter it carries on
 * each side — two adjacent halves making the gap between tiles, which is why
 * the cell pads by `--chrome-gap-tight` rather than a full gap — plus its own
 * border. The tile floors above are on the frame's CONTENT, not on the cell, so
 * a split has to subtract this before comparing.
 */
export const CHAT_GROUP_CELL_INSET = 2 * CHROME_GAP_TIGHT + 2 * CHAT_GROUP_FRAME_BORDER;

/** Which way a tile is halved: `row` puts the new tile beside it, `column` under it. */
export type ChatGroupSplitAxis = SplitAxis;
/** The drop edge a header split on an axis stands for: the new tile trails. */
const SPLIT_EDGE: Record<ChatGroupSplitAxis, DropEdge> = { row: "right", column: "bottom" };

/**
 * The chat group: an outlined work container with its own header.
 *
 * DESIGN.md "Workbench model" is the reference. Two things it settles show up
 * directly in this file.
 *
 * FRAMING. VS Code's editor group is a bordered container, and
 * `editorGroup.focusedEmptyBorder` puts focus on the frame ITSELF — with more
 * than one group open, "which one am I typing into" has to be answerable at a
 * glance, and the frame is what answers it. That is why `focused` draws on the
 * border rather than on anything inside. DESIGN.md principle 2 discourages
 * box-in-box, and this is its stated exception: a distinct REPEATED item earns
 * a frame, and the chat group earns it precisely because it repeats.
 *
 * OWNERSHIP. Pin, export, and import act on a CONVERSATION, so they belong to
 * the part that owns the conversation — this header — not to the window band
 * they used to sit in. The work-panel toggle is here for the same reason: each
 * group owns its own panel, so the control that opens it cannot be global.
 */
export interface ChatGroupAction {
  /** Stable id — also the `data-testid` suffix and the menu command key. */
  id: string;
  label: string;
  icon: ReactNode;
  /** Rendered pressed, for toggles that have an on state (pin). */
  active?: boolean;
  onSelect: () => void | Promise<void>;
  /** When present the control opens a menu of these instead of firing. */
  items?: Array<{ id: string; label: string; onSelect: () => void | Promise<void> }>;
}

export interface ChatGroupFrameProps {
  /** Leading edge of the header. The conversation's own title. */
  title: string;
  /** Trailing edge, before the panel toggle. */
  actions: ChatGroupAction[];
  /** Whether this group currently has focus — drives the border, see above. */
  focused?: boolean;
  /** This group's WORK PANEL — the right-hand rail. It belongs to the group
   *  because it shows what THIS conversation is doing. */
  panelOpen: boolean;
  onTogglePanel: () => void;
  /**
   * Split off another group beside (`row`) or under (`column`) this one.
   * Absent when no free conversation source remains.
   */
  onSplit?: (axis: ChatGroupSplitAxis) => void;
  /**
   * Whether a split on that axis leaves both halves above the tile floors.
   * Read when the choice opens, so it sees the tile as it is then.
   */
  splitFits?: (axis: ChatGroupSplitAxis) => boolean;
  /**
   * Take a conversation dropped on this tile.
   *
   * `target` is where it landed: an edge splits this tile on that axis, the
   * centre replaces what it is holding.
   */
  onSessionDrop?: (sessionId: string, target: DropTarget) => void;
  /**
   * Whether another tile still fits.
   *
   * At the ceiling every drop resolves to the centre, so the tile highlights
   * whole rather than by halves: the limit shows up in the gesture itself
   * instead of arriving as a rejection once the user has let go.
   */
  canSplit?: boolean;
  /** Close this group. Absent on the last one — a workspace with no group is
   *  not a state the user can get back out of. */
  onClose?: () => void;
  /**
   * Show only this group, or give the others their space back. Absent while
   * the group is alone: with nothing to hide, the control would do nothing.
   */
  maximized?: boolean;
  onToggleMaximize?: () => void;
  /** Raised when anything inside the group is interacted with, so the frame
   *  can take focus. */
  onFocus?: () => void;
  children: ReactNode;
}

const HEADER_BUTTON_CLASS =
  "h-(--chrome-icon-button) w-(--chrome-icon-button) aspect-square shrink-0 p-0 text-muted-foreground hover:text-foreground";

/**
 * The header's contributed-control slot.
 *
 * Tool activity is computed from the transcript, which only the chat view
 * inside this frame can see — but the control that opens it belongs to the
 * header, one level ABOVE that view. Rather than lifting the whole activity
 * derivation into the app shell just to hand it back down, the frame publishes
 * the slot element and the view portals its control into it.
 */
const ChatGroupHeaderSlotContext = createContext<HTMLElement | null>(null);

export function useChatGroupHeaderSlot(): HTMLElement | null {
  return useContext(ChatGroupHeaderSlotContext);
}

/**
 * The work panel is the same kind of guest. It stands as tall as the tile —
 * beside the header, not under it — so the view portals it into a slot that
 * is the tile's own child. `tile` is the frame itself, the box the panel's
 * docked/overlay verdict is measured against: measuring the view would
 * measure something the panel's own width changes.
 */
export interface ChatGroupPanelSlot {
  panel: HTMLElement | null;
  tile: HTMLElement | null;
}

/**
 * `null` means no frame at all — the view is on its own and keeps the panel.
 * Inside a frame the slot is published from the first render, with `panel`
 * still null until the slot element commits; the view must tell the two
 * apart, because rendering the panel inline and then moving it into the
 * portal one render later would remount everything under it.
 */
const ChatGroupPanelSlotContext = createContext<ChatGroupPanelSlot | null>(null);

export function useChatGroupPanelSlot(): ChatGroupPanelSlot | null {
  return useContext(ChatGroupPanelSlotContext);
}

export function ChatGroupFrame({
  title,
  actions,
  focused,
  panelOpen,
  onTogglePanel,
  onSplit,
  splitFits,
  onSessionDrop,
  canSplit,
  onClose,
  maximized = false,
  onToggleMaximize,
  onFocus,
  children,
}: ChatGroupFrameProps) {
  const { t } = useTranslation();
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null);
  const [tile, setTile] = useState<HTMLElement | null>(null);
  const panelSlots = useMemo<ChatGroupPanelSlot>(() => ({ panel: panelSlot, tile }), [panelSlot, tile]);
  // The split choice is settled when the popover OPENS, not on every render:
  // the verdict reads the canvas's live size, which is a layout read that
  // belongs in an event, and a verdict taken while the popover is open is
  // what the user is looking at.
  const [splitChoice, setSplitChoice] = useState<Record<ChatGroupSplitAxis, boolean> | null>(null);
  // Choosing a direction hands focus to the NEW tile; the popover must not
  // return it to the trigger on close, or this tile would take focus back.
  const splitChosenRef = useRef(false);
  const openSplitChoice = (open: boolean) => {
    setSplitChoice(open
      ? { row: splitFits ? splitFits("row") : true, column: splitFits ? splitFits("column") : true }
      : null);
  };
  const panelLabel = panelOpen ? t("chatPreviewRail.close") : t("chatPreviewRail.open");

  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const carriesSession = (event: React.DragEvent) =>
    event.dataTransfer.types.includes(CHAT_SESSION_DRAG_TYPE);

  const readTarget = (event: React.DragEvent<HTMLElement>): DropTarget => {
    const rect = event.currentTarget.getBoundingClientRect();
    const landed = dropTargetAt(rect, { x: event.clientX, y: event.clientY });
    if (!canSplit || landed === "center") return "center";
    // An edge whose halves would fall under the tile floors demotes to the
    // centre — the drop affordance and the split control state one rule.
    return splitFits && !splitFits(AXIS_OF[landed]) ? "center" : landed;
  };

  return (
    <section
      data-testid="chat-group"
      data-focused={focused ? "true" : undefined}
      data-drop-target={dropTarget ?? undefined}
      onDragOver={onSessionDrop ? (event) => {
        if (!carriesSession(event)) return;
        // Without this the browser refuses the drop and the whole gesture ends
        // in the default "no" cursor.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropTarget(readTarget(event));
      } : undefined}
      onDragLeave={onSessionDrop ? (event) => {
        // A drag crossing a child fires leave on the section too. Only a
        // pointer that actually left the tile's box should clear the hint.
        const rect = event.currentTarget.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (!inside) setDropTarget(null);
      } : undefined}
      onDrop={onSessionDrop ? (event) => {
        if (!carriesSession(event)) return;
        event.preventDefault();
        const sessionId = event.dataTransfer.getData(CHAT_SESSION_DRAG_TYPE);
        setDropTarget(null);
        if (sessionId) onSessionDrop(sessionId, readTarget(event));
      } : undefined}
      // Focus follows interaction rather than a click on the frame itself:
      // clicking into the composer IS choosing the group, and requiring a
      // second click on the chrome to say so would be a step with no purpose.
      onFocusCapture={onFocus}
      onMouseDownCapture={onFocus}
      ref={setTile}
      className={[
        // `relative` so the drop indicator can cover the half the new tile
        // would take, in the tile's own coordinates. A row: the conversation
        // column, then the work panel's slot beside it, as tall as the tile.
        "relative flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden rounded-lg border bg-card",
        // Focus lives on the frame. `border-border` is the resting hairline;
        // the focused group swaps the whole border rather than adding a ring,
        // so a group never changes size when focus moves to it.
        focused ? "border-primary/(--opacity-half)" : "border-border",
      ].join(" ")}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        data-testid="chat-group-header"
        className="flex h-(--chrome-band-height) shrink-0 items-center gap-(--chrome-gap-tight) border-b border-border/(--opacity-half) px-(--chrome-gap)"
      >
        <h2 className="min-w-0 flex-1 truncate text-caption font-medium text-foreground">
          {title}
        </h2>
        {/* Contributed controls (tool activity) land here — LEADING of the
            conversation actions, so the pin stays the first thing in the fixed
            set no matter what the transcript contributes. */}
        <div ref={setHeaderSlot} className="flex shrink-0 items-center" data-testid="chat-group-header-slot" />
        {actions.map((action) =>
          action.items ? (
            <DropdownMenu key={action.id}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={HEADER_BUTTON_CLASS}
                      title={action.label}
                      aria-label={action.label}
                      data-testid={`chat-group-action-${action.id}`}
                    >
                      {action.icon}
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">{action.label}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-[180px]">
                {action.items.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    data-testid={`chat-group-action-${action.id}-${item.id}`}
                    onClick={() => void item.onSelect()}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Tooltip key={action.id}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={HEADER_BUTTON_CLASS}
                  onClick={() => void action.onSelect()}
                  title={action.label}
                  aria-label={action.label}
                  aria-pressed={action.active}
                  data-testid={`chat-group-action-${action.id}`}
                >
                  {action.icon}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{action.label}</TooltipContent>
            </Tooltip>
          ),
        )}
        {onSplit ? (
          // Which way to halve is the user's call — beside the chat or under
          // it — so the control drops that choice instead of guessing from
          // the tile's shape. A direction the floors cannot afford is shown
          // disabled rather than hidden: the limit reads in the control.
          <Popover open={splitChoice !== null} onOpenChange={openSplitChoice}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={HEADER_BUTTON_CLASS}
                    title={t("chatGroup.split")}
                    aria-label={t("chatGroup.split")}
                    aria-expanded={splitChoice !== null}
                    data-testid="chat-group-split"
                  >
                    <Columns2 className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("chatGroup.split")}</TooltipContent>
            </Tooltip>
            <PopoverContent
              side="bottom"
              align="end"
              sideOffset={6}
              onCloseAutoFocus={(event) => {
                if (!splitChosenRef.current) return;
                splitChosenRef.current = false;
                event.preventDefault();
              }}
              className="flex w-auto gap-1 p-1"
              aria-label={t("chatGroup.split")}
              data-testid="chat-group-split-choice"
            >
              {splitChoice && !splitChoice.row && !splitChoice.column ? (
                <p className="px-2 py-1 text-xs text-muted-foreground" data-testid="chat-group-split-no-room">
                  {t("chatGroup.splitNoRoom")}
                </p>
              ) : (["row", "column"] as const).map((axis) => (
                <Button
                  key={axis}
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-2 px-2 text-xs"
                  disabled={splitChoice ? !splitChoice[axis] : false}
                  data-testid={`chat-group-split-${axis}`}
                  onClick={() => {
                    splitChosenRef.current = true;
                    setSplitChoice(null);
                    onSplit(axis);
                  }}
                >
                  {axis === "row" ? <Columns2 className="h-4 w-4" /> : <Rows2 className="h-4 w-4" />}
                  {axis === "row" ? t("chatGroup.splitRow") : t("chatGroup.splitColumn")}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        {/* Trailing cluster: the controls that act on this GROUP as a tile —
            its work panel, its share of the area, its presence. The panel's
            own tabs live on the panel card, not here. */}
        <div className="flex h-full shrink-0 items-center gap-(--chrome-gap-tight)">
        {/* The work panel is per-GROUP. It shows what THIS conversation is
            doing, so a single window-level toggle could only ever be right for
            one of the groups on screen. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={HEADER_BUTTON_CLASS}
              onClick={onTogglePanel}
              title={panelLabel}
              aria-label={panelLabel}
              aria-pressed={panelOpen}
              data-testid={TEST_IDS.chatGroupPanelToggle}
            >
              {panelOpen ? <PanelBottomClose className="h-4 w-4" /> : <PanelBottomOpen className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{panelLabel}</TooltipContent>
        </Tooltip>
        {onToggleMaximize ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={HEADER_BUTTON_CLASS}
                onClick={onToggleMaximize}
                title={maximized ? t("chatGroup.restore") : t("chatGroup.maximize")}
                aria-label={maximized ? t("chatGroup.restore") : t("chatGroup.maximize")}
                aria-pressed={maximized}
                data-testid="chat-group-maximize"
              >
                {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{maximized ? t("chatGroup.restore") : t("chatGroup.maximize")}</TooltipContent>
          </Tooltip>
        ) : null}
        {onClose ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={HEADER_BUTTON_CLASS}
                onClick={onClose}
                title={t("chatGroup.close")}
                aria-label={t("chatGroup.close")}
                data-testid="chat-group-close"
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("chatGroup.close")}</TooltipContent>
          </Tooltip>
        ) : null}
        </div>
      </header>
      {/* The conversation list is the WINDOW's sidebar and only that. A second
          copy of it inside the frame said the same thing twice and cost the
          transcript the width to say it. */}
      <ChatGroupHeaderSlotContext.Provider value={headerSlot}>
        <ChatGroupPanelSlotContext.Provider value={panelSlots}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        </ChatGroupPanelSlotContext.Provider>
      </ChatGroupHeaderSlotContext.Provider>
      </div>
      {/* The work panel lands here: `contents` makes what the view portals
          in the tile's own flex item (a column beside the conversation) or,
          floating, a box positioned against the tile. */}
      <div ref={setPanelSlot} className="contents" data-testid="chat-group-panel-slot" />
      {dropTarget ? (
        <div
          aria-hidden={true}
          className="pointer-events-none absolute rounded-md border-2 border-primary bg-primary/(--opacity-subtle)"
          style={dropIndicatorStyle(dropTarget)}
          data-testid="chat-group-drop-indicator"
        />
      ) : null}
    </section>
  );
}

const groupApiCache = new WeakMap<LvisApi, Map<string, LvisApi>>();

/**
 * One group's view of the api.
 *
 * `chatGroup()` rebinds the per-CONVERSATION channels only. Settings, plugins,
 * the session list, and everything else a tile reaches for come from other
 * preload surfaces and are window-scoped, so the group binding is LAYERED over
 * the full api rather than replacing it — handing a tile the bare binding gives
 * it an api that is missing most of itself.
 *
 * The primary group needs no layer: the top-level surface is already bound to
 * it. A surface WITHOUT the binding — a test double, an older preload — can
 * therefore still serve the primary, and only the primary; returning it for
 * another tile would put that tile's turns in the primary conversation, so it
 * refuses instead.
 *
 * Layered views are memoized per api and group because a tile passes this as a
 * prop, and a fresh object every render would defeat every memo below it.
 */
export function chatGroupApi(api: LvisApi, chatGroupId: string): LvisApi {
  if (chatGroupId === MAIN_CHAT_GROUP_ID) return api;
  if (!api.chatGroup) throw new Error(`chat-group-unavailable:${chatGroupId}`);

  let perGroup = groupApiCache.get(api);
  if (!perGroup) {
    perGroup = new Map();
    groupApiCache.set(api, perGroup);
  }
  const cached = perGroup.get(chatGroupId);
  if (cached) return cached;

  const layered = { ...api, ...api.chatGroup(chatGroupId) } as LvisApi;
  perGroup.set(chatGroupId, layered);
  return layered;
}

export interface ChatGroupState {
  id: string;
  /** The work panel, per group — see ChatGroupFrameProps.panelOpen. */
  panelOpen: boolean;
  /** Where this tile sits, in percentages of the main area. */
  box: ChatGroupBox;
}

/**
 * The open chat groups, tiled.
 *
 * The geometry is a split tree — see `chat-group-tree.ts` and
 * docs/design/tiled-chat-groups.md. Tiles are arranged freely, tmux style: a
 * session dropped on a tile's edge splits that tile on that axis, so 1, 2, 3,
 * and 4 tiles are each reachable in more than one shape.
 *
 * A group is bound to a conversation SOURCE, and every source is a distinct
 * ConversationLoop in main — `MAX_CHAT_GROUPS` is that ceiling, counted in
 * LEAVES and including the primary. Chat mode holds exactly one: it is the
 * focused-writing mode, and a second tile there would be the thing it exists
 * to remove.
 */
export function useChatGroups(appMode?: "chat" | "work") {
  const [tree, setTree] = useState<ChatGroupNode>(() => leaf(MAIN_CHAT_GROUP_ID));
  const [panelOpenIds, setPanelOpenIds] = useState<readonly string[]>([]);
  const [focusedId, setFocusedId] = useState(MAIN_CHAT_GROUP_ID);
  // The one tile shown alone, if any. A view choice, like chat mode's: the
  // others keep their conversations and their places until restored.
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  // Monotonic, so a closed tile's id is never reused within this renderer.
  // Main-process loops are keyed by this id, and reusing one would hand a
  // new tile the previous tile's live history. (A reload starts the count
  // over — main lets every group go when the renderer navigates, so the
  // fresh count meets no stale loop.)
  const nextGroupIndex = useRef(2);

  const setPanelOpen = useCallback((id: string, open: boolean) => {
    setPanelOpenIds((current) => {
      const has = current.includes(id);
      if (has === open) return current;
      return open ? [...current, id] : current.filter((each) => each !== id);
    });
  }, []);

  /**
   * Drop a new conversation on `targetGroupId`'s `edge`.
   *
   * Returns the new group's id, or null when the ceiling is already reached —
   * the caller shows no edge affordance in that case, so the limit is visible
   * in the gesture rather than as a rejection after the fact.
   */
  const dropOnEdge = useCallback((targetGroupId: string, edge: DropEdge): string | null => {
    if (countLeaves(tree) >= MAX_CHAT_GROUPS) return null;
    const id = `group-${nextGroupIndex.current}`;
    nextGroupIndex.current += 1;
    setTree((current) => splitLeaf(current, targetGroupId, edge, id));
    setFocusedId(id);
    // A tile added behind a maximized one would be a tile nobody can see.
    setMaximizedId(null);
    return id;
  }, [tree]);

  /**
   * The header's split: halve `groupId` on `axis`, the new tile trailing —
   * beside it for `row`, under it for `column`. The direction is the user's;
   * the control offers only the ones {@link splitFits} allows.
   */
  const split = useCallback((groupId: string, axis: ChatGroupSplitAxis) => {
    dropOnEdge(groupId, SPLIT_EDGE[axis]);
  }, [dropOnEdge]);

  /**
   * Whether halving `groupId` on `axis` leaves both halves at or above the
   * tile floors, given the canvas the percentages are laid out in. An
   * unmeasured canvas (no element yet) affords any split: nothing to check
   * against, and the gutter floors still hold once it is laid out.
   */
  const splitFits = useCallback((groupId: string, axis: ChatGroupSplitAxis, canvasSize: { width: number; height: number } | undefined) => {
    if (!canvasSize) return true;
    const box = layoutBoxes(tree).find((each) => each.chatGroupId === groupId);
    if (!box) return false;
    const extent = axis === "row"
      ? (box.width / 100) * canvasSize.width
      : (box.height / 100) * canvasSize.height;
    const floor = axis === "row" ? CHAT_GROUP_MIN_WIDTH : CHAT_GROUP_MIN_HEIGHT;
    // Each half is a cell; the floor is on what the cell's frame gets to use.
    return extent / 2 - CHAT_GROUP_CELL_INSET >= floor;
  }, [tree]);

  // Any tile but the last can go, the primary included: once split, the
  // primary is one tile among the others to the user, and a close that works
  // on every tile but one reads as a bug on that one. Its loop stays — main
  // gives it a blank conversation on release rather than tearing it down.
  const close = useCallback((id: string) => {
    const next = closeLeaf(tree, id);
    if (next === tree) return;
    const survivors = leafIds(next);
    setTree(next);
    setFocusedId((focused) => (survivors.includes(focused) ? focused : survivors[0]!));
    setMaximizedId((current) => (current === id ? null : current));
    setPanelOpenIds((current) => current.filter((each) => each !== id));
  }, [tree]);

  const toggleMaximize = useCallback((id: string) => {
    setMaximizedId((current) => (current === id ? null : id));
    setFocusedId(id);
  }, []);

  // Chat mode collapses to the focused tile rather than closing the others:
  // switching modes is a view change, and losing a conversation to it would
  // make the toggle destructive. Maximizing is the same kind of choice, made
  // in work mode; chat mode's own rule wins there, and since maximizing also
  // focuses the tile the two agree on which one that is. `maximizedId` is
  // always a tile the tree holds — closing that tile and adding another both
  // clear it — so it is shown without a second check.
  const shownAlone = appMode === "chat" ? focusedId : maximizedId;
  const visibleTree: ChatGroupNode = shownAlone === null ? tree : leaf(shownAlone);
  const groups = useMemo<ChatGroupState[]>(
    () => layoutBoxes(visibleTree).map((box) => ({
      id: box.chatGroupId,
      panelOpen: panelOpenIds.includes(box.chatGroupId),
      box,
    })),
    // `visibleTree` is rebuilt each render in chat mode, so the tree and the
    // mode are the honest dependencies here, not the derived node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, appMode, focusedId, maximizedId, panelOpenIds],
  );

  // Once split, every tile can be closed and any one can be shown alone —
  // even while one is: the tree, not the view, says how many there are. Not
  // in chat mode, though: it shows one tile and nothing of the others, so a
  // close there would swap in a conversation the user has no way to expect.
  const closable = appMode !== "chat" && countLeaves(tree) > 1;
  const canMaximize = appMode !== "chat" && countLeaves(tree) > 1;

  // Both halves can serve MAX_CHAT_GROUPS conversations now: main gives every
  // group its own ConversationLoop and labels every stream frame, and each tile
  // owns its conversation state through ChatGroupSession. The ceiling is the
  // number of loops, nothing weaker.
  const canSplit = appMode !== "chat" && countLeaves(tree) < MAX_CHAT_GROUPS;

  // Boundaries between tiles. Chat mode shows one leaf, so there are none.
  const gutters = useMemo(
    () => layoutGutters(visibleTree),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, appMode, focusedId, maximizedId],
  );

  const resize = useCallback((gutter: Pick<ChatGroupGutter, "path" | "index">, leadingShare: number) => {
    setTree((current) => resizeGutter(current, gutter, leadingShare));
  }, []);

  /**
   * Where everything WOULD be with the gutter at `leadingShare`, without
   * committing it — what a drag paints frame by frame. The tree is committed
   * once, at the end, so a drag does not re-render four conversations per
   * pointer move.
   */
  const previewResize = useCallback(
    (gutter: Pick<ChatGroupGutter, "path" | "index">, leadingShare: number) => {
      const next = resizeGutter(tree, gutter, leadingShare);
      return { boxes: layoutBoxes(next), gutters: layoutGutters(next) };
    },
    [tree],
  );

  return {
    groups,
    gutters,
    tree,
    focusedId,
    focus: setFocusedId,
    setPanelOpen,
    canSplit,
    split,
    splitFits,
    dropOnEdge,
    resize,
    previewResize,
    close,
    closable,
    canMaximize,
    maximizedId,
    toggleMaximize,
  };
}

/** Percent geometry → the inline style a cell or gutter is positioned with. */
export function areaStyle(box: { left: number; top: number; width: number; height: number }) {
  return {
    left: `${box.left}%`,
    top: `${box.top}%`,
    width: `${box.width}%`,
    height: `${box.height}%`,
  };
}

export interface ChatGroupGutterProps {
  gutter: ChatGroupGutter;
  /** The tile area, for turning percentages into the pixels the floors are in. */
  canvasRef: RefObject<HTMLElement | null>;
  previewResize: (gutter: ChatGroupGutter, leadingShare: number) => {
    boxes: ChatGroupBox[];
    gutters: ChatGroupGutter[];
  };
  onResize: (gutter: ChatGroupGutter, leadingShare: number) => void;
}

/**
 * The draggable boundary between two tiles.
 *
 * It is the same `EdgeResizeBar` the sidebar and the side panel resize with,
 * standing on the boundary instead of on a panel's edge: the leading tile is
 * the "panel", its extent along the split's axis is the "width", and the
 * trailing tile takes whatever is left of the pair. The floors are in pixels,
 * so the bar converts through the canvas size — the tree only knows shares.
 *
 * While dragging, the new layout is written straight to the cells' and
 * gutters' style — the same DOM-direct path the sidebar uses — and the tree
 * is committed once on release. Committing per move would re-render every
 * conversation on screen for every pointer event.
 */
export function ChatGroupGutter({ gutter, canvasRef, previewResize, onResize }: ChatGroupGutterProps) {
  const { t } = useTranslation();
  const canvas = useMeasuredSize(canvasRef);
  const along = gutter.axis === "row" ? canvas.width : canvas.height;
  const pairPx = (along * (gutter.leading + gutter.trailing)) / 100;
  const floor = gutter.axis === "row" ? CHAT_GROUP_MIN_WIDTH : CHAT_GROUP_MIN_HEIGHT;
  const leadingPx = (along * gutter.leading) / 100;

  const paint = useCallback((leadingShare: number) => {
    const root = canvasRef.current;
    if (!root) return;
    const next = previewResize(gutter, leadingShare);
    for (const box of next.boxes) {
      const cell = root.querySelector<HTMLElement>(`[data-testid="chat-group-cell:${box.chatGroupId}"]`);
      if (cell) Object.assign(cell.style, areaStyle(box));
    }
    for (const each of next.gutters) {
      const bar = root.querySelector<HTMLElement>(`[data-testid="chat-group-gutter:${each.key}"]`);
      if (bar) Object.assign(bar.style, areaStyle(each));
    }
  }, [canvasRef, gutter, previewResize]);

  // A pair that cannot fit two floors has nothing to give. No bar, rather
  // than a bar that snaps back on every drag.
  if (pairPx < floor * 2) return null;

  return (
    <div
      className="absolute"
      style={areaStyle(gutter)}
      data-testid={`chat-group-gutter:${gutter.key}`}
    >
      <EdgeResizeBar
        width={leadingPx}
        edge="end"
        axis={gutter.axis === "row" ? "x" : "y"}
        min={floor}
        max={pairPx - floor}
        resetWidth={pairPx / 2}
        onWidthChange={(px) => paint(px / pairPx)}
        onWidthCommit={(px) => onResize(gutter, px / pairPx)}
        ariaLabel={t("chatGroup.resize")}
        data-testid={`chat-group-gutter-bar:${gutter.key}`}
      />
    </div>
  );
}

/**
 * The conversation action set, in ONE place.
 *
 * The header renders these as buttons; the sidebar row offers the same set in
 * its context menu. DESIGN.md is explicit that the two surfaces "must not
 * disagree about what is possible", and the only way to guarantee that is for
 * both to read the same descriptor rather than each listing actions itself.
 *
 * Ids are the `conversation.*` names from `shared/native-context-menu.ts` so
 * the header button and the row's menu entry are the same command spelled the
 * same way, not two spellings that happen to do the same thing today.
 */
export function buildChatGroupActions({
  t,
  pinned,
  onTogglePin,
  onExport,
  onImport,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  pinned: boolean;
  onTogglePin: () => void | Promise<void>;
  onExport: (format: "markdown" | "json") => void | Promise<void>;
  onImport: () => void | Promise<void>;
}): ChatGroupAction[] {
  return [
    {
      // The label states what the click DOES, which flips with state. A fixed
      // "Pin" would be wrong half the time for a screen reader, and that costs
      // more than a tooltip whose text changes under the cursor — the tooltip
      // is already gone by the time the state has changed.
      id: pinned ? "conversation.unpin" : "conversation.pin",
      label: pinned ? t("mainToolbar.sessionUnstar") : t("mainToolbar.sessionStar"),
      active: pinned,
      icon: (
        <Pin
          // Keyed so React remounts on toggle: the fill animation is a mount
          // animation, and without the key it would never replay.
          key={pinned ? "on" : "off"}
          className={`h-4 w-4 ${pinned ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`}
        />
      ),
      onSelect: onTogglePin,
    },
    {
      id: "conversation.export",
      label: t("mainToolbar.export"),
      icon: <Download className="h-4 w-4" />,
      // Two formats, so this opens a menu rather than firing. The frame reads
      // `items` to decide that — the caller does not pick the control type.
      items: [
        { id: "markdown", label: t("sidebar.exportMarkdown"), onSelect: () => onExport("markdown") },
        { id: "json", label: t("sidebar.exportJson"), onSelect: () => onExport("json") },
      ],
      onSelect: () => {},
    },
    {
      id: "conversation.import",
      label: t("mainToolbar.import"),
      icon: <Upload className="h-4 w-4" />,
      onSelect: onImport,
    },
  ];
}
