import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
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

export function SettingsDialog({
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>앱 환경, 채팅 동작, 검색 엔진, 권한 정책을 설정합니다.</DialogDescription>
        </DialogHeader>
        <SettingsContent
          open={open}
          onOpenChange={onOpenChange}
          api={api}
          onSaved={onSaved}
          initialTab={initialTab}
        />
      </DialogContent>
    </Dialog>
  );
}

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
  const s = useSettingsOrchestration(open, api, onSaved);

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

  return (
    <>
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
        <Tabs value={tab} onValueChange={(nextTab) => setTab(normalizeSettingsTab(nextTab))}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 [&>*]:!grow-0 [&>*]:!shrink-0 [&>*]:!basis-auto overflow-x-auto">
            <TabsTrigger value="llm">지능 (LLM)</TabsTrigger>
            <TabsTrigger value="appearance">테마</TabsTrigger>
            <TabsTrigger value="chat">채팅</TabsTrigger>
            <TabsTrigger value="web">검색 (Web)</TabsTrigger>
            <TabsTrigger value="permissions" className="gap-1.5">
              권한
              {pendingPermissions > 0 && (
                <span className="rounded-full bg-destructive px-1.5 py-0.5 text-[10px] leading-none text-destructive-foreground">
                  {pendingPermissions}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="roles">역할</TabsTrigger>
            <TabsTrigger value="usage">사용량</TabsTrigger>
            <TabsTrigger value="audit">감사</TabsTrigger>
            <TabsTrigger value="plugin-perf">플러그인 성능</TabsTrigger>
            <TabsTrigger value="mcp">MCP 서버</TabsTrigger>
            <TabsTrigger value="plugin-config">플러그인 설정</TabsTrigger>
            <TabsTrigger value="marketplace">마켓플레이스</TabsTrigger>
          </TabsList>

          <TabsContent value="llm">
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

          <TabsContent value="appearance">
            <AppearanceTab />
          </TabsContent>

          <TabsContent value="chat">
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

          <TabsContent value="web">
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

          <TabsContent value="permissions"><PermissionsTab /></TabsContent>
          <TabsContent value="roles"><RolesTab api={api} /></TabsContent>
          <TabsContent value="usage"><UsageDashboard api={api} /></TabsContent>
          <TabsContent value="audit"><AuditTab /></TabsContent>
          <TabsContent value="plugin-perf"><PluginPerfTab api={api} /></TabsContent>
          <TabsContent value="mcp"><McpTab /></TabsContent>
          <TabsContent value="plugin-config"><PluginConfigTab /></TabsContent>
          <TabsContent value="marketplace">
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
        </Tabs>
    </>
  );
}
