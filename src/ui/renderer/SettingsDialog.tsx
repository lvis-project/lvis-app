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
        {saving ? "저장 중..." : "저장"}
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
  const s = useSettingsOrchestration(open, api, onSaved, onOpenChange);

  // Per-tab debounced save handlers. Toggle / radio / slider controls
  // call `.schedule()`; rapid bursts (slider drag) collapse into a single
  // `s.save(tab, { closeOnDone: false })` call 200ms after the most recent
  // change. The explicit TabSaveBar Save button calls `.cancel()` first
  // to avoid a double-write race (pending debounce + click on Save would
  // otherwise fire `s.save` twice), then `s.save(tab)` with the default
  // `closeOnDone: true`. `closeOnDone: false` for the debounce path is
  // critical: without it, every immediate-apply toggle would close the
  // dialog 200ms later.
  const llmSave = useDebouncedSave(() => void s.save("llm", { closeOnDone: false }));
  const chatSave = useDebouncedSave(() => void s.save("chat", { closeOnDone: false }));
  const webSave = useDebouncedSave(() => void s.save("web", { closeOnDone: false }));
  const marketplaceSave = useDebouncedSave(() => void s.save("marketplace", { closeOnDone: false }));

  useEffect(() => {
    if (open) setTab(normalizeSettingsTab(initialTab));
  }, [initialTab, open]);

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
            />
            <TabSaveBar
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
              onPiiRedactToggle={() => {
                s.setPiiRedactEnabled(!s.piiRedactEnabled);
                chatSave.schedule();
              }}
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
