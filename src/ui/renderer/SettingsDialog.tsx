import { useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import type { LvisApi } from "./types.js";
import { RolesTab } from "./tabs/RolesTab.js";
import { PermissionsTab } from "./tabs/PermissionsTab.js";
import { AuditTab } from "./tabs/AuditTab.js";
import { UsageDashboard } from "./components/UsageDashboard.js";
import { PluginPerfTab } from "./tabs/PluginPerfTab.js";
import { PrivacyTab } from "./tabs/PrivacyTab.js";
import { LlmTab } from "./tabs/LlmTab.js";
import { AdvancedTab } from "./tabs/AdvancedTab.js";
import { ChatTab } from "./tabs/ChatTab.js";
import { WebTab } from "./tabs/WebTab.js";
import { ProactiveTab } from "./tabs/ProactiveTab.js";
import { McpTab } from "./tabs/McpTab.js";
import { PluginConfigTab } from "./tabs/PluginConfigTab.js";
import { MsGraphTab } from "./tabs/MsGraphTab.js";
import { useSettingsOrchestration } from "./hooks/use-settings-orchestration.js";

export function SettingsDialog({ open, onOpenChange, api, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; api: LvisApi; onSaved: () => void }) {
  const [tab, setTab] = useState("llm");
  const s = useSettingsOrchestration(open, api, onSaved, onOpenChange);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>설정</DialogTitle><DialogDescription>앱 환경, 채팅 동작, 검색 엔진, 권한 정책을 설정합니다.</DialogDescription></DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 [&>*]:!grow-0 [&>*]:!shrink-0 [&>*]:!basis-auto overflow-x-auto">
            <TabsTrigger value="llm">지능 (LLM)</TabsTrigger>
            <TabsTrigger value="advanced">고급</TabsTrigger>
            <TabsTrigger value="chat">채팅</TabsTrigger>
            <TabsTrigger value="web">검색 (Web)</TabsTrigger>
            <TabsTrigger value="routine">브리핑</TabsTrigger>
            <TabsTrigger value="privacy">프라이버시</TabsTrigger>
            <TabsTrigger value="permissions">권한</TabsTrigger>
            <TabsTrigger value="roles">역할</TabsTrigger>
            <TabsTrigger value="usage">사용량</TabsTrigger>
            <TabsTrigger value="audit">감사</TabsTrigger>
            <TabsTrigger value="plugin-perf">플러그인 성능</TabsTrigger>
            <TabsTrigger value="mcp">MCP 서버</TabsTrigger>
            <TabsTrigger value="plugin-config">플러그인 설정</TabsTrigger>
            <TabsTrigger value="ms-graph">Microsoft 계정</TabsTrigger>
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
              onSaved={onSaved}
            />
          </TabsContent>

          <TabsContent value="advanced">
            <AdvancedTab
              temperature={s.temperature}
              setTemperature={s.setTemperature}
              maxOutputTokens={s.maxOutputTokens}
              setMaxOutputTokens={s.setMaxOutputTokens}
              seedInput={s.seedInput}
              setSeedInput={s.setSeedInput}
              responseFormat={s.responseFormat}
              setResponseFormat={s.setResponseFormat}
              stopSequencesText={s.stopSequencesText}
              setStopSequencesText={s.setStopSequencesText}
              streamSmoothing={s.streamSmoothing}
              setStreamSmoothing={s.setStreamSmoothing}
              fallbackChain={s.fallbackChain}
              setFallbackChain={s.setFallbackChain}
              fallbackOpen={s.fallbackOpen}
              setFallbackOpen={s.setFallbackOpen}
            />
          </TabsContent>

          <TabsContent value="chat">
            <ChatTab autoCompact={s.autoCompact} setAutoCompact={s.setAutoCompact} />
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
            />
          </TabsContent>

          <TabsContent value="routine">
            <ProactiveTab
              enableWakeupRoutine={s.enableWakeupRoutine}
              setEnableWakeupRoutine={s.setEnableWakeupRoutine}
            />
          </TabsContent>

          <TabsContent value="privacy">
            <PrivacyTab
              piiRedactEnabled={s.piiRedactEnabled}
              onToggle={() => s.setPiiRedactEnabled(!s.piiRedactEnabled)}
            />
          </TabsContent>

          <TabsContent value="permissions"><PermissionsTab /></TabsContent>
          <TabsContent value="roles"><RolesTab /></TabsContent>
          <TabsContent value="usage"><UsageDashboard api={api} /></TabsContent>
          <TabsContent value="audit"><AuditTab /></TabsContent>
          <TabsContent value="plugin-perf"><PluginPerfTab api={api} /></TabsContent>
          <TabsContent value="mcp"><McpTab /></TabsContent>
          <TabsContent value="plugin-config"><PluginConfigTab /></TabsContent>
          <TabsContent value="ms-graph"><MsGraphTab api={api} /></TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>닫기</Button>
          {tab !== "permissions" && tab !== "usage" && tab !== "roles" && tab !== "audit" && tab !== "plugin-perf" && tab !== "mcp" && tab !== "plugin-config" && (
            <Button onClick={() => void s.save(tab)} disabled={s.saving || !s.settingsLoaded}>{s.saving ? "저장 중..." : "저장"}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
