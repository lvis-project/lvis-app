import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { t } from "../../../i18n/runtime.js";
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
import { PERMISSION_REVIEWER_FRAMEWORK } from "../../../shared/permission-reviewer-framework.js";
import type { UserApprovalScope, UserApprovalVerdict } from "../../../shared/permissions-events.js";
import { EXEC_MODE_OPTIONS, LONG_TOAST_TTL_MS } from "../constants.js";
import { formatIpcError } from "../format-ipc-error.js";
import type {
  ExecMode,
  HookTrustRow,
  PermissionReviewerFallbackOnError,
  PermissionReviewerMode,
  PermissionReviewerSettings,
  PermissionRule,
} from "../types.js";
import type { SandboxCapabilityInfo } from "../../../shared/sandbox-capability-info.js";
import { AuditPanel } from "../components/permissions/AuditPanel.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { getApi } from "../api-client.js";
import { isIpcErrorResult } from "../types.js";

const DEFAULT_REVIEWER_SETTINGS: PermissionReviewerSettings = {
  mode: "disabled",
  provider: "openai",
  model: "gpt-4o-mini",
  fallbackOnError: "deny",
  interactive: { autoApprove: "off" },
};

function getReviewerInteractiveOptions(): Array<{
  value: "off" | "low";
  label: string;
  description: string;
}> {
  return [
    {
      value: "off",
      label: t("permissionsTab.interactiveOffLabel"),
      description: t("permissionsTab.interactiveOffDescription"),
    },
    {
      value: "low",
      label: t("permissionsTab.interactiveLowLabel"),
      description: t("permissionsTab.interactiveLowDescription"),
    },
  ];
}

function getReviewerModeOptions(): Array<{
  value: PermissionReviewerMode;
  label: string;
  description: string;
}> {
  return [
    { value: "disabled", label: t("permissionsTab.reviewerModeDisabledLabel"), description: t("permissionsTab.reviewerModeDisabledDescription") },
    { value: "rule", label: t("permissionsTab.reviewerModeRuleLabel"), description: t("permissionsTab.reviewerModeRuleDescription") },
    { value: "llm", label: t("permissionsTab.reviewerModeLlmLabel"), description: t("permissionsTab.reviewerModeLlmDescription") },
    { value: "strict", label: t("permissionsTab.reviewerModeStrictLabel"), description: t("permissionsTab.reviewerModeStrictDescription") },
  ];
}

function getReviewerFallbackOptions(): Array<{
  value: PermissionReviewerFallbackOnError;
  label: string;
  description: string;
}> {
  return [
    { value: "deny", label: t("permissionsTab.fallbackDenyLabel"), description: t("permissionsTab.fallbackDenyDescription") },
    { value: "rule", label: t("permissionsTab.fallbackRuleLabel"), description: t("permissionsTab.fallbackRuleDescription") },
  ];
}

function formatRevokeError(error: string | undefined, message: string | undefined): string {
  return formatIpcError(error, message, {
    codeMap: { "invalid-key": t("permissionsTab.errorInvalidKey") },
  });
}

function formatReviewerDispatchError(error: string): string {
  if (error.startsWith("reviewer-rewire-failed:")) {
    const detail = error.slice("reviewer-rewire-failed:".length).trim();
    return [
      t("permissionsTab.errorReviewerRewireFailed"),
      t("permissionsTab.errorReviewerRewireHint"),
      detail ? t("permissionsTab.errorReviewerRewireDetail", { detail }) : "",
    ].filter(Boolean).join(" ");
  }
  return formatIpcError(error, undefined, {
    codeMap: { "user-keyboard-required": t("permissionsTab.errorUserKeyboardRequired") },
    fallbackContext: t("permissionsTab.errorReviewerFallbackContext"),
  });
}

const REVIEWER_RENAME_NOTICE_LS_KEY = "permissions.reviewer.rename-notice.dismissed-v1";

