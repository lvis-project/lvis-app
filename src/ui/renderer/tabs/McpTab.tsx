import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Separator } from "../../../components/ui/separator.js";
import { Textarea } from "../../../components/ui/textarea.js";
import type { McpServerConfig, McpServerConfigDto, McpServerState } from "../types.js";
import { LONG_TOAST_TTL_MS } from "../constants.js";
import { useNotifySaved } from "../contexts/saved-toast.js";

// ─── Helper types re-exported from renderer/types.ts ─
// McpServerConfig / McpServerState 는 window.lvis.mcp 의 반환 타입

type Transport = "stdio" | "http";

const STATUS_BADGE: Record<McpServerState["status"], string> = {
  connected: "bg-success/15 text-success",
  connecting: "bg-warning/15 text-warning",
  disconnected: "bg-muted text-muted-foreground",
  error: "bg-destructive/15 text-destructive",
};

const STATUS_LABEL: Record<McpServerState["status"], string> = {
  connected: "연결됨",
  connecting: "연결 중",
  disconnected: "연결 해제",
  error: "오류",
};

const EMPTY_FORM = {
  id: "",
  transport: "stdio" as Transport,
  command: "",
  args: "",
  url: "",
  auth: "none" as "none" | "sso" | "api-key",
  apiKey: "",
  headers: "",
  env: "",
  allowPrivateNetworks: false,
};

export function parseCliWords(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  const trimmed = input.trim();

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    const nextChar = trimmed[i + 1];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      const shouldEscape =
        nextChar !== undefined &&
        (/\s/.test(nextChar) || nextChar === "'" || nextChar === '"' || nextChar === "\\");
      if (shouldEscape) {
        escaping = true;
        continue;
      }
      current += char;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping || quote) {
    throw new Error("인용부호 또는 이스케이프가 닫히지 않았습니다.");
  }
  if (current) tokens.push(current);
  return tokens;
}

