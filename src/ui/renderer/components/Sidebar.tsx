import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { EdgeResizeBar } from "./EdgeResizeBar.js";
import {
  CalendarDays,
  Download,
  Folder,
  FolderOpen,
  Home,
  KanbanSquare,
  KeyRound,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Repeat2,
  Search,
  ShoppingBag,
  Star,
  Trash2,
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu.js";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../../components/ui/context-menu.js";
import { Button } from "../../../components/ui/button.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { getPluginViewLabel, toViewKey } from "../api-client.js";
import { pluginIconFor } from "../utils/plugin-icon.js";
import type { PluginUiExtension } from "../types.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import { projectBasename, projectRootEquals, workspaceRootsToProjects } from "../../../shared/project-identity.js";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../../../shared/side-panel.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SidebarProps {
  activeView: string;
  /** Called with the view key string — same contract as handleViewSelect. */
  onSelect: (viewKey: string) => void;
  /** Plugin views from usePluginMarketplace — same list passed to MainContent. */
  pluginViews: PluginUiExtension[];
  /** Auth-status map: pluginId → { kind: "authed" | "unauthed" | ... }. */
  pluginAuthStatuses?: ReadonlyMap<string, { kind: string }>;
  /** Whether the user has an API key configured — drives the settings warning. */
  hasApiKey: boolean | null;
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
  /** Whether the current session is starred — drives the cluster star fill. */
  isCurrentSessionStarred: boolean;
  /** Toggle the current session star — third button in the cluster strip. */
  onToggleCurrentSessionStar: () => void | Promise<void>;
  /** Export the current session — fourth button in the cluster strip. */
  onExport: (format: "markdown" | "json") => void | Promise<void>;
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
}