function preserveSettingsScrollPosition(): () => void {
  const scroller = document.querySelector<HTMLElement>(".lvis-settings-scroll");
  if (!scroller) return () => undefined;
  const top = scroller.scrollTop;
  return () => {
    requestAnimationFrame(() => {
      scroller.scrollTop = top;
    });
  };
}

export function PermissionsTab() {
  const { t } = useTranslation();
  // ── 로딩 상태 ─────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── 인라인 배너 (alert 대체 — §F9) ───────────────
  const [banner, setBanner] = useState<{ type: "error" | "warn"; msg: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showBanner = useCallback((type: "error" | "warn", msg: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ type, msg });
    bannerTimerRef.current = setTimeout(() => setBanner(null), LONG_TOAST_TTL_MS);
  }, []);

  // ── 권한 리뷰어 rename 1회 안내 ───────────────────
  const [showRenameNotice, setShowRenameNotice] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(REVIEWER_RENAME_NOTICE_LS_KEY) !== "1") {
        setShowRenameNotice(true);
      }
    } catch {
      // LocalStorage unavailable — fail closed (don't show banner repeatedly)
    }
  }, []);
  const dismissRenameNotice = useCallback(() => {
    setShowRenameNotice(false);
    try {
      window.localStorage.setItem(REVIEWER_RENAME_NOTICE_LS_KEY, "1");
    } catch {}
  }, []);

  // ── Execution Mode ────────────────────────────────
  const [mode, setMode] = useState<ExecMode>("default");
  const [modeBusy, setModeBusy] = useState(false);

  // ── Explicit Approval Policy ──────────────────────
  const [requireExplicit, setRequireExplicit] = useState(true);
  const [policyManaged, setPolicyManaged] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
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
  const [userApprovals, setUserApprovals] = useState<Array<{
    key: string;
    approvedAt: string;
    scope: UserApprovalScope;
    verdictAtApproval: UserApprovalVerdict;
    nlJustification: string | null;
    revokedAt: string | null;
    toolName?: string;
    source?: string;
  }>>([]);
  const [approvalsBusy, setApprovalsBusy] = useState(false);
  const [reviewer, setReviewer] = useState<PermissionReviewerSettings>(DEFAULT_REVIEWER_SETTINGS);
  const [reviewerBusy, setReviewerBusy] = useState(false);
  // Runtime degrade: persisted mode="llm" but wiring fell back to rule because
  // no LLM provider/key is configured. Drives the degrade banner.
  const [reviewerDegradedToRule, setReviewerDegradedToRule] = useState(false);

  // ── OS Tool Sandbox ───────────────────────────────
  const [sandboxCapability, setSandboxCapability] = useState<SandboxCapabilityInfo | null>(null);
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [sandboxBusy, setSandboxBusy] = useState(false);

  // ── 초기 fetch (탭 진입 시) ───────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [modeRes, policyRes, rulesRes, hookTrustRes, dirRes, reviewerRes, sandboxRes, settingsRes] =
        await Promise.all([
          window.lvis.permission.getMode(),
          window.lvis.policy.get(),
          window.lvis.permission.listRules(),
          window.lvis.permission.hookTrustList(),
          window.lvis.permission.dirDispatch("list"),
          window.lvis.permission.reviewerDispatch("show"),
          window.lvis.permission.sandboxCapability(),
          getApi().getSettings(),
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
      setReviewerDegradedToRule(reviewerRes.reviewerDegradedToRule ?? false);
      setSandboxCapability(sandboxRes);
      setSandboxEnabled(settingsRes.features?.osToolSandbox ?? false);
    } catch (e) {
      setError((e as Error).message ?? t("permissionsTab.errorLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

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

  // Auto-refresh on cross-window directory/rule/user-approval config changes
  // (allow-session grants from out-of-allowed-dir dialog, addRule/removeRule
  // through PermissionManager SOT, userApprovalRecord/Revoke in another
  // window). Refresh BOTH `fetchAll` (rules + directories + mode) AND
  // `fetchApprovals` (active approvals) so every PermissionsTab section
  // stays in sync — the broadcast is a single hint event covering all
  // permission-state mutations.
  useEffect(() => {
    const unsubscribe = window.lvis?.permission?.onConfigChanged?.(() => {
      void fetchAll();
      void fetchApprovals();
    });
    return () => {
      unsubscribe?.();
    };
  }, [fetchAll, fetchApprovals]);

  const handleRevokeApproval = async (key: string, toolName: string, scope: UserApprovalScope) => {
    if (!window.lvis?.userApproval) return;
    if (scope === "persistent") {
      const confirmed = window.confirm(
        t("permissionsTab.confirmRevokePersistent", { toolName }),
      );
      if (!confirmed) return;
    }
    setApprovalsBusy(true);
    try {
      try {
        const result = await window.lvis.userApproval.revokeByKey(key);
        if (!result.ok) {
          const message = formatRevokeError(result.error, result.message);
          showBanner("error", t("permissionsTab.errorRevokeFailed", { message }));
          return;
        }
      } catch (err) {
        showBanner("error", t("permissionsTab.errorRevokeFailed", { message: (err as Error).message }));
        return;
      }
      try {
        await fetchApprovals();
        showBanner("warn", t("permissionsTab.successRevokeApproval", { toolName }));
      } catch (err) {
        showBanner(
          "warn",
          t("permissionsTab.errorRevokeRefreshFailed", { toolName, message: (err as Error).message }),
        );
      }
    } finally {
      setApprovalsBusy(false);
    }
  };

  const reviewerModeForExecMode = (m: ExecMode): PermissionReviewerMode =>
    m === "auto" ? "llm" : "disabled";
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
          showBanner("error", res.message ?? res.error ?? t("permissionsTab.errorModeChangeFailed"));
          return;
        }
      }
      if (reviewer.mode !== targetReviewerMode) {
        if (!modeChanged) return;
        const reviewerRes = await window.lvis.permission.reviewerDispatch(`mode ${targetReviewerMode}`);
        if (reviewerRes.ok) {
          setReviewer(reviewerRes.settings);
          setReviewerDegradedToRule(reviewerRes.reviewerDegradedToRule ?? false);
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
          setReviewerDegradedToRule(interactiveRes.reviewerDegradedToRule ?? false);
        } else {
          showBanner("error", formatReviewerDispatchError(interactiveRes.error));
          return;
        }
      }
    } catch (e) {
      showBanner("error", t("permissionsTab.errorModeChangeError", { message: (e as Error).message }));
    } finally {
      setModeBusy(false);
    }
  };

  const handleExplicitToggle = async () => {
    if (policyManaged) return;
    setPolicyBusy(true);
    try {
      const next = !requireExplicit;
      const res = await window.lvis.policy.set({ requireExplicitApproval: next });
      if (res.ok) {
        setRequireExplicit(next);
      } else if (res.error === "managed") {
        showBanner("warn", t("permissionsTab.errorPolicyManaged"));
      } else {
        showBanner("error", res.message ?? t("permissionsTab.errorPolicyChangeFailed"));
      }
    } finally {
      setPolicyBusy(false);
    }
  };

  const handleSandboxToggle = async () => {
    if (sandboxBusy) return;
    const next = !sandboxEnabled;
    setSandboxBusy(true);
    setSandboxEnabled(next);
    try {
      const res = await getApi().updateSettings({ features: { osToolSandbox: next } });
      if (isIpcErrorResult(res)) {
        setSandboxEnabled(!next);
        showBanner("error", res.message ?? t("permissionsTab.osSandboxToggleFailed"));
        return;
      }
      // Re-read capability so the activation note reflects the new state.
      const capability = await window.lvis.permission.sandboxCapability();
      setSandboxCapability(capability);
    } catch (e) {
      setSandboxEnabled(!next);
      showBanner("error", t("permissionsTab.osSandboxToggleError", { message: (e as Error).message }));
    } finally {
      setSandboxBusy(false);
    }
  };

  const applyReviewerCommand = async (rawArgs: string) => {
    if (reviewerBusy) return;
    setReviewerBusy(true);
    try {
      const res = await window.lvis.permission.reviewerDispatch(rawArgs);
      if (res.ok) {
        setReviewer(res.settings);
        setReviewerDegradedToRule(res.reviewerDegradedToRule ?? false);
      } else {
        showBanner("error", formatReviewerDispatchError(res.error));
      }
    } catch (e) {
      showBanner("error", t("permissionsTab.errorReviewerChangeError", { message: (e as Error).message }));
    } finally {
      setReviewerBusy(false);
    }
  };

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
        showBanner("error", res.message ?? t("permissionsTab.errorRuleAddFailed", { error: res.error }));
      }
    } catch (e) {
      showBanner("error", t("permissionsTab.errorRuleAddError", { message: (e as Error).message }));
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
        showBanner("error", res.message ?? t("permissionsTab.errorRuleRemoveFailed", { error: res.error }));
      }
    } catch (e) {
      showBanner("error", t("permissionsTab.errorRuleRemoveError", { message: (e as Error).message }));
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
          showBanner("warn", t("permissionsTab.warnDirectoryAckRequired"));
        } else {
          setPendingDirectoryWarning(null);
          showBanner("error", failed.error);
        }
      }
    } catch (e) {
      setPendingDirectoryWarning(null);
      showBanner("error", t("permissionsTab.errorDirectoryAddError", { message: (e as Error).message }));
    } finally {
      setDirsBusy(false);
    }
  };

  const handleRemoveDirectory = async (dir: string) => {
    const restoreScroll = preserveSettingsScrollPosition();
    setDirsBusy(true);
    try {
      const res = await window.lvis.permission.dirDispatch(`deny ${formatPermissionDirArg(dir)}`);
      if (res.ok && res.verb === "deny") {
        setDirectories(res.persisted);
      } else if (!res.ok) {
        showBanner("error", res.error);
      }
    } catch (e) {
      showBanner("error", t("permissionsTab.errorDirectoryRemoveError", { message: (e as Error).message }));
    } finally {
      setDirsBusy(false);
      restoreScroll();
    }
  };

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">{t("permissionsTab.loading")}</div>;
  }
  if (error) {
    return <div className="py-4 text-sm text-destructive">{error}</div>;
  }

  return (
    <div className="pr-1">
      <div className="space-y-6">
        <SettingsPageHeader
          title={t("permissionsTab.pageTitle")}
          description={t("permissionsTab.pageDescription")}
        />

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
              aria-label={t("permissionsTab.closeBannerAriaLabel")}
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
                {t("permissionsTab.hookQuarantineBadge", { count: quarantinedHooks.length })}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t("permissionsTab.hookQuarantineTitle")}</p>
                <p className="mt-1 text-[11px]">
                  {t("permissionsTab.hookQuarantineInstructionBefore")}<code className="rounded bg-background/70 px-1 font-mono">/permission hooks list</code>{t("permissionsTab.hookQuarantineInstructionAfter")}
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
                {t("permissionsTab.refreshButton")}
              </Button>
            </div>
          </div>
        )}

        {/* ── 현재 권한 정책 요약 ── */}
        <SettingsSection
          title={t("permissionsTab.currentPolicySummaryTitle")}
          description={t("permissionsTab.currentPolicySummaryDescription")}
        >
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">{t("permissionsTab.summaryPolicyPreset")}</p>
              <p className="mt-1 text-sm font-medium">{EXEC_MODE_OPTIONS.find((opt) => opt.value === mode)?.label ?? mode}</p>
            </div>
            <div className="rounded-md border px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">{t("permissionsTab.summaryReviewer")}</p>
              <p className="mt-1 text-sm font-medium">{getReviewerModeOptions().find((opt) => opt.value === reviewer.mode)?.label ?? reviewer.mode}</p>
            </div>
            <div className="rounded-md border px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">{t("permissionsTab.summaryApprovalDialog")}</p>
              <p className="mt-1 text-sm font-medium">{requireExplicit ? t("permissionsTab.summaryExplicitRequired") : t("permissionsTab.summaryCloseDenies")}</p>
            </div>
          </div>
        </SettingsSection>

        {/* ── Section A: Permission Policy Preset ── */}
        <SettingsSection
          title={t("permissionsTab.policyTitle")}
          description={t("permissionsTab.policyDescription")}
        >
          <RadioGroup
            value={mode}
            disabled={modeBusy}
            aria-label={t("permissionsTab.policyAriaLabel")}
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
        </SettingsSection>

        {/* ── 권한 리뷰어 ── */}
        <SettingsSection
          title={t("permissionsTab.reviewerTitle")}
          description={t("permissionsTab.reviewerDescription")}
        >
          {showRenameNotice ? (
            <div
              role="status"
              data-testid="reviewer-rename-notice"
              className="flex items-start gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-[11px] text-info"
            >
              <span className="flex-1">{t("permissionsTab.reviewerRenameNoticeText")}</span>
              <button
                type="button"
                onClick={dismissRenameNotice}
                aria-label={t("permissionsTab.closeBannerAriaLabel")}
                className="text-xs underline-offset-2 hover:underline"
              >
                {t("permissionsTab.closeButton")}
              </button>
            </div>
          ) : null}
          <RadioGroup
            value={reviewer.mode}
            disabled={reviewerBusy}
            aria-label={t("permissionsTab.reviewerAriaLabel")}
            onValueChange={(value) => void applyReviewerCommand(`mode ${value}`)}
            className="space-y-1.5"
          >
            {getReviewerModeOptions().map((opt) => (
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

          {reviewerDegradedToRule && reviewer.mode === "llm" ? (
            <p
              role="status"
              data-testid="reviewer-llm-degraded-banner"
              className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning"
            >
              {t("permissionsTab.warnReviewerLlmDegradedToRule")}
            </p>
          ) : null}

          <div className="space-y-3 rounded-md border bg-muted/20 px-3 py-3">
            <div>
              <p className="text-xs font-medium">{t("permissionsTab.llmSettingsTitle")}</p>
              <p className="text-[11px] text-muted-foreground">{t("permissionsTab.llmSettingsDescription")}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div
                className="rounded-md border bg-background px-3 py-2 text-xs"
                data-testid="reviewer-active-llm-source"
              >
                <p className="font-medium">{t("permissionsTab.llmVerificationLabel")}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("permissionsTab.llmVerificationDescription")}
                </p>
              </div>
              <Label className="space-y-1 text-xs">
                <span className="font-medium">{t("permissionsTab.errorHandlingLabel")}</span>
                <Select
                  value={reviewer.fallbackOnError}
                  disabled={reviewerBusy}
                  onValueChange={(value) => void applyReviewerCommand(`fallback ${value}`)}
                >
                  <SelectTrigger data-testid="reviewer-fallback-select" className="w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {getReviewerFallbackOptions().map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label} - {opt.description}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("permissionsTab.llmProviderManagedNote")}
            </p>

            <div className="space-y-2 border-t pt-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium">{t("permissionsTab.autoApproveLowRiskLabel")}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("permissionsTab.autoApproveLowRiskDescription")}
              </p>
              <RadioGroup
                value={reviewer.interactive.autoApprove}
                disabled={reviewerBusy}
                aria-label={t("permissionsTab.autoApproveLowRiskAriaLabel")}
                onValueChange={(value) => void applyReviewerCommand(`interactive ${value}`)}
                className="grid gap-2 sm:grid-cols-2"
              >
                {getReviewerInteractiveOptions().map((opt) => (
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
                  {t("permissionsTab.warnReviewerDisabledAutoApproveInactive")}
                </p>
              ) : null}
              {mode === "auto" && reviewer.interactive.autoApprove === "off" ? (
                <p
                  className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning"
                  data-testid="permissions-legacy-auto-mode-banner"
                >
                  {t("permissionsTab.warnAutoModeAutoApproveOff")}
                </p>
              ) : null}
              {mode === "strict" && reviewer.interactive.autoApprove === "low" ? (
                <p
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
                  data-testid="permissions-strict-low-contradiction-banner"
                >
                  {t("permissionsTab.warnStrictLowContradiction")}
                </p>
              ) : null}
              {mode === "allow" ? (
                <p
                  className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning"
                  data-testid="permissions-allow-mode-banner"
                >
                  {t("permissionsTab.warnAllowModeReviewerIgnored")}
                </p>
              ) : null}
            </div>
          </div>

          <details
            className="rounded-md border bg-muted/20"
            data-testid="reviewer-cli-mapping-panel"
          >
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
              {t("permissionsTab.cliMappingTitle")}
            </summary>
            <div className="space-y-2 border-t px-3 py-3 text-[11px]">
              <p className="text-muted-foreground">
                {t("permissionsTab.cliMappingDescription")}
              </p>
              <ul className="space-y-1 font-mono leading-relaxed">
                <li><code>/permission reviewer mode &lt;disabled|rule|llm|strict&gt;</code></li>
                <li><code>/permission reviewer interactive &lt;off|low&gt;</code></li>
                <li><code>/permission reviewer fallback &lt;deny|rule&gt;</code></li>
              </ul>
              <p className="text-muted-foreground">
                {t("permissionsTab.cliMappingProviderNote")}
              </p>
            </div>
          </details>

          <details
            className="rounded-md border bg-muted/20"
            data-testid="reviewer-framework-panel"
          >
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
              {t("permissionsTab.frameworkPanelTitle")}
            </summary>
            <div className="space-y-3 border-t px-3 py-3 text-xs">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded border bg-background/60 px-2 py-2">
                  <p className="text-[11px] text-muted-foreground">{t("permissionsTab.frameworkVersion")}</p>
                  <p className="mt-1 font-mono">{PERMISSION_REVIEWER_FRAMEWORK.version}</p>
                </div>
                <div className="rounded border bg-background/60 px-2 py-2">
                  <p className="text-[11px] text-muted-foreground">{t("permissionsTab.frameworkOutputContract")}</p>
                  <p className="mt-1 font-mono">{PERMISSION_REVIEWER_FRAMEWORK.outputContract}</p>
                </div>
              </div>
              <div className="rounded border bg-background/60 px-2 py-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">{t("permissionsTab.frameworkRiskLevels")}</p>
                <ul className="space-y-1">
                  {PERMISSION_REVIEWER_FRAMEWORK.levels.map((level) => (
                    <li key={level.level}>
                      <span className="font-mono uppercase">{level.level}</span> · {level.definition}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded border bg-background/60 px-2 py-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">{t("permissionsTab.frameworkComposition")}</p>
                <ul className="space-y-1">
                  {PERMISSION_REVIEWER_FRAMEWORK.compositionRules.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded border bg-background/60 px-2 py-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">{t("permissionsTab.frameworkInputFields")}</p>
                <p className="font-mono leading-relaxed">
                  {PERMISSION_REVIEWER_FRAMEWORK.inputFields.join(" · ")}
                </p>
              </div>
              <details className="rounded border bg-background/60">
                <summary className="cursor-pointer px-2 py-2 text-[11px] font-medium">
                  {t("permissionsTab.frameworkSystemPromptTitle")}
                </summary>
                <pre className="max-h-56 overflow-auto border-t px-2 py-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                  {PERMISSION_REVIEWER_FRAMEWORK.systemPrompt}
                </pre>
              </details>
            </div>
          </details>
        </SettingsSection>

        {/* ── Section B: Explicit Approval Policy ── */}
        <SettingsSection
          title={t("permissionsTab.approvalDialogTitle")}
          description={t("permissionsTab.approvalDialogDescription")}
        >
          <div className="flex items-center gap-3">
            <Checkbox
              checked={requireExplicit}
              aria-label={t("permissionsTab.approvalDialogCheckboxAriaLabel")}
              disabled={policyManaged || policyBusy}
              className="size-5"
              onCheckedChange={() => void handleExplicitToggle()}
            />
            <span className="text-sm">{requireExplicit ? t("permissionsTab.policyEnabled") : t("permissionsTab.policyDisabled")}</span>
            {policyManaged && <span className="text-base" title={t("permissionsTab.adminManagedTitle")}>🔒</span>}
          </div>
          {policyManaged && (
            <p className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning">
              {(policySource === "admin" || policySource === "merged") && policyAdminPath
                ? t("permissionsTab.adminPolicyWithPath", { policyAdminPath })
                : t("permissionsTab.adminPolicyNoPath")}
            </p>
          )}
        </SettingsSection>

        {/* ── OS Tool Sandbox ── */}
        <SettingsSection
          title={t("permissionsTab.osSandboxTitle")}
          description={t("permissionsTab.osSandboxDescription")}
        >
          <div className="flex items-center gap-3">
            <Checkbox
              checked={sandboxEnabled}
              data-testid="os-sandbox-toggle"
              aria-label={t("permissionsTab.osSandboxCheckboxAriaLabel")}
              disabled={sandboxBusy || !(sandboxCapability?.available ?? false)}
              className="size-5"
              onCheckedChange={() => void handleSandboxToggle()}
            />
            <span className="text-sm">
              {sandboxEnabled ? t("permissionsTab.osSandboxEnabled") : t("permissionsTab.osSandboxDisabled")}
            </span>
          </div>
          {sandboxCapability && !sandboxCapability.available ? (
            <p
              data-testid="os-sandbox-unavailable"
              className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning"
            >
              {t("permissionsTab.osSandboxUnavailable", { platform: sandboxCapability.platform })}
            </p>
          ) : null}
          {sandboxCapability && sandboxCapability.available ? (
            <div className="space-y-1 rounded-md border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              <p className="font-medium text-foreground">{t("permissionsTab.osSandboxCapabilityHeading")}</p>
              <p>
                {sandboxCapability.platform === "darwin"
                  ? t("permissionsTab.osSandboxCapabilityMac")
                  : sandboxCapability.platform === "linux"
                    ? t("permissionsTab.osSandboxCapabilityLinux")
                    : t("permissionsTab.osSandboxCapabilityOther")}
              </p>
              <p className="italic">{t("permissionsTab.osSandboxRestartNote")}</p>
            </div>
          ) : null}
        </SettingsSection>

        {/* ── Section C: Rule Editor ── */}
        <SettingsSection
          title={t("permissionsTab.rulesTitle")}
          description={<>{t("permissionsTab.rulesDescriptionBefore")}<code className="text-[10px]">mcp_*</code>{t("permissionsTab.rulesDescriptionAfter")}</>}
        >
          {rules.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">{t("permissionsTab.rulesEmpty")}</p>
          ) : (
            <div className="rounded-md border">
              <table className="w-full table-fixed text-xs">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.rulesColPattern")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.rulesColAction")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.rulesColSource")}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={`${r.pattern}:${r.action}:${i}`} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-1.5 font-mono">{r.pattern}</td>
                      <td className="px-3 py-1.5">
                        <Badge variant={r.action === "allow" ? "default" : "secondary"} className={`text-[10px] ${r.action === "deny" ? "text-destructive" : ""}`}>
                          {r.action === "allow" ? t("permissionsTab.actionAllow") : t("permissionsTab.actionDeny")}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.source ?? t("permissionsTab.sourceAll")}</td>
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
          <div className="flex items-center gap-2">
            <Input
              className="h-8 flex-1 text-xs"
              placeholder={t("permissionsTab.patternInputPlaceholder")}
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
                <SelectItem value="allow">{t("permissionsTab.actionAllow")}</SelectItem>
                <SelectItem value="deny">{t("permissionsTab.actionDeny")}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" className="h-8" onClick={() => void handleAddRule()} disabled={rulesBusy || !newPattern.trim()}>
              {t("permissionsTab.addButton")}
            </Button>
          </div>
        </SettingsSection>

        {/* ── Section D: Additional Directories ── */}
        <SettingsSection
          title={t("permissionsTab.directoriesTitle")}
          description={t("permissionsTab.directoriesDescription")}
          actions={
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => void refreshDirectories()}
              disabled={dirsBusy}
            >
              {t("permissionsTab.refreshButton")}
            </Button>
          }
        >
          {directories.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">{t("permissionsTab.directoriesEmpty")}</p>
          ) : (
            <div className="rounded-md border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.directoriesColPath")}</th>
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
              placeholder={t("permissionsTab.directoryInputPlaceholder")}
              value={newDirectory}
              onChange={(e) => {
                setNewDirectory(e.target.value);
                setPendingDirectoryWarning(null);
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && newDirectory.trim()) void handleAddDirectory(); }}
            />
            <Button size="sm" className="h-8" onClick={() => void handleAddDirectory()} disabled={dirsBusy || !newDirectory.trim()}>
              {t("permissionsTab.addButton")}
            </Button>
          </div>
          {pendingDirectoryWarning && pendingDirectoryWarning.path === newDirectory.trim() && (
            <div
              data-testid="directory-warning-confirmation"
              className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[12px] text-warning"
            >
              <p className="font-medium">{t("permissionsTab.directoryWarningTitle")}</p>
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
                  {t("permissionsTab.directoryWarningConfirmButton")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setPendingDirectoryWarning(null)}
                  disabled={dirsBusy}
                >
                  {t("permissionsTab.cancelButton")}
                </Button>
              </div>
            </div>
          )}
        </SettingsSection>

        {/* ── 사용자 승인 기록 ── */}
        <SettingsSection
          title={t("permissionsTab.approvalsTitle", { count: userApprovals.length })}
          description={t("permissionsTab.approvalsDescription")}
          actions={
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-3 text-[12px]"
              onClick={() => void fetchApprovals()}
              disabled={approvalsBusy}
            >
              {t("permissionsTab.refreshButton")}
            </Button>
          }
        >
          {userApprovals.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("permissionsTab.approvalsEmpty")}</p>
          ) : (
            <div className="overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.approvalsColTool")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.approvalsColScope")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.approvalsColRisk")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.approvalsColApprovedAt")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.approvalsColReason")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.approvalsColAction")}</th>
                  </tr>
                </thead>
                <tbody>
                  {userApprovals.map((a) => (
                    <tr key={a.key} className="border-b last:border-0">
                      <td className="max-w-[120px] truncate px-3 py-2 font-mono">
                        {a.toolName ?? a.key.slice(0, 12)}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${a.scope === "persistent" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground"}`}>
                          {a.scope === "persistent" ? t("permissionsTab.scopePersistent") : t("permissionsTab.scopeSession")}
                        </span>
                      </td>
                      <td className="px-3 py-2">{a.verdictAtApproval.toUpperCase()}{a.verdictAtApproval === "high" ? t("permissionsTab.verdictHighFixed") : ""}</td>
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
                          {t("permissionsTab.revokeButton")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SettingsSection>

        {/* ── Audit Log ── */}
        <SettingsSection
          title={t("permissionsTab.auditLogTitle")}
          description={t("permissionsTab.auditLogDescription")}
          actions={
            <Button size="sm" variant="outline" className="h-8 px-3 text-[12px]" onClick={() => setAuditOpen(true)}>
              {t("permissionsTab.auditLogOpenButton")}
            </Button>
          }
        >
          <p className="text-[11px] text-muted-foreground">{t("permissionsTab.auditLogHelp")}</p>
        </SettingsSection>

      </div>
      <AuditPanel open={auditOpen} onClose={() => setAuditOpen(false)} />
    </div>
  );
}

function formatPermissionDirArg(path: string): string {
  return /[\s"']|^-/.test(path) ? JSON.stringify(path) : path;
}
