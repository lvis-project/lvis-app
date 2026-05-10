import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Separator } from "../../../components/ui/separator.js";
import { EXEC_MODE_OPTIONS } from "../constants.js";
import type { ExecMode, HookTrustRow, PermissionRule } from "../types.js";

export function PermissionsTab() {
  // ── 로딩 상태 ─────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── 인라인 배너 (alert 대체 — §F9) ───────────────
  const [banner, setBanner] = useState<{ type: "error" | "warn"; msg: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showBanner = useCallback((type: "error" | "warn", msg: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ type, msg });
    bannerTimerRef.current = setTimeout(() => setBanner(null), 5000);
  }, []);

  // ── Section A: Execution Mode ─────────────────────
  const [mode, setMode] = useState<ExecMode>("default");
  const [modeBusy, setModeBusy] = useState(false);

  // ── Section B: Explicit Approval Policy ──────────
  const [requireExplicit, setRequireExplicit] = useState(true);
  const [policyManaged, setPolicyManaged] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  /** §C2: admin-dir source tracking */
  const [policySource, setPolicySource] = useState<"defaults" | "user" | "admin" | "merged">("defaults");
  const [policyAdminPath, setPolicyAdminPath] = useState<string | undefined>(undefined);

  // ── Section C: Rule Editor ────────────────────────
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [newAction, setNewAction] = useState<"allow" | "deny">("allow");
  const [rulesBusy, setRulesBusy] = useState(false);
  const [directories, setDirectories] = useState<string[]>([]);
  const [newDirectory, setNewDirectory] = useState("");
  const [dirsBusy, setDirsBusy] = useState(false);
  const [pendingDirectoryWarning, setPendingDirectoryWarning] = useState<{
    path: string;
    warnings: string[];
  } | null>(null);
  const [quarantinedHooks, setQuarantinedHooks] = useState<HookTrustRow[]>([]);

  // ── 초기 fetch (탭 진입 시) ───────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [modeRes, policyRes, rulesRes, hookTrustRes, dirRes] = await Promise.all([
        window.lvis.permission.getMode(),
        window.lvis.policy.get(),
        window.lvis.permission.listRules(),
        window.lvis.permission.hookTrustList(),
        window.lvis.permission.dirDispatch("list"),
      ]);
      setMode((modeRes.mode as ExecMode) ?? "default");
      setRequireExplicit(policyRes.requireExplicitApproval);
      setPolicyManaged(policyRes.managed);
      setPolicySource((policyRes.source as "defaults" | "user" | "admin" | "merged") ?? "defaults");
      setPolicyAdminPath(policyRes.adminPath as string | undefined);
      setRules(rulesRes);
      setQuarantinedHooks(hookTrustRes.ok ? hookTrustRes.disabled : []);
      setDirectories(dirRes.ok && dirRes.verb === "list" ? dirRes.userAdditions : []);
    } catch (e) {
      setError((e as Error).message ?? "데이터를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  // ── Section A handler ─────────────────────────────
  const handleModeChange = async (m: ExecMode) => {
    if (m === mode || modeBusy) return;
    setModeBusy(true);
    try {
      const res = await window.lvis.permission.setMode(m);
      if (res.ok) {
        setMode(res.mode as ExecMode);
      } else {
        showBanner("error", res.message ?? res.error ?? "실행 모드 변경에 실패했습니다.");
      }
    } catch (e) {
      showBanner("error", `실행 모드 변경 중 오류: ${(e as Error).message}`);
    } finally {
      setModeBusy(false);
    }
  };

  // ── Section B handler ─────────────────────────────
  const handleExplicitToggle = async () => {
    if (policyManaged) return;
    setPolicyBusy(true);
    try {
      const next = !requireExplicit;
      const res = await window.lvis.policy.set({ requireExplicitApproval: next });
      if (res.ok) {
        setRequireExplicit(next);
      } else if (res.error === "managed") {
        showBanner("warn", "이 정책은 IT 관리자가 설정했습니다. 사용자가 변경할 수 없습니다.");
      } else {
        showBanner("error", res.message ?? "정책 변경에 실패했습니다.");
      }
    } finally {
      setPolicyBusy(false);
    }
  };

  // ── Section C handlers ────────────────────────────
  const refreshRules = async () => {
    const r = await window.lvis.permission.listRules();
    setRules(r);
  };

  const handleAddRule = async () => {
    const pattern = newPattern.trim();
    if (!pattern) return;
    setRulesBusy(true);
    try {
      const res = await window.lvis.permission.addRule(pattern, newAction);
      if (res.ok) {
        setNewPattern("");
        await refreshRules();
      } else {
        showBanner("error", res.message ?? `규칙 추가 실패 (${res.error})`);
      }
    } catch (e) {
      showBanner("error", `규칙 추가 중 오류: ${(e as Error).message}`);
    } finally {
      setRulesBusy(false);
    }
  };

  const handleRemoveRule = async (pattern: string, action: "allow" | "deny") => {
    setRulesBusy(true);
    try {
      const res = await window.lvis.permission.removeRule(pattern, action);
      if (res.ok) {
        await refreshRules();
      } else {
        showBanner("error", res.message ?? `규칙 삭제 실패 (${res.error})`);
      }
    } catch (e) {
      showBanner("error", `규칙 삭제 중 오류: ${(e as Error).message}`);
    } finally {
      setRulesBusy(false);
    }
  };

  const refreshDirectories = async () => {
    const res = await window.lvis.permission.dirDispatch("list");
    if (res.ok && res.verb === "list") {
      setDirectories(res.userAdditions);
    }
  };

  const handleAddDirectory = async (acknowledgeWarnings = false) => {
    const dir = newDirectory.trim();
    if (!dir) return;
    setDirsBusy(true);
    try {
      const command = acknowledgeWarnings
        ? `allow --ack-warnings ${formatPermissionDirArg(dir)}`
        : `allow ${formatPermissionDirArg(dir)}`;
      const res = await window.lvis.permission.dirDispatch(command);
      if (res.ok && res.verb === "allow") {
        setNewDirectory("");
        setPendingDirectoryWarning(null);
        setDirectories(res.persisted);
        if (res.warnings.length > 0) {
          showBanner("warn", res.warnings.join(" "));
        }
      } else if (!res.ok) {
        const failed = res as {
          ok: false;
          error: string;
          warnings?: string[];
          requiresAcknowledgement?: boolean;
        };
        if (failed.requiresAcknowledgement && failed.warnings?.length) {
          setPendingDirectoryWarning({ path: dir, warnings: failed.warnings });
          showBanner("warn", "디렉터리 경고를 확인한 뒤 다시 승인해야 저장됩니다.");
        } else {
          setPendingDirectoryWarning(null);
          showBanner("error", failed.error);
        }
      }
    } catch (e) {
      setPendingDirectoryWarning(null);
      showBanner("error", `디렉터리 추가 중 오류: ${(e as Error).message}`);
    } finally {
      setDirsBusy(false);
    }
  };

  const handleRemoveDirectory = async (dir: string) => {
    setDirsBusy(true);
    try {
      const res = await window.lvis.permission.dirDispatch(`deny ${formatPermissionDirArg(dir)}`);
      if (res.ok && res.verb === "deny") {
        setDirectories(res.persisted);
      } else if (!res.ok) {
        showBanner("error", res.error);
      }
    } catch (e) {
      showBanner("error", `디렉터리 삭제 중 오류: ${(e as Error).message}`);
    } finally {
      setDirsBusy(false);
    }
  };

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">로딩 중...</div>;
  }
  if (error) {
    return <div className="py-4 text-sm text-destructive">{error}</div>;
  }

  return (
    <ScrollArea className="h-[420px] pr-2">
      <div className="space-y-6 pt-4">

        {/* ── 인라인 배너 (§F9 — alert 대체) ── */}
        {banner && (
          <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${banner.type === "error" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"}`}>
            <span className="mt-0.5 flex-shrink-0">{banner.type === "error" ? "⚠" : "🔒"}</span>
            <span>{banner.msg}</span>
            <button className="ml-auto flex-shrink-0 opacity-60 hover:opacity-100" onClick={() => setBanner(null)}>✕</button>
          </div>
        )}

        {quarantinedHooks.length > 0 && (
          <div
            data-testid="hook-quarantine-notice"
            className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-[12px] text-yellow-700 dark:text-yellow-300"
          >
            <div className="flex items-start gap-2">
              <Badge variant="secondary" className="mt-0.5 text-[10px] text-yellow-700 dark:text-yellow-300">
                검토 대기 {quarantinedHooks.length}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="font-medium">격리된 hook 파일이 있습니다.</p>
                <p className="mt-1 text-[11px]">
                  채팅 입력창에서 <code className="rounded bg-background/70 px-1 font-mono">/permission hooks list</code> 를 실행해
                  파일을 확인한 뒤 accept 또는 reject 하세요.
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {quarantinedHooks.slice(0, 3).map((hook) => (
                    <code key={hook.fileName} className="rounded border border-yellow-500/30 bg-background/70 px-1.5 py-0.5 font-mono text-[10px]">
                      {hook.fileName}
                    </code>
                  ))}
                  {quarantinedHooks.length > 3 && (
                    <span className="text-[10px] text-yellow-700/80 dark:text-yellow-300/80">
                      +{quarantinedHooks.length - 3}
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => void fetchAll()}
              >
                새로고침
              </Button>
            </div>
          </div>
        )}

        {/* ── Section A: Execution Mode ── */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">실행 모드</p>
            <p className="text-[11px] text-muted-foreground">AI 에이전트가 도구를 실행할 때 어떤 수준의 권한을 적용할지 결정합니다.</p>
          </div>
          <div className="space-y-1.5">
            {EXEC_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors ${mode === opt.value ? "border-primary bg-primary/10" : "border-muted hover:border-muted-foreground/40"}`}
                disabled={modeBusy}
                onClick={() => void handleModeChange(opt.value)}
              >
                <span className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 ${mode === opt.value ? "border-primary" : "border-muted-foreground"}`}>
                  {mode === opt.value && <span className="h-2 w-2 rounded-full bg-primary" />}
                </span>
                <span>
                  <span className="font-medium">{opt.label}</span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">{opt.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <Separator />

        {/* ── Section B: Explicit Approval Policy ── */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">명시적 승인 요구</p>
            <p className="text-[11px] text-muted-foreground">체크 시 승인 대화상자에서 모달 외부 클릭과 Escape 키가 차단되어 사용자가 반드시 명시적 버튼을 눌러야 합니다.</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              role="checkbox"
              aria-checked={requireExplicit}
              disabled={policyManaged || policyBusy}
              className={`relative h-5 w-5 flex-shrink-0 rounded border-2 transition-colors ${requireExplicit ? "border-primary bg-primary" : "border-muted-foreground"} ${policyManaged ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-primary/60"}`}
              onClick={() => void handleExplicitToggle()}
            >
              {requireExplicit && (
                <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">✓</span>
              )}
            </button>
            <span className="text-sm">{requireExplicit ? "활성화됨" : "비활성화됨"}</span>
            {policyManaged && <span className="text-base" title="IT 관리자 설정">🔒</span>}
          </div>
          {policyManaged && (
            <p className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-600 dark:text-yellow-400">
              {(policySource === "admin" || policySource === "merged") && policyAdminPath
                ? `이 정책은 회사 IT 관리자가 배포했습니다 (경로: ${policyAdminPath}). 사용자가 변경할 수 없습니다.`
                : "이 정책은 IT 관리자가 설정했습니다. 사용자가 변경할 수 없습니다."}
            </p>
          )}
        </div>

        <Separator />

        {/* ── Section C: Rule Editor ── */}
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">도구 규칙</p>
            <p className="text-[11px] text-muted-foreground">특정 도구 패턴에 대해 항상 허용 / 항상 거부를 설정합니다 (와일드카드 지원: <code className="text-[10px]">mcp_*</code>).</p>
          </div>

          {/* 규칙 테이블 */}
          {rules.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">저장된 규칙이 없습니다.</p>
          ) : (
            <div className="rounded-md border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-3 py-2 text-left font-medium">패턴</th>
                    <th className="px-3 py-2 text-left font-medium">동작</th>
                    <th className="px-3 py-2 text-left font-medium">소스</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={`${r.pattern}:${r.action}:${i}`} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-1.5 font-mono">{r.pattern}</td>
                      <td className="px-3 py-1.5">
                        <Badge variant={r.action === "allow" ? "default" : "secondary"} className={`text-[10px] ${r.action === "deny" ? "text-red-400" : ""}`}>
                          {r.action === "allow" ? "허용" : "거부"}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.source ?? "전체"}</td>
                      <td className="px-3 py-1.5 text-right">
                        <button
                          className="text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-40"
                          disabled={rulesBusy}
                          onClick={() => void handleRemoveRule(r.pattern, r.action)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 규칙 추가 */}
          <div className="flex items-center gap-2">
            <Input
              className="h-8 flex-1 text-xs"
              placeholder="패턴 (예: mcp_*, memory_save)"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newPattern.trim()) void handleAddRule(); }}
            />
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={newAction}
              onChange={(e) => setNewAction(e.target.value as "allow" | "deny")}
            >
              <option value="allow">허용</option>
              <option value="deny">거부</option>
            </select>
            <Button size="sm" className="h-8" onClick={() => void handleAddRule()} disabled={rulesBusy || !newPattern.trim()}>
              추가
            </Button>
          </div>
        </div>

        <Separator />

        {/* ── Section D: Additional Directories ── */}
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">허용 디렉터리</p>
              <p className="text-[11px] text-muted-foreground">작업 디렉터리 밖에서 파일 도구가 접근할 수 있는 사용자 승인 경로입니다.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => void refreshDirectories()}
              disabled={dirsBusy}
            >
              새로고침
            </Button>
          </div>

          {directories.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">추가 허용 디렉터리가 없습니다.</p>
          ) : (
            <div className="rounded-md border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-3 py-2 text-left font-medium">경로</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {directories.map((dir) => (
                    <tr key={dir} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="min-w-0 px-3 py-1.5 font-mono text-[11px]">
                        <span className="block truncate" title={dir}>{dir}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <button
                          className="text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-40"
                          disabled={dirsBusy}
                          onClick={() => void handleRemoveDirectory(dir)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Input
              className="h-8 flex-1 text-xs"
              placeholder="경로 (예: ~/Documents/project)"
              value={newDirectory}
              onChange={(e) => {
                setNewDirectory(e.target.value);
                setPendingDirectoryWarning(null);
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && newDirectory.trim()) void handleAddDirectory(); }}
            />
            <Button size="sm" className="h-8" onClick={() => void handleAddDirectory()} disabled={dirsBusy || !newDirectory.trim()}>
              추가
            </Button>
          </div>

          {pendingDirectoryWarning && pendingDirectoryWarning.path === newDirectory.trim() && (
            <div
              data-testid="directory-warning-confirmation"
              className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-[12px] text-yellow-700 dark:text-yellow-300"
            >
              <p className="font-medium">경고 확인 필요</p>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {pendingDirectoryWarning.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => void handleAddDirectory(true)}
                  disabled={dirsBusy}
                >
                  경고 확인 후 추가
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setPendingDirectoryWarning(null)}
                  disabled={dirsBusy}
                >
                  취소
                </Button>
              </div>
            </div>
          )}
        </div>

        <Separator />

        {/* ── Section E: Audit Log Placeholder ── */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">감사 로그</p>
            <p className="text-[11px] text-muted-foreground">도구 실행 감사 로그 뷰어는 Phase 2 이후 추가됩니다.</p>
          </div>
          <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            곧 추가 예정
          </div>
        </div>

      </div>
    </ScrollArea>
  );
}

function formatPermissionDirArg(path: string): string {
  return /[\s"']|^-/.test(path) ? JSON.stringify(path) : path;
}
