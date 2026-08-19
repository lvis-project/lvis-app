import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import type {
  CodexSubscriptionActionResult,
  CodexSubscriptionErrorCode,
  CodexSubscriptionStatus,
} from "../../../shared/codex-subscription.js";
import { useTranslation } from "../../../i18n/react.js";
import type { LvisApi } from "../types.js";
import { SettingsSection } from "../components/PageShell.js";

const STATUS_POLL_INTERVAL_MS = 1_500;

type BusyAction = "status" | "browser" | "device" | "cancel" | "logout" | "models" | null;

const ERROR_MESSAGE_KEYS: Record<CodexSubscriptionErrorCode, string> = {
  "codex-runtime-unavailable": "codexSubscriptionCard.errorRuntimeUnavailable",
  "codex-runtime-start-failed": "codexSubscriptionCard.errorRuntimeStartFailed",
  "codex-login-in-progress": "codexSubscriptionCard.errorLoginInProgress",
  "codex-login-failed": "codexSubscriptionCard.errorLoginFailed",
  "codex-operation-failed": "codexSubscriptionCard.errorOperationFailed",
};

export interface CodexSubscriptionCardProps {
  api: LvisApi;
}

/**
 * Connection-only UI for the isolated local Codex App Server.
 *
 * This deliberately does not change LVIS's API-key conversation provider. The
 * future Codex runtime must first bridge its tool approvals and audit events.
 */
