import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Columns2, Download, PanelBottomClose, PanelBottomOpen,
  Pin, Upload, X,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { MAIN_CHAT_GROUP_ID, MAX_CHAT_GROUPS } from "../../../contract/app-contract.js";
import type { LvisApi } from "../types.js";
import {
  closeLeaf,
  countLeaves,
  layoutBoxes,
  leaf,
  leafIds,
  splitLeaf,
  type ChatGroupBox,
  type ChatGroupNode,
  type DropEdge,
} from "./chat-group-tree.js";

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
  /** Split off another group. Absent when no free conversation source remains. */
  onSplit?: () => void;
  /** Close this group. Absent on the last one — a workspace with no group is
   *  not a state the user can get back out of. */
  onClose?: () => void;
  /** Raised when anything inside the group is interacted with, so the frame
   *  can take focus. */
  onFocus?: () => void;
  children: ReactNode;
}

const HEADER_BUTTON_CLASS =
  "h-6 w-6 aspect-square shrink-0 p-0 text-muted-foreground hover:text-foreground";

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
 * The work panel's share of the header.
 *
 * The panel is a COLUMN of the group, so the header line above it belongs to
 * the panel the same way the rest of the line belongs to the conversation —
 * one band across the group, split where the columns split. That is why the
 * panel has no title row of its own: its tabs ARE its header.
 *
 * The panel reports its own width up so the band can match it; the frame owns
 * the width because the toggle that closes the panel has to sit inside the
 * band even when there is no panel to portal anything into it.
 */
export interface ChatGroupPanelBand {
  slot: HTMLElement | null;
  setWidth: (px: number | null) => void;
}

const ChatGroupPanelBandContext = createContext<ChatGroupPanelBand | null>(null);

export function useChatGroupPanelBand(): ChatGroupPanelBand | null {
  return useContext(ChatGroupPanelBandContext);
}

