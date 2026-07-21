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
import type { UserApprovalScope, UserApprovalVerdict } from "../../../shared/permissions-events.js";
import { EXEC_MODE_OPTIONS, LONG_TOAST_TTL_MS } from "../constants.js";
import { formatIpcError } from "../format-ipc-error.js";
import type {
  ExecMode,
  HookTrustRow,
  PermissionReviewerMode,
  PermissionReviewerInteractiveAutoApprove,
  PermissionReviewerSettings,
  PermissionRule,
} from "../types.js";
import type {
  SandboxCapabilityInfo,
  SandboxWindowsStatusInfo,
} from "../../../shared/sandbox-capability-info.js";
import { PERMISSION_REVIEWER_FRAMEWORK } from "../../../shared/permission-reviewer-framework.js";
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

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);


  const [banner, setBanner] = useState<{ type: "error" | "warn"; msg: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showBanner = useCallback((type: "error" | "warn", msg: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ type, msg });
    bannerTimerRef.current = setTimeout(() => setBanner(null), LONG_TOAST_TTL_MS);
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

  // ── OS Tool Sandbox ───────────────────────────────
  const [sandboxCapability, setSandboxCapability] = useState<SandboxCapabilityInfo | null>(null);
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  // Windows srt-win repair flow (the OS sandbox is normally provisioned at
  // app-install time; this panel is the re-provision/repair fallback).
  // `windowsStatus` holds the latest readiness snapshot once the user opts in on
  // win32; the panel renders off it. `windowsInstallBusy` disables the
  // "Re-provision" button while the UAC prompt is in flight.
  // `windowsInstallCancelled` shows the cancelled banner after a UAC dismissal.
  const [windowsStatus, setWindowsStatus] = useState<SandboxWindowsStatusInfo | null>(null);
  const [windowsInstallBusy, setWindowsInstallBusy] = useState(false);
  const [windowsInstallCancelled, setWindowsInstallCancelled] = useState(false);


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
      setSandboxCapability(sandboxRes);
      const osSandboxOn = settingsRes.features?.osToolSandbox ?? false;
      setSandboxEnabled(osSandboxOn);
      // On win32 with the setting already ON, surface the consent/setup state
      // on tab entry so the panel persists across navigations until ready.
      if (sandboxRes.platform === "win32" && osSandboxOn) {
        setWindowsStatus(await window.lvis.permission.sandboxWindowsStatus());
      } else {
        setWindowsStatus(null);
      }
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

  useEffect(() => {
    const unsubscribe = window.lvis?.permission?.onModeChanged?.((nextMode) => {
      setMode((nextMode as ExecMode) ?? "default");
      void fetchAll();
    });
    return () => {
      unsubscribe?.();
    };
  }, [fetchAll]);

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
  ): PermissionReviewerInteractiveAutoApprove => (m === "auto" ? "medium" : "off");

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
      showBanner("error", t("permissionsTab.errorModeChangeError", { message: (e as Error).message }));
    } finally {
      setModeBusy(false);
    }
  };

  const handleInteractiveAutoApproveChange = async (
    value: PermissionReviewerInteractiveAutoApprove,
  ) => {
    if (modeBusy || reviewer.interactive.autoApprove === value) return;
    setModeBusy(true);
    try {
      const result = await window.lvis.permission.reviewerDispatch(`interactive ${value}`);
      if (result.ok) {
        setReviewer(result.settings);
      } else {
        showBanner("error", formatReviewerDispatchError(result.error));
      }
    } catch (error) {
      showBanner(
        "error",
        t("permissionsTab.errorModeChangeError", { message: (error as Error).message }),
      );
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
    // Clear any stale "Install cancelled" banner whenever the toggle moves.
    setWindowsInstallCancelled(false);
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
      // Windows: enabling the setting alone does NOT confine anything — srt-win
      // must be provisioned (normally at app-install time via NSIS customInstall).
      // When the user flips the toggle ON on win32, fetch the readiness snapshot;
      // if provisioning did not complete, the panel guides the (explicit,
      // non-auto) re-provision/repair. Turning OFF clears the panel.
      if (capability.platform === "win32") {
        if (next) {
          const status = await window.lvis.permission.sandboxWindowsStatus();
          setWindowsStatus(status);
        } else {
          setWindowsStatus(null);
        }
      }
    } catch (e) {
      setSandboxEnabled(!next);
      showBanner("error", t("permissionsTab.osSandboxToggleError", { message: (e as Error).message }));
    } finally {
      setSandboxBusy(false);
    }
  };

  // The ONLY user-consented privilege-escalation trigger. The OS sandbox is
  // normally provisioned at app-install time (NSIS customInstall), so this is
  // the manual REPAIR / re-provision path — invoked from an explicit
  // "Re-provision" click inside the win32 panel, never automatically. Triggers
  // ASRT's single self-elevating UAC prompt.
  const handleWindowsInstall = async () => {
    if (windowsInstallBusy) return;
    setWindowsInstallBusy(true);
    setWindowsInstallCancelled(false);
    try {
      const result = await window.lvis.permission.sandboxWindowsInstall();
      if (result.cancelled) {
        // UAC dismissed — not an error. Keep the user's opt-in setting ON so
        // the Windows consent panel remains visible and they can retry instead
        // of seeing the toggle immediately snap back off.
        setWindowsInstallCancelled(true);
        setWindowsStatus(await window.lvis.permission.sandboxWindowsStatus());
        return;
      }
      // Defensive: an error shape from the IPC (install threw or returned ok:false).
      // Keep the user's opt-in setting ON and leave the consent panel available
      // so a transient installer failure can be retried without re-enabling the
      // setting first.
      if ("ok" in result && result.ok === false) {
        setWindowsStatus(await window.lvis.permission.sandboxWindowsStatus());
        const detail = (result as { ok: false; message?: string; error?: string }).message
          ?? (result as { ok: false; message?: string; error?: string }).error
          ?? "unknown error";
        showBanner("error", t("permissionsTab.osSandboxWindowsInstallError", { message: detail }));
        return;
      }
      // Install ran — refresh the readiness snapshot so the panel advances to
      // the ready or setup-status state (verbatim instructions still drive the copy).
      const status = await window.lvis.permission.sandboxWindowsStatus();
      setWindowsStatus(status);
    } catch (e) {
      showBanner("error", t("permissionsTab.osSandboxWindowsInstallError", { message: (e as Error).message }));
    } finally {
      setWindowsInstallBusy(false);
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

  const sandboxPotentialReason = sandboxCapability?.potentialReason ?? sandboxCapability?.reason ?? "";
  const sandboxRuntimeReason = sandboxCapability?.runtime?.reason ?? "";

  return (
    <div className="pr-1">
      <div className="space-y-6">
        <SettingsPageHeader
          title={t("permissionsTab.pageTitle")}
          description={t("permissionsTab.pageDescription")}
        />

        {/* ── 인라인 배너 (§F9 — alert 대체) ── */}
        {banner && (
          <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${banner.type === "error" ? "border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) text-destructive" : "border-warning/(--opacity-medium) bg-warning/(--opacity-soft) text-warning"}`}>
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
            className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[12px] text-warning"
          >
            <div className="flex items-start gap-2">
              <Badge variant="secondary" className="mt-0.5 text-[10px] text-warning">
                {t("permissionsTab.hookQuarantineBadge", { count: quarantinedHooks.length })}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t("permissionsTab.hookQuarantineTitle")}</p>
                <p className="mt-1 text-[11px]">
                  {t("permissionsTab.hookQuarantineInstructionBefore")}<code className="rounded bg-background/(--opacity-stronger) px-1 font-mono">/permission hooks list</code>{t("permissionsTab.hookQuarantineInstructionAfter")}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {quarantinedHooks.slice(0, 3).map((hook) => (
                    <code key={hook.fileName} className="rounded border border-warning/(--opacity-medium) bg-background/(--opacity-stronger) px-1.5 py-0.5 font-mono text-[10px]">
                      {hook.fileName}
                    </code>
                  ))}
                  {quarantinedHooks.length > 3 && (
                    <span className="text-[10px] text-warning/(--opacity-intense)">
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
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">{t("permissionsTab.summaryPolicyPreset")}</p>
              <p className="mt-1 text-sm font-medium">{EXEC_MODE_OPTIONS.find((opt) => opt.value === mode)?.label ?? mode}</p>
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
                className={`flex h-auto min-w-0 w-full cursor-pointer items-start justify-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm font-normal ${mode === opt.value ? "border-primary bg-primary/(--opacity-subtle) hover:bg-primary/(--opacity-subtle)" : "border-muted hover:border-muted-foreground/(--opacity-medium)"}`}
              >
                <RadioGroupItem
                  id={`exec-mode-${opt.value}-radio`}
                  value={opt.value}
                  aria-label={opt.label}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{opt.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{opt.description}</span>
                  {opt.value === "auto" && mode === "auto" && (
                    <>
                      <span
                        className="mt-2 flex min-w-0 flex-col gap-2 rounded-md border bg-background/(--opacity-stronger) px-3 py-2"
                        data-testid="interactive-auto-approve-control"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] font-semibold">
                            {t("permissionsTab.interactiveAutoApproveLabel")}
                          </span>
                          <span className="block text-[10px] text-muted-foreground">
                            {reviewer.interactive.autoApprove === "medium"
                              ? t("permissionsTab.interactiveMediumDescription")
                              : reviewer.interactive.autoApprove === "low"
                                ? t("permissionsTab.interactiveLowDescription")
                                : t("permissionsTab.interactiveOffDescription")}
                          </span>
                        </span>
                        <Select
                          value={reviewer.interactive.autoApprove}
                          disabled={modeBusy}
                          onValueChange={(value) =>
                            void handleInteractiveAutoApproveChange(
                              value as PermissionReviewerInteractiveAutoApprove,
                            )
                          }
                        >
                          <SelectTrigger
                            className="h-8 w-full text-[11px]"
                            data-testid="interactive-auto-approve-select"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="off">{t("permissionsTab.interactiveOffLabel")}</SelectItem>
                            <SelectItem value="low">{t("permissionsTab.interactiveLowLabel")}</SelectItem>
                            <SelectItem value="medium">
                              {t("permissionsTab.interactiveMediumLabel")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </span>
                      <details
                        className="mt-2 rounded-md border bg-muted/(--opacity-light)"
                        data-testid="reviewer-prompt-panel"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-muted-foreground">
                          {t("permissionsTab.frameworkSystemPromptTitle")}
                        </summary>
                        <pre
                          className="max-h-44 overflow-auto border-t px-3 py-3 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
                          data-testid="reviewer-system-prompt"
                        >
                          {PERMISSION_REVIEWER_FRAMEWORK.systemPrompt}
                        </pre>
                      </details>
                    </>
                  )}
                </span>
              </Label>
            ))}
          </RadioGroup>
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
            <p className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning">
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
              className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning"
            >
              {t("permissionsTab.osSandboxUnavailable", { platform: sandboxCapability.platform })}
            </p>
          ) : null}
          {sandboxCapability && sandboxCapability.available ? (
            <div className="space-y-1 rounded-md border bg-muted/(--opacity-light) px-3 py-2 text-[11px] text-muted-foreground">
              <p className="font-medium text-foreground">{t("permissionsTab.osSandboxCapabilityHeading")}</p>
              <p>
                {sandboxCapability.platform === "darwin"
                  ? t("permissionsTab.osSandboxCapabilityMac")
                  : sandboxCapability.platform === "linux"
                    ? t("permissionsTab.osSandboxCapabilityLinux")
                    : sandboxCapability.platform === "win32"
                      ? t("permissionsTab.osSandboxCapabilityWindows")
                      : t("permissionsTab.osSandboxCapabilityOther")}
              </p>
              <p className="italic">{t("permissionsTab.osSandboxRestartNote")}</p>
              {sandboxPotentialReason ? (
                <p data-testid="os-sandbox-potential-reason">
                  {t("permissionsTab.osSandboxPotentialReason", { reason: sandboxPotentialReason })}
                </p>
              ) : null}
              {sandboxRuntimeReason ? (
                <p data-testid="os-sandbox-runtime-reason">
                  {t("permissionsTab.osSandboxRuntimeReason", { reason: sandboxRuntimeReason })}
                </p>
              ) : null}
            </div>
          ) : null}
          {/* ── Windows srt-win consent flow ── */}
          {windowsInstallCancelled ? (
            <p
              data-testid="os-sandbox-windows-install-cancelled"
              className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning"
            >
              {t("permissionsTab.osSandboxWindowsInstallCancelled")}
            </p>
          ) : null}
          {sandboxEnabled && windowsStatus?.applicable && !windowsStatus.ready ? (
            windowsStatus.userState !== "absent" ||
            windowsStatus.wfpState !== "absent" ? (
              // Install partially ran or status cannot be fully read. Show the
              // verbatim ASRT instructions and keep the explicit retry action
              // available. ASRT 0.0.66 no longer requires Windows sign-out.
              <div
                data-testid="os-sandbox-windows-setup-status"
                className="space-y-2 rounded-md border border-info/(--opacity-medium) bg-info/(--opacity-soft) px-3 py-2 text-[11px] text-info"
              >
                <p className="font-medium">{t("permissionsTab.osSandboxWindowsReloginHeading")}</p>
                <p className="whitespace-pre-line font-mono text-foreground">{windowsStatus.instructions}</p>
                <p className="italic">{t("permissionsTab.osSandboxWindowsReloginPending")}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  data-testid="os-sandbox-windows-install"
                  disabled={windowsInstallBusy}
                  onClick={() => void handleWindowsInstall()}
                >
                  {windowsInstallBusy
                    ? t("permissionsTab.osSandboxWindowsInstalling")
                    : t("permissionsTab.osSandboxWindowsInstallButton")}
                </Button>
              </div>
            ) : (
              // Sandbox not ready (install-time provisioning was cancelled/failed
              // or the app was not installed via the NSIS installer). REPAIR
              // fallback: warning card + a "Re-provision" button. No auto-UAC —
              // the user must click.
              <div
                data-testid="os-sandbox-windows-consent"
                className="space-y-2 rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning"
              >
                <p className="font-medium">{t("permissionsTab.osSandboxWindowsConsentHeading")}</p>
                <p>{t("permissionsTab.osSandboxWindowsConsentBody")}</p>
                {windowsStatus.instructions ? (
                  <p className="whitespace-pre-line font-mono text-foreground">{windowsStatus.instructions}</p>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  data-testid="os-sandbox-windows-install"
                  disabled={windowsInstallBusy}
                  onClick={() => void handleWindowsInstall()}
                >
                  {windowsInstallBusy
                    ? t("permissionsTab.osSandboxWindowsInstalling")
                    : t("permissionsTab.osSandboxWindowsInstallButton")}
                </Button>
              </div>
            )
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
            <div className="min-w-0 overflow-x-auto rounded-md border">
              <table data-testid="permissions-rules-table" className="min-w-[560px] w-full table-fixed text-xs">
                <colgroup>
                  <col className="w-[44%]" />
                  <col className="w-[20%]" />
                  <col className="w-[26%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead>
                  <tr className="border-b bg-muted/(--opacity-medium)">
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">{t("permissionsTab.rulesColPattern")}</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">{t("permissionsTab.rulesColAction")}</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">{t("permissionsTab.rulesColSource")}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={`${r.pattern}:${r.action}:${i}`} className="border-b last:border-0 hover:bg-muted/(--opacity-light)">
                      <td className="px-3 py-1.5 font-mono">
                        <span className="block truncate" title={r.pattern}>{r.pattern}</span>
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge variant={r.action === "allow" ? "default" : "secondary"} className={`shrink-0 whitespace-nowrap text-[10px] ${r.action === "deny" ? "text-destructive" : ""}`}>
                          {r.action === "allow" ? t("permissionsTab.actionAllow") : t("permissionsTab.actionDeny")}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        <span className="block truncate" title={r.source ?? t("permissionsTab.sourceAll")}>
                          {r.source ?? t("permissionsTab.sourceAll")}
                        </span>
                      </td>
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
              data-testid="permissions-rule-pattern-input"
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
            <Button size="sm" className="h-8" data-testid="permissions-rule-add" onClick={() => void handleAddRule()} disabled={rulesBusy || !newPattern.trim()}>
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
                  <tr className="border-b bg-muted/(--opacity-medium)">
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.directoriesColPath")}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {directories.map((dir) => (
                    <tr key={dir} className="border-b last:border-0 hover:bg-muted/(--opacity-light)">
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
              className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[12px] text-warning"
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
            <div className="min-w-0 overflow-x-auto rounded-md border">
              <table data-testid="permissions-approvals-table" className="min-w-[720px] w-full text-xs">
                <thead className="border-b bg-muted/(--opacity-medium)">
                  <tr>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">{t("permissionsTab.approvalsColTool")}</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">{t("permissionsTab.approvalsColScope")}</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">{t("permissionsTab.approvalsColRisk")}</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">{t("permissionsTab.approvalsColApprovedAt")}</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">{t("permissionsTab.approvalsColReason")}</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap font-medium">{t("permissionsTab.approvalsColAction")}</th>
                  </tr>
                </thead>
                <tbody>
                  {userApprovals.map((a) => (
                    <tr key={a.key} className="border-b last:border-0">
                      <td className="max-w-[120px] truncate px-3 py-2 font-mono">
                        {a.toolName ?? a.key.slice(0, 12)}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex h-5 items-center whitespace-nowrap rounded px-1.5 text-[10px] font-medium ${a.scope === "persistent" ? "bg-warning/(--opacity-soft) text-warning" : "bg-muted text-muted-foreground"}`}>
                          {a.scope === "persistent" ? t("permissionsTab.scopePersistent") : t("permissionsTab.scopeSession")}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{a.verdictAtApproval.toUpperCase()}{a.verdictAtApproval === "high" ? t("permissionsTab.verdictHighFixed") : ""}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
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
