import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getApi, toViewKey } from "../api-client.js";
import { extractPluginAuthErrorCode } from "../utils/plugin-auth-error.js";
import type { useTranslation } from "../../../i18n/react.js";
import type { AppMode } from "../MainToolbar.js";
import type { usePluginMarketplace } from "./use-plugin-marketplace.js";
import type { usePluginAuthStatuses } from "./use-plugin-auth-status.js";
import type { useChatState } from "./use-chat-state.js";
import type { useStatusBar } from "./use-status-bar.js";

type Api = ReturnType<typeof getApi>;
type TFn = ReturnType<typeof useTranslation>["t"];
type PluginMarketplace = ReturnType<typeof usePluginMarketplace>;
type PluginViews = PluginMarketplace["pluginViews"];
type PluginCards = PluginMarketplace["pluginCards"];
type PluginView = PluginViews[number];
type PluginAuthStatuses = ReturnType<typeof usePluginAuthStatuses>["statuses"];
type RefreshPluginAuthStatus = ReturnType<typeof usePluginAuthStatuses>["refresh"];
type SetErrorWithThought = ReturnType<typeof useChatState>["setErrorWithThought"];
type PushToast = ReturnType<typeof useStatusBar>["pushToast"];

export interface UsePluginViewRoutingDeps {
  api: Api;
  t: TFn;
  appMode: AppMode;
  activeView: string;
  setActiveView: Dispatch<SetStateAction<string>>;
  pluginViews: PluginViews;
  pluginCards: PluginCards;
  pluginAuthStatuses: PluginAuthStatuses;
  refreshPluginAuthStatus: RefreshPluginAuthStatus;
  setErrorWithThought: SetErrorWithThought;
  statusPushToast: PushToast;
}

export interface UsePluginViewRoutingResult {
  handleViewSelect: (key: string) => void;
  activePluginView: PluginView | undefined;
  activePluginAuthError: string | null;
}

/**
 * Plugin/built-in view routing + the host-managed plugin auth lifecycle,
 * extracted verbatim from App.tsx as ONE unit (guarded by AppPluginAuth.test).
 *
 * Owns the plugin-auth gate refs (the inline pending-open map, the loginTool
 * in-flight guard, the failed-open set) PLUS the action in-flight guard and the
 * `pluginAuthErrors` map. `handleViewSelect` is the sole mutator; the two drain
 * effects (auth-transition → open deferred panel; authed → clear stale error)
 * plus the uninstalled-plugin fallback effect consume that state. Moving the
 * refs and the drain effects together preserves the login-first / open-on-authed
 * contract (architecture.md §9.4a).
 *
 * Plugin views always open INLINE regardless of appMode (a selected plugin
 * panel stays in the chat panel, never a separate window). appMode still drives
 * detachment for the app's own built-in tabs (work-board/routines/…), which this
 * hook reads but never changes.
 */