// ─── Platform bridge (darwin traffic-light line) ───────────────────────────────
// On macOS the OS draws the traffic lights at {x:18,y:16} (≈12px diameter, so
// their visual center sits at ≈y:22, ≈x:[18..76]). The floating card is anchored
// at top-2 (8px) so the h-7 cluster strip's center lands on that line; the strip
// carries a left clearance (≈76px) so its leftmost button starts at x≈84, just
// RIGHT of the lights with no hover overlap. The cluster ([펼침/닫힘 toggle] →
// [검색] → [즐겨찾기] → [내보내기]) is the card's top strip when expanded and pops
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
  trailingSlot,
}: NavItemProps) {
  const toneStyle = NAV_TONE[tone];
  const btn = collapsed ? (
    /* Collapsed — perfectly square icon button */
    <button
      type="button"
      onClick={onClick}
      aria-current={isActive ? "page" : undefined}
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
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return btn;
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

function useWorkspaceProjects(): ProjectIdentity[] {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectIdentity[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.lvis?.workspace?.listRoots?.().then((result) => {
      if (cancelled || !result?.ok) return;
      const roots = Array.isArray(result.roots) ? result.roots : [];
      setProjects(workspaceRootsToProjects(result.defaultRoot, roots, t("sidebar.currentProject")));
    }).catch(() => {
      // Keep the localized fallback; the sidebar must remain usable without the workspace bridge.
    });
    return () => {
      cancelled = true;
    };
  }, [t]);

  return projects;
}

function ProjectSessionList({
  collapsed,
  sessions,
  currentSessionId,
  streaming,
  onLoadSession,
  onNewChatForProject,
  onRefreshProjects,
  projects: projectsProp,
}: {
  collapsed: boolean;
  sessions: SessionSummary[];
  currentSessionId?: string;
  streaming: boolean;
  onLoadSession?: (sessionId: string) => boolean | void | Promise<boolean | void>;
  onNewChatForProject?: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  onRefreshProjects?: () => void | Promise<void>;
  projects?: ProjectIdentity[];
}) {
  const { t } = useTranslation();
  // Reveal the project folder in the OS file manager (real capability:
  // workspace.reveal). No-op for the default project's empty root.
  const revealProject = (projectRoot: string) => {
    if (!projectRoot) return;
    void window.lvis?.workspace?.reveal?.(projectRoot);
  };
  // Remove a picked (non-default) project from the workspace root list (real
  // capability: workspace.removeRoot). The default/base-directory project is
  // not removable — its menu omits this item. Refresh the sidebar list on
  // success so the removed project disappears immediately.
  const removeProject = (project: ProjectIdentity) => {
    if (!project.projectRoot || project.isDefault) return;
    void Promise.resolve(window.lvis?.workspace?.removeRoot?.(project.projectRoot))
      .then(() => onRefreshProjects?.())
      .catch(() => {
        // Non-fatal: the list simply keeps the project until the next refresh.
      });
  };
  const fallbackProjects = useWorkspaceProjects();
  const workspaceProjects = projectsProp ?? fallbackProjects;
  const mainSessions = useMemo(
    () => sessions.filter((session) => session.sessionKind === "main"),
    [sessions],
  );
  const projects = useMemo(() => {
    const knownProjects = workspaceProjects.length > 0
      ? workspaceProjects
      : [{
          projectRoot: "",
          projectName: t("sidebar.currentProject"),
          isDefault: true,
        }];
    const unknownProjects = new Map<string, ProjectIdentity>();
    for (const session of mainSessions) {
      if (!session.projectRoot || knownProjects.some((project) => projectRootEquals(project.projectRoot, session.projectRoot))) continue;
      unknownProjects.set(session.projectRoot, {
        projectRoot: session.projectRoot,
        projectName: session.projectName || projectBasename(session.projectRoot),
        isDefault: false,
      });
    }
    return [...knownProjects, ...unknownProjects.values()];
  }, [mainSessions, t, workspaceProjects]);
  const defaultProjectRoot = projects.find((project) => project.isDefault)?.projectRoot ?? projects[0]?.projectRoot ?? "";
  const sessionsByProject = useMemo(
    () => projects.map((project) => {
      const projectSessions = mainSessions.filter((session) => {
        const root = session.projectRoot ?? defaultProjectRoot;
        return projectRootEquals(root, project.projectRoot) || root === project.projectRoot;
      });
      return {
        project,
        recent: projectSessions.slice(0, PROJECT_SESSION_LIMIT),
        overflow: Math.max(0, projectSessions.length - PROJECT_SESSION_LIMIT),
      };
    }),
    [defaultProjectRoot, mainSessions, projects],
  );

  if (collapsed) {
    return (
      <NavItem
        viewKey="project"
        label={t("sidebar.projectsLabel")}
        icon={<Folder className="h-4 w-4" />}
        isActive={false}
        onClick={() => {}}
        collapsed
        data-testid="sidebar-current-project"
      />
    );
  }

  return (
    <div className="space-y-1" data-testid="sidebar-projects">
      {sessionsByProject.map(({ project, recent, overflow }, index) => (
        <div key={project.projectRoot || "default-project"} className="space-y-1">
          {/* Right-click a project row → context menu of REAL project actions
              (new chat here, reveal folder, remove picked project). The default
              project omits reveal/remove — its root is app-managed. */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
          <button
            type="button"
            disabled={streaming}
            className={[
              "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-foreground transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              streaming ? "cursor-not-allowed opacity-50" : "hover:bg-muted",
            ].join(" ")}
            title={t("sidebar.newProjectChat", { project: project.projectName })}
            data-testid={index === 0 ? "sidebar-current-project" : `sidebar-project-${projectTestId(project.projectRoot, project.projectName)}`}
            onClick={() => void onNewChatForProject?.({
              ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
              projectName: project.projectName,
            })}
          >
            <Folder className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">{project.projectName}</span>
            <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-[11rem]" data-testid="sidebar-project-context-menu">
              <ContextMenuItem
                data-testid="sidebar-project-menu-new-chat"
                onSelect={() => void onNewChatForProject?.({
                  ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
                  projectName: project.projectName,
                })}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("sidebar.projectMenuNewChat")}
              </ContextMenuItem>
              {project.projectRoot ? (
                <ContextMenuItem
                  data-testid="sidebar-project-menu-reveal"
                  onSelect={() => revealProject(project.projectRoot)}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t("sidebar.projectMenuReveal")}
                </ContextMenuItem>
              ) : null}
              {project.projectRoot && !project.isDefault ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    data-testid="sidebar-project-menu-remove"
                    className="text-destructive focus:text-destructive"
                    onSelect={() => removeProject(project)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t("sidebar.projectMenuRemove")}
                  </ContextMenuItem>
                </>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
          <div className="ml-4 border-l border-border/(--opacity-half) pl-2">
            {recent.length > 0 ? recent.map((session) => {
              const active = session.id === currentSessionId;
              const time = formatRelativeSessionTime(session.modifiedAt, t);
              return (
                <button
                  type="button"
                  key={session.id}
                  disabled={streaming && !active}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-primary/(--opacity-subtle) text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    streaming && !active ? "cursor-not-allowed opacity-50" : "",
                  ].filter(Boolean).join(" ")}
                  data-testid={`sidebar-session-${session.id}`}
                  onClick={() => void onLoadSession?.(session.id)}
                >
                  <MessageSquareText className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  {time ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground/(--opacity-intense)">
                      {time}
                    </span>
                  ) : null}
                </button>
              );
            }) : (
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
      ))}
    </div>
  );
}

