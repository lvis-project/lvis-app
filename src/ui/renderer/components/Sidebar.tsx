import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { EdgeResizeBar } from "./EdgeResizeBar.js";
import { ViewHistoryNav, type ViewPathNavProps } from "./ViewPathNav.js";
import {
  CalendarDays,
  Folder,
  KanbanSquare,
  KeyRound,
  MessageSquareText,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PowerOff,
  Plus,
  Repeat2,
  Search,
  ShoppingBag,
  Wrench,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { getPluginViewLabel, toViewKey } from "../api-client.js";
import { toPluginDoctorViewKey, toPluginSettingsViewKey } from "../utils/plugin-doctor-view.js";
import { pluginIconFor } from "../utils/plugin-icon.js";
import { sortWithPinnedFirst } from "../utils/pinned-sort.js";
import type { SidebarTab } from "../hooks/use-sidebar-tab.js";
import type { SubscriptionRuntimeUiPolicy } from "../utils/subscription-runtime-ui-policy.js";
import {
  useNativeContextMenu,
  type NativeContextMenuHandlers,
} from "../hooks/use-native-context-menu.js";
import {
  useAddProjectFolder,
  type AddProjectFolderOutcome,
  type ProjectErrorReporter,
} from "../hooks/use-add-project-folder.js";
import { isSidebarTab } from "../../../shared/sidebar-tab.js";
import type { InlineViewKey } from "../../../shared/view-key.js";
import type { PluginCardSummary, PluginUiExtension } from "../types.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import { projectRootEquals, workspaceRootsToProjects } from "../../../shared/project-identity.js";
import { CHAT_SESSION_DRAG_TYPE } from "./chat-group-drop.js";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../../../shared/side-panel.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SidebarProps {
  activeView: InlineViewKey;
  /** Called with the selected key — same contract as handleViewSelect, which
   *  also accepts the `plugin-doctor:<id>` pseudo-key that is intercepted
   *  before it can become a location. Hence `string`, not `ViewKey`. */
  onSelect: (viewKey: string) => void;
  /** Plugin views from usePluginMarketplace — same list passed to the main content region. */
  pluginViews: PluginUiExtension[];
  /** Installed plugins that failed to load and therefore need Settings → Plugin Doctor. */
  failedPluginCards?: PluginCardSummary[];
  /**
   * Installed plugins the user has switched off that reserve a sidebar slot.
   * They are shown here — greyed, badged "off", no repair affordance — because
   * an inactive plugin that renders nowhere is indistinguishable from one the
   * app dropped, which is the exact confusion this list exists to end.
   */
  inactivePluginCards?: PluginCardSummary[];
  /** Auth-status map: pluginId → { kind: "authed" | "unauthed" | ... }. */
  pluginAuthStatuses?: ReadonlyMap<string, { kind: string }>;
  /** Whether the user has an API key configured — drives the settings warning. */
  hasApiKey: boolean | null;
  /** Canonical subscription readiness policy; legacy booleans are fallback-only. */
  subscriptionRuntimePolicy?: SubscriptionRuntimeUiPolicy;
  /** Selected subscription runtime needs sign-in or verification. */
  subscriptionUnavailable?: boolean;
  /** Selected subscription runtime is still checking whether chat is available. */
  subscriptionPending?: boolean;
  onOpenSettings: () => void;
  onNewChat: () => void;
  streaming: boolean;
  /**
   * Change 3: Marketplace jump button. Opens the plugin marketplace overlay.
   * Moved from PluginGridButton (InputActionBar) → Sidebar so marketplace is
   * reachable from the persistent nav rail (PluginGridButton removed in change 2).
   */
  onOpenMarketplace: () => void;
  /** `true` once the marketplace URL has finished loading. Controls button enabled state. */
  marketplaceUrlReady?: boolean;
  /**
   * Collapse state is owned by the shell (App.tsx). The collapse/expand toggle
   * is the FIRST button in the cluster strip next to the traffic lights (see
   * `onToggleCollapse`). When `true` the card body retracts and the cluster
   * pops OUT of the floating surface into the bare band.
   */
  collapsed: boolean;
  /** Toggle the rail — the leading cluster button next to the traffic lights. */
  onToggleCollapse: () => void;
  /** Expanded card width (px). Ignored while collapsed (fixed icon rail). */
  width?: number;
  /** Per-move drag update of the sidebar width (state only). */
  onWidthChange?: (px: number) => void;
  /** Drag-end / keyboard commit of the sidebar width (persist). Also drives
   *  the resize bar's double-click reset (commits SIDEBAR_DEFAULT_WIDTH). */
  onWidthCommit?: (px: number) => void;
  /** Open the unified search overlay — second button in the cluster strip. */
  onOpenUnifiedSearch: () => void;
  /** Route path + history. The sidebar renders only the HISTORY half in its
   *  cluster strip; App renders the path half on the canvas. */
  viewNav: ViewPathNavProps;
  /** Recent main-chat sessions shown under the current project group. */
  sessions?: SessionSummary[];
  /** Workspace projects from the App-level active project source of truth. */
  projects?: ProjectIdentity[];
  /** Active chat session id for project conversation selection state. */
  currentSessionId?: string;
  /** Load a selected session from the project conversation list. */
  onLoadSession?: (sessionId: string) => boolean | void | Promise<boolean | void>;
  /** Start a new main-chat session scoped to the selected project root. */
  onNewChatForProject?: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  /** Re-fetch the workspace project list (after a context-menu mutation e.g. remove). */
  onRefreshProjects?: () => void | Promise<void>;
  /** Surface a refused project mutation — an add or a remove — to the user. */
  onProjectError?: ProjectErrorReporter;
  /** Active sidebar tab ("chats" = ungrouped conversation list, "projects" = named-project groups). Persisted (SystemSettings). */
  activeSidebarTab?: SidebarTab;
  /** Switch the active sidebar tab — persists immediately. */
  onActiveSidebarTabChange?: (tab: SidebarTab) => void;
  /** Per-conversation pin state — reuses the existing starred-session mechanism (id truthy = pinned). */
  isSessionStarred?: (sessionId: string) => string | null;
  /** Toggle a conversation's pin state (any row, not just the active session). */
  onToggleSessionStar?: (sessionId: string, title?: string) => void | Promise<void>;
  /** True when the given project root is pinned — pinned projects sort to the top of the Projects tab. */
  isProjectPinned?: (projectRoot: string | undefined) => boolean;
  /** Pin/unpin a project — persists immediately (SystemSettings). */
  onToggleProjectPin?: (projectRoot: string) => void;
  /** What a conversation row can do to itself — see ConversationRowActions. */
  conversationActions?: ConversationRowActions;
  /** What a project row can do to itself — see ProjectRowActions. */
  projectActions?: ProjectRowActions;
}

// ─── Platform bridge (darwin traffic-light line) ───────────────────────────────
// On macOS the OS draws the traffic lights at {x:18,y:16} (≈12px diameter, so
// their visual center sits at ≈y:22, ≈x:[18..76]). The floating card is anchored
// at top-2 (8px) so the h-7 cluster strip's center lands on that line; the strip
// carries a left clearance (≈76px) so its leftmost button starts at x≈84, just


// out bare in the band when collapsed.
// Returns false when the preload bridge is absent (jsdom / Storybook / SSR) —
// no native chrome to align against there.
function isDarwinPlatform(): boolean {
  return (
    (window as unknown as { lvisPlatform?: { isDarwin: boolean } }).lvisPlatform?.isDarwin ?? false
  );
}

// ─── NavItem ─────────────────────────────────────────────────────────────────

/**
 * Per-section hover tone. Primary nav reads as the main surface (`accent`);
 * the footer reads as secondary (`muted`), so its rows tint a step softer on
 * hover. Both are theme tokens — a bundle switch re-tints every surface and
 * the color-token gate stays clean (no raw literals).
 */
type NavTone = "accent" | "muted" | "home" | "marketplace" | "settings";

/**
 * Per-tone styling: `hover` (inactive hover tint), `active` (selected bg+text),
 * `bar` (the left active-indicator bar color). The footer trio (Home /
 * Marketplace / Settings) each carry a distinct color so the ACTIVE state
 * matches that item's hover tint (e.g. Home = blue/info on both hover AND
 * active, not the shared primary). All theme tokens — the color-token gate
 * stays clean.
 */
const NAV_TONE: Record<NavTone, { hover: string; active: string; bar: string }> = {
  accent: {
    hover: "hover:bg-accent hover:text-accent-foreground",
    active: "bg-primary/(--opacity-subtle) text-primary",
    bar: "bg-primary",
  },
  muted: {
    hover: "hover:bg-muted hover:text-foreground",
    active: "bg-primary/(--opacity-subtle) text-primary",
    bar: "bg-primary",
  },
  home: {
    hover: "hover:bg-info/(--opacity-light) hover:text-foreground",
    active: "bg-info/(--opacity-light) text-info",
    bar: "bg-info",
  },
  marketplace: {
    hover: "hover:bg-primary/(--opacity-subtle) hover:text-foreground",
    active: "bg-primary/(--opacity-subtle) text-primary",
    bar: "bg-primary",
  },
  settings: {
    hover: "hover:bg-success/(--opacity-faint) hover:text-foreground",
    active: "bg-success/(--opacity-faint) text-success",
    bar: "bg-success",
  },
};

interface NavItemProps {
  viewKey: string;
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  collapsed: boolean;
  /** Hover tone for the inactive state. Defaults to the primary `accent` surface. */
  tone?: NavTone;
  "data-testid"?: string;
  "data-viewkey"?: string;
  "data-tour-anchor"?: string;
  title?: string;
  tooltipLabel?: string;
  trailingSlot?: React.ReactNode;
}

function NavItem({
  viewKey: _viewKey,
  label,
  icon,
  isActive,
  onClick,
  collapsed,
  tone = "accent",
  "data-testid": testId,
  "data-viewkey": dataViewKey,
  "data-tour-anchor": tourAnchor,
  title,
  tooltipLabel,
  trailingSlot,
}: NavItemProps) {
  const toneStyle = NAV_TONE[tone];
  const btn = collapsed ? (
    /* Collapsed — perfectly square icon button */
    <button
      type="button"
      onClick={onClick}
      aria-current={isActive ? "page" : undefined}
      aria-label={title}
      title={title}
      data-testid={testId}
      data-viewkey={dataViewKey}
      data-tour-anchor={tourAnchor}
      className={[
        "relative h-9 w-9 aspect-square flex items-center justify-center rounded-md transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive
          ? toneStyle.active
          : `text-muted-foreground ${toneStyle.hover}`,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isActive && (
        <span className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-full ${toneStyle.bar}`} />
      )}
      <span className="h-4 w-4 flex items-center justify-center">{icon}</span>
    </button>
  ) : (
    /* Expanded — full-width row */
    <button
      type="button"
      onClick={onClick}
      aria-current={isActive ? "page" : undefined}
      aria-label={title}
      title={title}
      data-testid={testId}
      data-viewkey={dataViewKey}
      data-tour-anchor={tourAnchor}
      className={[
        "relative w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive
          ? `${toneStyle.active} font-medium`
          : `text-muted-foreground ${toneStyle.hover}`,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isActive && (
        <span className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full ${toneStyle.bar}`} />
      )}
      <span className="shrink-0 h-4 w-4 flex items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate flex-1 text-left">{label}</span>
      {trailingSlot && (
        <span className="ml-auto shrink-0">{trailingSlot}</span>
      )}
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* btn is already the collapsed square button element */}
          {btn}
        </TooltipTrigger>
        <TooltipContent side="right">{tooltipLabel ?? title ?? label}</TooltipContent>
      </Tooltip>
    );
  }

  return btn;
}

