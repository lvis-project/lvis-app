import { Suspense } from "react";
import {
  Database,
  Home,
  KanbanSquare,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Repeat2,
  ShoppingBag,
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
   * lives on THIS card's right edge (see `onToggleCollapse`). When `true` the
   * floating card narrows to an icon-only rail.
   */
  collapsed: boolean;
  /** Toggle the rail — the control pinned to this card's right edge. */
  onToggleCollapse: () => void;
}

// ─── Platform bridge (darwin traffic-light clearance) ──────────────────────────
// On macOS the OS draws the traffic lights at {x:14,y:12}. The floating card now
// extends to the window top (top-0), so its top-left would sit under the lights.
// We add top padding on darwin to push the New Chat CTA below them. Returns false
// when the preload bridge is absent (jsdom / Storybook / SSR) — no native chrome
// to clear there.
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
type NavTone = "accent" | "muted";

const NAV_TONE_HOVER: Record<NavTone, string> = {
  accent: "hover:bg-accent hover:text-accent-foreground",
  muted: "hover:bg-muted hover:text-foreground",
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
  const hoverTone = NAV_TONE_HOVER[tone];
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
          ? "bg-primary/(--opacity-subtle) text-primary"
          : `text-muted-foreground ${hoverTone}`,
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
      data-tour-anchor={tourAnchor}
      className={[
        "relative w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive
          ? "bg-primary/(--opacity-subtle) text-primary font-medium"
          : `text-muted-foreground ${hoverTone}`,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {isActive && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
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

export function Sidebar({
  activeView,
  onSelect,
  pluginViews,
  pluginAuthStatuses,
  hasApiKey,
  onOpenSettings,
  onNewChat,
  streaming,
  onOpenMarketplace,
  marketplaceUrlReady = false,
  collapsed,
  onToggleCollapse,
}: SidebarProps) {
  const { t } = useTranslation();

  // The collapsed rail shows icons only; `compact` mirrors `collapsed`. There is
  // no hover-expand — the card is a consistent floating panel in every mode.
  const compact = collapsed;
  // On darwin the card top sits under the OS traffic lights (x:14,y:12); pad the
  // card content below them. Win/Linux + non-Electron need no clearance.
  const darwinTopClearance = isDarwinPlatform();

  const navListId = "sidebar-nav-list";

  return (
    // The sidebar is a FLOATING card — inset on all sides with rounded corners +
    // shadow, a distinct surface (bg-card) over the content row. (The CONTENT
    // pages are NOT floating — that's handled separately by removing each view's
    // outer Card box so content fills the canvas.) Toggle lives in the band.
    <aside
      data-testid="primary-sidebar"
      role="navigation"
      aria-label={t("sidebar.ariaLabel")}
      className={[
        // top-0 lets the floating card extend UP into the traffic-light band,
        // reclaiming the vertical space on the left. `overflow-visible` so the
        // collapse toggle pinned to the right edge can sit half outside.
        "absolute left-3 top-0 bottom-3 z-30 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl transition-[width] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "w-14" : "w-56",
      ].join(" ")}
      // The card overlays the Electron drag band (it extends to top-0). Mark it
      // no-drag so its controls stay clickable; the OS traffic lights still own
      // their own hit region above the padded content.
      style={{
        // @ts-expect-error — Electron-specific CSS extension
        WebkitAppRegion: "no-drag",
      }}
    >
      {/* ── Header strip — collapse/expand toggle aligned to the card's RIGHT
          edge. On darwin this strip sits in the traffic-light band: the OS
          lights own the left (x:14), the toggle owns the right. `pt-7` on darwin
          drops the strip's content below the lights' vertical center while the
          toggle stays right of them; win/linux + non-Electron need no clearance. */}
      <div className={`flex items-center justify-end px-1 ${darwinTopClearance ? "pt-7" : "pt-1"}`}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 aspect-square p-0 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onToggleCollapse}
              title={collapsed ? t("mainToolbar.expandSidebar") : t("mainToolbar.collapseSidebar")}
              aria-label={collapsed ? t("mainToolbar.expandSidebar") : t("mainToolbar.collapseSidebar")}
              aria-pressed={!collapsed}
              data-testid="sidebar-collapse-toggle"
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? t("mainToolbar.expandSidebar") : t("mainToolbar.collapseSidebar")}</TooltipContent>
        </Tooltip>
      </div>

      {/* ── New Chat CTA — below the header strip. */}
      <div className={`px-2 pt-1 pb-1 ${compact ? "flex justify-center" : ""}`}>
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
          <NavItem
            viewKey="memory"
            label={t("mainToolbar.memory")}
            icon={<Database className="h-4 w-4" />}
            isActive={activeView === "memory"}
            onClick={() => onSelect("memory")}
            collapsed={compact}
            data-testid="sidebar-memory"
          />
          <NavItem
            viewKey="starred"
            label={t("mainToolbar.starred")}
            icon={<Star className="h-4 w-4" />}
            isActive={activeView === "starred"}
            onClick={() => onSelect("starred")}
            collapsed={compact}
            data-testid="sidebar-starred"
          />
        </div>

        {/* PLUGINS group — scrollable flex-1 */}
        {pluginViews.length > 0 && (
          <>
            <SectionDivider collapsed={compact} label={compact ? undefined : t("sidebar.pluginsLabel")} />
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
              </div>
            </ScrollArea>
          </>
        )}

        {/* Spacer when no plugin list (keeps footer pinned) */}
        {pluginViews.length === 0 && <div className="flex-1" />}
      </div>

      {/* ── Footer — Marketplace + Settings ────────────────────────── */}
      {/* `pt-5` (20px): the footer is bottom-pinned (`mt-auto`), so its top edge —
          the divider "홈의 윗 라인" — is `sidebarBottom − footerHeight`. Padding
          above the rows raises that divider until it pixel-aligns (≈1px) with the
          composer's `border-t` pill seam on the right at the 460×840 default
          window. The two live in independent containers (floating-card sidebar vs
          flex content column) with different bottom anchors, so the alignment is
          tuned for the default size; it drifts a few px at other window heights. */}
      <div className={`border-t border-border px-2 pb-2 pt-5 mt-auto space-y-0.5 ${compact ? "flex flex-col items-center space-y-0.5" : ""}`}>
        {/* Home — placed above the marketplace, capped by this footer's border-t
            divider (which matches the composer's border-t seam). */}
        <NavItem
          viewKey="home"
          label={t("mainToolbar.home")}
          icon={<Home className="h-4 w-4" />}
          isActive={activeView === "home"}
          onClick={() => onSelect("home")}
          collapsed={compact}
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
          tone="muted"
          data-testid="sidebar-marketplace"
          data-tour-anchor="sidebar-marketplace"
        />
        <NavItem
          viewKey="settings"
          label={t("mainToolbar.settings")}
          icon={<KeyRound className={`h-4 w-4 ${hasApiKey === false ? "text-destructive" : ""}`} />}
          // Active when settings render inline (action mode). Marketplace stays
          // false — it's an overlay launcher that never sets activeView.
          isActive={activeView === "settings"}
          onClick={onOpenSettings}
          collapsed={compact}
          tone="muted"
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
    </aside>
  );
}
