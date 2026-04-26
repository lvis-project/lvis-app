import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Separator } from "../../../components/ui/separator.js";
import { sanitizePluginConfig, sanitizePluginConfigKey } from "../../../shared/plugin-config.js";
import { getApi } from "../api-client.js";
import { getHostMarketplaceApi } from "../host-marketplace-api.js";
import type { PluginCardSummary } from "../types.js";

type KV = { key: string; value: string };

function configToEntries(config: Record<string, unknown>): KV[] {
  return Object.entries(config).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

function entriesToConfig(entries: KV[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of entries) {
    const k = sanitizePluginConfigKey(key.trim());
    if (!k) continue;
    // Try to parse JSON values (numbers, booleans, objects); fall back to string.
    try {
      out[k] = JSON.parse(value);
    } catch {
      out[k] = value;
    }
  }
  return sanitizePluginConfig(out);
}

export function PluginConfigTab() {
  const [plugins, setPlugins] = useState<PluginCardSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<KV[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ type: "error" | "success"; msg: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showBanner = useCallback((type: "error" | "success", msg: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ type, msg });
    bannerTimerRef.current = setTimeout(() => setBanner(null), 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    };
  }, []);

  // Load plugin list — extracted so install/uninstall result events can
  // re-fetch without remounting the tab. Without this, the settings dialog
  // would still display the pre-install plugin set after a `lvis://install`
  // deep-link landed (sidebar refreshes via the same event but the settings
  // tab's local `plugins` state was a one-shot mount-time snapshot).
  const refreshPlugins = useCallback(async () => {
    try {
      const cards = await window.lvis.plugins.cards();
      setPlugins(cards);
      setSelectedId((current) => {
        if (current && cards.some((c) => c.id === current)) return current;
        return cards.length > 0 ? cards[0].id : null;
      });
    } catch (e) {
      showBanner("error", (e as Error).message ?? "플러그인 목록 로드 실패");
    } finally {
      setLoading(false);
    }
  }, [showBanner]);

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  // Sync with main-process lifecycle events. Both install (via `lvis://`
  // deep link) and uninstall (via this tab or any other surface) emit
  // result events that the renderer subscribes to in App.tsx for sidebar
  // refresh — wire the same hooks here so the settings list stays in sync.
  useEffect(() => {
    // `getApi()` throws if `window.lvisApi` isn't initialized — that path is
    // taken by jsdom unit tests that mock only `window.lvis`. Skip the
    // subscriptions in that case so the existing tests pass without forcing
    // every consumer test to provide both namespaces.
    let api: ReturnType<typeof getApi>;
    try {
      api = getApi();
    } catch {
      return;
    }
    const unsubs: Array<() => void> = [];
    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(
        api.onPluginInstallResult(({ success }) => {
          if (success) void refreshPlugins();
        }),
      );
    }
    if (typeof api.onPluginUninstallResult === "function") {
      unsubs.push(
        api.onPluginUninstallResult(({ success }) => {
          if (success) void refreshPlugins();
        }),
      );
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [refreshPlugins]);

  // Load config for selected plugin
  useEffect(() => {
    if (!selectedId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await window.lvis.pluginConfig.get(selectedId);
        if (cancelled) return;
        if (!result.ok) {
          setEntries([]);
          showBanner("error", result.message ?? "설정 로드 실패");
          return;
        }
        setEntries(configToEntries(result.config));
      } catch (e) {
        if (!cancelled) showBanner("error", (e as Error).message ?? "설정 로드 실패");
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId, showBanner]);

  const handleAddEntry = useCallback(() => {
    let k: string;
    try {
      k = sanitizePluginConfigKey(newKey.trim());
    } catch (e) {
      showBanner("error", (e as Error).message);
      return;
    }
    if (entries.some((e) => e.key === k)) {
      showBanner("error", `키 "${k}"가 이미 존재합니다.`);
      return;
    }
    setEntries((prev) => [...prev, { key: k, value: newValue }]);
    setNewKey("");
    setNewValue("");
  }, [newKey, newValue, entries, showBanner]);

  const handleRemoveEntry = useCallback((key: string) => {
    setEntries((prev) => prev.filter((e) => e.key !== key));
  }, []);

  const handleUpdateValue = useCallback((key: string, value: string) => {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, value } : e)));
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      const config = entriesToConfig(entries);
      const result = await window.lvis.pluginConfig.set(selectedId, config);
      if (!result.ok) {
        showBanner("error", result.message ?? "저장 실패");
        return;
      }
      setEntries(configToEntries(result.config));
      showBanner("success", "설정이 저장되었습니다.");
    } catch (e) {
      showBanner("error", (e as Error).message ?? "저장 실패");
    } finally {
      setSaving(false);
    }
  }, [selectedId, entries, showBanner]);

  const selectedPlugin = plugins.find((p) => p.id === selectedId);

  const handleUninstall = useCallback(async () => {
    if (!selectedId || !selectedPlugin) return;
    if (!window.confirm(`"${selectedPlugin.name}" 플러그인을 제거하시겠습니까?`)) return;
    setSaving(true);
    try {
      const result = await getHostMarketplaceApi().uninstallMarketplacePlugin(selectedId);
      if (!result.ok) {
        showBanner("error", result.message ?? "제거 실패");
        return;
      }
      setPlugins((prev) => prev.filter((p) => p.id !== selectedId));
      setSelectedId(null);
      showBanner("success", `${selectedPlugin.name} 제거 완료`);
    } catch (e) {
      showBanner("error", (e as Error).message ?? "제거 실패");
    } finally {
      setSaving(false);
    }
  }, [selectedId, selectedPlugin, showBanner]);

  return (
    <div className="flex flex-col h-full gap-3">
      {banner && (
        <div
          className={`rounded-md px-3 py-2 text-sm ${
            banner.type === "error" ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"
          }`}
        >
          {banner.msg}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">로딩 중…</p>
      ) : plugins.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          설치된 플러그인이 없습니다.
        </div>
      ) : (
        <div className="flex gap-3 h-[400px]">
          {/* Left: plugin list */}
          <div className="w-48 shrink-0 rounded-md border bg-card">
            <ScrollArea className="h-full">
              <div className="p-1 space-y-0.5">
                {plugins.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    className={`w-full text-left rounded px-2 py-1.5 text-xs hover:bg-accent ${
                      selectedId === p.id ? "bg-accent font-semibold" : ""
                    }`}
                  >
                    <div className="flex items-center gap-1 truncate">
                      {p.isManaged && <span title="관리자 설치 플러그인">🔒</span>}
                      <span className="truncate">{p.name}</span>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      {p.loadStatus === "loaded" && (
                        <span className="inline-block rounded-full bg-green-100 px-1.5 py-px text-[9px] font-medium text-green-700">로드됨</span>
                      )}
                      {p.loadStatus === "failed" && (
                        <span className="inline-block rounded-full bg-red-100 px-1.5 py-px text-[9px] font-medium text-red-700">실패</span>
                      )}
                      {p.loadStatus === "disabled" && (
                        <span className="inline-block rounded-full bg-gray-100 px-1.5 py-px text-[9px] font-medium text-gray-600">비활성</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Right: detail + key-value editor */}
          <div className="flex-1 min-w-0 flex flex-col gap-2 rounded-md border bg-card p-3">
            {selectedPlugin ? (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1">
                      <h3 className="text-sm font-semibold">{selectedPlugin.name}</h3>
                      {selectedPlugin.isManaged && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 py-px text-[9px] font-medium text-blue-700">🔒 관리형</span>
                      )}
                      {selectedPlugin.loadStatus && (
                        selectedPlugin.loadStatus === "loaded" ? (
                          <span className="inline-block rounded-full bg-green-100 px-1.5 py-px text-[9px] font-medium text-green-700">로드됨</span>
                        ) : selectedPlugin.loadStatus === "failed" ? (
                          <span className="inline-block rounded-full bg-red-100 px-1.5 py-px text-[9px] font-medium text-red-700">실패</span>
                        ) : (
                          <span className="inline-block rounded-full bg-gray-100 px-1.5 py-px text-[9px] font-medium text-gray-600">비활성</span>
                        )
                      )}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      {selectedPlugin.version && (
                        <span className="text-[10px] text-muted-foreground">v{selectedPlugin.version}</span>
                      )}
                      {selectedPlugin.publisher && (
                        <span className="text-[10px] text-muted-foreground">· {selectedPlugin.publisher}</span>
                      )}
                    </div>
                    <p className="font-mono text-[10px] text-muted-foreground">{selectedPlugin.id}</p>
                    {selectedPlugin.description && (
                      <p className="mt-1 text-xs text-muted-foreground">{selectedPlugin.description}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 text-xs px-2 shrink-0"
                    onClick={() => void handleUninstall()}
                    disabled={saving || selectedPlugin.isManaged}
                    title={selectedPlugin.isManaged ? "관리자가 설치한 플러그인은 제거할 수 없습니다" : undefined}
                  >
                    제거
                  </Button>
                </div>

                {/* Tools section */}
                {selectedPlugin.tools.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-1">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">제공 툴</p>
                      <div className="space-y-0.5 max-h-24 overflow-y-auto">
                        {selectedPlugin.tools.map((tool) => {
                          const desc = selectedPlugin.toolDescriptions?.[tool];
                          return (
                            <div key={tool} className="flex flex-col">
                              <span className="font-mono text-[10px] font-medium">{tool}</span>
                              {desc && <span className="text-[10px] text-muted-foreground">{desc}</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
                <Separator />

                <ScrollArea className="flex-1 min-h-0">
                  <div className="space-y-1.5 pr-2">
                    {entries.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        설정된 값이 없습니다. 아래에서 추가하세요.
                      </p>
                    )}
                    {entries.map((entry) => (
                      <div key={entry.key} className="flex items-center gap-2">
                        <Input
                          className="h-7 text-xs font-mono flex-[0_0_35%]"
                          value={entry.key}
                          readOnly
                        />
                        <Input
                          className="h-7 text-xs font-mono flex-1"
                          value={entry.value}
                          onChange={(e) => handleUpdateValue(entry.key, e.target.value)}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs px-2 text-red-600 border-red-300"
                          onClick={() => handleRemoveEntry(entry.key)}
                        >
                          삭제
                        </Button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>

                <Separator />

                <div className="flex items-center gap-2">
                  <Input
                    className="h-7 text-xs font-mono flex-[0_0_35%]"
                    placeholder="key"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                  />
                  <Input
                    className="h-7 text-xs font-mono flex-1"
                    placeholder="value (string / JSON)"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                  />
                  <Button size="sm" className="h-7 text-xs px-2" onClick={handleAddEntry}>
                    + 추가
                  </Button>
                </div>

                <div className="flex justify-end">
                  <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                    {saving ? "저장 중…" : "저장"}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">플러그인을 선택하세요.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