const WINDOWS_EXECUTABLE_PATTERN =
  /^((?:[A-Za-z]:\\|\\\\)[^"'<>|?*]*?\.(?:exe|cmd|bat|com|ps1|py|js|mjs|cjs))(?=\s|$)\s*(.*)$/i;

/**
 * Validates that the auth/apiKey combination is coherent.
 * - "api-key" auth requires a non-empty API key.
 * - "none" auth rejects any API key value (it would be silently dropped by
 *   the config builder and confuse the user into thinking it was saved).
 *
 * Returns a user-facing error string, or null when the combination is valid.
 */
export function validateAuthApiKey(
  auth: "none" | "sso" | "api-key",
  apiKey: string,
): string | null {
  if (auth === "sso") {
    return "SSO 인증은 아직 지원되지 않습니다.";
  }
  if (auth === "api-key" && !apiKey.trim()) {
    return "API Key 인증 방식은 API Key를 입력해야 합니다.";
  }
  if (auth === "none" && apiKey.trim()) {
    return "인증 방식이 '없음'일 때 API Key를 입력할 수 없습니다.";
  }
  return null;
}

export function splitCommandLine(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const winMatch = trimmed.match(WINDOWS_EXECUTABLE_PATTERN);
  if (winMatch) {
    const [, command, rest] = winMatch;
    return [command, ...parseCliWords(rest)];
  }

  return parseCliWords(trimmed);
}

function parseKeyValueLines(input: string, delimiter: ":" | "="): Record<string, string> | undefined {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return undefined;

  return Object.fromEntries(
    lines.map((line) => {
      const index = line.indexOf(delimiter);
      if (index <= 0) {
        throw new Error(
          delimiter === ":"
            ? "Headers는 한 줄에 HEADER: value 형식이어야 합니다."
            : "Env는 한 줄에 KEY=value 형식이어야 합니다.",
        );
      }
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
  );
}

export function McpTab() {
  const notifySaved = useNotifySaved();
  const formIdPrefix = useId();
  const formIds = {
    id: `${formIdPrefix}-server-id`,
    transport: `${formIdPrefix}-transport`,
    auth: `${formIdPrefix}-auth`,
    apiKey: `${formIdPrefix}-api-key`,
    command: `${formIdPrefix}-command`,
    args: `${formIdPrefix}-args`,
    env: `${formIdPrefix}-env`,
    url: `${formIdPrefix}-url`,
    allowPrivateNetworks: `${formIdPrefix}-allow-private`,
    headers: `${formIdPrefix}-headers`,
  };

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [banner, setBanner] = useState<{ type: "error" | "success"; msg: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showBanner = useCallback((type: "error" | "success", msg: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ type, msg });
    bannerTimerRef.current = setTimeout(() => setBanner(null), LONG_TOAST_TTL_MS); // MCP status messages need longer read time
  }, []);

  // 언마운트 시 타이머 정리 — 언마운트 후 setBanner 호출 방지
  useEffect(() => {
    return () => {
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    };
  }, []);

  // ── Section A: 연결 상태 목록 ─────────────────────
  const [states, setStates] = useState<McpServerState[]>([]);
  // ── Section B: 설정 파일 목록 ─────────────────────
  const [configs, setConfigs] = useState<McpServerConfigDto[]>([]);
  const [configPath, setConfigPath] = useState("");
  // ── Section C: 서버 추가 폼 ───────────────────────
  const [form, setForm] = useState(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const removingIdRef = useRef<string | null>(null);
  const [credentialTargetId, setCredentialTargetId] = useState<string | null>(null);
  const [credentialApiKey, setCredentialApiKey] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statesRes, configsRes, configPathRes] = await Promise.all([
        window.lvis.mcp.servers(),
        window.lvis.mcp.getConfigs(),
        window.lvis.mcp.getConfigPath(),
      ]);
      setStates(statesRes);
      setConfigs(configsRes);
      setConfigPath(configPathRes);
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
        showBanner("error", e instanceof Error ? e.message : String(e));
      }
    },
    [fetchAll, showBanner],
  );

  // 서버 제거
  const handleRemove = useCallback(
    async (id: string) => {
      if (removingIdRef.current) return;
      removingIdRef.current = id;
      setRemovingId(id);
      try {
        await window.lvis.mcp.removeConfig(id);
        await fetchAll();
        showBanner("success", `${id} 서버가 제거되었습니다.`);
        notifySaved();
      } catch (e) {
        showBanner("error", e instanceof Error ? e.message : String(e));
      } finally {
        removingIdRef.current = null;
        setRemovingId(null);
      }
    },
    [fetchAll, showBanner, notifySaved],
  );

  const handleSetApiKey = useCallback(async () => {
    if (!credentialTargetId) return;
    if (!credentialApiKey.trim()) {
      showBanner("error", "API Key를 입력하세요.");
      return;
    }
    setCredentialBusy(true);
    try {
      const result = await window.lvis.mcp.setApiKey(credentialTargetId, credentialApiKey);
      setCredentialTargetId(null);
      setCredentialApiKey("");
      await fetchAll();
      showBanner(
        result.connected ? "success" : "error",
        result.connected
          ? `${credentialTargetId} API Key가 저장되고 연결되었습니다.`
          : `${credentialTargetId} API Key는 저장되었지만 연결 실패: ${result.warning ?? "원인 불명"}`,
      );
      // Save itself succeeded — the connection-failure branch above is a
      // post-save warning, not a save failure. Toast either way.
      notifySaved();
    } catch (e) {
      showBanner("error", e instanceof Error ? e.message : String(e));
    } finally {
      setCredentialBusy(false);
    }
  }, [credentialApiKey, credentialTargetId, fetchAll, showBanner, notifySaved]);

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

    // Validate auth / apiKey combination before building the config payload.
    const authError = validateAuthApiKey(form.auth, form.apiKey);
    if (authError) { showBanner("error", authError); return; }

    let config: McpServerConfig;
    try {
      const shared = {
        id: form.id.trim(),
        ...(form.auth !== "none" ? { auth: form.auth } : {}),
        // Only persist apiKey when the auth mode actually uses it.
        ...(form.auth === "api-key" ? { apiKey: form.apiKey.trim() } : {}),
      };

      if (form.transport === "stdio") {
        const [command, ...inlineArgs] = splitCommandLine(form.command);
        if (!command) {
          showBanner("error", "stdio 실행 파일을 입력하세요.");
          return;
        }
        const extraArgs = form.args.trim() ? parseCliWords(form.args) : [];
        const args = [...inlineArgs, ...extraArgs];
        const env = parseKeyValueLines(form.env, "=");
        config = {
          ...shared,
          transport: "stdio",
          command,
          ...(args.length > 0 ? { args } : {}),
          ...(env ? { env } : {}),
        };
      } else {
        const headers = parseKeyValueLines(form.headers, ":");
        config = {
          ...shared,
          transport: "http",
          url: form.url.trim(),
          allowPrivateNetworks: form.allowPrivateNetworks,
          ...(headers ? { headers } : {}),
        };
      }
    } catch (e) {
      showBanner("error", e instanceof Error ? e.message : String(e));
      return;
    }

    setFormBusy(true);
    try {
      const result = await window.lvis.mcp.addConfig(config);
      setForm(EMPTY_FORM);
      setShowForm(false);
      showBanner(
        result.connected ? "success" : "error",
        result.connected
          ? `${config.id} 서버가 추가되고 연결되었습니다.`
          : `${config.id} 서버 설정은 저장되었지만 연결 실패: ${result.warning ?? "원인 불명"}`,
      );
      // addConfig persisted the entry — connection failure is a separate
      // post-save warning, not a save failure. Toast either way.
      notifySaved();
      void fetchAll();
    } catch (e) {
      showBanner("error", e instanceof Error ? e.message : String(e));
    } finally {
      setFormBusy(false);
    }
  }, [form, fetchAll, showBanner, notifySaved]);

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
            banner.type === "error" ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"
          }`}
        >
          {banner.msg}
        </div>
      )}

      {/* 에러 */}
      {error && (
        <div className="rounded-md bg-destructive/15 px-3 py-2 text-sm text-destructive">{error}</div>
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
            설정 파일: <code>{configPath}</code>
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
                        {cfg?.auth && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            auth:{cfg.auth}
                          </Badge>
                        )}
                      </div>
                      {st?.registeredTools.length ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          도구: {st.registeredTools.join(", ")}
                        </p>
                      ) : null}
                      {st?.lastError && (
                        <p className="mt-1 text-[11px] text-destructive truncate">{st.lastError}</p>
                      )}
                      {st?.connectedAt && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          연결: {new Date(st.connectedAt).toLocaleString()}
                        </p>
                      )}
                      {cfg?.transport === "stdio" && cfg.command && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate">
                          실행: {cfg.command}
                        </p>
                      )}
                      {cfg?.transport === "http" && cfg.url && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate">
                          URL: {cfg.url}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      {cfg?.auth === "api-key" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs px-2"
                          onClick={() => {
                            setCredentialTargetId((current) => (current === id ? null : id));
                            setCredentialApiKey("");
                          }}
                        >
                          키 설정
                        </Button>
                      )}
                      {status === "connected" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs px-2 text-warning border-warning/40"
                          onClick={() => void handleKill(id)}
                        >
                          킬
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs px-2 text-destructive border-destructive/40"
                        disabled={loading || removingId !== null}
                        onClick={() => void handleRemove(id)}
                      >
                        제거
                      </Button>
                    </div>
                  </div>
                  {credentialTargetId === id && (
                    <div className="mt-3 flex items-end gap-2 border-t pt-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <Label htmlFor={`${id}-api-key-update`} className="text-xs">
                          API Key (write-only)
                        </Label>
                        <Input
                          id={`${id}-api-key-update`}
                          type="password"
                          className="h-7 text-xs font-mono"
                          placeholder={
                            cfg?.transport === "stdio" && cfg.apiKeyEnv
                              ? `${cfg.apiKeyEnv}=...`
                              : cfg?.transport === "http" && cfg.apiKeyHeader
                                ? `${cfg.apiKeyHeader}: ...`
                                : "API key"
                          }
                          value={credentialApiKey}
                          onChange={(event) => setCredentialApiKey(event.target.value)}
                        />
                      </div>
                      <Button
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={credentialBusy}
                        onClick={() => void handleSetApiKey()}
                      >
                        저장
                      </Button>
                    </div>
                  )}
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
                <Label htmlFor={formIds.id} className="text-xs">
                  서버 ID *
                </Label>
                <Input
                  id={formIds.id}
                  className="h-7 text-xs"
                  placeholder="my-mcp-server"
                  value={form.id}
                  onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
                />
              </div>

              {/* Transport */}
              <div className="space-y-1">
                <Label htmlFor={formIds.transport} className="text-xs">
                  Transport *
                </Label>
                <NativeSelect
                  id={formIds.transport}
                  size="sm"
                  className="w-full"
                  value={form.transport}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, transport: e.target.value as Transport }))
                  }
                >
                  <NativeSelectOption value="stdio">stdio (로컬 프로세스)</NativeSelectOption>
                  <NativeSelectOption value="http">http (원격 서버)</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor={formIds.auth} className="text-xs">
                  Auth
                </Label>
                <NativeSelect
                  id={formIds.auth}
                  size="sm"
                  className="w-full"
                  value={form.auth}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, auth: e.target.value as typeof EMPTY_FORM.auth }))
                  }
                >
                  <NativeSelectOption value="none">없음</NativeSelectOption>
                  <NativeSelectOption value="sso">SSO</NativeSelectOption>
                  <NativeSelectOption value="api-key">API Key</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor={formIds.apiKey} className="text-xs">
                  API Key (write-only)
                </Label>
                <Input
                  id={formIds.apiKey}
                  type="password"
                  className="h-7 text-xs font-mono"
                  placeholder="sk-..."
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                />
              </div>
            </div>

            {form.transport === "stdio" ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor={formIds.command} className="text-xs">
                    Command *
                  </Label>
                  <Input
                    id={formIds.command}
                    className="h-7 text-xs font-mono"
                    placeholder="uvx my-mcp-server"
                    value={form.command}
                    onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    실행 파일만 입력하거나 전체 명령줄을 입력해도 자동 분리됩니다.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={formIds.args} className="text-xs">
                    Args (추가 인자)
                  </Label>
                  <Input
                    id={formIds.args}
                    className="h-7 text-xs font-mono"
                    placeholder="--port 3000 --profile 'team alpha'"
                    value={form.args}
                    onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={formIds.env} className="text-xs">
                    Env (KEY=value, write-only)
                  </Label>
                  <Textarea
                    id={formIds.env}
                    className="min-h-[88px] text-xs font-mono"
                    placeholder={"OPENAI_API_KEY=...\nMCP_PROFILE=team-alpha"}
                    value={form.env}
                    onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor={formIds.url} className="text-xs">
                    URL *
                  </Label>
                  <Input
                    id={formIds.url}
                    className="h-7 text-xs font-mono"
                    placeholder="https://example.com/mcp"
                    value={form.url}
                    onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={formIds.allowPrivateNetworks}
                    checked={form.allowPrivateNetworks}
                    onCheckedChange={(checked) =>
                      setForm((f) => ({ ...f, allowPrivateNetworks: checked === true }))
                    }
                    className="size-3.5"
                  />
                  <Label htmlFor={formIds.allowPrivateNetworks} className="text-xs">
                    사설 네트워크 허용 (localhost/로컬 네트워크)
                  </Label>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={formIds.headers} className="text-xs">
                    Headers (HEADER: value, write-only)
                  </Label>
                  <Textarea
                    id={formIds.headers}
                    className="min-h-[88px] text-xs font-mono"
                    placeholder={"Authorization: Bearer ...\nX-Team: alpha"}
                    value={form.headers}
                    onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
                  />
                </div>
              </>
            )}

            <p className="text-[10px] text-muted-foreground">
              비밀값(API key / headers / env / args)은 저장 후 다시 표시되지 않습니다.
            </p>

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
