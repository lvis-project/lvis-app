import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import type { PluginAuthState } from "../hooks/use-plugin-auth-status.js";
import type { LvisApi, PluginAuthSummary } from "../types.js";

interface PluginAuthSectionProps {
  api: LvisApi;
  pluginId: string;
  pluginName: string;
  auth: PluginAuthSummary;
  state: PluginAuthState;
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
  onRefresh,
}: PluginAuthSectionProps) {
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
      await api.callPluginMethod(auth.loginTool);
      onRefresh();
    } catch (err) {
      // Generic user-facing copy + log raw error to the console for support
      // triage. Avoids leaking IPC reject internals (e.g.
      // "Method 'x' is not UI-callable for plugin 'y'") into the badge UI.
      console.error(`[plugin-auth] ${pluginId} loginTool ${auth.loginTool} failed`, err);
      setLocalError("로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setWorking(false);
    }
  }, [api, auth.loginTool, onRefresh, pluginId]);

  const handleLogout = useCallback(async () => {
    if (!auth.logoutTool) return;
    setLocalError(null);
    setWorking(true);
    try {
      await api.callPluginMethod(auth.logoutTool);
      onRefresh();
    } catch (err) {
      console.error(`[plugin-auth] ${pluginId} logoutTool ${auth.logoutTool} failed`, err);
      setLocalError("로그아웃에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setWorking(false);
    }
  }, [api, auth.logoutTool, onRefresh, pluginId]);

  const label = auth.label?.trim() || pluginName;

  return (
    <div className="space-y-1" data-testid={`plugin-auth-section-${pluginId}`}>
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">인증</p>
      <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {renderBadge(state)}
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
                {working ? "처리 중…" : "로그아웃"}
              </Button>
            ) : (
              <span
                className="text-[10px] text-muted-foreground"
                data-testid={`plugin-auth-logout-hint-${pluginId}`}
              >
                로그아웃은 플러그인 화면에서
              </span>
            )
          ) : state.kind === "loading" ? (
            <span className="text-[10px] text-muted-foreground">확인 중…</span>
          ) : (
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs"
              onClick={() => void handleLogin()}
              disabled={working}
              data-testid={`plugin-auth-login-${pluginId}`}
            >
              {working ? "로그인 중…" : "로그인"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function renderBadge(state: PluginAuthState) {
  if (state.kind === "authed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-100 px-1.5 py-px text-[10px] font-medium text-green-700">
        ✓ 인증됨
      </span>
    );
  }
  if (state.kind === "unauthed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-100 px-1.5 py-px text-[10px] font-medium text-red-700">
        🔒 미인증
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-700">
        ⚠ 오류
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
      …
    </span>
  );
}
