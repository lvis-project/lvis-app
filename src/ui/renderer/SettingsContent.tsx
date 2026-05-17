import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs.js";
import {
  Brain,
  Palette,
  MessageSquare,
  Globe,
  Shield,
  UserCog,
  BarChart3,
  FileSearch,
  Gauge,
  Server,
  Puzzle,
  Store,
} from "lucide-react";
import { SavedToastFloating, SavedToastProvider } from "./contexts/saved-toast.js";
import type { LvisApi } from "./types.js";
import { RolesTab } from "./tabs/RolesTab.js";
import { PermissionsTab } from "./tabs/PermissionsTab.js";
import { AuditTab } from "./tabs/AuditTab.js";
import { UsageDashboard } from "./components/UsageDashboard.js";
import { PluginPerfTab } from "./tabs/PluginPerfTab.js";
import { LlmTab } from "./tabs/LlmTab.js";
import { AppearanceTab } from "./tabs/AppearanceTab.js";
import { ChatTab } from "./tabs/ChatTab.js";
import { WebTab } from "./tabs/WebTab.js";
import { McpTab } from "./tabs/McpTab.js";
import { PluginConfigTab } from "./tabs/PluginConfigTab.js";
import { MarketplaceTab } from "./tabs/MarketplaceTab.js";
import { useSettingsOrchestration } from "./hooks/use-settings-orchestration.js";
import { useDebouncedSave } from "./hooks/use-debounced-save.js";
import { normalizeSettingsTab } from "../../shared/settings-tabs.js";

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
  return (
    <div className="mt-4 flex justify-end border-t border-border/40 pt-3">
      <Button onClick={onSave} disabled={saving || !settingsLoaded}>
        {saving ? "저장 중…" : "저장"}
      </Button>
    </div>
  );
}

// Settings-wide "저장되었습니다" toast plumbing now lives in
// `./contexts/saved-toast.tsx` so PluginConfigTab can import the consumer
// hook without forming a circular import with SettingsContent (which
// itself imports PluginConfigTab in this file).