export function usePluginViewRouting({
  api,
  t,
  appMode,
  activeView,
  setActiveView,
  pluginViews,
  pluginCards,
  pluginAuthStatuses,
  refreshPluginAuthStatus,
  setErrorWithThought,
  statusPushToast,
}: UsePluginViewRoutingDeps): UsePluginViewRoutingResult {
  // Detached auth gate — plugins awaiting an unauthed→authed transition before
  // their detached panel opens. Keyed by pluginId → the detached view key to
  // open once `manifest.auth` status flips to `authed`. Populated by
  // handleViewSelect when a detached auth plugin is selected while unauthed
  // (the host fires loginTool to open the SSO window, NOT the panel); drained
  // by the auth-transition effect below. See architecture.md §9.4a.
  const pendingInlineAuthOpenRef = useRef<Map<string, string>>(new Map());
  const pluginAuthLoginInflightRef = useRef<Set<string>>(new Set());
  const failedPluginAuthOpenRef = useRef<Set<string>>(new Set());

  const [pluginAuthErrors, setPluginAuthErrors] = useState<Map<string, string>>(new Map());

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);
  const activePluginAuthError = activePluginView ? pluginAuthErrors.get(activePluginView.pluginId) ?? null : null;

  const openDetachedBuiltInView = useCallback(
    async (viewKey: "work-board" | "routines" | "memory" | "starred" | "insights"): Promise<boolean> => {
      const openDetached = api.window?.openDetached;
      if (!openDetached) {
        setErrorWithThought(t("app.errorCannotOpenNewWindow"));
        return false;
      }
      const result = await openDetached(viewKey);
      if (!result.ok) {
        console.warn(`[window] detached built-in view ${viewKey} did not open`, result.error);
        setErrorWithThought(t("app.errorCannotOpenNewWindowDetail", { error: result.error }));
        return false;
      }
      return true;
    },
    [api, setErrorWithThought],
  );

  const clearPluginAuthError = useCallback((pluginId: string) => {
    setPluginAuthErrors((prev) => {
      if (!prev.has(pluginId)) return prev;
      const next = new Map(prev);
      next.delete(pluginId);
      return next;
    });
  }, []);

  const formatPluginAuthLoginError = useCallback(
    (err: unknown): string => {
      const code = extractPluginAuthErrorCode(err);
      const detail =
        code === "non-corp-network"
          ? t("app.pluginAuthLoginFailedNonCorpNetwork")
          : t("app.pluginAuthLoginFailedGeneric");
      return code
        ? t("app.pluginAuthLoginFailedWithCode", { code, detail })
        : t("app.pluginAuthLoginFailedNoCode", { detail });
    },
    [t],
  );

  // Plugin views ALWAYS render inline in the chat panel — selecting one
  // switches the main window's active view in every appMode (the meeting panel
  // and every other plugin view stay alongside the conversation instead of
  // popping into a separate window). This is the default and only behavior for
  // plugin views; there is no per-view detach declaration. (Built-in detachable
  // views like work-board still detach in chat mode — see below — because they
  // are the app's own KakaoTalk-style tabs, not plugins.)
  //
  // Auth is a HOST-managed lifecycle (architecture.md §9.4a): the agent never
  // calls login/logout, and auth plugin view selection is login-first and
  // host-generic off `manifest.auth`. Selecting an auth plugin view:
  //   • authed   → open the plugin panel/page.
  //   • not authed → call loginTool via callPluginMethod (opens the SSO
  //     window), record a pending open, and open the panel/page when the
  //     plugin's status transitions to authed.
  //   • login failure → still open the plugin panel/page and surface a
  //     sanitized error code so the failure is not silent.
  // Plugins WITHOUT `manifest.auth.loginTool` open directly.
  const handleViewSelect = useCallback(
    (key: string) => {
      if (key.startsWith("plugin:")) {
        const view = pluginViews.find((v) => toViewKey(v) === key);
        if (!view) return;
        const card = pluginCards.find((c) => c.id === view.pluginId);
        const loginTool = card?.auth?.loginTool;
        const authState = pluginAuthStatuses.get(view.pluginId)?.kind;
        const openPluginView = () => {
          // Always inline, regardless of appMode.
          setActiveView(key);
        };

        if (!loginTool || authState === "authed") {
          clearPluginAuthError(view.pluginId);
          failedPluginAuthOpenRef.current.delete(view.pluginId);
          openPluginView();
          return;
        }

        pendingInlineAuthOpenRef.current.set(view.pluginId, key);
        clearPluginAuthError(view.pluginId);
        failedPluginAuthOpenRef.current.delete(view.pluginId);

        const inflightKey = `${view.pluginId}:${loginTool}`;
        if (pluginAuthLoginInflightRef.current.has(inflightKey)) {
          return;
        }
        pluginAuthLoginInflightRef.current.add(inflightKey);
        void (async () => {
          try {
            await api.callPluginMethod(loginTool, undefined, { userAction: true });
            refreshPluginAuthStatus(view.pluginId);
          } catch (err) {
            // Raw err.message may carry OAuth/Bearer fragments — keep raw in
            // console only, and surface a sanitized code-oriented message.
            console.warn(
              `[plugin-auth] ${view.pluginId} loginTool '${loginTool}' failed`,
              err,
            );
            pendingInlineAuthOpenRef.current.delete(view.pluginId);
            failedPluginAuthOpenRef.current.add(view.pluginId);
            const message = formatPluginAuthLoginError(err);
            setPluginAuthErrors((prev) => {
              const next = new Map(prev);
              next.set(view.pluginId, message);
              return next;
            });
            statusPushToast({ severity: "error", message, ttlMs: 10000 });
          } finally {
            pluginAuthLoginInflightRef.current.delete(inflightKey);
          }
        })();
        return;
      }
      // Chat mode: built-in detachable views open in a separate window; home
      // (and every work-mode path) stays inline.
      if (
        appMode === "chat" &&
        (key === "work-board" ||
          key === "routines" ||
          key === "memory" ||
          key === "starred" ||
          key === "insights")
      ) {
        void openDetachedBuiltInView(key);
        return;
      }
      setActiveView(key);
    },
    [
      api,
      appMode,
      pluginViews,
      pluginCards,
      pluginAuthStatuses,
      openDetachedBuiltInView,
      setErrorWithThought,
      refreshPluginAuthStatus,
      clearPluginAuthError,
      formatPluginAuthLoginError,
      statusPushToast,
    ],
  );

  // Auth gate drain — when a plugin the user selected while unauthed
  // transitions to authed (the usePluginAuthStatuses hook updates the map on
  // `${id}.auth.changed` or a manual refresh), open the panel/page that was
  // deferred. Only authed opens; an `error` status clears the pending entry
  // without silently navigating.
  useEffect(() => {
    if (pendingInlineAuthOpenRef.current.size === 0) return;
    for (const [pluginId, viewKey] of [...pendingInlineAuthOpenRef.current]) {
      if (failedPluginAuthOpenRef.current.has(pluginId)) {
        pendingInlineAuthOpenRef.current.delete(pluginId);
        continue;
      }
      const kind = pluginAuthStatuses.get(pluginId)?.kind;
      if (kind === "authed") {
        pendingInlineAuthOpenRef.current.delete(pluginId);
        setActiveView(viewKey);
      } else if (kind === "error") {
        pendingInlineAuthOpenRef.current.delete(pluginId);
      }
    }
  }, [pluginAuthStatuses, setActiveView]);

  useEffect(() => {
    setPluginAuthErrors((prev) => {
      let next: Map<string, string> | null = null;
      for (const pluginId of prev.keys()) {
        if (pluginAuthStatuses.get(pluginId)?.kind === "authed") {
          next ??= new Map(prev);
          next.delete(pluginId);
          failedPluginAuthOpenRef.current.delete(pluginId);
        }
      }
      return next ?? prev;
    });
  }, [pluginAuthStatuses]);

  // If the currently-open plugin view belongs to a plugin that just got
  // uninstalled, fall back to home so the renderer doesn't render a "view
  // not found" placeholder for a stale plugin id.
  useEffect(() => {
    if (!activeView.startsWith("plugin:")) return;
    if (activePluginView) return;
    setActiveView("home");
  }, [activeView, activePluginView, setActiveView]);

  return { handleViewSelect, activePluginView, activePluginAuthError };
}