function FailedPluginNavItem({
  plugin,
  onSelect,
  collapsed,
}: {
  plugin: PluginCardSummary;
  onSelect: (key: string) => void;
  collapsed: boolean;
}) {
  const { t } = useTranslation();
  const viewKey = toPluginDoctorViewKey(plugin.id);
  const label = plugin.name || plugin.id;
  const title = t("sidebar.pluginDoctorRequiredTitle", { label });
  const IconComponent = pluginIconFor({
    icon: plugin.icon,
    iconText: plugin.iconText,
  });
  const trailingSlot = (
    <span
      className="rounded-full bg-destructive/(--opacity-soft) px-1.5 py-px text-[9px] font-medium text-destructive"
      aria-label={t("sidebar.pluginDoctorRequiredAriaLabel")}
    >
      {t("sidebar.pluginDoctorBadge")}
    </span>
  );
  const icon = (
    <span className="relative h-4 w-4">
      <IconComponent className="h-4 w-4 text-destructive" />
      <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
        <Wrench className="h-2 w-2" aria-hidden="true" />
      </span>
    </span>
  );

  return (
    <Suspense
      fallback={
        <NavItem
          viewKey={viewKey}
          label={label}
          icon={<Wrench className="h-4 w-4 text-destructive" />}
          isActive={false}
          onClick={() => onSelect(viewKey)}
          collapsed={collapsed}
          data-testid={`sidebar-${viewKey.replace(/:/g, "-")}`}
          data-viewkey={viewKey}
          title={title}
          tooltipLabel={title}
          trailingSlot={collapsed ? undefined : trailingSlot}
        />
      }
    >
      <NavItem
        viewKey={viewKey}
        label={label}
        icon={icon}
        isActive={false}
        onClick={() => onSelect(viewKey)}
        collapsed={collapsed}
        data-testid={`sidebar-${viewKey.replace(/:/g, "-")}`}
        data-viewkey={viewKey}
        title={title}
        tooltipLabel={title}
        trailingSlot={collapsed ? undefined : trailingSlot}
      />
    </Suspense>
  );
}

// ─── InactivePluginNavItem ───────────────────────────────────────────────────

/**
 * An installed plugin the user switched off, holding the sidebar slot it would
 * occupy when active.
 *
 * Deliberately NOT styled as a failure. `enabled: false` is a choice the user
 * made, so it gets no destructive colour, no wrench, and no Doctor — those
 * would tell the user something is broken and invite a repair for a plugin
 * that is working exactly as configured. What it does get is presence: before
 * this row existed, an inactive plugin rendered nowhere in the app while the
 * marketplace still listed it as installed, which is the same dead end as a
 * silently dropped one. Selecting it opens Plugin Settings, where the toggle
 * that turned it off is.
 */
function InactivePluginNavItem({
  plugin,
  onSelect,
  collapsed,
}: {
  plugin: PluginCardSummary;
  onSelect: (key: string) => void;
  collapsed: boolean;
}) {
  const { t } = useTranslation();
  const viewKey = toPluginSettingsViewKey(plugin.id);
  const label = plugin.name || plugin.id;
  const title = t("sidebar.pluginInactiveTitle", { label });
  const IconComponent = pluginIconFor({
    icon: plugin.icon,
    iconText: plugin.iconText,
  });
  const trailingSlot = (
    <span
      className="rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground"
      aria-label={t("sidebar.pluginInactiveAriaLabel")}
    >
      {t("sidebar.pluginInactiveBadge")}
    </span>
  );

  return (
    <Suspense
      fallback={
        <NavItem
          viewKey={viewKey}
          label={label}
          icon={<PowerOff className="h-4 w-4 text-muted-foreground" />}
          isActive={false}
          onClick={() => onSelect(viewKey)}
          collapsed={collapsed}
          data-testid={`sidebar-${viewKey.replace(/:/g, "-")}`}
          data-viewkey={viewKey}
          title={title}
          tooltipLabel={title}
          trailingSlot={collapsed ? undefined : trailingSlot}
        />
      }
    >
      <NavItem
        viewKey={viewKey}
        label={label}
        icon={
          <span className="relative h-4 w-4">
            <IconComponent className="h-4 w-4 text-muted-foreground" />
            <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <PowerOff className="h-2 w-2" aria-hidden="true" />
            </span>
          </span>
        }
        isActive={false}
        onClick={() => onSelect(viewKey)}
        collapsed={collapsed}
        data-testid={`sidebar-${viewKey.replace(/:/g, "-")}`}
        data-viewkey={viewKey}
        title={title}
        tooltipLabel={title}
        trailingSlot={collapsed ? undefined : trailingSlot}
      />
    </Suspense>
  );
}

// ─── PluginNavItem ────────────────────────────────────────────────────────────

function PluginNavItem({
  view,
  isActive,
  isUnauthed,
  onSelect,
  collapsed,
}: {
  view: PluginUiExtension;
  isActive: boolean;
  isUnauthed: boolean;
  onSelect: (key: string) => void;
  collapsed: boolean;
}) {
  const { t } = useTranslation();
  const viewKey = toViewKey(view);
  const label = getPluginViewLabel(view);
  const IconComponent = pluginIconFor({
    icon: view.icon,
    iconText: view.iconText,
  });

  const trailingSlot = isUnauthed ? (
    <span
      className="h-1.5 w-1.5 rounded-full bg-destructive"
      aria-label={t("sidebar.authRequiredAriaLabel")}
    />
  ) : null;

  return (
    <Suspense
      fallback={
        <NavItem
          viewKey={viewKey}
          label={label}
          icon={<span className="h-4 w-4" />}
          isActive={isActive}
          onClick={() => onSelect(viewKey)}
          collapsed={collapsed}
          data-testid={`sidebar-${viewKey.replace(/:/g, "-")}`}
          data-viewkey={viewKey}
        />
      }
    >
      <NavItem
        viewKey={viewKey}
        label={label}
        icon={<IconComponent className="h-4 w-4" />}
        isActive={isActive}
        onClick={() => onSelect(viewKey)}
        collapsed={collapsed}
        data-testid={`sidebar-${viewKey.replace(/:/g, "-")}`}
        data-viewkey={viewKey}
        trailingSlot={trailingSlot}
      />
    </Suspense>
  );
}

