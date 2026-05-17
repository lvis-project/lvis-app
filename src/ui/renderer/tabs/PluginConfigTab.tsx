import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Separator } from "../../../components/ui/separator.js";
import { sanitizePluginConfig, sanitizePluginConfigKey } from "../../../shared/plugin-config.js";
import { getApi } from "../api-client.js";
import { getHostMarketplaceApi } from "../host-marketplace-api.js";
import type { InstallInFlight } from "../hooks/use-plugin-marketplace.js";
import type { PluginCardSummary } from "../types.js";
import { PluginAuthSection } from "../components/PluginAuthSection.js";
import { usePluginAuthStatuses } from "../hooks/use-plugin-auth-status.js";
import { PluginUninstallDialog } from "../dialogs/PluginUninstallDialog.js";
import { PluginConfigSchemaForm } from "./PluginConfigSchemaForm.js";
import { DEFAULT_TOAST_TTL_MS } from "../constants.js";
import { useNotifySaved } from "../contexts/saved-toast.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";

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
  // Pull the dialog-wide "저장되었습니다" notifier so every successful
  // plugin-config write — manual key/value editor save, schema-form save,
  // and per-secret writes — surfaces a uniform toast next to the user's
  // gaze without each tab having to roll its own banner.
  const notifySaved = useNotifySaved();
  const [plugins, setPlugins] = useState<PluginCardSummary[]>([]);
  const [installInFlight, setInstallInFlight] = useState<InstallInFlight>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<PluginCardSummary | null>(null);
  // Tools list is collapsed by default — plugins that declare many tools
  // would otherwise dominate the detail panel. Reset to collapsed on
  // plugin switch.
  const [toolsExpanded, setToolsExpanded] = useState(false);
  useEffect(() => {
    setToolsExpanded(false);
  }, [selectedId]);
  // Test environments do not always inject `window.lvisApi`; fall back to
  // `null` so unrelated PluginConfigTab tests don't crash before they
  // exercise their own code paths. The hook short-circuits when api is null.
  // useMemo([]) — `window.lvisApi` is set once at preload boot and never
  // reassigned at runtime; recomputing on every render would force the
  // hook's `refresh` callback to re-bind, tearing down + re-subscribing
  // every `<pluginId>.auth.changed` listener on each parent render.
  const apiForAuthHook = useMemo(() => {
    try { return getApi(); } catch { return null; }
  }, []);
  const { statuses: authStatuses, refresh: refreshAuthStatus } = usePluginAuthStatuses(
    apiForAuthHook,
    plugins,
  );
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
    bannerTimerRef.current = setTimeout(() => setBanner(null), DEFAULT_TOAST_TTL_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    };
  }, []);

  // Load plugin list — extracted so install/uninstall result events can
  // re-fetch without remounting the tab. Without this, the settings dialog
  // would still display the pre-install plugin set after a `lvis://install`
  // deep-link landed (other plugin surfaces refresh via the same event but
  // the settings tab's local `plugins` state was a one-shot mount-time snapshot).
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
  // result events that the renderer subscribes to in App.tsx for plugin view
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
    if (typeof api.onPluginInstallProgress === "function") {
      unsubs.push(
        api.onPluginInstallProgress((payload) => {
          setInstallInFlight((prev) => ({ ...prev, [payload.slug]: payload.phase }));
        }),
      );
    }
    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(
        api.onPluginInstallResult(({ slug, success }) => {
          setInstallInFlight((prev) => {
            if (!(slug in prev)) return prev;
            const next = { ...prev };
            delete next[slug];
            return next;
          });
          if (success) {
            void refreshPlugins();
          }
        }),
      );
    }
    if (typeof api.onPluginUninstallResult === "function") {
      unsubs.push(
        api.onPluginUninstallResult(({ success }) => {
          if (success) {
            void refreshPlugins();
          }
        }),
      );
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [refreshPlugins]);

  // Load config for selected plugin
  const [savedConfig, setSavedConfig] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (!selectedId) {
      setEntries([]);
      setSavedConfig({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await window.lvis.pluginConfig.get(selectedId);
        if (cancelled) return;
        if (!result.ok) {
          setEntries([]);
          setSavedConfig({});
          showBanner("error", result.message ?? "설정 로드 실패");
          return;
        }
        setEntries(configToEntries(result.config));
        setSavedConfig(result.config as Record<string, unknown>);
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
      notifySaved();
    } catch (e) {
      showBanner("error", (e as Error).message ?? "저장 실패");
    } finally {
      setSaving(false);
    }
  }, [selectedId, entries, showBanner, notifySaved]);

  const selectedPlugin = plugins.find((p) => p.id === selectedId);
  // §9.2 Track B — merge schema-declared defaults with the saved config
  // so the typed form always shows the value the plugin will actually
  // receive (defaults first, saved overrides win).
  const mergedConfigValues = useMemo(() => {
    const schema = selectedPlugin?.configSchema;
    if (!schema?.properties) return savedConfig;
    const merged: Record<string, unknown> = { ...savedConfig };
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (merged[key] === undefined && prop.default !== undefined) {
        merged[key] = prop.default;
      }
    }
    return merged;
  }, [selectedPlugin, savedConfig]);
  // US-3c.1: build secretsPresent map for PluginConfigSchemaForm.
  // Batches a single IPC call per plugin selection to find which secret
  // fields already have a value in the keychain, so the masked input shows
  // "**** (저장됨)" instead of the empty placeholder.
  const [secretsPresent, setSecretsPresent] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!selectedId) {
      setSecretsPresent({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await window.lvis.pluginConfig.listSecretKeys(selectedId);
        if (cancelled) return;
        if (result && result.ok && Array.isArray(result.keys)) {
          const map: Record<string, boolean> = {};
          for (const k of result.keys as string[]) {
            map[k] = true;
          }
          setSecretsPresent(map);
        } else {
          setSecretsPresent({});
        }
      } catch {
        if (!cancelled) setSecretsPresent({});
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  const isDevMode = window.lvis?.env?.isDev === true;
  const [localInstalling, setLocalInstalling] = useState(false);

  const handleInstallLocal = useCallback(async () => {
    let api: ReturnType<typeof getApi>;
    try {
      api = getApi();
    } catch {
      showBanner("error", "API를 사용할 수 없습니다.");
      return;
    }
    setLocalInstalling(true);
    try {
      const result = await api.installLocalPlugin?.();
      if (!result) {
        // user canceled the dialog
        return;
      }
      showBanner("success", `로컬 플러그인 "${result.pluginId}" 설치 완료. 플러그인이 재시작됩니다.`);
      void refreshPlugins();
    } catch (e) {
      showBanner("error", (e as Error).message ?? "로컬 설치 실패");
    } finally {
      setLocalInstalling(false);
    }
  }, [showBanner, refreshPlugins]);

  const handleUninstall = useCallback(async (pluginId: string, displayName: string) => {
    setSaving(true);
    try {
      const result = await getHostMarketplaceApi().uninstallMarketplacePlugin(pluginId);
      if (!result.ok) {
        showBanner("error", result.message ?? "제거 실패");
        return;
      }
      setPlugins((prev) => prev.filter((p) => p.id !== pluginId));
      setSelectedId((current) => (current === pluginId ? null : current));
      showBanner("success", `${displayName} 제거 완료`);
    } catch (e) {
      showBanner("error", (e as Error).message ?? "제거 실패");
    } finally {
      setSaving(false);
      setUninstallTarget(null);
    }
  }, [showBanner]);

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3">
      <SettingsPageHeader
        title="플러그인 설정"
        description="설치된 플러그인의 개별 설정을 관리합니다"
      />
      <div className="flex flex-1 min-h-0 flex-col gap-3">
      <PluginUninstallDialog
        target={uninstallTarget}
        working={saving}
        onClose={() => {
          if (!saving) setUninstallTarget(null);
        }}
        onConfirm={(id) => handleUninstall(id, uninstallTarget?.name ?? id)}
      />
      {banner && (
        <div
          className={`rounded-md px-3 py-2 text-sm ${
            banner.type === "error" ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"
          }`}
        >
          {banner.msg}
        </div>
      )}

      {isDevMode && (
        <div className="flex items-center justify-between rounded-md border border-warning/40 bg-warning/15 px-3 py-2">
          <div className="space-y-0.5">
            <p className="text-xs font-medium text-warning">개발자 도구</p>
            <p className="text-[11px] text-warning/80">
              로컬 빌드 폴더에서 플러그인을 직접 설치합니다 (개발 모드 필요).
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-xs border-warning/50 text-warning hover:bg-warning/20"
            onClick={() => void handleInstallLocal()}
            disabled={localInstalling}
          >
            {localInstalling ? "설치 중…" : "로컬 폴더에서 설치"}
          </Button>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">로딩 중…</p>
      ) : plugins.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          설치된 플러그인이 없습니다.
        </div>
      ) : (
        // Split height fills to the viewport bottom. The 180px reserve
        // matches the actual non-split chrome above:
        //   CustomTitleBar 36 + right-pane pt-2 8 + TabsContent mt-2 8 +
        //   page header (94) + right-pane pb-8 32 ≈ 178.
        // Right detail card stretches to fill the split height; its own
        // `overflow-y-auto` is the single scroll surface for the card so
        // the entire 환경 설정 list is reachable by scrolling.
        <div className="flex gap-3 h-[calc(100dvh-180px)] min-h-[350px]">
          {/* Left: plugin list (sub-sidebar — fixed width) */}
          <div className="w-60 shrink-0 rounded-md border bg-card">
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
                        <span className="inline-block rounded-full bg-success/15 px-1.5 py-px text-[9px] font-medium text-success">로드됨</span>
                      )}
                      {p.loadStatus === "failed" && (
                        <span className="inline-block rounded-full bg-destructive/15 px-1.5 py-px text-[9px] font-medium text-destructive">실패</span>
                      )}
                      {p.loadStatus === "disabled" && (
                        <span className="inline-block rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">비활성</span>
                      )}
                      {/* Auth status — only when manifest declares `auth` AND the plugin is
                          actually loaded (skip failed/disabled rows whose runtime can't be
                          invoked). The list-level badge is a "you need to do something here"
                          surface; we render only `unauthed` (red) so the row stays visually
                          quiet for the happy-path. Click → detail panel handles login flow. */}
                      {p.auth && p.loadStatus === "loaded" && authStatuses.get(p.id)?.kind === "unauthed" && (
                        <span
                          className="inline-block rounded-full bg-destructive/15 px-1.5 py-px text-[9px] font-medium text-destructive"
                          title="이 플러그인은 로그인이 필요합니다"
                        >
                          🔒 미인증
                        </span>
                      )}
                    </div>
                  </button>
                ))}
                {/* Skeleton rows for installs the main process is still
                    pipelining. The slug is removed from `installInFlight`
                    when the install-result event lands and `refreshPlugins`
                    promotes it into a real `plugins` entry. */}
                {Object.entries(installInFlight)
                  .filter(([slug]) => !plugins.some((p) => p.id === slug))
                  .map(([slug, phase]) => (
                    <div
                      key={`in-flight:${slug}`}
                      className="flex w-full animate-pulse items-center gap-2 rounded border border-dashed border-muted px-2 py-1.5 text-xs text-muted-foreground"
                      aria-label={`${slug} 설치 진행 중`}
                      aria-live="polite"
                    >
                      <span
                        className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
                        aria-hidden="true"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{slug}</span>
                        <span className="truncate text-[9px] opacity-70">
                          {phase === "installing" ? "설치 중…" : "재시작 중…"}
                        </span>
                      </span>
                    </div>
                  ))}
              </div>
            </ScrollArea>
          </div>

          {/* Right: detail card. The card itself is the ONE scroll surface
              for everything inside (header + 인증 + 제공 툴 + 환경 설정),
              so the user can scroll past the auth/tools sections to reach
              the full list of config fields. */}
          <div className="flex-1 min-w-0 flex flex-col gap-2 rounded-md border bg-card p-3 overflow-y-auto min-h-0">
            {selectedPlugin ? (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1">
                      <h3 className="text-sm font-semibold">{selectedPlugin.name}</h3>
                      {selectedPlugin.isManaged && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-info/15 px-1.5 py-px text-[9px] font-medium text-info">🔒 관리형</span>
                      )}
                      {selectedPlugin.installPolicy === "admin" && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-px text-[9px] font-medium text-destructive"
                          title="관리자만 설치할 수 있는 플러그인입니다"
                          aria-label="관리자 전용 플러그인"
                        >
                          🔐 관리자 전용
                        </span>
                      )}
                      {selectedPlugin.installPolicy === "user" && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded-full border border-border bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground"
                          title="모든 사용자가 설치할 수 있는 플러그인입니다"
                          aria-label="사용자 설치 가능 플러그인"
                        >
                          사용자 설치 가능
                        </span>
                      )}
                      {selectedPlugin.loadStatus && (
                        selectedPlugin.loadStatus === "loaded" ? (
                          <span className="inline-block rounded-full bg-success/15 px-1.5 py-px text-[9px] font-medium text-success">로드됨</span>
                        ) : selectedPlugin.loadStatus === "failed" ? (
                          <span className="inline-block rounded-full bg-destructive/15 px-1.5 py-px text-[9px] font-medium text-destructive">실패</span>
                        ) : (
                          <span className="inline-block rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">비활성</span>
                        )
                      )}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                      <span className="font-mono text-[10px] text-muted-foreground">{selectedPlugin.id}</span>
                      {selectedPlugin.version && (
                        <span className="text-[10px] text-muted-foreground">· v{selectedPlugin.version}</span>
                      )}
                      {selectedPlugin.publisher && (
                        <span className="text-[10px] text-muted-foreground">· {selectedPlugin.publisher}</span>
                      )}
                    </div>
                    {selectedPlugin.description && (
                      <p className="mt-1 text-xs text-muted-foreground">{selectedPlugin.description}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 text-xs px-2 shrink-0"
                    onClick={() => setUninstallTarget(selectedPlugin)}
                    disabled={saving || selectedPlugin.isManaged}
                    title={selectedPlugin.isManaged ? "관리자가 설치한 플러그인은 제거할 수 없습니다" : undefined}
                  >
                    제거
                  </Button>
                </div>

                {/* Auth section — only when manifest declares `auth`, the
                    plugin is loaded (failed/disabled plugins have no live
                    runtime to invoke), and the api bridge is available.
                    See architecture.md §9.4a. */}
                {selectedPlugin.auth &&
                  selectedPlugin.loadStatus === "loaded" &&
                  apiForAuthHook && (
                  <>
                    <Separator />
                    {/* PluginAuthSection renders its own "인증" header
                        internally — no outer label needed. */}
                    <PluginAuthSection
                      // `key` forces React to remount the section when the
                      // user switches between plugins in the list. Without
                      // it the same instance is reused across plugin
                      // selections and stale internal state (`working`,
                      // `localError`) carries over between plugins.
                      key={selectedPlugin.id}
                      api={apiForAuthHook}
                      pluginId={selectedPlugin.id}
                      pluginName={selectedPlugin.name}
                      auth={selectedPlugin.auth}
                      state={authStatuses.get(selectedPlugin.id) ?? { kind: "loading" }}
                      onRefresh={() => refreshAuthStatus(selectedPlugin.id)}
                    />
                  </>
                )}

                {/* Tools section — tool descriptions are markdown (plugin
                    manifests routinely include `**bold**`, code spans, lists,
                    and line breaks). Rendered through the shared ReactMarkdown
                    surface (chat cards) for consistent typography.

                    Collapsed by default with a tool-count badge so the detail
                    panel stays scannable for plugins with many tools. Click
                    the row to expand. */}
                {selectedPlugin.tools.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-1">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded text-left hover:bg-muted/30 -mx-1 px-1 py-1"
                        aria-expanded={toolsExpanded}
                        aria-controls={`plugin-tools-list-${selectedPlugin.id}`}
                        onClick={() => setToolsExpanded((prev) => !prev)}
                      >
                        <span className="flex items-center gap-2">
                          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">제공 툴</span>
                          <span className="inline-flex items-center justify-center min-w-[1.25rem] rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground tabular-nums">
                            {selectedPlugin.tools.length}
                          </span>
                        </span>
                        <span aria-hidden="true" className="text-[10px] text-muted-foreground">
                          {toolsExpanded ? "▾" : "▸"}
                        </span>
                      </button>
                      {toolsExpanded && (
                        <div
                          id={`plugin-tools-list-${selectedPlugin.id}`}
                          className="space-y-2 max-h-48 overflow-y-auto pr-1"
                        >
                          {selectedPlugin.tools.map((tool) => {
                            const desc = selectedPlugin.toolDescriptions?.[tool];
                            return (
                              <div key={tool} className="flex flex-col gap-0.5 rounded border border-border/40 bg-muted/20 px-2 py-1.5">
                                <span className="font-mono text-[11px] font-semibold">{tool}</span>
                                {desc && (
                                  <div className="prose prose-sm lvis-prose max-w-none break-words text-[11px] text-muted-foreground [&_p]:my-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5 [&_code]:text-[10px]">
                                    <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                                      {desc}
                                    </ReactMarkdown>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}
                <Separator />

                {selectedPlugin.configSchema ? (
                  // §9.2 Track B — declarative form. Cleartext fields go
                  // through pluginConfig.set; format:'secret' fields go
                  // through pluginConfig.setSecret so values land in the
                  // encrypted keychain instead of cleartext settings.json.
                  // The form renders inline (no internal ScrollArea) — the
                  // PARENT right-detail card has `overflow-y-auto`, so all
                  // env-config items are reachable by scrolling the card.
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">환경 설정</span>
                    <PluginConfigSchemaForm
                        pluginId={selectedPlugin.id}
                        schema={selectedPlugin.configSchema}
                        values={mergedConfigValues}
                        secretsPresent={secretsPresent}
                        onSave={async (values) => {
                          setSaving(true);
                          try {
                            const result = await window.lvis.pluginConfig.set(
                              selectedPlugin.id,
                              values,
                            );
                            if (!result.ok) {
                              showBanner("error", result.message ?? "저장 실패");
                              return;
                            }
                            setSavedConfig(result.config as Record<string, unknown>);
                            setEntries(configToEntries(result.config));
                            showBanner("success", "설정이 저장되었습니다.");
                            notifySaved();
                          } catch (e) {
                            showBanner("error", (e as Error).message ?? "저장 실패");
                          } finally {
                            setSaving(false);
                          }
                        }}
                        onSetSecret={async (key, value) => {
                          const result = await window.lvis.pluginConfig.setSecret(
                            selectedPlugin.id,
                            key,
                            value,
                          );
                          if (!result.ok) {
                            showBanner("error", result.message ?? "비밀 값 저장 실패");
                            return;
                          }
                          // Optimistically mark the key as present so the
                          // masked "**** (저장됨)" placeholder appears immediately.
                          setSecretsPresent((prev) => ({ ...prev, [key]: true }));
                          showBanner("success", `${key} 저장 완료`);
                          notifySaved();
                        }}
                      />
                  </div>
                ) : (
                  <>
                    {/* "환경변수" section — schema-less plugins use the raw
                        key/value editor. Without an explicit heading the
                        user can't tell what this list represents ("환경변수
                        헤더 누락"), so anchor it visually with a label and
                        a hint that the value box accepts JSON. The row
                        list caps at ~5 rows (220px ≈ row height × 5 +
                        gaps) and scrolls beyond that so a plugin with 20
                        env vars doesn't push the Save button off-screen. */}
                    <div className="flex items-baseline justify-between">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        환경변수
                      </p>
                      <span className="text-[10px] text-muted-foreground">
                        {entries.length}개 · 값은 문자열 또는 JSON
                      </span>
                    </div>
                    <ScrollArea className="w-full rounded-md border bg-background/40 p-2" style={{ maxHeight: 220 }}>
                      <div className="space-y-1.5 pr-2">
                        {entries.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            설정된 값이 없습니다. 아래에서 추가하세요.
                          </p>
                        )}
                        {entries.map((entry) => (
                          <div key={entry.key} className="flex items-center gap-2">
                            <Input
                              className="h-7 text-xs font-mono flex-[0_0_30%]"
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
                              className="h-7 text-xs px-2 text-destructive border-destructive/40"
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
                        className="h-7 text-xs font-mono flex-[0_0_30%]"
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
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">플러그인을 선택하세요.</p>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
