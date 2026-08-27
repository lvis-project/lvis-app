import { useCallback, useState, type ReactNode } from "react";
import { Columns2, Download, PanelRightClose, PanelRightOpen, Pin, Upload, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";

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
  /** This group's OWN sidebar — its conversation list. Rendered inside the
   *  frame, so it scrolls and closes with the group rather than with the
   *  window. */
  sidebar?: ReactNode;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
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

export function ChatGroupFrame({
  title,
  actions,
  focused,
  sidebar,
  sidebarOpen,
  onToggleSidebar,
  onSplit,
  onClose,
  onFocus,
  children,
}: ChatGroupFrameProps) {
  const { t } = useTranslation();
  const sidebarLabel = sidebarOpen
    ? t("chatGroup.hideSidebar")
    : t("chatGroup.showSidebar");
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={HEADER_BUTTON_CLASS}
              onClick={onToggleSidebar}
              title={sidebarLabel}
              aria-label={sidebarLabel}
              aria-pressed={sidebarOpen}
              data-testid="chat-group-sidebar-toggle"
            >
              {sidebarOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{sidebarLabel}</TooltipContent>
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
      </header>
      {/* The group's own sidebar sits INSIDE the frame, on the trailing edge —
          the side its toggle is on. Putting it outside would make it the
          window's sidebar again, which is the thing this is not. */}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        {sidebarOpen && sidebar ? (
          <aside
            className="flex min-h-0 w-56 shrink-0 flex-col overflow-hidden border-l border-border/(--opacity-half)"
            data-testid="chat-group-sidebar"
          >
            {sidebar}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

/** A group's conversation source. Each maps to ONE ConversationLoop in main. */
type ChatGroupSource = "main" | "side";

export interface ChatGroupState {
  id: string;
  source: ChatGroupSource;
  sidebarOpen: boolean;
}

/**
 * The open chat groups, tiled.
 *
 * The list is flat and laid out along one axis rather than a split TREE. A tree
 * buys arbitrary nesting, and nothing else here can address a nested position —
 * not a keyboard command, not a restore, not a test. A flat list is the model
 * the rest of the app can actually name a group in.
 *
 * A group is bound to a conversation SOURCE, and every source is a distinct
 * ConversationLoop in main. There are two of those today (the main chat and the
 * side chat), so `canSplit` goes false at two. That is a real ceiling, not a
 * chosen one: a third tile with no loop behind it would be a chat box that
 * cannot answer, and an empty tile that looks live is worse than no tile.
 */
export function useChatGroups() {
  const [groups, setGroups] = useState<ChatGroupState[]>([
    { id: "main", source: "main", sidebarOpen: false },
  ]);
  const [focusedId, setFocusedId] = useState("main");

  const takenSources = new Set(groups.map((group) => group.source));
  const freeSource = (["main", "side"] as ChatGroupSource[]).find(
    (source) => !takenSources.has(source),
  );

  const split = useCallback(() => {
    setGroups((current) => {
      const taken = new Set(current.map((group) => group.source));
      const next = (["main", "side"] as ChatGroupSource[]).find((source) => !taken.has(source));
      if (!next) return current;
      setFocusedId(next);
      return [...current, { id: next, source: next, sidebarOpen: false }];
    });
  }, []);

  const close = useCallback((id: string) => {
    setGroups((current) => {
      // Never close the last one: a workspace with no group has no control left
      // to open one from.
      if (current.length <= 1) return current;
      const next = current.filter((group) => group.id !== id);
      setFocusedId((focused) => (focused === id ? next[0]!.id : focused));
      return next;
    });
  }, []);

  const toggleSidebar = useCallback((id: string) => {
    setGroups((current) =>
      current.map((group) =>
        group.id === id ? { ...group, sidebarOpen: !group.sidebarOpen } : group,
      ),
    );
  }, []);

  return {
    groups,
    focusedId,
    focus: setFocusedId,
    canSplit: freeSource !== undefined,
    split,
    close,
    toggleSidebar,
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
