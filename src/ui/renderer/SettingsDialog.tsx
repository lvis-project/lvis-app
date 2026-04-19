import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import type { LvisApi } from "./types.js";
import { VENDORS } from "./constants.js";
import { RolesTab } from "./tabs/RolesTab.js";
import { PermissionsTab } from "./tabs/PermissionsTab.js";
import { AuditTab } from "./tabs/AuditTab.js";
import { UsageDashboard } from "./components/UsageDashboard.js";
import { PluginPerfTab } from "./tabs/PluginPerfTab.js";
import { PrivacyTab } from "./tabs/PrivacyTab.js";
import { LlmTab } from "./tabs/LlmTab.js";
import { AdvancedTab, type FallbackEntry } from "./tabs/AdvancedTab.js";
import { ChatTab } from "./tabs/ChatTab.js";
import { WebTab } from "./tabs/WebTab.js";
import { ProactiveTab } from "./tabs/ProactiveTab.js";

export function SettingsDialog({ open, onOpenChange, api, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; api: LvisApi; onSaved: () => void }) {
  const [tab, setTab] = useState("llm");
  const [vendor, setVendor] = useState("claude");
  const [keyInput, setKeyInput] = useState("");
  const [model, setModel] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [autoCompact, setAutoCompact] = useState(true);
  const [enableThinking, setEnableThinking] = useState(true);
  const [thinkingBudget, setThinkingBudget] = useState(10_000);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const [webProvider, setWebProvider] = useState("duckduckgo");
  const [webKeyInput, setWebKeyInput] = useState("");
  const [hasWebKey, setHasWebKey] = useState(false);

  const [baseUrl, setBaseUrl] = useState("");
  const [vertexProject, setVertexProject] = useState("");
  const [vertexLocation, setVertexLocation] = useState("");
  const [enableDailyBriefing, setEnableDailyBriefing] = useState(false);

  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxOutputTokens, setMaxOutputTokens] = useState<number>(4096);
  const [seedInput, setSeedInput] = useState<string>("");
  const [responseFormat, setResponseFormat] = useState<"text" | "json">("text");
  const [stopSequencesText, setStopSequencesText] = useState<string>("");
  const [streamSmoothing, setStreamSmoothing] = useState<"none" | "word" | "char">("none");

  const [piiRedactEnabled, setPiiRedactEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  const [fallbackChain, setFallbackChain] = useState<FallbackEntry[]>([]);
  const [fallbackOpen, setFallbackOpen] = useState(false);

  const vendorInfo = VENDORS.find((v) => v.id === vendor) ?? VENDORS[0];

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSettingsLoaded(false);
    void (async () => {
      const s = await api.getSettings();
      if (cancelled) return;
      setVendor(s.llm.provider);
      setModel(s.llm.model);
      setBaseUrl((s.llm.baseUrls ?? {})[s.llm.provider] ?? "");
      setVertexProject(s.llm.vertexProject ?? "");
      setVertexLocation(s.llm.vertexLocation ?? "");
      setEnableThinking(s.llm.enableThinking ?? true);
      setThinkingBudget(s.llm.thinkingBudgetTokens ?? 10_000);
      setTemperature(s.llm.temperature ?? 0.7);
      setMaxOutputTokens(s.llm.maxOutputTokens ?? 4096);
      setSeedInput(s.llm.seed !== undefined ? String(s.llm.seed) : "");
      setResponseFormat(s.llm.responseFormat ?? "text");
      setStopSequencesText((s.llm.stopSequences ?? []).join("\n"));
      setStreamSmoothing(s.llm.streamSmoothing ?? "none");
      setAutoCompact(s.chat.autoCompact ?? true);
      const apiKeySet = await api.hasApiKey(s.llm.provider);
      if (cancelled) return;
      setHasKey(apiKeySet);

      setWebProvider(s.webSearch.provider);
      const webApiKeySet = await api.hasWebApiKey(s.webSearch.provider);
      if (cancelled) return;
      setHasWebKey(webApiKeySet);
      setEnableDailyBriefing(s.proactive?.enableDailyBriefing ?? false);
      setPiiRedactEnabled(s.privacy?.piiRedactEnabled ?? false);
      setFallbackChain((s.llm.fallbackChain ?? []).map((e) => ({ provider: e.provider, model: e.model })));
      setSettingsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  useEffect(() => {
    if (!open) return;
    const v = VENDORS.find((x) => x.id === vendor);
    if (!v) return;
    let cancelled = false;
    void api.hasApiKey(vendor).then((k) => {
      if (!cancelled) setHasKey(k);
    });
    void api.getSettings().then((s) => {
      if (cancelled) return;
      if (s.llm.provider !== vendor) setModel(v.defaultModel);
      else setModel(s.llm.model);
      setBaseUrl((s.llm.baseUrls ?? {})[vendor as any] ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [vendor, open, api]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api.hasWebApiKey(webProvider).then((k) => {
      if (!cancelled) setHasWebKey(k);
    });
    return () => {
      cancelled = true;
    };
  }, [webProvider, open, api]);

  const save = async () => {
    if (!settingsLoaded) return;
    setSaving(true);
    try {
      if (tab !== "permissions") {
        if (keyInput.trim()) {
          await api.setApiKey(vendor, keyInput.trim());
          setKeyInput("");
          setHasKey(true);
        }
        if (webKeyInput.trim()) {
          await api.setWebApiKey(webProvider, webKeyInput.trim());
          setWebKeyInput("");
          setHasWebKey(true);
        }
        const current = await api.getSettings();
        const mergedBaseUrls = { ...(current.llm.baseUrls ?? {}) } as Record<string, string>;
        const trimmed = baseUrl.trim();
        if (trimmed) mergedBaseUrls[vendor] = trimmed;
        else delete mergedBaseUrls[vendor];
        await api.updateSettings({
          llm: {
            provider: vendor as any,
            model: model.trim() || vendorInfo.defaultModel,
            baseUrls: mergedBaseUrls as any,
            enableThinking,
            thinkingBudgetTokens: thinkingBudget,
            vertexProject: vertexProject.trim() || undefined,
            vertexLocation: vertexLocation.trim() || undefined,
            temperature,
            maxOutputTokens,
            seed: (() => {
              const raw = seedInput.trim();
              if (raw === "") return undefined;
              const n = Number.parseInt(raw, 10);
              return Number.isFinite(n) ? n : undefined;
            })(),
            responseFormat,
            stopSequences: stopSequencesText
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
            streamSmoothing,
            fallbackChain: fallbackChain.filter((e) => e.provider && e.model).map((e) => ({ provider: e.provider as any, model: e.model })),
          } as any,
          webSearch: { provider: webProvider as any },
          chat: { autoCompact },
          proactive: { enableDailyBriefing } as any,
          privacy: { piiRedactEnabled },
        } as any);
      }
      if (tab !== "permissions") { onSaved(); onOpenChange(false); }
      else { onOpenChange(false); }
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>설정</DialogTitle><DialogDescription>앱 환경, 채팅 동작, 검색 엔진, 권한 정책을 설정합니다.</DialogDescription></DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 [&>*]:!grow-0 [&>*]:!shrink-0 [&>*]:!basis-auto">
            <TabsTrigger value="llm">지능 (LLM)</TabsTrigger>
            <TabsTrigger value="advanced">고급</TabsTrigger>
            <TabsTrigger value="chat">채팅</TabsTrigger>
            <TabsTrigger value="web">검색 (Web)</TabsTrigger>
            <TabsTrigger value="proactive">브리핑</TabsTrigger>
            <TabsTrigger value="privacy">프라이버시</TabsTrigger>
            <TabsTrigger value="permissions">권한</TabsTrigger>
            <TabsTrigger value="roles">역할</TabsTrigger>
            <TabsTrigger value="usage">사용량</TabsTrigger>
            <TabsTrigger value="audit">감사</TabsTrigger>
            <TabsTrigger value="plugin-perf">플러그인 성능</TabsTrigger>
          </TabsList>

          <TabsContent value="llm">
            <LlmTab
              api={api}
              vendor={vendor}
              setVendor={setVendor}
              baseUrl={baseUrl}
              setBaseUrl={setBaseUrl}
              vertexProject={vertexProject}
              setVertexProject={setVertexProject}
              vertexLocation={vertexLocation}
              setVertexLocation={setVertexLocation}
              hasKey={hasKey}
              setHasKey={setHasKey}
              keyInput={keyInput}
              setKeyInput={setKeyInput}
              model={model}
              setModel={setModel}
              enableThinking={enableThinking}
              setEnableThinking={setEnableThinking}
              thinkingBudget={thinkingBudget}
              setThinkingBudget={setThinkingBudget}
              onSaved={onSaved}
            />
          </TabsContent>

          <TabsContent value="advanced">
            <AdvancedTab
              temperature={temperature}
              setTemperature={setTemperature}
              maxOutputTokens={maxOutputTokens}
              setMaxOutputTokens={setMaxOutputTokens}
              seedInput={seedInput}
              setSeedInput={setSeedInput}
              responseFormat={responseFormat}
              setResponseFormat={setResponseFormat}
              stopSequencesText={stopSequencesText}
              setStopSequencesText={setStopSequencesText}
              streamSmoothing={streamSmoothing}
              setStreamSmoothing={setStreamSmoothing}
              fallbackChain={fallbackChain}
              setFallbackChain={setFallbackChain}
              fallbackOpen={fallbackOpen}
              setFallbackOpen={setFallbackOpen}
            />
          </TabsContent>

          <TabsContent value="chat">
            <ChatTab autoCompact={autoCompact} setAutoCompact={setAutoCompact} />
          </TabsContent>

          <TabsContent value="web">
            <WebTab
              api={api}
              webProvider={webProvider}
              setWebProvider={setWebProvider}
              hasWebKey={hasWebKey}
              setHasWebKey={setHasWebKey}
              webKeyInput={webKeyInput}
              setWebKeyInput={setWebKeyInput}
              onSaved={onSaved}
            />
          </TabsContent>

          <TabsContent value="proactive">
            <ProactiveTab
              enableDailyBriefing={enableDailyBriefing}
              setEnableDailyBriefing={setEnableDailyBriefing}
            />
          </TabsContent>

          <TabsContent value="privacy">
            <PrivacyTab
              piiRedactEnabled={piiRedactEnabled}
              onToggle={() => setPiiRedactEnabled((prev) => !prev)}
            />
          </TabsContent>

          <TabsContent value="permissions">
            <PermissionsTab />
          </TabsContent>

          <TabsContent value="roles">
            <RolesTab />
          </TabsContent>

          <TabsContent value="usage">
            <UsageDashboard api={api} />
          </TabsContent>

          <TabsContent value="audit">
            <AuditTab />
          </TabsContent>

          <TabsContent value="plugin-perf">
            <PluginPerfTab api={api} />
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>닫기</Button>
          {tab !== "permissions" && tab !== "usage" && tab !== "roles" && tab !== "audit" && tab !== "plugin-perf" && (
            <Button onClick={() => void save()} disabled={saving || !settingsLoaded}>{saving ? "저장 중..." : "저장"}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
