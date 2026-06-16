import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Database,
  Home,
  KanbanSquare,
  KeyRound,
  PanelLeftClose,
  Plus,
  Repeat2,
  Star,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { getPluginViewLabel, toViewKey } from "../api-client.js";
import { pluginIconFor } from "../utils/plugin-icon.js";
import type { PluginUiExtension } from "../types.js";

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
}

// ─── NavItem ─────────────────────────────────────────────────────────────────

interface NavItemProps {
  viewKey: string;
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  collapsed: boolean;
  "data-testid"?: string;
  "data-viewkey"?: string;
  trailingSlot?: React.ReactNode;
}

function NavItem({
  viewKey: _viewKey,
  label,
  icon,
  isActive,
  onClick,
  collapsed,
  "data-testid": testId,
  "data-viewkey": dataViewKey,
  trailingSlot,
}: NavItemProps) {
  const btn = collapsed ? (
    /* Collapsed — perfectly square icon button */
    <button
      type="button"
      onClick={onClick}
      aria-current={isActive ? "page" : undefined}
      data-testid={testId}
      data-viewkey={dataViewKey}
      className={[
        "relative h-9 w-9 aspect-square flex items-center justify-center rounded-md transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isActive && (
        <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
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
      className={[
        "relative w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive
          ? "bg-primary/10 text-primary font-medium"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isActive && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
      )}
      <span className="shrink-0 h-4 w-4 flex items-center justify-center">{icon}</span>
      <span className="truncate flex-1 text-left">{label}</span>
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
  const viewKey = toViewKey(view);
  const label = getPluginViewLabel(view);
  const IconComponent = pluginIconFor({
    icon: view.icon,
    iconText: view.iconText,
  });

  const trailingSlot = isUnauthed ? (
    <span
      className="h-1.5 w-1.5 rounded-full bg-destructive"
      aria-label="인증 필요"
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

// ─── Sidebar ─────────────────────────────────────────────────────────────────

/** Narrow width breakpoint below which the sidebar force-collapses (px). */
const FORCE_COLLAPSE_WIDTH = 900;

export function Sidebar({
  activeView,
  onSelect,
  pluginViews,
  pluginAuthStatuses,
  hasApiKey,
  onOpenSettings,
  onNewChat,
  streaming,
}: SidebarProps) {
  const { t } = useTranslation();

  // Collapse state — user toggle. Persisted in component state; a future
  // improvement could wire this to api.updateSettings for cross-reload persistence.
  const [userCollapsed, setUserCollapsed] = useState(false);

  // Force-collapse when the shell is too narrow for a comfortable expanded rail.
  const [forceCollapsed, setForceCollapsed] = useState(false);
  const shellRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = shellRef.current?.closest(".flex.h-screen") as HTMLElement | null;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setForceCollapsed(entry.contentRect.width < FORCE_COLLAPSE_WIDTH);
      }
    });
    ro.observe(el);
    // Initial check
    setForceCollapsed(el.getBoundingClientRect().width < FORCE_COLLAPSE_WIDTH);
    return () => ro.disconnect();
  }, []);

  const collapsed = forceCollapsed || userCollapsed;

  const handleToggleCollapse = useCallback(() => {
    // Only allow user toggle when not force-collapsed by viewport
    if (!forceCollapsed) setUserCollapsed((v) => !v);
  }, [forceCollapsed]);

  const navListId = "sidebar-nav-list";

  return (
    <aside
      ref={shellRef}
      data-testid="primary-sidebar"
      role="navigation"
      aria-label={t("sidebar.ariaLabel", { defaultValue: "기본 탐색" })}
      className={[
        "flex min-h-0 flex-col overflow-hidden bg-background border-r border-border shrink-0 transition-all duration-200",
        collapsed ? "w-14" : "w-56",
      ].join(" ")}
    >
      {/* ── Brand/Home zone — height matches MainToolbar (h-10 content + py-1.5 = ~52px) */}
      <div className="h-[52px] border-b border-border px-2 flex items-center gap-1 shrink-0">
        {collapsed ? (
          /* Collapsed: Home icon centred; NavItem handles its own Tooltip when collapsed */
          <div className="flex items-center justify-center w-full">
            <NavItem
              viewKey="home"
              label={t("mainToolbar.home")}
              icon={<Home className="h-4 w-4" />}
              isActive={activeView === "home"}
              onClick={() => onSelect("home")}
              collapsed={collapsed}
              data-testid="sidebar-home"
            />
          </div>
        ) : (
          /* Expanded: Home item left, collapse toggle right */
          <>
            <NavItem
              viewKey="home"
              label={t("mainToolbar.home")}
              icon={<Home className="h-4 w-4" />}
              isActive={activeView === "home"}
              onClick={() => onSelect("home")}
              collapsed={collapsed}
              data-testid="sidebar-home"
            />
            {!forceCollapsed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 aspect-square p-0 shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent"
                    onClick={handleToggleCollapse}
                    aria-expanded={!collapsed}
                    aria-controls={navListId}
                    aria-label={t("sidebar.collapse", { defaultValue: "사이드바 닫기" })}
                    data-testid="sidebar-collapse-toggle"
                  >
                    <PanelLeftClose className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {t("sidebar.collapse", { defaultValue: "사이드바 닫기" })}
                </TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>

      {/* ── New Chat CTA — below the top zone */}
      <div className={`px-2 pt-2 pb-1 ${collapsed ? "flex justify-center" : ""}`}>
        {collapsed ? (
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
        <div className={`px-2 py-2 space-y-0.5 ${collapsed ? "flex flex-col items-center" : ""}`}>
          <NavItem
            viewKey="work-board"
            label={t("mainToolbar.workBoard")}
            icon={<KanbanSquare className="h-4 w-4" />}
            isActive={activeView === "work-board"}
            onClick={() => onSelect("work-board")}
            collapsed={collapsed}
            data-testid="toolbar-work-board"
          />
          <NavItem
            viewKey="routines"
            label={t("mainToolbar.routines")}
            icon={<Repeat2 className="h-4 w-4" />}
            isActive={activeView === "routines"}
            onClick={() => onSelect("routines")}
            collapsed={collapsed}
            data-testid="sidebar-routines"
          />
          <NavItem
            viewKey="memory"
            label={t("mainToolbar.memory")}
            icon={<Database className="h-4 w-4" />}
            isActive={activeView === "memory"}
            onClick={() => onSelect("memory")}
            collapsed={collapsed}
            data-testid="sidebar-memory"
          />
          <NavItem
            viewKey="starred"
            label={t("mainToolbar.starred")}
            icon={<Star className="h-4 w-4" />}
            isActive={activeView === "starred"}
            onClick={() => onSelect("starred")}
            collapsed={collapsed}
            data-testid="sidebar-starred"
          />
        </div>

        {/* PLUGINS group — scrollable flex-1 */}
        {pluginViews.length > 0 && (
          <>
            <SectionDivider collapsed={collapsed} label={collapsed ? undefined : t("sidebar.pluginsLabel", { defaultValue: "플러그인" })} />
            <ScrollArea className="flex-1 min-h-0">
              <div className={`px-2 py-1 space-y-0.5 ${collapsed ? "flex flex-col items-center" : ""}`}>
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
                      collapsed={collapsed}
                    />
                  );
                })}
              </div>
            </ScrollArea>
          </>
        )}

        {/* Spacer when no plugin list (keeps footer pinned) */}
        {pluginViews.length === 0 && <div className="flex-1" />}
      </div>

      {/* ── Footer — Settings ───────────────────────────────────────── */}
      <div className={`border-t border-border py-2 px-2 mt-auto ${collapsed ? "flex justify-center" : ""}`}>
        <NavItem
          viewKey="settings"
          label={t("mainToolbar.settings")}
          icon={<KeyRound className={`h-4 w-4 ${hasApiKey === false ? "text-destructive" : ""}`} />}
          isActive={false}
          onClick={onOpenSettings}
          collapsed={collapsed}
          data-testid="sidebar-settings"
          trailingSlot={
            hasApiKey === false && !collapsed ? (
              <span className="text-[10px] text-destructive">
                {t("mainToolbar.apiKeyRequired")}
              </span>
            ) : undefined
          }
        />
      </div>
    </aside>
  );
}