export function CodexSubscriptionCard({ api }: CodexSubscriptionCardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CodexSubscriptionStatus | null>(null);
  const [models, setModels] = useState<Array<{
    id: string;
    displayName: string;
    isDefault: boolean;
  }>>([]);
  const [error, setError] = useState<CodexSubscriptionErrorCode | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);

  const applyStatus = useCallback((next: CodexSubscriptionStatus) => {
    setStatus(next);
    if (next.connection !== "connected") setModels([]);
  }, []);

  const applyActionResult = useCallback((result: CodexSubscriptionActionResult): boolean => {
    applyStatus(result.status);
    if (result.ok) {
      setError(null);
      return true;
    }
    setError(result.error);
    return false;
  }, [applyStatus]);

  const refreshStatus = useCallback(async (quiet = false) => {
    if (!quiet) setBusy("status");
    try {
      applyActionResult(await api.codexSubscriptionStatus());
    } catch {
      setError("codex-operation-failed");
    } finally {
      if (!quiet) setBusy(null);
    }
  }, [api, applyActionResult]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.connection !== "pending" || busy !== null) return;
    const timer = window.setInterval(() => {
      void refreshStatus(true);
    }, STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [busy, refreshStatus, status?.connection]);

  const startBrowserLogin = async () => {
    setBusy("browser");
    setError(null);
    setModels([]);
    try {
      applyActionResult(await api.codexSubscriptionStartBrowserLogin());
    } catch {
      setError("codex-operation-failed");
    } finally {
      setBusy(null);
    }
  };

  const startDeviceCodeLogin = async () => {
    setBusy("device");
    setError(null);
    setModels([]);
    try {
      const result = await api.codexSubscriptionStartDeviceCodeLogin();
      applyStatus(result.status);
      if (result.ok) {
        setError(null);
      } else {
        setError(result.error);
      }
    } catch {
      setError("codex-operation-failed");
    } finally {
      setBusy(null);
    }
  };

  const cancelLogin = async () => {
    setBusy("cancel");
    try {
      applyActionResult(await api.codexSubscriptionCancelLogin());
    } catch {
      setError("codex-operation-failed");
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    setBusy("logout");
    try {
      applyActionResult(await api.codexSubscriptionLogout());
    } catch {
      setError("codex-operation-failed");
    } finally {
      setBusy(null);
    }
  };

  const discoverModels = async () => {
    setBusy("models");
    setError(null);
    try {
      const result = await api.codexSubscriptionListModels();
      applyStatus(result.status);
      if (result.ok) {
        setModels(result.models);
      } else {
        setError(result.error);
      }
    } catch {
      setError("codex-operation-failed");
    } finally {
      setBusy(null);
    }
  };

  const unavailable = status?.runtime === "unavailable";
  const connected = !unavailable && status?.connection === "connected";
  const pending = !unavailable && status?.connection === "pending";
  const pendingDeviceCode = status?.pendingLogin === "device-code"
    ? status.pendingDeviceCode
    : null;
  const controlsDisabled = busy !== null || status === null;
  const statusLabel = status === null
    ? t("codexSubscriptionCard.statusChecking")
    : unavailable
      ? t("codexSubscriptionCard.statusUnavailable")
      : connected
        ? t("codexSubscriptionCard.statusConnected")
        : pending
          ? status.pendingLogin === "device-code"
            ? t("codexSubscriptionCard.statusDevicePending")
            : t("codexSubscriptionCard.statusBrowserPending")
          : t("codexSubscriptionCard.statusSignedOut");

  return (
    <SettingsSection
      title={t("codexSubscriptionCard.title")}
      description={t("codexSubscriptionCard.description")}
      id="codex-subscription"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card p-3">
          <div className="min-w-0 space-y-1" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={connected ? "default" : "secondary"}
                className={unavailable ? "bg-destructive text-destructive-foreground" : undefined}
              >
                {statusLabel}
              </Badge>
              {connected && status?.planType ? (
                <span className="text-xs text-muted-foreground">
                  {t("codexSubscriptionCard.planType", { planType: status.planType })}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("codexSubscriptionCard.isolatedRuntimeNotice")}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => void refreshStatus()}
            disabled={busy !== null}
            aria-label={t("codexSubscriptionCard.refreshStatus")}
          >
            {busy === "status" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          </Button>
        </div>

        {error ? (
          <p role="alert" className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive">
            {t(ERROR_MESSAGE_KEYS[error])}
          </p>
        ) : null}

        {pending && pendingDeviceCode ? (
          <div className="rounded-md border border-dashed p-3" aria-live="polite">
            <p className="text-xs font-medium">{t("codexSubscriptionCard.deviceCodeLabel")}</p>
            <code className="mt-1 block select-all break-all rounded bg-muted px-2 py-1 font-mono text-sm" data-testid="codex-subscription-device-code">
              {pendingDeviceCode}
            </code>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("codexSubscriptionCard.deviceCodeHint")}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {connected ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void discoverModels()}
                disabled={controlsDisabled}
              >
                {busy === "models" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                {busy === "models" ? t("codexSubscriptionCard.discoveringModels") : t("codexSubscriptionCard.discoverModels")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void logout()}
                disabled={controlsDisabled}
              >
                {busy === "logout" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                {busy === "logout" ? t("codexSubscriptionCard.signingOut") : t("codexSubscriptionCard.signOut")}
              </Button>
            </>
          ) : pending ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void cancelLogin()}
              disabled={controlsDisabled}
            >
              {busy === "cancel" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
              {busy === "cancel" ? t("codexSubscriptionCard.cancelling") : t("codexSubscriptionCard.cancel")}
            </Button>
          ) : !unavailable ? (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => void startBrowserLogin()}
                disabled={controlsDisabled}
              >
                {busy === "browser" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                {busy === "browser" ? t("codexSubscriptionCard.openingBrowser") : t("codexSubscriptionCard.signInBrowser")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void startDeviceCodeLogin()}
                disabled={controlsDisabled}
              >
                {busy === "device" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                {busy === "device" ? t("codexSubscriptionCard.startingDeviceCode") : t("codexSubscriptionCard.signInDeviceCode")}
              </Button>
            </>
          ) : null}
        </div>

        {connected ? (
          <div className="rounded-md border bg-muted/(--opacity-muted) p-3">
            <p className="text-xs text-muted-foreground">
              {t("codexSubscriptionCard.futureRuntimeNotice")}
            </p>
            {models.length > 0 ? (
              <ul className="mt-2 space-y-1" aria-label={t("codexSubscriptionCard.discoveredModels")}>
                {models.map((model) => (
                  <li key={model.id} className="flex min-w-0 items-center gap-2 text-xs">
                    <span className="min-w-0 truncate">{model.displayName}</span>
                    {model.isDefault ? (
                      <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                        {t("codexSubscriptionCard.defaultModel")}
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : busy !== "models" ? (
              <p className="mt-2 text-xs text-muted-foreground">{t("codexSubscriptionCard.modelsNotLoaded")}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
