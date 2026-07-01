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
 * Owns the four plugin-auth gate refs (pendingDetached/pendingInline pending-open
 * maps, the loginTool in-flight guard, the failed-open set) PLUS the action
 * in-flight guard and the `pluginAuthErrors` map. `handleViewSelect` is the sole
 * mutator; the two drain effects (auth-transition → open deferred panel;
 * authed → clear stale error) plus the uninstalled-plugin fallback effect
 * consume that state. Moving the refs and the drain effects together preserves
 * the login-first / open-on-authed contract (architecture.md §9.4a).
 *
 * appMode is the SOLE authority for inline-vs-detached; this hook never changes
 * it, only reads it.
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
  // In-flight guard for kind="action" plugin-panel dispatches — keyed by
  // `${pluginId}:${tool}`. Prevents duplicate fires from rapid double-clicks
  // when no panel transition is visible to throttle the user naturally.
  const pluginActionInflightRef = useRef<Set<string>>(new Set());
  // Detached auth gate — plugins awaiting an unauthed→authed transition before
  // their detached panel opens. Keyed by pluginId → the detached view key to
  // open once `manifest.auth` status flips to `authed`. Populated by
  // handleViewSelect when a detached auth plugin is selected while unauthed
  // (the host fires loginTool to open the SSO window, NOT the panel); drained
  // by the auth-transition effect below. See architecture.md §9.4a.
  const pendingDetachedAuthOpenRef = useRef<Map<string, string>>(new Map());
  const pendingInlineAuthOpenRef = useRef<Map<string, string>>(new Map());
  const pluginAuthLoginInflightRef = useRef<Set<string>>(new Set());
  const failedPluginAuthOpenRef = useRef<Set<string>>(new Set());

  const [pluginAuthErrors, setPluginAuthErrors] = useState<Map<string, string>>(new Map());

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);
  const activePluginAuthError = activePluginView ? pluginAuthErrors.get(activePluginView.pluginId) ?? null : null;

  const openDetachedPluginView = useCallback(
    async (viewKey: string): Promise<boolean> => {
      const openDetached = api.window?.openDetached;
      if (!openDetached) {
        setErrorWithThought(t("app.errorCannotOpenPluginWindow"));
        return false;
      }
      const result = await openDetached(viewKey);
      if (!result.ok) {
        console.warn(`[plugin-ui] detached plugin view ${viewKey} did not open`, result.error);
        setErrorWithThought(t("app.errorCannotOpenPluginWindowDetail", { error: result.error }));
        return false;
      }
      return true;
    },
    [api, setErrorWithThought],
  );

  const openDetachedBuiltInView = useCallback(
    async (viewKey: "work-board" | "routines" | "memory" | "starred"): Promise<boolean> => {
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

  // In chat mode (appMode === "chat"), selecting a plugin view opens a
  // separate magnetic-snap BrowserWindow instead of switching the main
  // window's active view. The app's mode is the sole authority for this;
  // plugins do not get a say.
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
        // kind="action" entries never open a panel/window — host directly
        // dispatches the declared tool. uiCallable allowlist is enforced
        // downstream in runtime/index.ts:callFromUi. Active view state is
        // intentionally NOT changed so the user stays on whatever they
        // were looking at (chat / settings / etc.). slot==="sidebar" 는
        // (현재 schema 키 — 사용자에게는 "플러그인 패널") 강제하지만
        // future enum 확장 시 defense-in-depth.
        if (view.extension.kind === "action" && view.extension.slot === "sidebar") {
          const actionTool = view.extension.tool;
          if (typeof actionTool !== "string" || actionTool.length === 0) {
            console.warn(
              `[plugin-action] ${view.pluginId} extension ${view.extension.id} has kind="action" but no tool field — manifest validation should have caught this`,
            );
            return;
          }
          // In-flight guard: 사용자가 동일 action 아이콘을 빠르게 N번 클릭하면
          // N번 동시 디스패치 surface 가 열림 (mutating tool 일 때 실해). per
          // (pluginId, tool) 단위로 in-flight 추적해 진행 중이면 swallow.
          const inflightKey = `${view.pluginId}:${actionTool}`;
          if (pluginActionInflightRef.current.has(inflightKey)) {
            return;
          }
          pluginActionInflightRef.current.add(inflightKey);
          void (async () => {
            try {
              await api.callPluginMethod(actionTool);
            } catch (err) {
              // Raw err.message 는 OAuth refresh-token / Bearer header fragment
              // 가 포함될 수 있어 사용자 chat 영역에 그대로 노출하지 않는다.
              // 진단용 raw 는 console.warn 으로만 보존.
              console.warn(
                `[plugin-action] ${view.pluginId} tool '${actionTool}' failed`,
                err,
              );
              setErrorWithThought(t("app.errorCannotRunPluginAction"));
            } finally {
              pluginActionInflightRef.current.delete(inflightKey);
            }
          })();
          return;
        }
        const card = pluginCards.find((c) => c.id === view.pluginId);
        const loginTool = card?.auth?.loginTool;
        const authState = pluginAuthStatuses.get(view.pluginId)?.kind;
        const openPluginView = () => {
          if (appMode === "chat") {
            void openDetachedPluginView(key);
          } else {
            setActiveView(key);
          }
        };

        // appMode is the SOLE authority for inline-vs-detached. Work keeps
        // plugin views inline; chat pops plugin views into detached windows.
        if (!loginTool || authState === "authed") {
          clearPluginAuthError(view.pluginId);
          failedPluginAuthOpenRef.current.delete(view.pluginId);
          openPluginView();
          return;
        }

        const pendingMap =
          appMode === "chat"
            ? pendingDetachedAuthOpenRef.current
            : pendingInlineAuthOpenRef.current;
        pendingMap.set(view.pluginId, key);
        clearPluginAuthError(view.pluginId);
        failedPluginAuthOpenRef.current.delete(view.pluginId);

        const inflightKey = `${view.pluginId}:${loginTool}`;
        if (pluginAuthLoginInflightRef.current.has(inflightKey)) {
          return;
        }
        pluginAuthLoginInflightRef.current.add(inflightKey);
        void (async () => {
          try {
            await api.callPluginMethod(loginTool);
            refreshPluginAuthStatus(view.pluginId);
          } catch (err) {
            // Raw err.message may carry OAuth/Bearer fragments — keep raw in
            // console only, and surface a sanitized code-oriented message.
            console.warn(
              `[plugin-auth] ${view.pluginId} loginTool '${loginTool}' failed`,
              err,
            );
            pendingMap.delete(view.pluginId);
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
          key === "starred")
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
      openDetachedPluginView,
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
    if (
      pendingDetachedAuthOpenRef.current.size === 0 &&
      pendingInlineAuthOpenRef.current.size === 0
    ) return;
    for (const [pluginId, viewKey] of [...pendingDetachedAuthOpenRef.current]) {
      if (failedPluginAuthOpenRef.current.has(pluginId)) {
        pendingDetachedAuthOpenRef.current.delete(pluginId);
        continue;
      }
      const kind = pluginAuthStatuses.get(pluginId)?.kind;
      if (kind === "authed") {
        pendingDetachedAuthOpenRef.current.delete(pluginId);
        void openDetachedPluginView(viewKey);
      } else if (kind === "error") {
        pendingDetachedAuthOpenRef.current.delete(pluginId);
      }
    }
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
  }, [pluginAuthStatuses, openDetachedPluginView, setActiveView]);

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