// ─── Section divider ──────────────────────────────────────────────────────────

function SectionDivider({ collapsed, label }: { collapsed: boolean; label?: string }) {
  if (collapsed) {
    return <div className="border-t border-border my-1 mx-2" />;
  }
  return (
    <div className="border-t border-border my-1">
      {label && (
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-3 py-1.5">
          {label}
        </p>
      )}
    </div>
  );
}

// ─── Project sessions ───────────────────────────────────────────────────────

const PROJECT_SESSION_LIMIT = 6;

function formatRelativeSessionTime(modifiedAt: string, t: ReturnType<typeof useTranslation>["t"]): string {
  const ms = Date.now() - new Date(modifiedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return t("sidebar.justNow");
  if (minutes < 60) return t("sidebar.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("sidebar.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("sidebar.daysAgo", { count: days });
}

function projectTestId(root: string, fallback: string): string {
  const safe = (root || fallback).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "default";
}

function useWorkspaceProjects(enabled: boolean): ProjectIdentity[] {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectIdentity[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void window.lvis?.workspace?.listRoots?.().then((result) => {
      if (cancelled || !result?.ok) return;
      const roots = Array.isArray(result.roots) ? result.roots : [];
      // fallbackName is only a safety net for a root with no resolvable
      // basename (near-unreachable in practice) — the default project is
      // filtered out of every display surface anyway, so its exact string
      // value is never shown.
      setProjects(workspaceRootsToProjects(result.defaultRoot, roots, t("sidebar.projectsLabel")));
    }).catch(() => {
      // Keep the localized fallback; the sidebar must remain usable without the workspace bridge.
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, t]);

  return projects;
}

/**
 * A single conversation row — shared by both the per-project grouped list and
 * the ungrouped "no project" flat list below, so the two surfaces render
 * byte-identical session buttons.
 *
 * Structured as a `<div role group>` wrapping TWO sibling buttons (the main
 * "load this session" click target + the pin toggle) rather than one button
 * with a nested interactive child — nesting a real button inside a button is
 * invalid HTML and would only ever fire the outer element's click handler.
 * The `data-testid`/`aria-current`/click semantics stay on the inner "load"
 * button, unchanged from the prior single-button structure.
 */
/**
 * What a conversation row can do to ITSELF.
 *
 * One object rather than eight loose props: these arrive together, they are
 * offered together in one menu, and a row that has some of them but not others
 * would show a menu with holes in it.
 */
export interface ConversationRowActions {
  isArchived: (sessionId: string) => boolean;
  isUnread: (sessionId: string) => boolean;
  onRename: (sessionId: string, title: string) => void | Promise<void>;
  onSetArchived: (sessionId: string, archived: boolean) => void | Promise<void>;
  onSetUnread: (sessionId: string, unread: boolean) => void | Promise<void>;
  onShare: (sessionId: string) => void | Promise<void>;
  onCopy: (sessionId: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
  /** Import a conversation. Acts on the LIST, not on any row — see the Chats
   *  tab's own context menu. */
  onImport?: () => void | Promise<void>;
}

/** What a project row can do to itself — see ConversationRowActions. */
export interface ProjectRowActions {
  isArchived: (projectRoot: string | undefined) => boolean;
  onSetArchived: (projectRoot: string) => void;
  label: (projectRoot: string | undefined) => string | undefined;
  onSetLabel: (projectRoot: string, label: string) => void;
}

/**
 * Rename in place, for whichever row is being renamed.
 *
 * One component because a conversation row and a project row rename
 * identically: the label becomes a field, Enter commits, Escape and blur
 * abandon. Two copies would be two chances for the two rows to disagree about
 * what Escape does.
 */
function InlineRename({
  initial,
  onCommit,
  onCancel,
  testId,
  t,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  testId: string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      type="text"
      autoFocus
      value={value}
      placeholder={t("sidebar.renamePlaceholder")}
      aria-label={t("sidebar.renamePlaceholder")}
      data-testid={testId}
      className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 py-0.5 text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      // Blur abandons rather than commits. A rename that lands because focus
      // moved is a rename the user never confirmed.
      onBlur={onCancel}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const next = value.trim();
          // An empty field is not a rename. Leave the row as it was.
          if (next) onCommit(next);
          else onCancel();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

function SessionRow({
  session,
  active,
  streaming,
  onLoadSession,
  isPinned,
  onTogglePin,
  onOpenMenu,
  unread,
  archived,
  renaming,
  onCommitRename,
  onCancelRename,
  t,
}: {
  session: SessionSummary;
  active: boolean;
  streaming: boolean;
  onLoadSession?: (sessionId: string) => boolean | void | Promise<boolean | void>;
  /** Truthy when this conversation is pinned — pinned rows sort to the top and show a persistent filled pin. */
  isPinned?: boolean;
  /** Toggle this conversation's pin — omitted entirely hides the pin affordance. */
  onTogglePin?: () => void | Promise<void>;
  /** Open this row's actions menu. Wired to BOTH the right-click and the
   *  trailing entry button, so the two cannot offer different things. */
  onOpenMenu?: (event: MouseEvent<HTMLElement>) => void;
  /** Manually marked unread — drawn as a dot plus a heavier title. */
  unread?: boolean;
  /** Archived — kept legible but visibly set aside. */
  archived?: boolean;
  renaming?: boolean;
  onCommitRename?: (title: string) => void;
  onCancelRename?: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const time = formatRelativeSessionTime(session.modifiedAt, t);
  const rowDisabled = streaming && !active;
  const pinLabel = isPinned ? t("sidebar.unpinConversation") : t("sidebar.pinConversation");
  return (
    <div
      onContextMenu={onOpenMenu}
      className={[
        "group relative flex w-full min-w-0 items-center rounded-md transition-colors",
        active
          ? "bg-primary/(--opacity-subtle) text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        rowDisabled ? "cursor-not-allowed opacity-50" : "",
        // Archived rows stay READABLE. Dimming them to the point of illegibility
        // would make the archive a place things go to be lost, which is what
        // delete is for.
        archived && !rowDisabled ? "opacity-70" : "",
      ].filter(Boolean).join(" ")}
      data-archived={archived ? "true" : undefined}
      data-unread={unread ? "true" : undefined}
    >
      {/* ── Leading slot. One 14px square that holds the row's KIND at rest and
          its pin on hover. The two never coexist, so the row's text never
          shifts — the reason the swap happens here rather than by revealing a
          fourth control. A pinned row keeps the pin showing: the state has to
          be readable without hovering every row to find it. */}
      <span className="relative ml-2 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {onTogglePin ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void onTogglePin();
            }}
            className={[
              "absolute inset-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isPinned ? "flex text-primary" : "hidden group-hover:flex group-focus-within:flex",
            ].join(" ")}
            aria-label={pinLabel}
            title={pinLabel}
            aria-pressed={isPinned}
            data-testid={`sidebar-session-pin-${session.id}`}
          >
            <Pin className={`h-3 w-3 ${isPinned ? "fill-current" : ""}`} />
          </button>
        ) : null}
        <MessageSquareText
          className={[
            "h-3.5 w-3.5",
            // Hidden — not removed. The glyph keeps reserving the square so the
            // swap costs no layout.
            isPinned ? "invisible" : "group-hover:invisible group-focus-within:invisible",
          ].join(" ")}
          aria-hidden="true"
        />
      </span>
      {renaming && onCommitRename && onCancelRename ? (
        <div className="flex min-w-0 flex-1 items-center px-2 py-1">
          <InlineRename
            initial={session.title}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
            testId={`sidebar-session-rename-${session.id}`}
            t={t}
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={rowDisabled}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`sidebar-session-${session.id}`}
          onClick={() => void onLoadSession?.(session.id)}
          // Dragging a conversation onto a tile is how the main area is
          // arranged: the edge it lands on says whether to split that tile or
          // replace what it holds. A click still just opens it in place.
          draggable={!rowDisabled}
          onDragStart={(event) => {
            event.dataTransfer.setData(CHAT_SESSION_DRAG_TYPE, session.id);
            event.dataTransfer.effectAllowed = "copy";
          }}
        >
          {/* Unread is a dot AND weight. The dot alone would be the only
              carrier of the state, and colour alone is not a signal everyone
              receives. */}
          {unread ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
              aria-hidden="true"
              data-testid={`sidebar-session-unread-${session.id}`}
            />
          ) : null}
          <span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold text-foreground" : ""}`}>
            {session.title}
          </span>
        </button>
      )}
      {time ? (
        <span className="shrink-0 pr-1 text-[10px] text-muted-foreground/(--opacity-intense) group-hover:hidden group-focus-within:hidden">
          {time}
        </span>
      ) : null}
      {/* ── Trailing slot: the way IN to this row's actions. Right-click already
          opens the same menu, but a right-click is undiscoverable — the button
          is what tells the user the menu exists. Both call one handler. */}
      {onOpenMenu ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenMenu(event);
          }}
          className="mr-1 hidden shrink-0 rounded p-1 hover:bg-muted-foreground/(--opacity-subtle) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:flex group-focus-within:flex"
          aria-label={t("sidebar.conversationMenu")}
          title={t("sidebar.conversationMenu")}
          data-testid={`sidebar-session-menu-${session.id}`}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The conversation list, exported because a chat GROUP renders the same list in
 * its own sidebar. One list component, so the window's sidebar and a group's
 * sidebar cannot show two different pictures of the same conversations.
 */
function ProjectSessionList({
  collapsed,
  sessions,
  currentSessionId,
  conversationSurfaceVisible,
  streaming,
  onLoadSession,
  onNewChatForProject,
  onRefreshProjects,
  onProjectError,
  projects: projectsProp,
  activeTab,
  onActiveTabChange,
  isSessionStarred,
  onToggleSessionStar,
  isProjectPinned,
  onToggleProjectPin,
  conversationActions,
  projectActions,
}: {
  collapsed: boolean;
  sessions: SessionSummary[];
  currentSessionId?: string;
  /**
   * Whether a CONVERSATION is what the window is showing.
   *
   * A session stays loaded while the user reads a plugin view or Settings, so
   * "which session is loaded" and "which row is the current page" are two
   * different questions. Answering them with one value put `aria-current`
   * on a chat row and on the plugin row at the same time — two rows claiming
   * to be the page the user is on.
   */
  conversationSurfaceVisible: boolean;
  streaming: boolean;
  onLoadSession?: (sessionId: string) => boolean | void | Promise<boolean | void>;
  onNewChatForProject?: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  onRefreshProjects?: () => void | Promise<void>;
  onProjectError?: ProjectErrorReporter;
  projects?: ProjectIdentity[];
  activeTab: SidebarTab;
  onActiveTabChange: (tab: SidebarTab) => void;
  isSessionStarred?: (sessionId: string) => string | null;
  onToggleSessionStar?: (sessionId: string, title?: string) => void | Promise<void>;
  isProjectPinned?: (projectRoot: string | undefined) => boolean;
  onToggleProjectPin?: (projectRoot: string) => void;
  conversationActions?: ConversationRowActions;
  projectActions?: ProjectRowActions;
}) {
  const { t } = useTranslation();
  const openNativeContextMenu = useNativeContextMenu();
  // Adding a project is the SAME flow the composer's project selector and the
  // workspace file-browser tab use — `useAddProjectFolder` owns the
  // `workspace.pickRoot` + adjacency-acknowledgement state machine, so this is
  // a third ENTRY POINT into one implementation, not a third implementation.
  const { pendingWarning, addFolder, confirmPendingFolder, cancelPendingFolder } = useAddProjectFolder();
  // A refused add is reported for the same reason a refused remove is: the user
  // asked for a change and did not get one, and the picker dismissing itself
  // looks identical whether the folder was persisted or rejected.
  // `needs-acknowledgement` stays quiet because the warning block below IS the
  // response, and `canceled` is the user's own decision.
  const applyAddOutcome = async (outcome: AddProjectFolderOutcome): Promise<void> => {
    if (outcome.status === "failed") {
      onProjectError?.("add", outcome.error);
      return;
    }
    if (outcome.status !== "added") return;
    await onRefreshProjects?.();
  };
  const addProject = async (): Promise<void> => {
    await applyAddOutcome(await addFolder());
  };
  const confirmAddProject = async (): Promise<void> => {
    await applyAddOutcome(await confirmPendingFolder());
  };
  // The one command a right-click offers wherever there is no project row —
  // the Projects tab trigger, its empty area, and the collapsed rail icon.
  const addProjectMenuHandlers = (): NativeContextMenuHandlers => ({
    "project.add": () => void addProject(),
  });
  // Reveal the project folder in the OS file manager (real capability:
  // workspace.reveal).
  const revealProject = (projectRoot: string) => {
    if (!projectRoot) return;
    void window.lvis?.workspace?.reveal?.(projectRoot);
  };
  // Remove a picked (non-default) project from the workspace root list (real
  // capability: workspace.removeRoot). Refresh the sidebar list on success so
  // the removed project disappears immediately.
  const removeProject = async (project: ProjectIdentity): Promise<void> => {
    if (!project.projectRoot || project.isDefault) return;
    try {
      const result = await window.lvis?.workspace?.removeRoot?.(project.projectRoot);
      if (!result?.ok) {
        onProjectError?.("remove", result?.error, result?.message);
        return;
      }
      await onRefreshProjects?.();
    } catch (error) {
      onProjectError?.("remove", "remove-failed", error instanceof Error ? error.message : undefined);
    }
  };
  const isSessionPinned = (sessionId: string) => Boolean(isSessionStarred?.(sessionId));
  const fallbackProjects = useWorkspaceProjects(projectsProp === undefined);
  const workspaceProjects = projectsProp ?? fallbackProjects;
  // Which row is mid-rename. One id for BOTH kinds of row: renaming two things
  // at once is not a state the user can be in, so it is not a state to model.
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  // Archived rows are out of the way by default and one click from being back.
  const [showArchived, setShowArchived] = useState(false);

  const mainSessions = useMemo(
    () => sessions.filter((session) => session.sessionKind === "main"),
    [sessions],
  );
  // Named (real, user-visible) projects — the default/base-directory binding
  // is EXCLUDED here so it is never rendered as a project group or a
  // pickable entry: "no explicit project" is the normal state for a
  // conversation, not a synthetic "Current Project" bucket (2026-07 "remove
  // Current Project labeling" refinement). `workspaceProjects` still carries
  // the default entry (other internal consumers need it for execution
  // context), so it is filtered out ONLY at this display boundary. Pinned
  // projects sort to the top (stable — order among unpinned/pinned groups is
  // otherwise unchanged).
  const namedProjects = useMemo(() => {
    const configured = workspaceProjects.filter((project) => !project.isDefault);
    return sortWithPinnedFirst(configured, (project) => Boolean(isProjectPinned?.(project.projectRoot)));
  }, [isProjectPinned, workspaceProjects]);
  const sessionsByProject = useMemo(
    () => namedProjects.map((project) => {
      const projectSessions = sortWithPinnedFirst(
        mainSessions.filter((session) => session.projectRoot && projectRootEquals(session.projectRoot, project.projectRoot)),
        (session) => isSessionPinned(session.id),
      );
      return {
        project,
        recent: projectSessions.slice(0, PROJECT_SESSION_LIMIT),
        overflow: Math.max(0, projectSessions.length - PROJECT_SESSION_LIMIT),
      };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isSessionPinned is derived fresh each render from isSessionStarred (a stable-enough dep); listing it would require useCallback ceremony for no behavioral benefit.
    [mainSessions, namedProjects, isSessionStarred],
  );
  // Every conversation NOT scoped to a named project — no projectRoot at all
  // (the common case once "no explicit project" stops persisting default
  // metadata), or a projectRoot that doesn't match any named project.
  // Sessions persisted BEFORE this refinement tagged every session with the
  // default workspace root/"workspace" name (no isDefault guard); those no
  // longer reach this component with that metadata at all — `handleChatSessions`
  // (src/ipc/handlers/chat.ts) strips projectRoot/projectName at the read
  // chokepoint whenever the stored root is the default workspace root, so a
  // legacy session arrives here exactly like a normal "no explicit project"
  // one (no projectRoot) rather than a phantom named group. Rendered as a
  // plain, ungrouped list — the conventional "general chats" pattern — rather
  // than wrapped in a fake project header. Pinned conversations sort first.
  const ungroupedSessions = useMemo(() => {
    const plain = mainSessions.filter(
      (session) => !session.projectRoot || !namedProjects.some((project) => projectRootEquals(project.projectRoot, session.projectRoot)),
    );
    return sortWithPinnedFirst(plain, (session) => isSessionPinned(session.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainSessions, namedProjects, isSessionStarred]);
  const ungroupedRecent = ungroupedSessions.slice(0, PROJECT_SESSION_LIMIT);
  const ungroupedOverflow = Math.max(0, ungroupedSessions.length - PROJECT_SESSION_LIMIT);

  // Collapsed rail: deliberately NOT wired to the add-project menu. The rail
  // renders no projects at all, and it has nowhere to host the adjacency
  // warning `workspace.pickRoot` can demand before an add completes — a
  // right-click "add project" there would silently do nothing for exactly the
  // folders that most need a confirmation.
  if (collapsed) {
    return (
      <NavItem
        viewKey="project"
        label={t("sidebar.projectsLabel")}
        icon={<Folder className="h-4 w-4" />}
        isActive={false}
        onClick={() => {}}
        collapsed
        data-testid="sidebar-projects-collapsed"
      />
    );
  }

  const hasNamedProjects = sessionsByProject.length > 0;
  const hasUngroupedSessions = ungroupedSessions.length > 0;


  const conversationMenuHandlers = (session: SessionSummary): NativeContextMenuHandlers => {
    const actions = conversationActions;
    const archived = actions?.isArchived(session.id) ?? false;
    const unread = actions?.isUnread(session.id) ?? false;
    return {
      ...(!streaming || session.id === currentSessionId
        ? { "conversation.open": () => void onLoadSession?.(session.id) }
        : {}),
      ...(actions
        ? {
            [unread ? "conversation.mark-read" : "conversation.mark-unread"]: () =>
              void actions.onSetUnread(session.id, !unread),
            "conversation.rename": () => setRenamingKey(`session:${session.id}`),
            "conversation.share": () => void actions.onShare(session.id),
            "conversation.copy": () => void actions.onCopy(session.id),
            [archived ? "conversation.unarchive" : "conversation.archive"]: () =>
              void actions.onSetArchived(session.id, !archived),
            "conversation.delete": () => void actions.onDelete(session.id),
          }
        : {}),
      ...(onToggleSessionStar
        ? {
            [isSessionPinned(session.id) ? "conversation.unpin" : "conversation.pin"]: () =>
              void onToggleSessionStar(session.id, session.title),
          }
        : {}),
    } as NativeContextMenuHandlers;
  };

  const renderSessionRow = (session: SessionSummary) => (
    <SessionRow
      key={session.id}
      session={session}
      active={conversationSurfaceVisible && session.id === currentSessionId}
      streaming={streaming}
      onLoadSession={onLoadSession}
      isPinned={isSessionPinned(session.id)}
      onTogglePin={onToggleSessionStar ? () => onToggleSessionStar(session.id, session.title) : undefined}
      onOpenMenu={(event) => openNativeContextMenu(event, "conversation", conversationMenuHandlers(session))}
      unread={conversationActions?.isUnread(session.id)}
      archived={conversationActions?.isArchived(session.id)}
      renaming={renamingKey === `session:${session.id}`}
      onCommitRename={conversationActions
        ? (title) => {
            setRenamingKey(null);
            void conversationActions.onRename(session.id, title);
          }
        : undefined}
      onCancelRename={() => setRenamingKey(null)}
      t={t}
    />
  );

  // Archived conversations leave the default listing. They are not deleted, so
  // the toggle below brings them straight back — the reason archive is worth
  // having as something distinct from delete.
  const visibleSessions = (list: SessionSummary[]) =>
    showArchived || !conversationActions
      ? list
      : list.filter((session) => !conversationActions.isArchived(session.id));

  const hasArchivedSessions = Boolean(
    conversationActions && sessions.some((session) => conversationActions.isArchived(session.id)),
  );

  // The folder's own actions, built once. The row's right-click and its
  // trailing button both call this, so the two can never offer different sets.
  const projectMenuHandlers = (project: ProjectIdentity): NativeContextMenuHandlers => {
    const root = project.projectRoot;
    const archived = Boolean(projectActions?.isArchived(root));
    return {
      ...(!streaming
        ? {
            "project.new-chat": () => void onNewChatForProject?.({
              ...(root ? { projectRoot: root } : {}),
              projectName: project.projectName,
            }),
          }
        : {}),
      ...(onToggleProjectPin && root
        ? { [pinnedLabelFor(root)]: () => onToggleProjectPin(root) }
        : {}),
      ...(projectActions && root
        ? {
            "project.edit": () => setRenamingKey(`project:${root}`),
            [archived ? "project.unarchive" : "project.archive"]: () =>
              projectActions.onSetArchived(root),
          }
        : {}),
      ...(root ? { "project.reveal": () => revealProject(root) } : {}),
      // Also offered ON a row: someone hunting for "add a project"
      // right-clicks the nearest project-looking thing.
      ...addProjectMenuHandlers(),
      ...(root && !project.isDefault
        ? { "project.remove": () => void removeProject(project) }
        : {}),
    } as NativeContextMenuHandlers;
  };
  const pinnedLabelFor = (root: string) =>
    isProjectPinned?.(root) ? "project.unpin" : "project.pin";

  // Archived FOLDERS leave the listing on the same terms archived
  // conversations do, and answer to the same toggle — one archive, one switch.
  const visibleProjects = showArchived || !projectActions
    ? sessionsByProject
    : sessionsByProject.filter(({ project }) => !projectActions.isArchived(project.projectRoot));

  return (
    <Tabs value={activeTab} onValueChange={(value) => onActiveSidebarTabChangeGuard(value, onActiveTabChange)} data-testid="sidebar-tabs">
      <TabsList className="grid h-8 w-full grid-cols-2 rounded-md bg-muted p-0.5">
        <TabsTrigger value="chats" className="h-7 rounded-sm px-1 text-[12px]" data-testid="sidebar-tab-chats">
          {t("sidebar.chatsTab")}
        </TabsTrigger>
        {/* Right-click the tab itself → the same "add project" menu as its
            empty area, so the shortcut is reachable even from the Chats tab. */}
        <TabsTrigger
          value="projects"
          className="h-7 rounded-sm px-1 text-[12px]"
          data-testid="sidebar-tab-projects"
          onContextMenu={(event) => openNativeContextMenu(event, "project", addProjectMenuHandlers())}
        >
          {t("sidebar.projectsTab")}
        </TabsTrigger>
      </TabsList>

      {/* Chats tab — every conversation with no explicit project, a plain
          ungrouped list (the conventional "general chats" pattern). */}
      {/* Right-click the LIST itself (not a row) → import. Importing always
          creates a brand-new conversation, so it acts on the list; putting it
          on a row would imply it acts on that row. Rows stop propagation once
          they answer, so their own menu still wins. */}
      <TabsContent
        value="chats"
        className="mt-2 min-h-24 space-y-1"
        data-testid="sidebar-unassigned-sessions"
        onContextMenu={(event) => openNativeContextMenu(event, "conversation", {
          ...(conversationActions?.onImport
            ? { "conversation.import": () => void conversationActions.onImport!() }
            : {}),
        } as NativeContextMenuHandlers)}
      >
        {hasUngroupedSessions ? (
          <>
            {visibleSessions(ungroupedRecent).map(renderSessionRow)}
            {ungroupedOverflow > 0 ? (
              <div className="px-2 pt-1 text-[10px] text-muted-foreground">
                {t("sidebar.moreSessions", { count: ungroupedOverflow })}
              </div>
            ) : null}
            {/* Offered only once something IS archived. A permanent toggle for
                an empty archive is a control that never does anything. */}
            {hasArchivedSessions ? (
              <button
                type="button"
                onClick={() => setShowArchived((value) => !value)}
                className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-pressed={showArchived}
                data-testid="sidebar-toggle-archived"
              >
                {showArchived ? t("sidebar.hideArchived") : t("sidebar.showArchived")}
              </button>
            ) : null}
          </>
        ) : (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
            {t("sidebar.noProjectSessions")}
          </div>
        )}
      </TabsContent>

      {/* Projects tab — named-project groups, each with its own nested
          (pinned-first) conversation list. */}
      {/* Right-click anywhere in this tab that is not a row (min-h keeps that
          blank target present even with one project) → "add project". Rows
          stop propagation once they answer, so their own menu still wins. */}
      <TabsContent
        value="projects"
        className="mt-2 min-h-24 space-y-1"
        data-testid="sidebar-projects"
        onContextMenu={(event) => openNativeContextMenu(event, "project", addProjectMenuHandlers())}
      >
        {pendingWarning ? (
          /* Same acknowledgement text the composer selector shows for the same
             `pickRoot` warning — one flow, one wording. */
          <div
            data-testid="sidebar-project-root-warning"
            className="space-y-2 rounded-md border border-destructive bg-destructive/(--opacity-muted) p-2 text-[11px]"
          >
            <div className="font-medium text-destructive">{t("composerProjectSelector.rootWarningTitle")}</div>
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground [overflow-wrap:anywhere]">
              {pendingWarning.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                data-testid="sidebar-project-root-warning-confirm"
                onClick={() => void confirmAddProject()}
              >
                {t("composerProjectSelector.rootWarningConfirm")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="sidebar-project-root-warning-cancel"
                onClick={cancelPendingFolder}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : null}
        {hasNamedProjects ? visibleProjects.map(({ project, recent, overflow }) => {
          const pinned = Boolean(isProjectPinned?.(project.projectRoot));
          const archived = Boolean(projectActions?.isArchived(project.projectRoot));
          const displayName = projectActions?.label(project.projectRoot) ?? project.projectName;
          const openProject = () => void onNewChatForProject?.({
            ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
            projectName: project.projectName,
          });
          return (
          <div key={project.projectRoot} className="space-y-1">
            {/* The folder row. Clicking it starts a chat here; the trailing
                button and the right-click open the SAME set of folder actions,
                built once below so the two entry points cannot diverge. */}
            <div
              className={[
                "group flex w-full min-w-0 items-center rounded-md transition-colors",
                streaming ? "cursor-not-allowed opacity-50" : "hover:bg-muted",
                archived && !streaming ? "opacity-70" : "",
              ].filter(Boolean).join(" ")}
              data-archived={archived ? "true" : undefined}
              onContextMenu={(event) => openNativeContextMenu(event, "project", projectMenuHandlers(project))}
            >
              {renamingKey === `project:${project.projectRoot}` && projectActions && project.projectRoot ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1">
                  <Folder className="h-4 w-4 shrink-0 text-primary" />
                  <InlineRename
                    initial={displayName}
                    onCommit={(value) => {
                      setRenamingKey(null);
                      projectActions.onSetLabel(project.projectRoot!, value);
                    }}
                    onCancel={() => setRenamingKey(null)}
                    testId={`sidebar-project-rename-${projectTestId(project.projectRoot, project.projectName)}`}
                    t={t}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  disabled={streaming}
                  className={[
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    streaming ? "cursor-not-allowed" : "",
                  ].filter(Boolean).join(" ")}
                  title={project.projectRoot ?? t("sidebar.newProjectChat", { project: displayName })}
                  data-testid={`sidebar-project-${projectTestId(project.projectRoot, project.projectName)}`}
                  onClick={openProject}
                >
                  <Folder className="h-4 w-4 shrink-0 text-primary" />
                  {pinned ? <Pin className="h-3 w-3 shrink-0 fill-current text-primary" /> : null}
                  <span className="min-w-0 flex-1 truncate">{displayName}</span>
                  {/* Hidden at rest, not removed — it keeps reserving its width
                      so the folder name does not re-truncate when the pointer
                      arrives. A row that reflows under the cursor is harder to
                      aim at than one that simply reveals a control. */}
                  <Plus
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground invisible group-hover:visible group-focus-within:visible"
                    aria-hidden="true"
                  />
                </button>
              )}
              {/* After the new-chat affordance, exactly as the folder's own
                  actions sit after the conversation's. */}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  openNativeContextMenu(event, "project", projectMenuHandlers(project));
                }}
                className="mr-1 hidden shrink-0 rounded p-1 hover:bg-muted-foreground/(--opacity-subtle) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:flex group-focus-within:flex"
                aria-label={t("sidebar.projectMenu")}
                title={t("sidebar.projectMenu")}
                data-testid={`sidebar-project-menu-${projectTestId(project.projectRoot, project.projectName)}`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="ml-4 border-l border-border/(--opacity-half) pl-2">
              {visibleSessions(recent).length > 0 ? visibleSessions(recent).map(renderSessionRow) : (
                <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                  {t("sidebar.noProjectSessions")}
                </div>
              )}
              {overflow > 0 ? (
                <div className="px-2 pt-1 text-[10px] text-muted-foreground">
                  {t("sidebar.moreSessions", { count: overflow })}
                </div>
              ) : null}
            </div>
          </div>
          );
        }) : (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
            {t("sidebar.noProjectSessions")}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

/** Radix Tabs' onValueChange passes a bare `string` — narrow to `SidebarTab` before persisting. */
function onActiveSidebarTabChangeGuard(value: string, onActiveTabChange: (tab: SidebarTab) => void): void {
  if (isSidebarTab(value)) onActiveTabChange(value);
}

// ─── ClusterStrip ──────────────────────────────────────────────────────────
//
// The horizontal button cluster that sits ON the OS traffic-light LINE, RIGHT
// AFTER the lights:
//   [펼침/닫힘 collapse toggle] → [검색 search] → [뒤로 back] → [앞으로 forward]
//
// Pin / export / import USED to sit here. They act on a CONVERSATION, and the
// part that owns the conversation is the chat group, so they moved into its
// header (ChatGroupFrame) and into each row's context menu. What took their
// place navigates ROUTES, which is what this sidebar owns. See DESIGN.md
// "Workbench model".
// Always rendered (both expanded + collapsed). When the surrounding card is
// expanded it forms the card's top strip; when collapsed it stands bare in the
// band. Each control is an h-6 w-6 icon button (24px, ~4px pad around the 16px
// glyph) with TIGHT ~2px gaps (gap-0.5) so the hover-highlight box hugs the
// icon and never pops out of the band; the whole strip is a single h-7
// items-center row so every glyph centers on the lights' line.
//
// `leadClearance` left-pads the FIRST button past the OS traffic lights on
// darwin. The lights occupy roughly x in [18 .. 76] (trafficLightPosition.x:18
// + ~58px for the 3 lights). The card surface starts at the aside's `left-2`
// (≈8px), so the strip needs ≈76px of internal left padding to push its
// leftmost button to x≈84 (lights end + ~8px gap) with NO hover overlap. The
// card surface still paints behind the lights — the OS draws the lights ON TOP
// of the webview, so that is purely cosmetic backing, not a collision.
function ClusterStrip({
  collapsed,
  leadClearance,
  onToggleCollapse,
  onOpenUnifiedSearch,
  viewNav,
}: {
  collapsed: boolean;
  /** True on darwin — left-pad the first button past the OS traffic lights. */
  leadClearance: boolean;
  onToggleCollapse: () => void;
  onOpenUnifiedSearch: () => void;
  /** Route history. Only the history half renders here — the path half names
   *  the content, so it belongs on the canvas, not in the chrome. */
  viewNav: ViewPathNavProps;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={[
        "flex h-7 shrink-0 items-center gap-0.5 pr-1",
        // Clear the OS lights on darwin (≈76px from the card's left edge → first
        // button lands at x≈84). Win/Linux + non-Electron have no OS lights.
        leadClearance ? "pl-[4.75rem]" : "pl-1",
      ].join(" ")}
      data-testid="sidebar-cluster"
    >
      {/* 펼침/닫힘 — shell-owned collapse toggle. Leftmost, next to the lights. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 aspect-square p-0 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onToggleCollapse}
            title={collapsed ? t("mainToolbar.expandSidebar") : t("mainToolbar.collapseSidebar")}
            aria-label={collapsed ? t("mainToolbar.expandSidebar") : t("mainToolbar.collapseSidebar")}
            aria-pressed={!collapsed}
            data-testid="sidebar-collapse-toggle"
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{collapsed ? t("mainToolbar.expandSidebar") : t("mainToolbar.collapseSidebar")}</TooltipContent>
      </Tooltip>

      {/* 검색 — unified search. Tour anchor "chat-history". */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 aspect-square p-0 shrink-0"
            onClick={onOpenUnifiedSearch}
            title={t("mainToolbar.unifiedSearch")}
            aria-label={t("mainToolbar.unifiedSearch")}
            data-tour-anchor="chat-history"
          >
            <Search className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("mainToolbar.unifiedSearch")}</TooltipContent>
      </Tooltip>

      {/* 뒤로 / 앞으로 — route history. This strip is the sidebar's, and the
          sidebar is what decides which route is showing, so the control that
          moves BETWEEN routes belongs to it. */}
      <ViewHistoryNav
        canGoBack={viewNav.canGoBack}
        canGoForward={viewNav.canGoForward}
        backLabel={viewNav.backLabel}
        forwardLabel={viewNav.forwardLabel}
        onBack={viewNav.onBack}
        onForward={viewNav.onForward}
      />
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar({
  activeView,
  onSelect,
  pluginViews,
  failedPluginCards = [],
  inactivePluginCards = [],
  pluginAuthStatuses,
  subscriptionRuntimePolicy,
  hasApiKey,
  onOpenSettings,
  subscriptionUnavailable = false,
  subscriptionPending = false,
  onNewChat,
  onNewChatForProject,
  streaming,
  onOpenMarketplace,
  marketplaceUrlReady = false,
  collapsed,
  onToggleCollapse,
  width = SIDEBAR_DEFAULT_WIDTH,
  onWidthChange,
  onWidthCommit,
  onOpenUnifiedSearch,
  viewNav,
  sessions = [],
  projects,
  currentSessionId,
  onLoadSession,
  onRefreshProjects,
  onProjectError,
  activeSidebarTab = "chats",
  onActiveSidebarTabChange,
  isSessionStarred,
  onToggleSessionStar,
  conversationActions,
  projectActions,
  isProjectPinned,
  onToggleProjectPin,
}: SidebarProps) {
  const { t } = useTranslation();
  const resizable = !collapsed && Boolean(onWidthChange && onWidthCommit);
  // Card element ref — EdgeResizeBar applies the live drag width directly to
  // this node's style (rAF-coalesced) so dragging never re-renders the whole
  // Sidebar tree, mirroring ChatSidePanel's drag-perf pattern.
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Collapse/expand animates the card width; an active resize drag must not. The
  // drag writes width live to `cardRef` below, so a width tween would lag the
  // pointer — `isResizing` (true only between a drag's first move and its commit)
  // is the single gate that suppresses the transition for the drag path alone.
  const [isResizing, setIsResizing] = useState(false);
  const handleWidthChange = useCallback(
    (px: number) => {
      setIsResizing(true);
      onWidthChange?.(px);
    },
    [onWidthChange],
  );
  const handleWidthCommit = useCallback(
    (px: number) => {
      setIsResizing(false);
      onWidthCommit?.(px);
    },
    [onWidthCommit],
  );

  // The collapsed rail shows icons only; `compact` mirrors `collapsed`. There is
  // no hover-expand — the card is a consistent floating panel in every mode.
  const compact = collapsed;
  const hasPluginEntries = pluginViews.length > 0
    || failedPluginCards.length > 0
    || inactivePluginCards.length > 0;
  // On darwin the OS traffic lights (x:18,y:16) sit just left of the cluster
  // Subscription readiness is distinct from API-key presence: when a login
  // runtime is selected, never describe its verification state as an API-key
  // problem or invite the user to configure an unrelated credential.
  const runtimeUnavailable = subscriptionRuntimePolicy ? subscriptionRuntimePolicy.chatUnavailable : subscriptionUnavailable;
  const runtimePending = subscriptionRuntimePolicy ? subscriptionRuntimePolicy.chatPending : subscriptionPending;
  const settingsNeedsApiKey = hasApiKey === false && !runtimeUnavailable && !runtimePending;
  // strip. The aside's top inset is tuned so the strip's buttons land on the
  // lights' line. Win/Linux + non-Electron have no OS lights to align against.
  const darwinTopClearance = isDarwinPlatform();

  const navListId = "sidebar-nav-list";

  return (
    // The sidebar is a FLOATING-CARD shell. The <aside> is a TRANSPARENT
    // positioning container anchored next to the traffic lights; it never paints
    // a surface itself. Two zones live inside:
    //   1. The CLUSTER STRIP (toggle → search → star → export) — ALWAYS rendered,
    //      sitting on the traffic-light line.
    //   2. The card SURFACE wrapper — carries `bg-card`/border/shadow/rounded and
    //      holds the strip + nav body when EXPANDED. When COLLAPSED the surface
    //      retracts (body removed) and the cluster pops OUT into the bare band
    //      with NO surface behind it. The strip's screen position is identical in
    //      both states; the only visual delta is the card surface behind it.
    // The cluster strip must share the traffic lights' CENTRE LINE, and that
    // line moved when the band went 44px -> 36px: the lights are now at
    // trafficLightPosition.y:12 with a ≈12px diameter, so their centre is 18.
    // An h-7 (28px) strip centres at inset + 14, so the inset has to be 4
    // (top-1), not 8 — at top-2 the icons sat 4px BELOW the lights.
    // win/linux + non-Electron have no OS lights to align against.
    <aside
      data-testid="primary-sidebar"
      role="navigation"
      aria-label={t("sidebar.ariaLabel")}
      className={[
        "absolute left-2 bottom-3 z-30 flex min-h-0 flex-col",
        darwinTopClearance ? "top-1" : "top-1.5",
        collapsed && "pointer-events-none",
      ].join(" ")}
      // The aside overlays the Electron drag band. Mark it no-drag so its controls
      // stay clickable; the OS traffic lights still own their hit region to the
      // left of the cluster.
      style={{
        // @ts-expect-error — Electron-specific CSS extension
        WebkitAppRegion: "no-drag",
      }}
    >
      {/* ── EXPANDED: the cluster strip sits ON the card surface (its top strip).
          COLLAPSED: the outer wrapper carries NO surface tokens, so the cluster
          pops OUT into the bare band; the nav body below keeps its own compact
          icon-rail surface so nav stays reachable. The width tween animates the
          surface in/out; the cluster strip itself never unmounts. */}
      <div
        ref={cardRef}
        data-testid="sidebar-card"
        data-surface={collapsed ? "bare" : "card"}
        className={[
          "flex min-h-0 flex-col motion-reduce:transition-none",
          // Collapse/expand animates the card width. The two states differ in
          // width kind — expanded is `${width}px` (inline), collapsed is content
          // `auto` (`w-auto`) — so `interpolate-size: allow-keywords` is what lets
          // the px⇄auto tween run. An active resize drag suppresses the tween
          // (isResizing) because the drag writes width live to `cardRef`.
          isResizing
            ? ""
            : "transition-[width] duration-[var(--motion-base)] ease-[var(--motion-ease-out)] [interpolate-size:allow-keywords]",
          collapsed
            ? // Bare region: width hugs its widest child (the cluster strip,
              // ≈144px); no surface tokens — transparent, on the band. `items-start`
              // left-aligns the narrower icon-rail body under the cluster.
              // `flex-1 min-h-0` stretches the bare column to the aside's bottom
              // (matching the expanded card) so the collapsed icon-rail body below
              // — itself `flex-1` — fills top-to-bottom in chat mode instead of
              // hugging content height.
              "w-auto items-start flex-1 min-h-0 pointer-events-none [&>*]:pointer-events-auto"
            : // Expanded: `relative` anchors the inner-edge resize handle;
              // `flex-1 min-h-0` stretches the card to the aside's bottom so the
              // surface reaches near the window bottom instead of collapsing to
              // content height. Width comes from the inline style below (durable,
              // user-resized) instead of the former fixed `w-56`.
              "lvis-surface-raised relative flex-1 min-h-0 overflow-hidden rounded-2xl bg-card",
        ].join(" ")}
        style={collapsed ? undefined : { width: `${width}px` }}
      >
        {/* ── Inner-edge drag-to-resize bar (expanded only) — the SAME shared
            EdgeResizeBar + useEdgeResize primitive the right ChatSidePanel uses,
            so drag feel / hit geometry / keyboard / double-click-reset are one
            code path across both panels. `variant="inset"` keeps the strip
            inside the card (it is overflow-hidden, unlike the side panel's
            aside). Adjusts the durable sidebar width between
            SIDEBAR_MIN_WIDTH/MAX; double-click resets to the default. */}
        {resizable ? (
          <EdgeResizeBar
            width={width}
            edge="end"
            variant="inset"
            onWidthChange={handleWidthChange}
            onWidthCommit={handleWidthCommit}
            min={SIDEBAR_MIN_WIDTH}
            max={SIDEBAR_MAX_WIDTH}
            resetWidth={SIDEBAR_DEFAULT_WIDTH}
            applyElementRef={cardRef}
            ariaLabel={t("sidebar.resizeHandleAriaLabel")}
            data-testid="sidebar-resize-handle"
          />
        ) : null}
        {/* ── Cluster strip — [펼침/닫힘 toggle] → [검색] → [즐겨찾기] → [내보내기],
            ~8px gaps, each h-7 w-7. Sits on the traffic-light line. When the card
            is expanded this is the card's top strip; when collapsed it stands bare
            in the band. Always rendered — never hidden in either state. */}
        <ClusterStrip
          collapsed={collapsed}
          leadClearance={darwinTopClearance}
          onToggleCollapse={onToggleCollapse}
          onOpenUnifiedSearch={onOpenUnifiedSearch}
          viewNav={viewNav}
        />

      {/* ── Card body — new chat + nav + footer. EXPANDED: inline within the card
          surface above. COLLAPSED: its own compact icon-rail surface below the
          bare cluster (mt-1.5 gap), so nav stays reachable while the cluster has
          popped out of the floating surface. */}
      <div
        className={
          collapsed
            ? // Collapsed: a compact icon-rail card BELOW the bare cluster,
              // pinned to the aside's left edge (left-2 ≈ 8px) so it stays within
              // the main content's collapsed left padding (pl-20 ≈ 80px). The
              // cluster strip above keeps its own lead clearance to clear the OS
              // lights; the rail does NOT inherit that clearance. `mt-2.5`
              // (≈10px) gives the rail card adequate top margin below the band so
              // it is not flush against the cluster strip in chat mode.
              "lvis-surface-raised mt-2.5 w-14 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card"
            : "flex min-h-0 flex-1 flex-col overflow-hidden"
        }
      >
      {/* ── New Chat CTA — `pt-2.5` (≈10px) gives the card body breathing room
          below the cluster strip (R6 — not flush against it). */}
      <div className={`px-2 pt-2.5 pb-1 ${compact ? "flex justify-center" : ""}`}>
        {compact ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="default"
                size="icon"
                className="h-9 w-9 aspect-square p-0 shrink-0"
                onClick={onNewChat}
                disabled={streaming}
                aria-label={t("mainToolbar.newChat")}
                data-testid="sidebar-new-chat"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t("mainToolbar.newChat")}</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            variant="default"
            className="w-full h-9 gap-2"
            onClick={onNewChat}
            disabled={streaming}
            data-testid="sidebar-new-chat"
          >
            <Plus className="h-4 w-4" />
            <span>{t("mainToolbar.newChat")}</span>
          </Button>
        )}
      </div>

      {/* ── Primary nav + plugins (scrollable) ──────────────────────── */}
      <div id={navListId} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* PRIMARY NAV group */}
        <div className={`px-2 py-2 space-y-0.5 ${compact ? "flex flex-col items-center" : ""}`}>
          <NavItem
            viewKey="work-board"
            label={t("mainToolbar.workBoard")}
            icon={<KanbanSquare className="h-4 w-4" />}
            isActive={activeView === "work-board"}
            onClick={() => onSelect("work-board")}
            collapsed={compact}
            data-testid="toolbar-work-board"
          />
          <NavItem
            viewKey="routines"
            label={t("mainToolbar.routines")}
            icon={<Repeat2 className="h-4 w-4" />}
            isActive={activeView === "routines"}
            onClick={() => onSelect("routines")}
            collapsed={compact}
            data-testid="sidebar-routines"
          />
          {/* 메모리 panel intentionally removed from the sidebar surface
              (2026-07 shell refinement). MEMORY.md remains viewable + editable
              in Settings → 역할/메모리 (RolesTab memory section); the "memory"
              view itself stays routable (main content region + UnifiedSearch deep-link)
              so no navigation breaks. */}
          <NavItem
            viewKey="insights"
            label={t("mainToolbar.insights")}
            icon={<CalendarDays className="h-4 w-4" />}
            isActive={activeView === "insights" || activeView === "starred"}
            onClick={() => onSelect("insights")}
            collapsed={compact}
            data-testid="sidebar-starred"
            data-viewkey="insights"
          />
        </div>

        {/* PLUGINS + PROJECTS group — scrollable flex-1 */}
        {(
          <>
            {hasPluginEntries ? (
              <SectionDivider collapsed={compact} label={compact ? undefined : t("sidebar.pluginsLabel")} />
            ) : null}
            {/* Radix ScrollArea wraps viewport content in a `display: table` div,
                which sizes to max-content — long unbreakable titles then blow the
                content wider than the card and get HARD-clipped by the viewport,
                so row-level `truncate` never produces its ellipsis. Force that
                wrapper back to block so width is bounded and `…` can kick in. */}
            <ScrollArea className="flex-1 min-h-0 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0">
              <div className={`px-2 py-1 space-y-0.5 ${compact ? "flex flex-col items-center" : ""}`}>
                {pluginViews.map((view) => {
                  const viewKey = toViewKey(view);
                  const isUnauthed =
                    view.extension !== undefined &&
                    pluginAuthStatuses?.get(view.pluginId)?.kind === "unauthed";
                  return (
                    <PluginNavItem
                      key={viewKey}
                      view={view}
                      isActive={activeView === viewKey}
                      isUnauthed={Boolean(isUnauthed)}
                      onSelect={onSelect}
                      collapsed={compact}
                    />
                  );
                })}
                {failedPluginCards.map((plugin) => (
                  <FailedPluginNavItem
                    key={`doctor:${plugin.id}`}
                    plugin={plugin}
                    onSelect={onSelect}
                    collapsed={compact}
                  />
                ))}
                {inactivePluginCards.map((plugin) => (
                  <InactivePluginNavItem
                    key={`inactive:${plugin.id}`}
                    plugin={plugin}
                    onSelect={onSelect}
                    collapsed={compact}
                  />
                ))}
                <div className={compact ? "pt-1" : pluginViews.length > 0 ? "pt-2" : ""}>
                  {/* No standalone "Projects" section divider here — the Chats/
                      Projects TabsList inside ProjectSessionList already frames
                      this section, so a redundant label above it would be
                      confusing chrome (2026-07 sidebar-tabs refinement). */}
                  <ProjectSessionList
                    collapsed={compact}
                    sessions={sessions}
                    projects={projects}
                    currentSessionId={currentSessionId}
                    conversationSurfaceVisible={activeView === "home"}
                    streaming={streaming}
                    onLoadSession={onLoadSession}
                    onNewChatForProject={onNewChatForProject}
                    onRefreshProjects={onRefreshProjects}
                    onProjectError={onProjectError}
                    activeTab={activeSidebarTab}
                    onActiveTabChange={onActiveSidebarTabChange ?? (() => {})}
                    isSessionStarred={isSessionStarred}
                    onToggleSessionStar={onToggleSessionStar}
                    isProjectPinned={isProjectPinned}
                    onToggleProjectPin={onToggleProjectPin}
                    conversationActions={conversationActions}
                    projectActions={projectActions}
                  />
                </div>
              </div>
            </ScrollArea>
          </>
        )}
      </div>

      {/* ── Footer — Home + Marketplace + Settings ───────────────────── */}
      {/* Bottom-pinned (`mt-auto`). The Home-top divider (this footer's
          `border-t`) and the Home row share the SAME uniform spacing rhythm as
          the primary nav group above (`py-2` + `space-y-0.5`) — no bespoke
          margin correction. The divider LINE is kept; only the earlier
          composer-seam-alignment padding was removed so the footer reads as one
          uniform nav rhythm at every window height. */}
      <div className={`border-t border-border px-2 py-2 mt-auto space-y-0.5 ${compact ? "flex flex-col items-center space-y-0.5" : ""}`}>
        {/* Home used to sit here. The conversation list IS the home surface —
            a row that navigates to "the chat" while the chats are listed a few
            pixels above it was naming the same destination twice. */}
        {/* Marketplace jump — styled as a NavItem, disabled until URL ready */}
        <NavItem
          viewKey="marketplace"
          label={t("sidebar.marketplace")}
          icon={<ShoppingBag className="h-4 w-4" />}
          isActive={false}
          onClick={() => {
            if (marketplaceUrlReady) onOpenMarketplace();
          }}
          collapsed={compact}
          tone="marketplace"
          data-testid="sidebar-marketplace"
          data-tour-anchor="sidebar-marketplace"
        />
        <NavItem
          viewKey="settings"
          label={t("mainToolbar.settings")}
          icon={<KeyRound className={settingsNeedsApiKey || runtimeUnavailable ? "h-4 w-4 text-destructive" : "h-4 w-4"} />}
          // Active when settings render inline (work mode). Marketplace stays
          // false — it's an overlay launcher that never sets activeView.
          isActive={activeView === "settings"}
          onClick={onOpenSettings}
          collapsed={compact}
          tone="settings"
          data-testid="sidebar-settings"
          data-tour-anchor="settings-entry"
          trailingSlot={
            runtimePending && !compact ? (
              <span className="text-[10px] text-muted-foreground">
                {t("subscriptionProvidersSection.statusChecking")}
              </span>
            ) : runtimeUnavailable && !compact ? (
              <span className="text-[10px] text-destructive">
                {t("formatIpcError.subscriptionChatUnavailable")}
              </span>
            ) : settingsNeedsApiKey && !compact ? (
              <span className="text-[10px] text-destructive">
                {t("mainToolbar.apiKeyRequired")}
              </span>
            ) : undefined
          }
        />
      </div>
      </div>
      </div>
    </aside>
  );
}