export function ChatGroupFrame({
  title,
  actions,
  focused,
  panelOpen,
  onTogglePanel,
  onSplit,
  onClose,
  onFocus,
  children,
}: ChatGroupFrameProps) {
  const { t } = useTranslation();
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [panelSlot, setPanelSlot] = useState<HTMLDivElement | null>(null);
  const [panelBandWidth, setPanelBandWidth] = useState<number | null>(null);
  const panelBand = useMemo<ChatGroupPanelBand>(
    () => ({ slot: panelSlot, setWidth: setPanelBandWidth }),
    [panelSlot],
  );
  const panelLabel = panelOpen ? t("chatPreviewRail.close") : t("chatPreviewRail.open");
  return (
    <section
      data-testid="chat-group"
      data-focused={focused ? "true" : undefined}
      // Focus follows interaction rather than a click on the frame itself:
      // clicking into the composer IS choosing the group, and requiring a
      // second click on the chrome to say so would be a step with no purpose.
      onFocusCapture={onFocus}
      onMouseDownCapture={onFocus}
      className={[
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card",
        // Focus lives on the frame. `border-border` is the resting hairline;
        // the focused group swaps the whole border rather than adding a ring,
        // so a group never changes size when focus moves to it.
        focused ? "border-primary/(--opacity-half)" : "border-border",
      ].join(" ")}
    >
      <header
        data-testid="chat-group-header"
        className="flex h-9 shrink-0 items-center gap-1 border-b border-border/(--opacity-half) px-2"
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={HEADER_BUTTON_CLASS}
                onClick={onSplit}
                title={t("chatGroup.split")}
                aria-label={t("chatGroup.split")}
                data-testid="chat-group-split"
              >
                <Columns2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("chatGroup.split")}</TooltipContent>
          </Tooltip>
        ) : null}
        {/* The panel's share of the header line: its tabs on the left, the
            control that closes it on the right, sized to the panel column so
            the divider between them is ONE line from the header to the bottom
            of the group. */}
        <div
          data-testid="chat-group-panel-band"
          className={[
            "flex h-full shrink-0 items-center gap-1",
            // `-mr-2` cancels the header's own right padding so the band's
            // right edge is the GROUP's inner edge — the same edge the panel
            // column ends on. Without it the band sits 8px inboard and its
            // divider misses the column's by exactly that much.
            panelBandWidth === null ? "" : "-mr-2 border-l border-border/(--opacity-half) pl-2 pr-2",
          ].join(" ")}
          style={panelBandWidth === null ? undefined : { width: `${panelBandWidth}px` }}
        >
          <div
            ref={setPanelSlot}
            className="flex h-full min-w-0 flex-1 items-center overflow-hidden"
            data-testid="chat-group-panel-slot"
          />
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
              data-testid="chat-group-panel-toggle"
            >
              {panelOpen ? <PanelBottomClose className="h-4 w-4" /> : <PanelBottomOpen className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{panelLabel}</TooltipContent>
        </Tooltip>
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
        <ChatGroupPanelBandContext.Provider value={panelBand}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        </ChatGroupPanelBandContext.Provider>
      </ChatGroupHeaderSlotContext.Provider>
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
  // Monotonic, so a closed tile's id is never reused. Main-process loops are
  // keyed by this id, and reusing one would hand a new tile the previous
  // tile's live history.
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
    return id;
  }, [tree]);

  /** The split control: same thing as a drop on the focused tile's right edge. */
  const split = useCallback(() => {
    dropOnEdge(focusedId, "right");
  }, [dropOnEdge, focusedId]);

  const close = useCallback((id: string) => {
    // The primary group is the window's conversation. Closing it would leave
    // no tile that the session list, resume, and restore all address.
    if (id === MAIN_CHAT_GROUP_ID) return;
    setTree((current) => {
      const next = closeLeaf(current, id);
      if (next === current) return current;
      const survivors = leafIds(next);
      setFocusedId((focused) => (survivors.includes(focused) ? focused : survivors[0]!));
      return next;
    });
    setPanelOpenIds((current) => current.filter((each) => each !== id));
  }, []);

  // Chat mode collapses to the focused tile rather than closing the others:
  // switching modes is a view change, and losing a conversation to it would
  // make the toggle destructive.
  const visibleTree = appMode === "chat" ? leaf(focusedId) : tree;
  const groups = useMemo<ChatGroupState[]>(
    () => layoutBoxes(visibleTree).map((box) => ({
      id: box.chatGroupId,
      panelOpen: panelOpenIds.includes(box.chatGroupId),
      box,
    })),
    // `visibleTree` is rebuilt each render in chat mode, so the tree and the
    // mode are the honest dependencies here, not the derived node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, appMode, focusedId, panelOpenIds],
  );

  // The main process can serve MAX_CHAT_GROUPS conversations: every channel is
  // group-addressed and every stream frame is labelled. The RENDERER cannot yet
  // — App still owns one set of conversation state for the window
  // (useChatState, useSendMessage, and the per-turn handlers), so a second tile
  // would render the first tile's transcript over its own group's stream.
  //
  // Phase 3 in docs/design/tiled-chat-groups.md extracts that state per group.
  // When it lands this constant goes away and the ceiling is MAX_CHAT_GROUPS.
  // Until then the honest ceiling is one: a split button that produced a tile
  // showing another conversation is worse than no split button.
  const RENDERER_GROUP_CEILING = 1;
  const ceiling = Math.min(MAX_CHAT_GROUPS, RENDERER_GROUP_CEILING);
  const canSplit = appMode !== "chat" && countLeaves(tree) < ceiling;

  return {
    groups,
    tree,
    focusedId,
    focus: setFocusedId,
    setPanelOpen,
    canSplit,
    /** True while a drop would actually be honoured — gates the edge affordance. */
    canDrop: canSplit,
    split,
    dropOnEdge,
    close,
  };
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