// ─── ClusterStrip ──────────────────────────────────────────────────────────
//
// The horizontal button cluster that sits ON the OS traffic-light LINE, RIGHT
// AFTER the lights:
//   [펼침/닫힘 collapse toggle] → [검색 search] → [즐겨찾기 star] → [내보내기 export]
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
  isCurrentSessionStarred,
  onToggleCurrentSessionStar,
  onExport,
}: {
  collapsed: boolean;
  /** True on darwin — left-pad the first button past the OS traffic lights. */
  leadClearance: boolean;
  onToggleCollapse: () => void;
  onOpenUnifiedSearch: () => void;
  isCurrentSessionStarred: boolean;
  onToggleCurrentSessionStar: () => void | Promise<void>;
  onExport: (format: "markdown" | "json") => void | Promise<void>;
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

      {/* 즐겨찾기 — current-session star. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 aspect-square p-0 shrink-0"
            onClick={() => void onToggleCurrentSessionStar()}
            title={isCurrentSessionStarred ? t("mainToolbar.sessionUnstar") : t("mainToolbar.sessionStar")}
            aria-label={isCurrentSessionStarred ? t("mainToolbar.sessionUnstar") : t("mainToolbar.sessionStar")}
            aria-pressed={isCurrentSessionStarred}
          >
            <Star key={isCurrentSessionStarred ? "on" : "off"} className={`h-4 w-4 ${isCurrentSessionStarred ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{isCurrentSessionStarred ? t("mainToolbar.sessionUnstar") : t("mainToolbar.sessionStar")}</TooltipContent>
      </Tooltip>

      {/* 내보내기 — export menu (Markdown / JSON). Tour anchor "settings-entry". */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 aspect-square p-0 shrink-0"
                title={t("mainToolbar.export")}
                aria-label={t("mainToolbar.export")}
                data-testid="toolbar-export"
                data-tour-anchor="settings-entry"
              >
                <Download className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("mainToolbar.export")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-[180px]">
          <DropdownMenuItem data-testid="toolbar-export-markdown" onClick={() => void onExport("markdown")}>
            {t("sidebar.exportMarkdown")}
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="toolbar-export-json" onClick={() => void onExport("json")}>
            {t("sidebar.exportJson")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar({
  activeView,
  onSelect,
  pluginViews,
  pluginAuthStatuses,
  hasApiKey,
  onOpenSettings,
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
  isCurrentSessionStarred,
  onToggleCurrentSessionStar,
  onExport,
  sessions = [],
  projects,
  currentSessionId,
  onLoadSession,
  onRefreshProjects,
}: SidebarProps) {
  const { t } = useTranslation();
  const resizable = !collapsed && Boolean(onWidthChange && onWidthCommit);
  // Card element ref — EdgeResizeBar applies the live drag width directly to
  // this node's style (rAF-coalesced) so dragging never re-renders the whole
  // Sidebar tree, mirroring ChatSidePanel's drag-perf pattern.
  const cardRef = useRef<HTMLDivElement | null>(null);

  // The collapsed rail shows icons only; `compact` mirrors `collapsed`. There is
  // no hover-expand — the card is a consistent floating panel in every mode.
  const compact = collapsed;
  // On darwin the OS traffic lights (x:18,y:16) sit just left of the cluster
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
    // top-2 (8px) lands the h-7 (28px) cluster strip's center at ≈22px — the OS
    // traffic lights' visual center (trafficLightPosition.y:16 + ≈6px half of
    // their ≈12px diameter). So the cluster sits ON the lights' line on darwin.
    // win/linux + non-Electron align a touch higher (top-1.5) with no OS lights.
    <aside
      data-testid="primary-sidebar"
      role="navigation"
      aria-label={t("sidebar.ariaLabel")}
      className={[
        "absolute left-2 bottom-3 z-30 flex min-h-0 flex-col",
        darwinTopClearance ? "top-2" : "top-1.5",
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
          // While resizable the width is driven by inline style (drag-live), so
          // suppress the width tween — it would lag the pointer. Collapse/expand
          // still animates the width.
          resizable ? "" : "transition-[width] duration-[var(--motion-base)] ease-[var(--motion-ease-out)]",
          collapsed
            ? // Bare region: width hugs its widest child (the cluster strip,
              // ≈144px); no surface tokens — transparent, on the band. `items-start`
              // left-aligns the narrower icon-rail body under the cluster.
              // `flex-1 min-h-0` stretches the bare column to the aside's bottom
              // (matching the expanded card) so the collapsed icon-rail body below
              // — itself `flex-1` — fills top-to-bottom in chat mode instead of
              // hugging content height.
              "w-auto items-start flex-1 min-h-0"
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
            onWidthChange={onWidthChange!}
            onWidthCommit={onWidthCommit!}
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
          isCurrentSessionStarred={isCurrentSessionStarred}
          onToggleCurrentSessionStar={onToggleCurrentSessionStar}
          onExport={onExport}
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
              view itself stays routable (MainContent + UnifiedSearch deep-link)
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
            {pluginViews.length > 0 ? (
              <SectionDivider collapsed={compact} label={compact ? undefined : t("sidebar.pluginsLabel")} />
            ) : null}
            <ScrollArea className="flex-1 min-h-0">
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
                <div className={compact ? "pt-1" : pluginViews.length > 0 ? "pt-2" : ""}>
                  {!compact ? (
                    <SectionDivider collapsed={false} label={t("sidebar.projectsLabel")} />
                  ) : null}
                  <ProjectSessionList
                    collapsed={compact}
                    sessions={sessions}
                    projects={projects}
                    currentSessionId={currentSessionId}
                    streaming={streaming}
                    onLoadSession={onLoadSession}
                    onNewChatForProject={onNewChatForProject}
                    onRefreshProjects={onRefreshProjects}
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
        {/* Home — placed above the marketplace, capped by this footer's border-t
            divider (which matches the composer's border-t seam). */}
        <NavItem
          viewKey="home"
          label={t("mainToolbar.home")}
          icon={<Home className="h-4 w-4" />}
          isActive={activeView === "home"}
          onClick={() => onSelect("home")}
          collapsed={compact}
          tone="home"
          data-testid="sidebar-home"
        />
        {/* Divider between Home and Marketplace */}
        <div className="my-1 border-t border-border self-stretch" />
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
          icon={<KeyRound className={`h-4 w-4 ${hasApiKey === false ? "text-destructive" : ""}`} />}
          // Active when settings render inline (work mode). Marketplace stays
          // false — it's an overlay launcher that never sets activeView.
          isActive={activeView === "settings"}
          onClick={onOpenSettings}
          collapsed={compact}
          tone="settings"
          data-testid="sidebar-settings"
          data-tour-anchor="settings-entry"
          trailingSlot={
            hasApiKey === false && !compact ? (
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