export function SettingsContent({
  open,
  onOpenChange,
  api,
  onSaved,
  initialTab = "llm",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  api: LvisApi;
  onSaved: () => void;
  initialTab?: string;
}) {
  const [tab, setTab] = useState(() => normalizeSettingsTab(initialTab));
  const [pendingPermissions, setPendingPermissions] = useState(0);
  // Floating "저장되었습니다" pulse — bumped on EVERY successful save in
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
  const s = useSettingsOrchestration(open, api, handleSaved);

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

  // Cancel any pending debounced save when the dialog transitions to
  // closed. Radix Dialog keeps its children mounted when `open=false`,
  // so the hook's unmount-cleanup would otherwise miss this case —
  // a toggle a millisecond before close would still fire its 200ms
  // debounced save on a "closed" dialog, persisting a half-edited
  // value the user already abandoned.
  useEffect(() => {
    if (!open) {
      llmSave.cancel();
      chatSave.cancel();
      webSave.cancel();
      marketplaceSave.cancel();
    }
  }, [open, llmSave, chatSave, webSave, marketplaceSave]);

  // Flush any pending debounced save when the user closes the window or
  // quits the app. The 200ms debounce window is short, but a user who
  // toggles a control and immediately hits Cmd+Q would otherwise lose
  // that toggle to the dying renderer process. `flush()` is a no-op
  // when nothing is pending, so registering all four is safe.
  useEffect(() => {
    if (!open) return;
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
  }, [open, llmSave, chatSave, webSave, marketplaceSave]);

  // Reset tab + clear stale error banner ONLY when the dialog transitions
  // open. Depending on the whole `s` orchestration object would re-fire
  // this effect every render (since `s` is recreated each render) and
  // clear the error banner the moment it is set — the user would see it
  // flash and disappear. Depending on the stable `clearLastSaveError`
  // identity (it is a `useCallback([])` inside the hook) keeps the
  // dependency list explicit while still firing only on dialog open.
  const clearLastSaveError = s.clearLastSaveError;
  useEffect(() => {
    if (open) {
      setTab(normalizeSettingsTab(initialTab));
      clearLastSaveError();
    }
  }, [initialTab, open, clearLastSaveError]);

  useEffect(() => {
    if (!open) return;
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
  }, [api, open]);

  // Scroll-reset: when the user switches tabs, reset the right pane to top
  // so they always land at the page header rather than the previous tab's
  // scroll position. `behavior: "instant"` avoids the animated scroll
  // fighting the tab transition animation on fast tab-switchers.
  const rightPaneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rightPaneRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [tab]);

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
    "text-muted-foreground hover:bg-accent/60 hover:text-foreground " +
    "data-[state=active]:bg-accent data-[state=active]:text-accent-foreground " +
    "data-[state=active]:shadow-none";
  // Common icon class so the 12 nav entries render at a uniform 16px.
  const navIconCls = "size-4 shrink-0";

  return (
    <SavedToastProvider value={notifySaved}>
    <Tabs
      orientation="vertical"
      value={tab}
      onValueChange={(nextTab) => setTab(normalizeSettingsTab(nextTab))}
      // No gap: sidebar and content share a single border (right edge of
      // the sidebar) so the layout reads as two regions of the dialog,
      // not two stacked cards. Simplified per user direction
      // "레이아웃을 단순화해".
      className="relative flex h-full min-h-0"
    >
      {/* Dialog-wide save feedback — anchored to the Tabs root (not the
          right pane) so the user sees it even after scrolling deep into
          a tab. Top-center placement keeps it in the spot the eye lands
          immediately after clicking Save. */}
      <SavedToastFloating at={savedAt} />

      {/* Sidebar — fixed column, scrolls independently if the trigger list
          ever grows beyond the available height. The list stays put when
          the right pane scrolls (the headline ux complaint that motivated
          the sidebar conversion). */}
      <TabsList
        aria-label="설정 카테고리"
        // Vertical sidebar — the shadcn TabsList primitive defaults to a
        // horizontal pill (`inline-flex h-10 items-center justify-center
        // rounded-md bg-muted p-1`). cn() merges class lists but only
        // tailwind-merge collapses conflicting utilities — the primitive's
        // `justify-center` survived previous overrides because we never
        // specified a competing `justify-*`, which left every trigger
        // vertically centered in the column (the "사이드바가 상단으로 안
        // 올라옴" symptom). Explicit `justify-start` + `h-full` + plain
        // `flex` (not inline-flex) + `rounded-none bg-transparent` make
        // the override unambiguous.
        className="flex h-full w-48 shrink-0 flex-col items-stretch justify-start gap-1 overflow-y-auto rounded-none border-r bg-transparent p-2"
      >
        <TabsTrigger value="llm" className={sideTriggerCls}>
          <Brain className={navIconCls} aria-hidden="true" />
          모델
        </TabsTrigger>
        <TabsTrigger value="appearance" className={sideTriggerCls}>
          <Palette className={navIconCls} aria-hidden="true" />
          테마
        </TabsTrigger>
        <TabsTrigger value="chat" className={sideTriggerCls}>
          <MessageSquare className={navIconCls} aria-hidden="true" />
          채팅
        </TabsTrigger>
        <TabsTrigger value="web" className={sideTriggerCls}>
          <Globe className={navIconCls} aria-hidden="true" />
          검색 (Web)
        </TabsTrigger>
        <TabsTrigger value="permissions" className={sideTriggerCls}>
          <Shield className={navIconCls} aria-hidden="true" />
          권한
          {pendingPermissions > 0 && (
            <span className="ml-auto rounded-full bg-destructive px-1.5 py-0.5 text-[10px] leading-none text-destructive-foreground">
              {pendingPermissions}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="roles" className={sideTriggerCls}>
          <UserCog className={navIconCls} aria-hidden="true" />
          역할
        </TabsTrigger>
        <TabsTrigger value="usage" className={sideTriggerCls}>
          <BarChart3 className={navIconCls} aria-hidden="true" />
          사용량
        </TabsTrigger>
        <TabsTrigger value="audit" className={sideTriggerCls}>
          <FileSearch className={navIconCls} aria-hidden="true" />
          감사
        </TabsTrigger>
        <TabsTrigger value="plugin-perf" className={sideTriggerCls}>
          <Gauge className={navIconCls} aria-hidden="true" />
          플러그인 성능
        </TabsTrigger>
        <TabsTrigger value="mcp" className={sideTriggerCls}>
          <Server className={navIconCls} aria-hidden="true" />
          MCP 서버
        </TabsTrigger>
        <TabsTrigger value="plugin-config" className={sideTriggerCls}>
          <Puzzle className={navIconCls} aria-hidden="true" />
          플러그인 설정
        </TabsTrigger>
        <TabsTrigger value="marketplace" className={sideTriggerCls}>
          <Store className={navIconCls} aria-hidden="true" />
          마켓플레이스
        </TabsTrigger>
      </TabsList>

      {/* Right pane — two-layer layout so split-pane tabs (PluginConfigTab,
          McpTab) can use h-full reliably.
          Outer: `overflow-hidden flex-col flex-1` — gives a fixed height
            to the column so children can fill it with h-full / flex-1.
          Inner scroll: `overflow-y-scroll flex-1 min-h-0` — the actual
            scroll container. `overflow-y-scroll` (not `auto`) keeps the
            gutter always-reserved so layout doesn't shift on short pages.
            `lvis-settings-scroll` hooks the themed webkit scrollbar.
          pt-2 on outer matches the sidebar's p-2 so the first sidebar
          trigger and the SettingsPageHeader h2 land at the same Y. */}
      <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
      <div ref={rightPaneRef} className="flex flex-1 min-h-0 flex-col overflow-y-scroll px-6 pt-2 pb-5 lvis-settings-scroll">
        {s.lastSaveError && (
          <div
            role="alert"
            className="mb-3 flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="settings-save-error"
          >
            <div className="min-w-0">
              <p className="font-medium">설정 저장 실패 — {s.lastSaveError.tab} 탭</p>
              <p className="text-[11px] opacity-80">{s.lastSaveError.message}</p>
            </div>
            <button
              type="button"
              className="text-[11px] underline opacity-80 hover:opacity-100"
              onClick={s.clearLastSaveError}
            >
              닫기
            </button>
          </div>
        )}

          <TabsContent value="llm" className="flex-1 min-h-0 outline-none">
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

          <TabsContent value="appearance" className="flex-1 min-h-0 outline-none">
            <AppearanceTab />
          </TabsContent>

          <TabsContent value="chat" className="flex-1 min-h-0 outline-none">
            <ChatTab
              autoCompact={s.autoCompact}
              setAutoCompact={s.setAutoCompact}
              streamSmoothing={s.streamSmoothing}
              setStreamSmoothing={s.setStreamSmoothing}
              idlePreferenceRefresh={s.idlePreferenceRefresh}
              setIdlePreferenceRefresh={s.setIdlePreferenceRefresh}
              piiRedactEnabled={s.piiRedactEnabled}
              settingsLoaded={s.settingsLoaded}
              // ChatTab wraps onPiiRedactToggle with onImmediateChange.
              // idlePreferenceRefresh owns a separate `features` patch path,
              // so it must not schedule the bulk chat payload.
              onPiiRedactToggle={() => s.setPiiRedactEnabled(!s.piiRedactEnabled)}
              onImmediateChange={chatSave.schedule}
            />
            {/* ChatTab is fully immediate-apply — no deferred-save bar needed. */}
          </TabsContent>

          <TabsContent value="web" className="flex-1 min-h-0 outline-none">
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

          <TabsContent value="permissions" className="flex-1 min-h-0 outline-none"><PermissionsTab /></TabsContent>
          <TabsContent value="roles" className="flex-1 min-h-0 outline-none"><RolesTab api={api} /></TabsContent>
          <TabsContent value="usage" className="flex-1 min-h-0 outline-none"><UsageDashboard api={api} /></TabsContent>
          <TabsContent value="audit" className="flex-1 min-h-0 outline-none"><AuditTab /></TabsContent>
          <TabsContent value="plugin-perf" className="flex-1 min-h-0 outline-none"><PluginPerfTab api={api} /></TabsContent>
          <TabsContent value="mcp" className="flex-1 min-h-0 outline-none"><McpTab /></TabsContent>
          <TabsContent value="plugin-config" className="flex-1 min-h-0 outline-none"><PluginConfigTab /></TabsContent>
          <TabsContent value="marketplace" className="flex-1 min-h-0 outline-none">
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
              onSaved={onSaved}
              onImmediateChange={marketplaceSave.schedule}
            />
            <TabSaveBar
              onSave={() => {
                marketplaceSave.cancel();
                void s.save("marketplace");
              }}
              saving={s.saving}
              settingsLoaded={s.settingsLoaded}
            />
          </TabsContent>
      </div>
      </div>
    </Tabs>
    </SavedToastProvider>
  );
}
