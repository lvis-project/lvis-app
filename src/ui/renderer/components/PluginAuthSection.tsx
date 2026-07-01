import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type { PluginAuthState } from "../hooks/use-plugin-auth-status.js";
import type { LvisApi, PluginAuthSummary } from "../types.js";

function isOpenLoginUiFailure(result: unknown): result is { ok: false; error?: string } {
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
}

interface PluginAuthSectionProps {
  api: LvisApi;
  pluginId: string;
  pluginName: string;
  auth: PluginAuthSummary;
  state: PluginAuthState;
  /**
   * Optional opener for plugins whose login surface lives inside a declared
   * detached plugin UI. When present, the login button opens that UI instead
   * of invoking loginTool without the payload the plugin UI is meant to
   * collect.
   */
  onOpenLoginUi?: () => Promise<unknown> | unknown;
  /**
   * Called after a successful login/logout invocation. Owner is expected to
   * re-fetch the auth status — typically a thin wrapper around the
   * `usePluginAuthStatuses` hook's `refresh(pluginId)`. The plugin SHOULD
   * also emit `<pluginId>.auth.changed`; this callback ensures freshness
   * even if the event is dropped or fires before the IPC chain settles.
   */
  onRefresh: () => void;
}

export function PluginAuthSection({
  api,
  pluginId,
  pluginName,
  auth,
  state,
  onOpenLoginUi,
  onRefresh,
}: PluginAuthSectionProps) {
  const { t } = useTranslation();
  const [working, setWorking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Clear stale `localError` when the auth status transitions externally
  // (e.g. a `<pluginId>.auth.changed` event arrives after the user clicked
  // 로그인, the IPC rejected, but a parallel re-auth elsewhere succeeded).
  // Without this the error banner persists alongside the green ✓ 인증됨
  // badge, which contradicts the actual state.
  useEffect(() => {
    if (state.kind === "authed" && localError) setLocalError(null);
  }, [state.kind, localError]);

  const handleLogin = useCallback(async () => {
    setLocalError(null);
    setWorking(true);
    try {
      if (onOpenLoginUi) {
        const result = await onOpenLoginUi();
        if (isOpenLoginUiFailure(result)) {
          throw new Error(result.error?.trim() || "detached login window failed");
        }
      } else {
        await api.callPluginMethod(auth.loginTool);
        onRefresh();
      }
    } catch (err) {
      // Generic user-facing copy + log raw error to the console for support
      // triage. Avoids leaking IPC reject internals (e.g.
      // "Method 'x' is not declared as a UI action for plugin 'y'") into the badge UI.
      console.error(`[plugin-auth] ${pluginId} loginTool ${auth.loginTool} failed`, err);
      setLocalError(t("pluginAuthSection.loginError"));
    } finally {
      setWorking(false);
    }
  }, [api, auth.loginTool, onOpenLoginUi, onRefresh, pluginId, t]);

  const handleLogout = useCallback(async () => {
    if (!auth.logoutTool) return;
    setLocalError(null);
    setWorking(true);
    try {
      await api.callPluginMethod(auth.logoutTool);
      onRefresh();
    } catch (err) {
      console.error(`[plugin-auth] ${pluginId} logoutTool ${auth.logoutTool} failed`, err);
      setLocalError(t("pluginAuthSection.logoutError"));
    } finally {
      setWorking(false);
    }
  }, [api, auth.logoutTool, onRefresh, pluginId, t]);

  const label = auth.label?.trim() || pluginName;

  return (
    <div className="space-y-1" data-testid={`plugin-auth-section-${pluginId}`}>
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{t("pluginAuthSection.sectionHeading")}</p>
      <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/(--opacity-muted) px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {renderBadge(state, t)}
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{label}</p>
            {state.kind === "authed" && state.account && (
              <p className="truncate text-[10px] text-muted-foreground">{state.account}</p>
            )}
            {state.kind === "error" && (
              <p className="truncate text-[10px] text-destructive">{state.message}</p>
            )}
            {localError && state.kind !== "error" && (
              <p className="truncate text-[10px] text-destructive">{localError}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {state.kind === "authed" ? (
            auth.logoutTool ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => void handleLogout()}
                disabled={working}
                data-testid={`plugin-auth-logout-${pluginId}`}
              >
                {working ? t("pluginAuthSection.working") : t("pluginAuthSection.logoutButton")}
              </Button>
            ) : (
              <span
                className="text-[10px] text-muted-foreground"
                data-testid={`plugin-auth-logout-hint-${pluginId}`}
              >
                {t("pluginAuthSection.logoutHint")}
              </span>
            )
          ) : state.kind === "loading" ? (
            <span className="text-[10px] text-muted-foreground">{t("pluginAuthSection.checking")}</span>
          ) : (
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs"
              onClick={() => void handleLogin()}
              disabled={working}
              data-testid={`plugin-auth-login-${pluginId}`}
            >
              {working ? t("pluginAuthSection.loggingIn") : onOpenLoginUi ? t("pluginAuthSection.openLoginWindow") : t("pluginAuthSection.loginButton")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function renderBadge(state: PluginAuthState, t: (key: string) => string) {
  if (state.kind === "authed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/(--opacity-soft) px-1.5 py-px text-[10px] font-medium text-success">
        {t("pluginAuthSection.badgeAuthed")}
      </span>
    );
  }
  if (state.kind === "unauthed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/(--opacity-soft) px-1.5 py-px text-[10px] font-medium text-destructive">
        {t("pluginAuthSection.badgeUnauthed")}
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/(--opacity-soft) px-1.5 py-px text-[10px] font-medium text-warning">
        {t("pluginAuthSection.badgeError")}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
      …
    </span>
  );
}
