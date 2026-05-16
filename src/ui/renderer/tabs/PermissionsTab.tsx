import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.js";
import { Separator } from "../../../components/ui/separator.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../components/ui/tooltip.js";
import { PERMISSION_REVIEWER_FRAMEWORK } from "../../../shared/permission-reviewer-framework.js";
import type { UserApprovalScope, UserApprovalVerdict } from "../../../shared/permissions-events.js";
import { EXEC_MODE_OPTIONS, LONG_TOAST_TTL_MS } from "../constants.js";
import { getApi } from "../api-client.js";
import { formatIpcError } from "../format-ipc-error.js";
import type {
  ExecMode,
  HookTrustRow,
  PermissionReviewerFallbackOnError,
  PermissionReviewerMode,
  PermissionReviewerProvider,
  PermissionReviewerSettings,
  PermissionRule,
} from "../types.js";
import { AuditPanel } from "../components/permissions/AuditPanel.js";

const DEFAULT_REVIEWER_SETTINGS: PermissionReviewerSettings = {
  mode: "disabled",
  provider: "openai",
  model: "gpt-4o-mini",
  fallbackOnError: "deny",
  interactive: { autoApprove: "off" },
};

const REVIEWER_INTERACTIVE_OPTIONS: Array<{
  value: "off" | "low";
  label: string;
  description: string;
}> = [
  {
    value: "off",
    label: "끔",
    description: "도구가 실행되기 전 항상 확인 창을 표시합니다. (기본값, 가장 안전)",
  },
  {
    value: "low",
    label: "저위험 자동 허용",
    description:
      "위험도가 낮다고 판단된 작업은 확인 없이 자동으로 허용합니다. " +
      "중간·높은 위험도는 여전히 확인 창이 표시됩니다.",
  },
];

const REVIEWER_MODE_OPTIONS: Array<{
  value: PermissionReviewerMode;
  label: string;
  description: string;
}> = [
  // 4-mode enum (post issue #664 normalization). `disabled` is now a true
  // pass-through (no reviewer lane); `strict` is the new fail-closed mode
  // equivalent to the pre-#664 "disabled" semantic. See
  // docs/architecture/permission-policy-design.md §3 Layer 5.
  { value: "disabled", label: "검토 끔 (자동 통과)", description: "리뷰어 레인을 끄고 카테고리 기본 정책만 적용합니다. 도구별 차단/허용 규칙은 그대로 유지됩니다." },
  { value: "rule", label: "규칙 기반 검증", description: "로컬 규칙으로 저위험 작업만 통과시키고 고위험은 대기시킵니다." },
  { value: "llm", label: "LLM 검증", description: "규칙 검증 뒤 LLM이 위험도를 올릴 수 있습니다. 낮출 수는 없습니다." },
  { value: "strict", label: "엄격 (모두 보류)", description: "헤드리스 변경을 모두 보류 대기열로 보냅니다. 사용자가 직접 승인해야 실행됩니다." },
];

/** All five providers — always visible so users know what's available. */
const REVIEWER_PROVIDER_OPTIONS: Array<{ value: PermissionReviewerProvider; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic Claude" },
  { value: "google", label: "Google Gemini" },
  { value: "foundry", label: "Azure AI Foundry" },
  { value: "gcp-playground", label: "Google AI Studio (GCP)" },
];

const REVIEWER_FALLBACK_OPTIONS: Array<{
  value: PermissionReviewerFallbackOnError;
  label: string;
  description: string;
}> = [
  { value: "deny", label: "차단", description: "LLM 오류나 응답 파싱 실패 시 검토 대기열로 보냅니다." },
  { value: "rule", label: "규칙 결과 사용", description: "LLM 실패 시 로컬 규칙 결과를 그대로 적용합니다." },
];

/**
 * Map IPC-layer revoke error codes to Korean user-facing strings.
 *
 * Mirrors `formatReviewerDispatchError` for the user-approval revoke
 * path so the UI doesn't leak raw English error codes (e.g.
 * "user-keyboard-required") to end users. Issue #826 introduced the
 * intent gate; this helper closes the resulting localization gap
 * surfaced in the cross-cutting review.
 *
 * Migrated to shared `formatIpcError` SOT (#830) — only the revoke-
 * specific `invalid-key` wording rides on `codeMap`.
 */
function formatRevokeError(error: string | undefined, message: string | undefined): string {
  return formatIpcError(error, message, {
    codeMap: { "invalid-key": "유효하지 않은 승인 키입니다." },
  });
}

