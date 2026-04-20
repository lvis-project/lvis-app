import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Separator } from "../../../components/ui/separator.js";
import type { McpServerConfig, McpServerState } from "../types.js";

// ─── Helper types re-exported from renderer/types.ts ─
// McpServerConfig / McpServerState 는 window.lvis.mcp 의 반환 타입

type Transport = "stdio" | "http";

const STATUS_BADGE: Record<McpServerState["status"], string> = {
  connected: "bg-green-100 text-green-800",
  connecting: "bg-yellow-100 text-yellow-800",
  disconnected: "bg-gray-100 text-gray-600",
  error: "bg-red-100 text-red-800",
};

const STATUS_LABEL: Record<McpServerState["status"], string> = {
  connected: "연결됨",
  connecting: "연결 중",
  disconnected: "연결 해제",
  error: "오류",
};

const EMPTY_FORM = {
  id: "",
  name: "",
  transport: "stdio" as Transport,
  command: "",
  args: "",
  url: "",
  allowPrivateNetworks: false,
};

export function McpTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [banner, setBanner] = useState<{ type: "error" | "success"; msg: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showBanner = useCallback((type: "error" | "success", msg: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ type, msg });
    bannerTimerRef.current = setTimeout(() => setBanner(null), 5000);
  }, []);

  // ── Section A: 연결 상태 목록 ─────────────────────
  const [states, setStates] = useState<McpServerState[]>([]);
  // ── Section B: 설정 파일 목록 ─────────────────────
  const [configs, setConfigs] = useState<McpServerConfig[]>([]);
  // ── Section C: 서버 추가 폼 ───────────────────────
  const [form, setForm] = useState(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statesRes, configsRes] = await Promise.all([
        window.lvis.mcp.servers(),
        window.lvis.mcp.getConfigs(),
      ]);
      setStates(statesRes);
      setConfigs(configsRes);
    } catch (e) {
      setError((e as Error).message ?? "데이터를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // 킬 스위치
  const handleKill = useCallback(
    async (id: string) => {
      try {
        await window.lvis.mcp.kill(id);
        showBanner("success", `${id} 연결이 해제되었습니다.`);
        void fetchAll();
      } catch (e) {
        showBanner("error", (e as Error).message);
      }
    },
    [fetchAll, showBanner],
  );

  // 서버 제거
  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await window.lvis.mcp.removeConfig(id);
        showBanner("success", `${id} 서버가 제거되었습니다.`);
        void fetchAll();
      } catch (e) {
        showBanner("error", (e as Error).message);
      }
    },
    [fetchAll, showBanner],
  );

  // 서버 추가
  const handleAdd = useCallback(async () => {
    if (!form.id.trim()) { showBanner("error", "서버 ID를 입력하세요."); return; }
    if (form.transport === "stdio" && !form.command.trim()) {
      showBanner("error", "stdio 서버는 실행 명령(command)이 필요합니다.");
      return;
    }
    if (form.transport === "http" && !form.url.trim()) {
      showBanner("error", "http 서버는 URL이 필요합니다.");
      return;
    }

    let config: McpServerConfig;
    if (form.transport === "stdio") {
      config = {
        id: form.id.trim(),
        transport: "stdio",
        command: form.command.trim(),
        args: form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
      };
    } else {
      config = {
        id: form.id.trim(),
        transport: "http",
        url: form.url.trim(),
        allowPrivateNetworks: form.allowPrivateNetworks,
      };
    }

    setFormBusy(true);
    try {
      await window.lvis.mcp.addConfig(config);
      setForm(EMPTY_FORM);
      setShowForm(false);
      showBanner("success", `${config.id} 서버가 추가되었습니다.`);
      void fetchAll();
    } catch (e) {
      showBanner("error", (e as Error).message);
    } finally {
      setFormBusy(false);
    }
  }, [form, fetchAll, showBanner]);

  // 설정에는 있지만 현재 연결 상태가 없는 서버도 표시
  const allIds = new Set([
    ...states.map((s) => s.id),
    ...configs.map((c) => c.id),
  ]);

  const getState = (id: string) => states.find((s) => s.id === id);
  const getConfig = (id: string) => configs.find((c) => c.id === id);

  return (
    <div className="flex flex-col h-full gap-4">
      {/* 배너 */}
      {banner && (
        <div
          className={`rounded-md px-3 py-2 text-sm ${
            banner.type === "error" ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"
          }`}
        >
          {banner.msg}
        </div>
      )}

      {/* 에러 */}
      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {/* ── Section A: 서버 목록 ────────────────────── */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">MCP 서버</h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void fetchAll()} disabled={loading}>
            새로고침
          </Button>
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "취소" : "+ 서버 추가"}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">로딩 중…</p>
      ) : allIds.size === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          등록된 MCP 서버가 없습니다.
          <br />
          <span className="text-xs">
            설정 파일: <code>~/.lvis/mcp-servers.json</code>
          </span>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-2 pr-2">
            {Array.from(allIds).map((id) => {
              const st = getState(id);
              const cfg = getConfig(id);
              const status = st?.status ?? "disconnected";
              return (
                <div key={id} className="rounded-md border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold truncate">{id}</span>
                        <Badge className={`text-[10px] px-1.5 py-0 ${STATUS_BADGE[status]}`}>
                          {STATUS_LABEL[status]}
                        </Badge>
                        {cfg && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {cfg.transport}
                          </Badge>
                        )}
                      </div>
                      {st?.registeredTools.length ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          도구: {st.registeredTools.join(", ")}
                        </p>
                      ) : null}
                      {st?.lastError && (
                        <p className="mt-1 text-[11px] text-red-600 truncate">{st.lastError}</p>
                      )}
                      {st?.connectedAt && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          연결: {new Date(st.connectedAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      {status === "connected" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs px-2 text-orange-600 border-orange-300"
                          onClick={() => void handleKill(id)}
                        >
                          킬
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs px-2 text-red-600 border-red-300"
                        onClick={() => void handleRemove(id)}
                      >
                        제거
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}

      {/* ── Section B: 서버 추가 폼 ─────────────────── */}
      {showForm && (
        <>
          <Separator />
          <div className="space-y-3 rounded-md border bg-muted/40 p-4">
            <h4 className="text-xs font-semibold text-foreground">새 MCP 서버 추가</h4>

            <div className="grid grid-cols-2 gap-3">
              {/* ID */}
              <div className="space-y-1">
                <label className="text-xs">서버 ID *</label>
                <Input
                  className="h-7 text-xs"
                  placeholder="my-mcp-server"
                  value={form.id}
                  onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
                />
              </div>

              {/* Transport */}
              <div className="space-y-1">
                <label className="text-xs">Transport *</label>
                <select
                  className="h-7 w-full rounded-md border bg-background px-2 text-xs"
                  value={form.transport}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, transport: e.target.value as Transport }))
                  }
                >
                  <option value="stdio">stdio (로컬 프로세스)</option>
                  <option value="http">http (원격 서버)</option>
                </select>
              </div>
            </div>

            {form.transport === "stdio" ? (
              <>
                <div className="space-y-1">
                  <label className="text-xs">Command *</label>
                  <Input
                    className="h-7 text-xs font-mono"
                    placeholder="uvx my-mcp-server"
                    value={form.command}
                    onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs">Args (공백 구분)</label>
                  <Input
                    className="h-7 text-xs font-mono"
                    placeholder="--verbose --port 3000"
                    value={form.args}
                    onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <label className="text-xs">URL *</label>
                  <Input
                    className="h-7 text-xs font-mono"
                    placeholder="https://example.com/mcp"
                    value={form.url}
                    onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="mcp-allow-private"
                    type="checkbox"
                    checked={form.allowPrivateNetworks}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, allowPrivateNetworks: e.target.checked }))
                    }
                    className="h-3.5 w-3.5"
                  />
                  <label htmlFor="mcp-allow-private" className="text-xs">
                    사설 네트워크 허용 (localhost/사내망)
                  </label>
                </div>
              </>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setForm(EMPTY_FORM);
                  setShowForm(false);
                }}
              >
                취소
              </Button>
              <Button size="sm" onClick={() => void handleAdd()} disabled={formBusy}>
                {formBusy ? "추가 중…" : "추가"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
