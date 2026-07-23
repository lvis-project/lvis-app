import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n/react.js";
import { Button } from "../../components/ui/button.js";
import { Tabs, VerticalTabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs.js";
import {
  Brain,
  Palette,
  MessageSquare,
  Globe,
  Shield,
  UserCog,
  BarChart3,
  FileSearch,
  Server,
  Puzzle,
  Store,
  Info,
  Rocket,
  ChevronLeft,
  ChevronRight,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useContainerNarrow } from "./hooks/use-container-narrow.js";
import { SavedToastFloating, SavedToastProvider } from "./contexts/saved-toast.js";
import type { LvisApi } from "./types.js";
import { RolesTab } from "./tabs/RolesTab.js";
import { PermissionsTab } from "./tabs/PermissionsTab.js";
import { AuditTab } from "./tabs/AuditTab.js";
import { UsageDashboard } from "./components/UsageDashboard.js";
import { LlmTab } from "./tabs/LlmTab.js";
import { AppearanceTab } from "./tabs/AppearanceTab.js";
import { ChatTab } from "./tabs/ChatTab.js";
import { WebTab } from "./tabs/WebTab.js";
import { McpTab } from "./tabs/McpTab.js";
import { PluginConfigTab } from "./tabs/PluginConfigTab.js";
import { MarketplaceTab } from "./tabs/MarketplaceTab.js";
import { AboutTab } from "./tabs/AboutTab.js";
import { StartupTab } from "./tabs/StartupTab.js";
import { useSettingsOrchestration } from "./hooks/use-settings-orchestration.js";
import { useDebouncedSave } from "./hooks/use-debounced-save.js";
import { normalizeSettingsTab, type SettingsTab } from "../../shared/settings-tabs.js";
import type { MarketplacePackageFilter } from "../../shared/marketplace-package-sections.js";

type SettingsNavItem = { value: SettingsTab; icon: LucideIcon; labelKey: string };

/**
 * Grouped, data-driven settings navigation. Re-grouping or re-ordering is a
 * pure data edit here — the wide sidebar and the narrow mobile depth-1 list
 * both iterate this single array, so the two layouts can never drift. The
 * former "general" tab was split (account → Model, stats → Usage, system info
 * → the "about" tab appended to the Advanced group).
 */
const SETTINGS_NAV: { group: string; items: SettingsNavItem[] }[] = [
  {
    group: "settingsContent.groupAccountModel",
    items: [
      { value: "llm", icon: Brain, labelKey: "settingsContent.tabLlm" },
      { value: "usage", icon: BarChart3, labelKey: "settingsContent.tabUsage" },
    ],
  },
  {
    group: "settingsContent.groupApp",
    items: [
      { value: "appearance", icon: Palette, labelKey: "settingsContent.tabAppearance" },
      { value: "chat", icon: MessageSquare, labelKey: "settingsContent.tabChat" },
      { value: "web", icon: Globe, labelKey: "settingsContent.tabWeb" },
      { value: "startup", icon: Rocket, labelKey: "settingsContent.tabStartup" },
    ],
  },
  {
    group: "settingsContent.groupPermRoles",
    items: [
      { value: "permissions", icon: Shield, labelKey: "settingsContent.tabPermissions" },
      { value: "roles", icon: UserCog, labelKey: "settingsContent.tabRoles" },
    ],
  },
  {
    group: "settingsContent.groupPlugins",
    items: [
      { value: "marketplace", icon: Store, labelKey: "settingsContent.tabMarketplace" },
      { value: "plugin-config", icon: Puzzle, labelKey: "settingsContent.tabPluginConfig" },
      { value: "mcp", icon: Server, labelKey: "settingsContent.tabMcp" },
    ],
  },
  {
    group: "settingsContent.groupAdvanced",
    items: [
      { value: "audit", icon: FileSearch, labelKey: "settingsContent.tabAudit" },
    ],
  },
  // About is app/system info, not an "Advanced" setting — it sits on its own as
  // a divider-separated footer item (empty group string ⇒ headerless render)
  // rather than under the Advanced header.
  {
    group: "",
    items: [
      { value: "about", icon: Info, labelKey: "settingsContent.tabAbout" },
    ],
  },
];

/**
 * Inline save bar rendered at the bottom of each tab that holds a
 * deferred-save form (llm / chat / web / marketplace). Replaces the
 * single dialog-level footer Save button so the action lives next to
 * the inputs it persists, matching the per-section save policy used
 * by the rest of the dialog.
 */
function TabSaveBar({
  onSave,
  saving,
  settingsLoaded,
}: {
  onSave: () => void;
  saving: boolean;
  settingsLoaded: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 flex justify-end border-t border-border/(--opacity-medium) pt-3">
      <Button onClick={onSave} disabled={saving || !settingsLoaded}>
        {saving ? t("settingsContent.saving") : t("settingsContent.save")}
      </Button>
    </div>
  );
}


// `./contexts/saved-toast.tsx` so PluginConfigTab can import the consumer
// hook without forming a circular import with SettingsContent (which
// itself imports PluginConfigTab in this file).

export function SettingsContent({
  api,
  onSaved,
  initialTab = "llm",
  onClose,
}: {
  api: LvisApi;
  onSaved: () => void;
  initialTab?: string;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState(() => normalizeSettingsTab(initialTab));
  const [marketplaceFilter, setMarketplaceFilter] = useState<MarketplacePackageFilter>("all");
  const [pendingPermissions, setPendingPermissions] = useState(0);

  // the dialog. Tabs whose save runs through the orchestration hook hit
  // it via the wrapped `handleSaved` below; tabs with their own IPC
  // (PluginConfigTab / AppearanceTab / RolesTab / McpTab) call
  // `notifySaved()` from useNotifySaved() after their own success.
  //
  // Use a monotonic counter (not Date.now()) so two saves completing in
  // the same millisecond still cause the SavedToastFloating useEffect to
  // re-fire — React bails state updates via Object.is, and equal
  // timestamps would silently drop the second toast.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const notifySaved = useCallback(() => setSavedAt((n) => (n ?? 0) + 1), []);
  const handleSaved = useCallback(() => {
    notifySaved();
    onSaved();
  }, [notifySaved, onSaved]);
  const s = useSettingsOrchestration(api, handleSaved);

  // Per-tab debounced save handlers. Immediate-apply controls (toggle,
  // radio, slider, select) call `.schedule()`; rapid bursts collapse
  // into a single `s.save(tab)` 200ms after the most recent change.
  // The explicit TabSaveBar Save button calls `.cancel()` first to
  // avoid a double-write race (pending debounce + click would otherwise
  // fire `s.save` twice), then `s.save(tab)`. The save itself never
  // closes the dialog — modern multi-tab Settings (VS Code, Linear,
  // Raycast) keep the modal open after Save so the user can verify the
  // change and edit a sibling tab; close lives on the Dialog X / Esc.
  const llmSave = useDebouncedSave(() => void s.save("llm"));

  const chatSave = useDebouncedSave(() => void s.save("chat"));
  const webSave = useDebouncedSave(() => void s.save("web"));
  const marketplaceSave = useDebouncedSave(() => void s.save("marketplace"));
  const openMarketplaceTab = useCallback((filter: MarketplacePackageFilter = "all") => {
    setMarketplaceFilter(filter);
    setTab("marketplace");
  }, []);
  const handleTabValueChange = useCallback((nextTab: string) => {
    const normalized = normalizeSettingsTab(nextTab);
    if (normalized === "marketplace") setMarketplaceFilter("all");
    setTab(normalized);
    // Committing a category (click, or Enter in manual/narrow mode) drops into
    // depth-2 detail on narrow; inert on wide (both regions stay visible).
    setMobileDepth("detail");
  }, []);

  // Flush any pending debounced save when the user closes the window or
  // quits the app. The 200ms debounce window is short, but a user who
  // toggles a control and immediately hits Cmd+Q would otherwise lose
  // that toggle to the dying renderer process. `flush()` is a no-op
  // when nothing is pending, so registering all four is safe.
  // (Note: in the BrowserWindow conversion the hook's own unmount
  // cleanup also fires `cancel()`, so the pre-conversion Dialog
  // `open=false` cancel-effect was retired — see PR #890 review.)
  useEffect(() => {
    const flushAll = () => {
      llmSave.flush();
      chatSave.flush();
      webSave.flush();
      marketplaceSave.flush();
    };
    window.addEventListener("beforeunload", flushAll);
    window.addEventListener("pagehide", flushAll);
    return () => {
      window.removeEventListener("beforeunload", flushAll);
      window.removeEventListener("pagehide", flushAll);
    };
  }, [llmSave, chatSave, webSave, marketplaceSave]);

  // Reset tab + clear stale error banner whenever a new `initialTab` arrives
  // (mount or IPC-driven tab change). Depending on the whole `s` orchestration
  // object would re-fire this effect every render and clear the error banner
  // the moment it is set; depending on the stable `clearLastSaveError`
  // identity (`useCallback([])` inside the hook) keeps the dep list explicit.
  const clearLastSaveError = s.clearLastSaveError;
  useEffect(() => {
    setTab(normalizeSettingsTab(initialTab));
    clearLastSaveError();
  }, [initialTab, clearLastSaveError]);

  useEffect(() => {
    let alive = true;
    const refreshPending = async () => {
      try {
        const result = await api.permission.deferredList();
        if (alive && result.ok) setPendingPermissions(result.pending.length);
      } catch {
        if (alive) setPendingPermissions(0);
      }
    };
    void refreshPending();
    const unsubscribe = api.permission.onDeferredPending((summary) => {
      setPendingPermissions(summary.pending);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  // Scroll-reset: when the user switches tabs, reset the right pane to top
  // so they always land at the page header rather than the previous tab's
  // scroll position. `behavior: "instant"` avoids the animated scroll
  // fighting the tab transition animation on fast tab-switchers.
  const rightPaneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rightPaneRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [tab]);

  // ── Responsive shell ────────────────────────────────────────────────────
  // Panel-width (not viewport) responsive switch: the inline Settings panel can
  // be narrow on a wide display (split view / small window), so we measure the
  // panel root itself. Below ~640px (≈ Tailwind `sm`) the w-48 sidebar + content
  // master-detail is too cramped, so we collapse to a mobile 2-depth stack.
  // `useContainerNarrow`'s 60px dead-band (enter 640 / exit 700) keeps a drag
  // near the boundary from flip-flopping, and it reports wide (isNarrow=false)
  // under jsdom where ResizeObserver is absent — unit tests keep the
  // master-detail layout unchanged.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { isNarrow } = useContainerNarrow(rootRef, { enter: 640, exit: 700 });

  // Narrow-only 2-depth navigation. Depth 1 = the grouped category list;
  // depth 2 = one selected pane + a back bar. Default "list": a freshly opened
  // narrow panel shows the category list first, and the outer return-to-app back
  // button (PageShell, rendered above SettingsContent) stays the primary escape
  // from depth 1. Selecting a category marks it "detail"; on wide that is inert,
  // but it means a later narrowing lands on the actively-selected pane instead
  // of bouncing back to the list. On resize narrow→wide the depth is ignored
  // (both regions show); wide→narrow reuses the retained depth.
  const [mobileDepth, setMobileDepth] = useState<"list" | "detail">("list");
  const mobileBackRef = useRef<HTMLButtonElement>(null);

  // Focus hand-off across the narrow depth transition so keyboard focus never
  // lands in a `display:none` region. Entering detail focuses the back button;
  // returning to the list focuses the active category trigger. The prev-depth
  // guard means resizing into narrow (or first mount) never steals focus — only
  // a real user-driven depth change moves it.
  const prevDepthRef = useRef(mobileDepth);
  useEffect(() => {
    const prev = prevDepthRef.current;
    prevDepthRef.current = mobileDepth;
    if (!isNarrow || prev === mobileDepth) return;
    if (mobileDepth === "detail") {
      mobileBackRef.current?.focus();
    } else {
      rootRef.current
        ?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
        ?.focus();
    }
  }, [mobileDepth, isNarrow]);

  // Sidebar trigger style: full-width row, left-aligned, active row uses
  // accent background to read like a real selected list item rather than
  // the horizontal pill-tab style Radix ships by default. `data-[state=active]`
  // overrides the base TabsTrigger active style (background + shadow) which
  // looks wrong in a vertical list. `whitespace-nowrap` + `overflow-hidden`
  // keep long labels (or scaled-up system fonts) from wrapping to two lines
  // and breaking the row rhythm of the sidebar.
  // Sidebar trigger style includes `flex` (not inline-flex), `gap-2` for
  // the icon spacing, and explicit `justify-start` to override the
  // shadcn TabsTrigger primitive's default `inline-flex items-center
  // justify-center` (which would center-align the icon+label horizontally).
  const sideTriggerCls =
    "flex w-full items-center justify-start gap-2.5 overflow-hidden whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium " +
    "text-muted-foreground hover:bg-accent/(--opacity-strong) hover:text-foreground " +
    "data-[state=active]:bg-accent data-[state=active]:text-accent-foreground " +
    "data-[state=active]:shadow-none";
  // The active panel must grow with ordinary overflowing content. Keeping it
  // as a fixed `flex-1 min-h-0` item lets descendants overflow beyond the
  // panel's layout box, so the outer scroll pane's bottom padding is consumed
  // and the last control lands flush against the window edge. Active panels
  // are flex columns so split-pane children can still use `flex-1 min-h-0`.
  const tabContentCls =
    "min-h-full min-w-0 w-full shrink-0 outline-none data-[state=active]:flex data-[state=active]:flex-col";
  // Common icon class so the 12 nav entries render at a uniform 16px.
  const navIconCls = "size-4 shrink-0";

  return (
    <SavedToastProvider value={notifySaved}>
    <div ref={rootRef} className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
    <Tabs
      orientation="vertical"
      // Keyboard activation: automatic on wide (arrowing a trigger instantly
      // reveals its pane beside the list). Manual on narrow so arrowing browses
      // the depth-1 category list without committing into a pane on every key —
      // Enter/click commits and drops into depth-2 detail.
      activationMode={isNarrow ? "manual" : "automatic"}
      value={tab}
      onValueChange={handleTabValueChange}
      // `data-settings-layout` exposes the panel-width layout mode for tests.
      data-settings-layout={isNarrow ? "narrow" : "wide"}
      // No gap: sidebar and content share a single border (right edge of
      // the sidebar) so the layout reads as two regions of the dialog,
      // not two stacked cards. Simplified per user direction

      className="relative flex h-full min-h-0 min-w-0 flex-1"
    >
      {/* Dialog-wide save feedback — anchored to the Tabs root (not the
          right pane) so the user sees it even after scrolling deep into
          a tab. Top-center placement keeps it in the spot the eye lands
          immediately after clicking Save. */}
      <SavedToastFloating at={savedAt} />

      {/* Nav column. Wide: fixed sidebar (w-48 + border-r) that scrolls
          independently and stays put while the right pane scrolls. Narrow: the
          full-width depth-1 category list (no divider — it is the whole view),
          hidden at depth-2 detail.
          Outer div owns the column width so the version footer can sit below
          the nav list as a sibling (Radix TabsList only accepts TabsTrigger
          children). */}
      <div
        data-testid={isNarrow ? "settings-mobile-list" : undefined}
        className={cn(
          "flex h-full flex-col",
          isNarrow ? "w-full" : "w-48 shrink-0 border-r",
          isNarrow && mobileDepth === "detail" && "hidden",
        )}
      >
      {/* Sidebar settings header. `pt-6` mirrors the right-pane stack
          (scroll pt-2 + TabsContent mt-2 + SettingsPageHeader pt-2 = 24)
          so the sidebar h2 baseline aligns with the right-pane h2 of
          the active tab. `px-5` (20px) aligns the settings text-left with
          the nav-trigger icon-left (TabsList p-2 + trigger px-3 = 20). */}
      <div className="flex items-center gap-2 px-5 pt-6 mb-6">
        <h2
          data-testid="settings-sidebar-heading"
          className="min-w-0 flex-1 truncate text-xl font-semibold leading-9 tracking-normal"
        >
          {t("settingsContent.sidebarHeading")}
        </h2>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t("settingsContent.closeButton")}
            data-testid="settings-close"
            className="size-8 shrink-0"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {/* VerticalTabsList bakes in the shadcn vertical-sidebar override
          (flex-col + justify-start + rounded-none + bg-transparent); only
          the instance-specific column behaviour stays here. */}
      <VerticalTabsList
        aria-label={t("settingsContent.sidebarAriaLabel")}
        className="flex-1 overflow-y-auto"
      >
        {SETTINGS_NAV.map((group) => (
          <Fragment key={group.items[0]?.value ?? group.group}>
            {/* Group header: uppercase, muted, small mono. Non-focusable (a
                plain generic element, skipped by the tablist roving focus) so
                arrow keys still move only between triggers. A group with an
                empty header string (the trailing About item) renders a thin
                divider instead, separating it as a standalone footer entry. */}
            {group.group ? (
              <div className="select-none px-3 pb-1 pt-3 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground first:pt-0">
                {t(group.group)}
              </div>
            ) : (
              <div className="mx-3 my-2 border-t border-border/(--opacity-medium)" aria-hidden="true" />
            )}
            {group.items.map((item) => {
              const Icon = item.icon;
              const isPermissions = item.value === "permissions";
              return (
                <TabsTrigger
                  key={item.value}
                  value={item.value}
                  className={sideTriggerCls}
                  // Radix fires `onValueChange` only when the value actually
                  // changes, so tapping the ALREADY-active category in the
                  // narrow list would never drill in. Drill on any activation
                  // (TabsTrigger is a button, so this also covers keyboard
                  // Enter/Space); inert on wide.
                  onClick={() => { if (isNarrow) setMobileDepth("detail"); }}
                >
                  <Icon className={navIconCls} aria-hidden="true" />
                  <span className="min-w-0 truncate">{t(item.labelKey)}</span>
                  {isPermissions && pendingPermissions > 0 && (
                    <span
                      className={cn(
                        "rounded-full bg-destructive px-1.5 py-0.5 text-[10px] leading-none text-destructive-foreground",
                        !isNarrow && "ml-auto",
                      )}
                    >
                      {pendingPermissions}
                    </span>
                  )}
                  {/* Narrow depth-1 rows read as a drill-in list: trailing
                      chevron cues the tap-to-detail affordance. */}
                  {isNarrow && (
                    <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                </TabsTrigger>
              );
            })}
          </Fragment>
        ))}
      </VerticalTabsList>
      {/* Version footer — fills dead space at the bottom of the sidebar
          tastefully. Static text only; no IPC needed. */}
      <div className="shrink-0 border-t px-3 py-2.5">
        <span className="text-[11px] tabular-nums text-muted-foreground/(--opacity-strong) select-none">
          v0.1.8
        </span>
      </div>
      </div>

      {/* Right pane — two-layer layout so split-pane tabs (PluginConfigTab,
          McpTab) can use h-full reliably.
          Outer: `overflow-hidden flex-col flex-1` — gives a fixed height
            to the column so children can fill it with h-full / flex-1.
          Inner scroll: `overflow-y-auto [scrollbar-gutter:stable]` —
            scrolls only when content overflows AND reserves the gutter
            via the CSS `scrollbar-gutter` property so the layout
            doesn't shift on short pages. Replaces the previous
            `overflow-y-scroll` (always-visible track) — that variant
            caused a double-scrollbar on Win/Linux for tabs that owned
            their own internal scroll (PluginConfigTab, McpTab).
          Top padding: pt-2 on the inner scroll matches the sidebar
          wrapper's pt-2, plus SettingsPageHeader's pt-2 lands h2 at
          the same Y as the sidebar first trigger text — both well
          below the title bar. */}
      <div
        className={cn(
          "flex flex-1 min-w-0 flex-col overflow-hidden",
          // Narrow depth-1 (list) hides the pane; depth-2 shows only the pane.
          isNarrow && mobileDepth === "list" && "hidden",
        )}
      >
      {/* Narrow depth-2 back bar — returns to the depth-1 category list. The
          outer PageShell back button (return to app) stays above this. */}
      {isNarrow && (
        <div className="flex shrink-0 items-center border-b px-2 py-2">
          <button
            ref={mobileBackRef}
            type="button"
            onClick={() => setMobileDepth("list")}
            aria-label={t("settingsContent.mobileBackAria")}
            data-testid="settings-mobile-back"
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/(--opacity-strong) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
            {t("settingsContent.sidebarHeading")}
          </button>
        </div>
      )}
      <div ref={rightPaneRef} className="flex min-w-0 flex-1 min-h-0 flex-col overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] px-4 pt-2 pb-12 scroll-pb-12 sm:px-8 lvis-settings-scroll">
        {s.lastSaveError && (
          <div
            role="alert"
            className="mb-3 flex items-start justify-between gap-2 rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
            data-testid="settings-save-error"
          >
            <div className="min-w-0">
              <p className="font-medium">{t("settingsContent.saveErrorMessage", { tab: s.lastSaveError.tab })}</p>
              <p className="text-[11px] opacity-80">{s.lastSaveError.message}</p>
            </div>
            <button
              type="button"
              className="text-[11px] underline opacity-80 hover:opacity-100"
              onClick={s.clearLastSaveError}
            >
              {t("settingsContent.closeButton")}
            </button>
          </div>
        )}

          <TabsContent value="about" className={tabContentCls}>
            <AboutTab api={api} />
          </TabsContent>

          <TabsContent value="llm" className={tabContentCls}>
            <LlmTab
              api={api}
              vendor={s.vendor}
              setVendor={s.setVendor}
              baseUrl={s.baseUrl}
              setBaseUrl={s.setBaseUrl}
              vertexProject={s.vertexProject}
              setVertexProject={s.setVertexProject}
              vertexLocation={s.vertexLocation}
              setVertexLocation={s.setVertexLocation}
              hasKey={s.hasKey}
              setHasKey={s.setHasKey}
              keyInput={s.keyInput}
              setKeyInput={s.setKeyInput}
              marketplaceProviderPresetId={s.marketplaceProviderPresetId}
              marketplaceProviderPresets={s.marketplaceProviderPresets}
              onSelectMarketplaceProviderPreset={s.selectMarketplaceProviderPreset}
              onClearMarketplaceProviderPreset={s.clearMarketplaceProviderPreset}
              onOpenMarketplace={() => openMarketplaceTab("provider")}
              model={s.model}
              setModel={s.setModel}
              enableThinking={s.enableThinking}
              setEnableThinking={s.setEnableThinking}
              thinkingBudget={s.thinkingBudget}
              setThinkingBudget={s.setThinkingBudget}
              fallbackChain={s.fallbackChain}
              setFallbackChain={s.setFallbackChain}
              fallbackOpen={s.fallbackOpen}
              setFallbackOpen={s.setFallbackOpen}
              hostResolverMap={s.hostResolverMap}
              setHostResolverMap={s.setHostResolverMap}
              loadedHostResolverMap={s.loadedHostResolverMap}
              onSaved={onSaved}
              onImmediateChange={llmSave.schedule}
              onSave={() => {
                llmSave.cancel();
                void s.save("llm");
              }}
              saving={s.saving}
              settingsLoaded={s.settingsLoaded}
            />
          </TabsContent>

          <TabsContent value="appearance" className={tabContentCls}>
            <AppearanceTab onOpenMarketplace={openMarketplaceTab} />
          </TabsContent>

          <TabsContent value="chat" className={tabContentCls}>
            <ChatTab
              autoCompact={s.autoCompact}
              setAutoCompact={s.setAutoCompact}
              streamSmoothing={s.streamSmoothing}
              setStreamSmoothing={s.setStreamSmoothing}
              idlePreferenceRefresh={s.idlePreferenceRefresh}
              setIdlePreferenceRefresh={s.setIdlePreferenceRefresh}
              subAgentAutonomousWake={s.subAgentAutonomousWake}
              setSubAgentAutonomousWake={s.setSubAgentAutonomousWake}
              piiRedactEnabled={s.piiRedactEnabled}
              settingsLoaded={s.settingsLoaded}
              // ChatTab wraps onPiiRedactToggle with onImmediateChange.
              // Feature toggles own separate `features` patch paths,
              // so it must not schedule the bulk chat payload.
              onPiiRedactToggle={() => s.setPiiRedactEnabled(!s.piiRedactEnabled)}
              onImmediateChange={chatSave.schedule}
            />
            {/* ChatTab is fully immediate-apply — no deferred-save bar needed. */}
          </TabsContent>

          <TabsContent value="web" className={tabContentCls}>
            <WebTab
              api={api}
              webProvider={s.webProvider}
              setWebProvider={s.setWebProvider}
              hasWebKey={s.hasWebKey}
              setHasWebKey={s.setHasWebKey}
              webKeyInput={s.webKeyInput}
              setWebKeyInput={s.setWebKeyInput}
              onSaved={onSaved}
              onImmediateChange={webSave.schedule}
            />
            <TabSaveBar
              onSave={() => {
                webSave.cancel();
                void s.save("web");
              }}
              saving={s.saving}
              settingsLoaded={s.settingsLoaded}
            />
          </TabsContent>

          <TabsContent value="startup" className={tabContentCls}><StartupTab /></TabsContent>
          <TabsContent value="permissions" className={tabContentCls}><PermissionsTab /></TabsContent>
          <TabsContent value="roles" className={tabContentCls}><RolesTab api={api} /></TabsContent>
          <TabsContent value="usage" className={tabContentCls}>
            <UsageDashboard
              api={api}
              onNavigate={(nextTab) => setTab(normalizeSettingsTab(nextTab))}
            />
          </TabsContent>
          <TabsContent value="audit" className={tabContentCls}><AuditTab /></TabsContent>
          <TabsContent value="mcp" className={tabContentCls}><McpTab /></TabsContent>
          <TabsContent value="plugin-config" className={tabContentCls}><PluginConfigTab api={api} /></TabsContent>
          <TabsContent value="marketplace" className={tabContentCls}>
            <MarketplaceTab
              api={api}
              baseUrl={s.marketplaceBaseUrl}
              setBaseUrl={s.setMarketplaceBaseUrl}
              allowPrivateNetwork={s.marketplaceAllowPrivateNetwork}
              setAllowPrivateNetwork={s.setMarketplaceAllowPrivateNetwork}
              hasApiKey={s.hasMarketplaceApiKey}
              setHasApiKey={s.setHasMarketplaceApiKey}
              apiKeyInput={s.marketplaceApiKeyInput}
              setApiKeyInput={s.setMarketplaceApiKeyInput}
              initialFilter={marketplaceFilter}
              onSaved={onSaved}
              onImmediateChange={marketplaceSave.schedule}
            />
            {/* No bottom TabSaveBar — URL + API key each own an inline
                Save; private-network toggle is immediate-apply. */}
          </TabsContent>
      </div>
      </div>
    </Tabs>
    </div>
    </SavedToastProvider>
  );
}