function formatReviewerDispatchError(error: string): string {
  if (error.startsWith("reviewer-rewire-failed:")) {
    const detail = error.slice("reviewer-rewire-failed:".length).trim();
    return [
      "리뷰어 런타임 재연결에 실패해 이전 설정으로 복원했습니다.",
      "공급자 API 키, 모델 이름, 오류 처리 정책을 확인한 뒤 다시 적용하세요.",
      detail ? `상세: ${detail}` : "",
    ].filter(Boolean).join(" ");
  }
  return formatIpcError(error, undefined, {
    codeMap: { "user-keyboard-required": "리뷰어 설정 변경은 활성 사용자 입력에서만 실행할 수 있습니다." },
    fallbackContext: "리뷰어 오류",
  });
}

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
    bannerTimerRef.current = setTimeout(() => setBanner(null), LONG_TOAST_TTL_MS); // permission banners contain policy text that needs longer read time
  }, []);

  // ── Execution Mode ────────────────────────────────
  const [mode, setMode] = useState<ExecMode>("default");
  const [modeBusy, setModeBusy] = useState(false);

  // ── Explicit Approval Policy ──────────────────────
  const [requireExplicit, setRequireExplicit] = useState(true);
  const [policyManaged, setPolicyManaged] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  /** §C2: admin-dir source tracking */
  const [policySource, setPolicySource] = useState<"defaults" | "user" | "admin" | "merged">("defaults");
  const [policyAdminPath, setPolicyAdminPath] = useState<string | undefined>(undefined);

  // ── Rule Editor ───────────────────────────────────
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
  const [auditOpen, setAuditOpen] = useState(false);
  // R-2 / R-5: user approval records
  const [userApprovals, setUserApprovals] = useState<Array<{
    key: string;
    approvedAt: string;
    scope: UserApprovalScope;
    verdictAtApproval: UserApprovalVerdict;
    nlJustification: string | null;
    revokedAt: string | null;
    /** R-2 Round-3: display metadata from user-approval-store. */
    toolName?: string;
    source?: string;
  }>>([]);
  const [approvalsBusy, setApprovalsBusy] = useState(false);
  const [reviewer, setReviewer] = useState<PermissionReviewerSettings>(DEFAULT_REVIEWER_SETTINGS);
  const [reviewerModelDraft, setReviewerModelDraft] = useState(DEFAULT_REVIEWER_SETTINGS.model);
  const [reviewerBusy, setReviewerBusy] = useState(false);
  /**
   * Key-driven dynamic activation: maps each provider to whether
   * its required API key (or GCP service account) is stored. Providers
   * with no key are visible but non-selectable (greyed out + tooltip).
   * Refreshed on tab entry and whenever reviewerDispatch mutates settings.
   */
  const [providerKeyMap, setProviderKeyMap] = useState<
    Partial<Record<PermissionReviewerProvider, boolean>>
  >({});

  // ── 초기 fetch (탭 진입 시) ───────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [modeRes, policyRes, rulesRes, hookTrustRes, dirRes, reviewerRes, ...keyChecks] =
        await Promise.all([
          window.lvis.permission.getMode(),
          window.lvis.policy.get(),
          window.lvis.permission.listRules(),
          window.lvis.permission.hookTrustList(),
          window.lvis.permission.dirDispatch("list"),
          window.lvis.permission.reviewerDispatch("show"),
          // Check key presence for all five providers in parallel
          ...REVIEWER_PROVIDER_OPTIONS.map((opt) =>
            window.lvis.permission.reviewerProviderHasKey(opt.value),
          ),
        ]);
      if (!reviewerRes.ok) {
        throw new Error(reviewerRes.error);
      }
      setMode((modeRes.mode as ExecMode) ?? "default");
      setRequireExplicit(policyRes.requireExplicitApproval);
      setPolicyManaged(policyRes.managed);
      setPolicySource((policyRes.source as "defaults" | "user" | "admin" | "merged") ?? "defaults");
      setPolicyAdminPath(policyRes.adminPath as string | undefined);
      setRules(rulesRes);
      setQuarantinedHooks(hookTrustRes.ok ? hookTrustRes.disabled : []);
      setDirectories(dirRes.ok && dirRes.verb === "list" ? dirRes.userAdditions : []);
      setReviewer(reviewerRes.settings);
      setReviewerModelDraft(reviewerRes.settings.model);
      // Build provider key map from parallel key-check results
      const keyMap: Partial<Record<PermissionReviewerProvider, boolean>> = {};
      REVIEWER_PROVIDER_OPTIONS.forEach((opt, i) => {
        keyMap[opt.value] = Boolean(keyChecks[i]);
      });
      setProviderKeyMap(keyMap);
    } catch (e) {
      setError((e as Error).message ?? "데이터를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  // ── R-2/R-5: User approval records ───────────────
  const fetchApprovals = useCallback(async () => {
    if (!window.lvis?.userApproval) return;
    try {
      const list = await window.lvis.userApproval.list();
      setUserApprovals(list.filter((a) => !a.revokedAt));
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => { void fetchApprovals(); }, [fetchApprovals]);

  const handleRevokeApproval = async (key: string, toolName: string, scope: UserApprovalScope) => {
    if (!window.lvis?.userApproval) return;
    // CRITICAL 2.1: persistent approvals require explicit confirmation — accidental revoke is unrecoverable
    if (scope === "persistent") {
      const confirmed = window.confirm(
        `[${toolName}] 지속 승인을 취소하시겠습니까?\n\n취소 후 복구할 수 없으며, 다음 도구 호출 시 다시 승인 요청됩니다.`,
      );
      if (!confirmed) return;
    }
    setApprovalsBusy(true);
    try {
      // Issue #805: split revoke + refresh into separate try blocks so a
      // refresh failure after a SUCCESSFUL revoke shows an accurate banner
      // instead of the misleading "취소 실패" message that conflates the
      // two failure modes.
      //
      // Cross-cutting #826 follow-up: `revokeByKey` is an `ipcRenderer.invoke`
      // that RESOLVES with `{ok:false,error,message}` on policy reject —
      // it does NOT throw. The try blocks below catch thrown errors AND
      // inspect the resolved result. The intent gate ("user-keyboard-
      // required") is one such resolved-reject path.
      try {
        const result = await window.lvis.userApproval.revokeByKey(key);
        if (!result.ok) {
          const message = formatRevokeError(result.error, result.message);
          showBanner("error", `취소 실패: ${message}`);
          return;
        }
      } catch (err) {
        showBanner("error", `취소 실패: ${(err as Error).message}`);
        return;
      }
      // Revoke succeeded — refresh the table. If that fails, the row may
      // stay visible until the next reload but the revoke itself landed.
      try {
        await fetchApprovals();
        showBanner("warn", `[${toolName}] 승인이 취소되었습니다.`);
      } catch (err) {
        showBanner(
          "warn",
          `[${toolName}] 승인이 취소되었으나 목록 새로고침 실패: ${(err as Error).message}`,
        );
      }
    } finally {
      setApprovalsBusy(false);
    }
  };

  // ── Section A handler ─────────────────────────────
  const reviewerModeForExecMode = (m: ExecMode): PermissionReviewerMode =>
    m === "auto" ? "llm" : "disabled";
  // `interactive.autoApprove` is the SOT for foreground reviewer auto-allow.
  // Selecting `auto` exec mode in the UI also flips
  // `interactive.autoApprove="low"` so the legacy UX (auto mode → LOW
  // silent allow) is preserved without `auto` being a hidden second opt-in.
  // Selecting any non-auto mode flips back to `"off"`.
  const interactiveAutoApproveForExecMode = (
    m: ExecMode,
  ): "off" | "low" => (m === "auto" ? "low" : "off");

  const handleModeChange = async (m: ExecMode) => {
    const targetReviewerMode = reviewerModeForExecMode(m);
    const targetInteractive = interactiveAutoApproveForExecMode(m);
    if (
      (m === mode &&
        reviewer.mode === targetReviewerMode &&
        reviewer.interactive.autoApprove === targetInteractive) ||
      modeBusy
    ) {
      return;
    }
    setModeBusy(true);
    try {
      let modeChanged = m === mode;
      if (m !== mode) {
        const res = await window.lvis.permission.setMode(m);
        if (res.ok) {
          setMode(res.mode as ExecMode);
          modeChanged = true;
        } else {
          showBanner("error", res.message ?? res.error ?? "실행 모드 변경에 실패했습니다.");
          return;
        }
      }
      if (reviewer.mode !== targetReviewerMode) {
        if (!modeChanged) return;
        const reviewerRes = await window.lvis.permission.reviewerDispatch(`mode ${targetReviewerMode}`);
        if (reviewerRes.ok) {
          setReviewer(reviewerRes.settings);
          setReviewerModelDraft(reviewerRes.settings.model);
        } else {
          showBanner("error", formatReviewerDispatchError(reviewerRes.error));
          return;
        }
      }
      if (reviewer.interactive.autoApprove !== targetInteractive) {
        if (!modeChanged) return;
        const interactiveRes = await window.lvis.permission.reviewerDispatch(
          `interactive ${targetInteractive}`,
        );
        if (interactiveRes.ok) {
          setReviewer(interactiveRes.settings);
        } else {
          showBanner("error", formatReviewerDispatchError(interactiveRes.error));
          return;
        }
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

  /** Refresh provider key map (re-query all providers in parallel). */
  const refreshProviderKeyMap = useCallback(async () => {
    const results = await Promise.all(
      REVIEWER_PROVIDER_OPTIONS.map((opt) =>
        window.lvis.permission.reviewerProviderHasKey(opt.value),
      ),
    );
    const keyMap: Partial<Record<PermissionReviewerProvider, boolean>> = {};
    REVIEWER_PROVIDER_OPTIONS.forEach((opt, i) => {
      keyMap[opt.value] = Boolean(results[i]);
    });
    setProviderKeyMap(keyMap);
  }, []);

  // Refresh providerKeyMap whenever chat LLM settings change so that
  // adding an Azure AI Foundry or Gemini key in the Settings tab immediately
  // enables the corresponding reviewer provider without a tab switch.
  // Minor-1.3 fix: use getApi() consistent with AppearanceTab / RolesTab
  // instead of direct (window as unknown as { lvisApi }).lvisApi access.
  useEffect(() => {
    let api: ReturnType<typeof getApi> | undefined;
    try { api = getApi(); } catch { return; }
    if (!api?.onSettingsUpdated) return;
    return api.onSettingsUpdated(() => {
      void refreshProviderKeyMap();
    });
  }, [refreshProviderKeyMap]);

  const applyReviewerCommand = async (rawArgs: string) => {
    if (reviewerBusy) return;
    setReviewerBusy(true);
    let dispatchOk = false;
    try {
      const res = await window.lvis.permission.reviewerDispatch(rawArgs);
      if (res.ok) {
        setReviewer(res.settings);
        setReviewerModelDraft(res.settings.model);
        dispatchOk = true;
      } else {
        showBanner("error", formatReviewerDispatchError(res.error));
      }
    } catch (e) {
      showBanner("error", `리뷰어 설정 변경 중 오류: ${(e as Error).message}`);
    } finally {
      setReviewerBusy(false);
    }
    // Refresh key map AFTER busy is cleared, so a provider change
    // paired with a key change in the same session updates the list.
    // Only refresh on success — no point querying keys after a failed dispatch.
    if (dispatchOk) {
      await refreshProviderKeyMap();
    }
  };

  const handleReviewerModelApply = async () => {
    const model = reviewerModelDraft.trim();
    if (!model) {
      showBanner("error", "리뷰어 모델 이름을 입력하세요.");
      return;
    }
    if (/\s/.test(model)) {
      showBanner("error", "리뷰어 모델 이름에는 공백을 사용할 수 없습니다.");
      return;
    }
    await applyReviewerCommand(`model ${model}`);
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
    // SettingsContent's right pane owns the dialog-wide scroll (always-
    // visible gutter via overflow-y-scroll). An inner ScrollArea here
    // would double-stack scrollbars, which is what the audit/permissions
    // pair looked like before this consolidation.
    <div className="pr-1">
      <div className="space-y-6 pt-4">

        {/* ── 인라인 배너 (§F9 — alert 대체) ── */}
        {banner && (
          <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${banner.type === "error" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-warning/40 bg-warning/15 text-warning"}`}>
            <span className="mt-0.5 flex-shrink-0">{banner.type === "error" ? "⚠" : "🔒"}</span>
            <span>{banner.msg}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto h-6 w-6 flex-shrink-0 opacity-60 hover:opacity-100"
              onClick={() => setBanner(null)}
              aria-label="알림 닫기"
            >
              ✕
            </Button>
          </div>
        )}

        {quarantinedHooks.length > 0 && (
          <div
            data-testid="hook-quarantine-notice"
            className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[12px] text-warning"
          >
            <div className="flex items-start gap-2">
              <Badge variant="secondary" className="mt-0.5 text-[10px] text-warning">
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
                    <code key={hook.fileName} className="rounded border border-warning/40 bg-background/70 px-1.5 py-0.5 font-mono text-[10px]">
                      {hook.fileName}
                    </code>
                  ))}
                  {quarantinedHooks.length > 3 && (
                    <span className="text-[10px] text-warning/80">
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

        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">현재 권한 정책</p>
            <p className="text-[11px] text-muted-foreground">
              기본, 전체 물어보기, 자동 검증, 전체 허용 중 하나를 선택하고 세부 리뷰어 설정을 조정합니다.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">정책 프리셋</p>
              <p className="mt-1 text-sm font-medium">{EXEC_MODE_OPTIONS.find((opt) => opt.value === mode)?.label ?? mode}</p>
            </div>
            <div className="rounded-md border px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">백그라운드 리뷰</p>
              <p className="mt-1 text-sm font-medium">{REVIEWER_MODE_OPTIONS.find((opt) => opt.value === reviewer.mode)?.label ?? reviewer.mode}</p>
            </div>
            <div className="rounded-md border px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">승인 대화상자</p>
              <p className="mt-1 text-sm font-medium">{requireExplicit ? "명시 액션 필수" : "닫기 동작은 거부 처리"}</p>
            </div>
          </div>
        </div>

        <Separator />

        {/* ── Section A: Permission Policy Preset ── */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">권한 정책</p>
            <p className="text-[11px] text-muted-foreground">
              기본은 읽기 도구를 허용하고, 전체 물어보기는 읽기까지 확인합니다. 자동 검증은 헤드리스 작업을 백그라운드 리뷰어 설정으로 검증하고, 전체 허용은 하드 차단 범위 밖의 도구를 자동 허용하되 허용 디렉터리 밖 접근은 별도 승인합니다.
            </p>
          </div>
          <RadioGroup
            value={mode}
            disabled={modeBusy}
            aria-label="권한 정책 선택"
            onValueChange={(value) => void handleModeChange(value as ExecMode)}
            className="space-y-1.5"
          >
            {EXEC_MODE_OPTIONS.map((opt) => (
              <Label
                key={opt.value}
                htmlFor={`exec-mode-${opt.value}-radio`}
                data-testid={`exec-mode-${opt.value}`}
                className={`flex h-auto w-full cursor-pointer items-start justify-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm font-normal ${mode === opt.value ? "border-primary bg-primary/10 hover:bg-primary/10" : "border-muted hover:border-muted-foreground/40"}`}
              >
                <RadioGroupItem
                  id={`exec-mode-${opt.value}-radio`}
                  value={opt.value}
                  aria-label={opt.label}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">{opt.label}</span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">{opt.description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </div>

        <Separator />

        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">백그라운드 권한 리뷰어</p>
            <p className="text-[11px] text-muted-foreground">
              루틴·헤드리스 실행을 어떻게 검증할지 선택합니다. LLM 검증은 로컬 규칙 뒤에 실행되며 위험도를 낮출 수 없습니다.
            </p>
          </div>

          <RadioGroup
            value={reviewer.mode}
            disabled={reviewerBusy}
            aria-label="백그라운드 권한 리뷰어 선택"
            onValueChange={(value) => void applyReviewerCommand(`mode ${value}`)}
            className="space-y-1.5"
          >
            {REVIEWER_MODE_OPTIONS.map((opt) => (
              <Label
                key={opt.value}
                htmlFor={`reviewer-mode-${opt.value}-radio`}
                data-testid={`reviewer-mode-${opt.value}`}
                className={`flex h-auto w-full cursor-pointer items-start justify-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm font-normal ${reviewer.mode === opt.value ? "border-primary bg-primary/10 hover:bg-primary/10" : "border-muted hover:border-muted-foreground/40"}`}
              >
                <RadioGroupItem
                  id={`reviewer-mode-${opt.value}-radio`}
                  value={opt.value}
                  aria-label={opt.label}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="font-medium">{opt.label}</span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">{opt.description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>

          <div className="space-y-3 rounded-md border bg-muted/20 px-3 py-3">
            <div>
              <p className="text-xs font-medium">LLM 검증 설정</p>
              <p className="text-[11px] text-muted-foreground">LLM 검증을 선택하기 전에 공급자, 모델, 오류 처리 정책을 미리 정합니다.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Label className="space-y-1 text-xs">
                <span className="font-medium">LLM 공급자</span>
                <Select
                  value={reviewer.provider}
                  disabled={reviewerBusy}
                  onValueChange={(value) => void applyReviewerCommand(`provider ${value}`)}
                >
                  <SelectTrigger data-testid="reviewer-provider-select" className="w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <TooltipProvider>
                      {REVIEWER_PROVIDER_OPTIONS.map((opt) => {
                        const hasKey = providerKeyMap[opt.value] ?? false;
                        const isDisabled = !hasKey;
                        // Minor-4.1: use design-system Tooltip (hover + keyboard focus)
                        // instead of title attribute (hover-only, not read by screen readers).
                        // opacity-40 → opacity-60 for Minor-1.2 contrast improvement.
                        const item = (
                          <SelectItem
                            key={opt.value}
                            value={opt.value}
                            disabled={isDisabled}
                            className={isDisabled ? "opacity-60 cursor-not-allowed" : undefined}
                            data-testid={`reviewer-provider-option-${opt.value}`}
                          >
                            {opt.label}
                            {isDisabled && (
                              <span className="ml-2 text-[10px] text-muted-foreground">(키 없음)</span>
                            )}
                          </SelectItem>
                        );
                        if (!isDisabled) return item;
                        return (
                          <Tooltip key={opt.value}>
                            <TooltipTrigger asChild>{item}</TooltipTrigger>
                            <TooltipContent data-testid="reviewer-provider-tooltip">API 키 설정 필요 — 지능 설정에서 키를 추가하세요.</TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </TooltipProvider>
                  </SelectContent>
                </Select>
              </Label>
              <Label className="space-y-1 text-xs">
                <span className="font-medium">오류 처리</span>
                <Select
                  value={reviewer.fallbackOnError}
                  disabled={reviewerBusy}
                  onValueChange={(value) => void applyReviewerCommand(`fallback ${value}`)}
                >
                  <SelectTrigger data-testid="reviewer-fallback-select" className="w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REVIEWER_FALLBACK_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label} - {opt.description}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
            </div>
            <Label className="space-y-1 text-xs">
              <span className="font-medium">리뷰어 모델</span>
              <div className="flex gap-2">
                <Input
                  data-testid="reviewer-model-input"
                  className="h-8 flex-1 text-xs"
                  value={reviewerModelDraft}
                  disabled={reviewerBusy}
                  onChange={(e) => setReviewerModelDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleReviewerModelApply();
                  }}
                />
                <Button
                  size="sm"
                  className="h-8 px-3"
                  disabled={reviewerBusy || reviewerModelDraft.trim() === reviewer.model}
                  onClick={() => void handleReviewerModelApply()}
                >
                  적용
                </Button>
              </div>
            </Label>
            <p className="text-[11px] text-muted-foreground">
              OpenAI · Anthropic · Google: 지능 설정의 공급자 키를 사용합니다.
              Azure AI Foundry · Google AI Studio: 지능 설정에서 Azure AI Foundry 또는 Gemini 공급자 API 키를 저장하면 자동으로 활성화됩니다. Foundry 는 엔드포인트 baseUrl 도 함께 설정해야 합니다.
              키가 없는 공급자는 선택할 수 없습니다.
            </p>
            {/* Minor-1.4: Foundry baseUrl format hint — prose-only was ambiguous */}
            <details className="text-[10px] text-muted-foreground">
              <summary className="cursor-pointer select-none">Foundry baseUrl 형식 보기</summary>
              <code className="mt-1 block rounded bg-muted/30 px-2 py-1 font-mono">
                {"https://<resource>.openai.azure.com/openai/deployments/<deployment>"}
              </code>
            </details>

            <div className="space-y-2 border-t pt-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium">저위험 자동 허용</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                위험도가 낮다고 판단된 도구 실행은 확인 없이 자동으로 허용합니다.
                중간·높은 위험도의 실행은 어떤 경우에도 확인 창이 표시됩니다.
              </p>
              <RadioGroup
                value={reviewer.interactive.autoApprove}
                disabled={reviewerBusy}
                aria-label="저위험 자동 허용 설정"
                onValueChange={(value) => void applyReviewerCommand(`interactive ${value}`)}
                className="grid gap-2 sm:grid-cols-2"
              >
                {REVIEWER_INTERACTIVE_OPTIONS.map((opt) => (
                  <Label
                    key={opt.value}
                    htmlFor={`reviewer-interactive-${opt.value}-radio`}
                    data-testid={`reviewer-interactive-${opt.value}`}
                    className={`flex h-auto w-full cursor-pointer items-start justify-start gap-2.5 rounded-md border px-3 py-2 text-left text-xs font-normal ${reviewer.interactive.autoApprove === opt.value ? "border-primary bg-primary/10 hover:bg-primary/10" : "border-muted hover:border-muted-foreground/40"}`}
                  >
                    <RadioGroupItem
                      id={`reviewer-interactive-${opt.value}-radio`}
                      value={opt.value}
                      aria-label={opt.label}
                      className="mt-0.5"
                    />
                    <span className="flex-1 space-y-0.5">
                      <span className="block font-medium">{opt.label}</span>
                      <span className="block text-[11px] text-muted-foreground">{opt.description}</span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
              {reviewer.interactive.autoApprove === "low" && reviewer.mode === "disabled" ? (
                <p className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning">
                  ⚠ 백그라운드 권한 검사가 "명시 승인만" 으로 꺼져 있어 자동 허용이 동작하지 않습니다. "규칙 기반" 또는 "LLM" 으로 변경하세요.
                </p>
              ) : null}
              {mode === "auto" && reviewer.interactive.autoApprove === "off" ? (
                <p
                  className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning"
                  data-testid="permissions-legacy-auto-mode-banner"
                >
                  ⚠ "자동 검증" 모드에서 자동 허용이 꺼져 있습니다.
                  낮은 위험도 작업을 확인 없이 허용하려면 위에서 "저위험 자동 허용"을 선택하세요.
                </p>
              ) : null}
              {mode === "strict" && reviewer.interactive.autoApprove === "low" ? (
                <p
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
                  data-testid="permissions-strict-low-contradiction-banner"
                >
                  ⛔ "전체 물어보기" 모드와 "저위험 자동 허용"이 동시에 켜져 있어 설정이 충돌합니다.
                  모두 묻기 정책을 유지하려면 자동 허용을 "끔"으로 변경하세요.
                </p>
              ) : null}
              {mode === "allow" ? (
                <p
                  className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning"
                  data-testid="permissions-allow-mode-banner"
                >
                  ⚠ "전체 허용" 모드에서는 모든 작업이 자동으로 허용되므로 자동 허용 설정이 적용되지 않습니다.
                </p>
              ) : null}
            </div>
          </div>

          <details
            className="rounded-md border bg-muted/20"
            data-testid="reviewer-framework-panel"
          >
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
              권한 리뷰어 프레임워크 / 프롬프트
            </summary>
            <div className="space-y-3 border-t px-3 py-3 text-xs">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded border bg-background/60 px-2 py-2">
                  <p className="text-[11px] text-muted-foreground">버전</p>
                  <p className="mt-1 font-mono">{PERMISSION_REVIEWER_FRAMEWORK.version}</p>
                </div>
                <div className="rounded border bg-background/60 px-2 py-2">
                  <p className="text-[11px] text-muted-foreground">출력 계약</p>
                  <p className="mt-1 font-mono">{PERMISSION_REVIEWER_FRAMEWORK.outputContract}</p>
                </div>
              </div>
              <div className="rounded border bg-background/60 px-2 py-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">위험도 기준</p>
                <ul className="space-y-1">
                  {PERMISSION_REVIEWER_FRAMEWORK.levels.map((level) => (
                    <li key={level.level}>
                      <span className="font-mono uppercase">{level.level}</span> · {level.definition}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded border bg-background/60 px-2 py-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">판단 구성</p>
                <ul className="space-y-1">
                  {PERMISSION_REVIEWER_FRAMEWORK.compositionRules.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded border bg-background/60 px-2 py-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">LLM 입력 필드</p>
                <p className="font-mono leading-relaxed">
                  {PERMISSION_REVIEWER_FRAMEWORK.inputFields.join(" · ")}
                </p>
              </div>
              <details className="rounded border bg-background/60">
                <summary className="cursor-pointer px-2 py-2 text-[11px] font-medium">
                  시스템 프롬프트 원문
                </summary>
                <pre className="max-h-56 overflow-auto border-t px-2 py-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                  {PERMISSION_REVIEWER_FRAMEWORK.systemPrompt}
                </pre>
              </details>
            </div>
          </details>
        </div>

        <Separator />

        {/* ── Section B: Explicit Approval Policy ── */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">승인 대화상자 동작</p>
            <p className="text-[11px] text-muted-foreground">체크 시 승인 대화상자에서 모달 외부 클릭과 Escape 키가 차단되어 버튼 또는 승인 단축키로 명시적으로 결정해야 합니다.</p>
          </div>
          <div className="flex items-center gap-3">
            <Checkbox
              checked={requireExplicit}
              aria-label="승인 대화상자에서 버튼 또는 단축키로 명시적 승인 또는 거부를 요구"
              disabled={policyManaged || policyBusy}
              className="size-5"
              onCheckedChange={() => void handleExplicitToggle()}
            />
            <span className="text-sm">{requireExplicit ? "활성화됨" : "비활성화됨"}</span>
            {policyManaged && <span className="text-base" title="IT 관리자 설정">🔒</span>}
          </div>
          {policyManaged && (
            <p className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning">
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
              <table className="w-full table-fixed text-xs">
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
                        <Badge variant={r.action === "allow" ? "default" : "secondary"} className={`text-[10px] ${r.action === "deny" ? "text-destructive" : ""}`}>
                          {r.action === "allow" ? "허용" : "거부"}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.source ?? "전체"}</td>
                      <td className="px-3 py-1.5 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive"
                          disabled={rulesBusy}
                          onClick={() => void handleRemoveRule(r.pattern, r.action)}
                        >
                          ✕
                        </Button>
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
              placeholder="패턴 (예: mcp_*, agent_spawn)"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newPattern.trim()) void handleAddRule(); }}
            />
            <Select
              value={newAction}
              onValueChange={(value) => setNewAction(value as "allow" | "deny")}
            >
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">허용</SelectItem>
                <SelectItem value="deny">거부</SelectItem>
              </SelectContent>
            </Select>
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
                        <span className="block whitespace-normal break-all" title={dir}>{dir}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive"
                          disabled={dirsBusy}
                          onClick={() => void handleRemoveDirectory(dir)}
                        >
                          ✕
                        </Button>
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
              className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[12px] text-warning"
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

        {/* ── R-5: 사용자 승인 기록 ── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">사용자 승인 기록 ({userApprovals.length})</p>
              <p className="text-[11px] text-muted-foreground">세션 또는 지속적으로 기록된 도구 승인 목록입니다.</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-3 text-[12px]"
              onClick={() => void fetchApprovals()}
              disabled={approvalsBusy}
            >
              새로고침
            </Button>
          </div>
          {userApprovals.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">기록된 승인이 없습니다.</p>
          ) : (
            <div className="overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">도구</th>
                    <th className="px-3 py-2 text-left font-medium">범위</th>
                    <th className="px-3 py-2 text-left font-medium">위험도</th>
                    <th className="px-3 py-2 text-left font-medium">승인 일시</th>
                    <th className="px-3 py-2 text-left font-medium">사유</th>
                    <th className="px-3 py-2 text-left font-medium">액션</th>
                  </tr>
                </thead>
                <tbody>
                  {userApprovals.map((a) => (
                    <tr key={a.key} className="border-b last:border-0">
                      <td className="max-w-[120px] truncate px-3 py-2 font-mono">
                        {/* R-2 Round-3 MEDIUM: show toolName from entry metadata, not hex hash fragment */}
                        {a.toolName ?? a.key.slice(0, 12)}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${a.scope === "persistent" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground"}`}>
                          {a.scope === "persistent" ? "지속" : "세션"}
                        </span>
                      </td>
                      <td className="px-3 py-2">{a.verdictAtApproval.toUpperCase()}{a.verdictAtApproval === "high" ? " (HIGH 고정)" : ""}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {new Date(a.approvedAt).toLocaleString()}
                      </td>
                      <td className="max-w-[180px] truncate px-3 py-2 text-muted-foreground"
                          title={a.nlJustification ?? undefined}>
                        {a.nlJustification ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={approvalsBusy}
                          onClick={() => void handleRevokeApproval(a.key, a.toolName ?? a.key.slice(0, 12), a.scope)}
                        >
                          취소
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <Separator />

        {/* ── Audit Log ── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
            <p className="text-sm font-medium">감사 로그</p>
            <p className="text-[11px] text-muted-foreground">최근 권한 감사 기록과 체인 검증 상태를 확인합니다.</p>
            </div>
            <Button size="sm" variant="outline" className="h-8 px-3 text-[12px]" onClick={() => setAuditOpen(true)}>
              열기
            </Button>
          </div>
        </div>

      </div>
      <AuditPanel open={auditOpen} onClose={() => setAuditOpen(false)} />
    </div>
  );
}

function formatPermissionDirArg(path: string): string {
  return /[\s"']|^-/.test(path) ? JSON.stringify(path) : path;
}
