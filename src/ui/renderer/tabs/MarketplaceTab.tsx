import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { getHostMarketplaceApi } from "../host-marketplace-api.js";
import type { LvisApi, MarketplaceItem } from "../types.js";
import type { MarketplacePackageType } from "../../../shared/assistant-context.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";

export interface MarketplaceTabProps {
  api: LvisApi;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  allowPrivateNetwork: boolean;
  setAllowPrivateNetwork: (v: boolean) => void;
  hasApiKey: boolean;
  setHasApiKey: (v: boolean) => void;
  apiKeyInput: string;
  setApiKeyInput: (v: string) => void;
  onSaved: () => void;
  /** Debounced immediate-apply hook — fired when private-network toggle flips. */
  onImmediateChange?: () => void;
  /** Synchronous "save now" — cancels any pending debounce and runs s.save("marketplace")
   *  immediately. Wired to inline Save buttons (URL, API key). */
  onSaveNow?: () => void;
}

export function MarketplaceTab(props: MarketplaceTabProps) {
  const {
    api,
    baseUrl,
    setBaseUrl,
    allowPrivateNetwork,
    setAllowPrivateNetwork,
    hasApiKey,
    setHasApiKey,
    apiKeyInput,
    setApiKeyInput,
    onSaved,
    onImmediateChange,
    onSaveNow,
  } = props;
  const [packages, setPackages] = useState<MarketplaceItem[]>([]);
  const [packageStatus, setPackageStatus] = useState("로딩 중…");
  const [filter, setFilter] = useState<"all" | MarketplacePackageType>("all");
  const [workingSlug, setWorkingSlug] = useState<string | null>(null);

  // URL is committed via an explicit "저장" button (user directive 2026-05-18) —
  // typing only updates a local draft; the parent setter (and marketplace
  // endpoint switchover) fire when Save is pressed. Re-sync the draft if the
  // parent value changes externally (cross-window broadcast, initial load).
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  useEffect(() => { setUrlDraft(baseUrl); }, [baseUrl]);
  const isUrlDirty = urlDraft.trim() !== baseUrl.trim();
  const commitUrl = useCallback(() => {
    setBaseUrl(urlDraft.trim());
    // setBaseUrl schedules a parent-state update; the debounced save would
    // fire 200ms later. For an explicit "Save" button we want sync persist,
    // so call onSaveNow which cancels the debounce and runs s.save("marketplace")
    // right now. The state will have committed by the next render before
    // s.save reads it (React 18 batches setState within the same call).
    onSaveNow?.();
  }, [urlDraft, setBaseUrl, onSaveNow]);

  // API key persistence — same explicit-save pattern as URL. The value lives
  // in `apiKeyInput` (updated on every keystroke); Save button flushes the
  // marketplace section. Disabled when the input is empty since the
  // marketplace endpoint only requires a key when the server demands one.
  const commitApiKey = useCallback(() => {
    onSaveNow?.();
  }, [onSaveNow]);

  // "Leave without saving" warning — user directive 2026-05-18 ("저장 버튼
  // 안누르고 컨텐츠를 벗어나려고 하면 경고 띄워주기"). Fires on window close
  // (Cmd+Q / X) when there are unsaved URL changes or a typed-but-not-saved
  // API key. Browsers/Electron show their native "leave?" confirm when
  // `returnValue` is set. The private-network toggle is immediate-apply
  // and isn't tracked here — it persists the moment the user clicks it.
  useEffect(() => {
    const isDirty = urlDraft.trim() !== baseUrl.trim() || apiKeyInput.trim() !== "";
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [urlDraft, baseUrl, apiKeyInput]);

  // API key + private network sit behind a "고급 옵션" collapse since most
  // users keep the default endpoint with no auth (user directive 2026-05-18).
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const refreshPackages = useCallback(async () => {
    try {
      const items = await api.listMarketplacePlugins();
      setPackages(items);
      setPackageStatus(`패키지 ${items.length}개`);
    } catch (err) {
      setPackageStatus(`로드 실패: ${(err as Error).message}`);
    }
  }, [api]);

  useEffect(() => {
    void refreshPackages();
  }, [refreshPackages]);

  const visiblePackages = useMemo(() => (
    filter === "all"
      ? packages
      : packages.filter((item) => (item.pluginType ?? "plugin") === filter)
  ), [filter, packages]);

  const installPackage = useCallback(async (item: MarketplaceItem) => {
    const packageType = item.pluginType ?? "plugin";
    setWorkingSlug(item.id);
    try {
      if (packageType === "mcp") {
        const result = await api.installMcpFromMarketplace(item.id);
        if (!result.ok) throw new Error(result.message);
      } else if (packageType === "agent") {
        const result = await getHostMarketplaceApi().installMarketplaceAgent?.(item.id);
        if (!result?.ok) throw new Error(result?.message ?? result?.error ?? "Agent install API unavailable");
      } else if (packageType === "skill") {
        const result = await getHostMarketplaceApi().installMarketplaceSkill?.(item.id);
        if (!result?.ok) throw new Error(result?.message ?? result?.error ?? "Skill install API unavailable");
      } else {
        const result = await getHostMarketplaceApi().installMarketplacePlugin(item.id);
        if (!result.ok) throw new Error(result.message ?? result.error);
      }
      await refreshPackages();
    } catch (err) {
      setPackageStatus(`작업 실패: ${(err as Error).message}`);
    } finally {
      setWorkingSlug(null);
    }
  }, [api, refreshPackages]);

  const uninstallPackage = useCallback(async (item: MarketplaceItem) => {
    const packageType = item.pluginType ?? "plugin";
    setWorkingSlug(item.id);
    try {
      if (packageType === "agent") {
        const result = await getHostMarketplaceApi().uninstallMarketplaceAgent?.(item.id);
        if (!result?.ok) throw new Error(result?.message ?? result?.error ?? "Agent uninstall API unavailable");
      } else if (packageType === "skill") {
        const result = await getHostMarketplaceApi().uninstallMarketplaceSkill?.(item.id);
        if (!result?.ok) throw new Error(result?.message ?? result?.error ?? "Skill uninstall API unavailable");
      } else if (packageType === "plugin") {
        const result = await getHostMarketplaceApi().uninstallMarketplacePlugin(item.id);
        if (!result.ok) throw new Error(result.message ?? result.error);
      }
      await refreshPackages();
    } catch (err) {
      setPackageStatus(`작업 실패: ${(err as Error).message}`);
    } finally {
      setWorkingSlug(null);
    }
  }, [refreshPackages]);

  const filterOptions: Array<{ value: "all" | MarketplacePackageType; label: string }> = [
    { value: "all", label: "All" },
    { value: "plugin", label: "Plugins" },
    { value: "mcp", label: "MCP" },
    { value: "agent", label: "Agents" },
    { value: "skill", label: "Skills" },
  ];

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="마켓플레이스"
        description="플러그인 마켓플레이스 연결과 신뢰 정책을 설정합니다"
      />

      <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning">
        설정은 저장 즉시 디스크에 기록되지만 <strong className="font-semibold">실제 적용 시점</strong> 은 항목마다 다릅니다 —
        URL 변경은 마켓플레이스 오류 배너의 "다시 시도" 버튼으로 즉시 재시도,
        API 키 변경은 앱 재시작 후 적용,
        사설 네트워크 허용 토글은 다음 마켓플레이스 요청부터 즉시 적용됩니다.
      </div>

      <SettingsSection title="서버 연결">
        {/* URL — explicit Save button (user directive 2026-05-18). The
            draft state means typing doesn't churn the marketplace endpoint
            on every keystroke; "저장" disabled when draft == committed. */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">마켓플레이스 서버 URL</Label>
          <div className="flex items-center gap-2">
            <Input
              type="url"
              placeholder="https://marketplace.your-corp.example"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && isUrlDirty) commitUrl(); }}
              className="flex-1"
            />
            <Button
              type="button"
              size="sm"
              onClick={commitUrl}
              disabled={!isUrlDirty}
              title={isUrlDirty ? "변경된 URL을 저장합니다" : "변경 사항이 없습니다"}
            >
              저장
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!baseUrl.trim()}
              onClick={() => {
                const url = baseUrl.trim();
                if (url) void api.openExternalUrl(url);
              }}
              aria-label="마켓플레이스 웹페이지 열기"
              title="설정된 마켓플레이스 URL을 시스템 브라우저로 엽니다"
            >
              마켓플레이스 열기 ↗
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            lvis-marketplace REST API 엔드포인트. 자체 배포 시 내부 호스트로 변경하세요. 비워두면 마켓플레이스 기능이 비활성화됩니다.
          </p>
        </div>

        {/* 고급 옵션 — API 키 + 사설 네트워크. Collapsed by default; most
            deployments use the public endpoint with no auth. */}
        <div className="space-y-2 pt-3 border-t border-border/50">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 rounded-md py-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={advancedOpen}
          >
            <span className="inline-block w-3 text-xs leading-none">{advancedOpen ? "▾" : "▸"}</span>
            고급 옵션
          </button>

          {advancedOpen && (
            <div className="space-y-4 pt-2">
              {/* API key */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">API 키 (선택)</Label>
                <div className="flex items-center gap-2">
                  {hasApiKey
                    ? <Badge variant="default" className="text-xs">설정됨</Badge>
                    : <Badge variant="secondary" className="text-xs">미설정</Badge>}
                  {hasApiKey && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-destructive"
                      onClick={() => void api.deleteMarketplaceApiKey().then(() => {
                        setHasApiKey(false);
                        onSaved();
                      })}
                    >
                      삭제
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder={hasApiKey ? "새 키로 교체" : "Bearer token (서버가 요구하는 경우)"}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && apiKeyInput.trim()) commitApiKey(); }}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={commitApiKey}
                    disabled={!apiKeyInput.trim()}
                    title="API 키를 OS 키체인에 저장합니다"
                  >
                    저장
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  서버가 인증을 요구할 때만 입력하세요. 키는 OS 키체인에 암호화되어 저장됩니다.
                </p>
              </div>

              {/* Private network toggle */}
              <div className="flex items-start gap-3 rounded-md border px-3 py-2.5">
                <Checkbox
                  checked={allowPrivateNetwork}
                  aria-labelledby="marketplace-allow-private-network-label"
                  className="mt-0.5 size-5"
                  onCheckedChange={(checked) => {
                    setAllowPrivateNetwork(checked === true);
                    onImmediateChange?.();
                  }}
                />
                <div className="space-y-0.5">
                  <p
                    id="marketplace-allow-private-network-label"
                    className="flex items-center gap-2 text-sm font-medium"
                  >
                    사설 네트워크 허용 (loopback / RFC1918)
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                      즉시 적용
                    </span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    로컬 또는 내부 마켓플레이스 서버에 접속할 때 활성화합니다. SSRF 가드를 우회하므로 외부 호스트(prod) 환경에서는 끄세요.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title="패키지 인벤토리"
        description={packageStatus}
        actions={
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void refreshPackages()}>
            새로고침
          </Button>
        }
      >
        <div className="flex flex-wrap gap-1">
          {filterOptions.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={filter === option.value ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <ScrollArea className="h-64 rounded-md border">
          <div className="divide-y">
            {visiblePackages.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">표시할 패키지가 없습니다.</div>
            ) : visiblePackages.map((item) => {
              const packageType = item.pluginType ?? "plugin";
              const isWorking = workingSlug === item.id;
              const canUninstall = item.installed && (packageType === "plugin" || packageType === "agent" || packageType === "skill");
              return (
                <div key={`${packageType}:${item.id}`} className="flex items-start justify-between gap-3 p-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{item.name}</span>
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px] uppercase">{packageType}</Badge>
                      {packageType === "mcp" && item.mcpAuth?.mode === "oauth" && (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] uppercase">OAuth</Badge>
                      )}
                      {item.installed && <Badge variant="default" className="h-5 px-1.5 text-[10px]">설치됨</Badge>}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{item.description || item.packageSpec}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{item.id}</p>
                  </div>
                  <Button
                    size="sm"
                    variant={item.installed ? "outline" : "default"}
                    className="h-7 shrink-0 px-2 text-xs"
                    disabled={isWorking || (item.installed && !canUninstall)}
                    onClick={() => void (item.installed ? uninstallPackage(item) : installPackage(item))}
                  >
                    {isWorking ? "처리 중…" : item.installed ? "제거" : "설치"}
                  </Button>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </SettingsSection>
    </div>
  );
}
