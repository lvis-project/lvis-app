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
import {
  parseInlineViewKey,
  type InlineViewKey,
  type PluginViewKey,
} from "../../../shared/view-key.js";
import { extractPluginAuthErrorCode } from "../utils/plugin-auth-error.js";
import type { useTranslation } from "../../../i18n/react.js";
import type { usePluginMarketplace } from "./use-plugin-marketplace.js";
import type { usePluginAuthStatuses } from "./use-plugin-auth-status.js";
import type { useStatusBar } from "./use-status-bar.js";

type Api = ReturnType<typeof getApi>;
type TFn = ReturnType<typeof useTranslation>["t"];
type PluginMarketplace = ReturnType<typeof usePluginMarketplace>;
type PluginViews = PluginMarketplace["pluginViews"];
type PluginCards = PluginMarketplace["pluginCards"];
type PluginView = PluginViews[number];
type PluginAuthStatuses = ReturnType<typeof usePluginAuthStatuses>["statuses"];
type RefreshPluginAuthStatus = ReturnType<typeof usePluginAuthStatuses>["refresh"];
type PushToast = ReturnType<typeof useStatusBar>["pushToast"];

export interface UsePluginViewRoutingDeps {
  api: Api;
  t: TFn;
  activeView: InlineViewKey;
  setActiveView: Dispatch<SetStateAction<InlineViewKey>>;
  pluginViews: PluginViews;
  pluginCards: PluginCards;
  pluginAuthStatuses: PluginAuthStatuses;
  refreshPluginAuthStatus: RefreshPluginAuthStatus;
  statusPushToast: PushToast;
}

export interface UsePluginViewRoutingResult {
  handleViewSelect: (key: string) => void;
  activePluginView: PluginView | undefined;
  /** The open plugin view's runtime is still starting — see the memo below. */
  activePluginPreparing: boolean;
  activePluginAuthError: string | null;
}

/**
 * Is this plugin still starting up?
 *
 * One reading of `loadStatus`, shared by the two places that ask: the
 * selection handler, which must not refuse a click on a preparing plugin's
 * row, and the fallback-to-home effect, which must not undo that navigation.
 */
function isPluginPreparing(cards: PluginCards, pluginId: string): boolean {
  return cards.some((card) => card.id === pluginId && card.loadStatus === "preparing");
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
 * Selecting a view ALWAYS renders it inline, for plugin views and the app's
 * own built-in tabs alike, in every appMode. Nothing here opens a window:
 * a mode is a layout, not a destination, and having one mode answer a
 * navigation click with a second window left the main window unable to say
 * where it was.
 */
export function usePluginViewRouting({
  api,
  t,
  activeView,
  setActiveView,
  pluginViews,
  pluginCards,
  pluginAuthStatuses,
  refreshPluginAuthStatus,
  statusPushToast,
}: UsePluginViewRoutingDeps): UsePluginViewRoutingResult {
  // Inline auth gate — plugins awaiting an unauthed→authed transition before
  // their inline panel is navigated to. Keyed by pluginId → the view key to
  // open (via setActiveView) once `manifest.auth` status flips to `authed`.
  // Populated by handleViewSelect when an auth plugin is selected while unauthed
  // (the host fires loginTool to open the SSO window, NOT the panel); drained
  // by the auth-transition effect below. See architecture.md §9.4a.
  const pendingInlineAuthOpenRef = useRef<Map<string, PluginViewKey>>(new Map());
  const pluginAuthLoginInflightRef = useRef<Set<string>>(new Set());
  const failedPluginAuthOpenRef = useRef<Set<string>>(new Set());

  const [pluginAuthErrors, setPluginAuthErrors] = useState<Map<string, string>>(new Map());

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);
  const activePluginAuthError = activePluginView ? pluginAuthErrors.get(activePluginView.pluginId) ?? null : null;
  /**
   * The open view names a plugin whose runtime has not finished starting, so
   * its view is not registered yet. The panel is a destination the user asked
   * for, not a missing one: the host shows its loading state, and the view
   * takes over the moment `pluginViews` gains it.
   */
  const activePluginPreparing = useMemo(() => {
    if (activePluginView) return false;
    const parsed = parseInlineViewKey(activeView);
    if (parsed?.kind !== "plugin") return false;
    return isPluginPreparing(pluginCards, parsed.pluginId);
  }, [activePluginView, activeView, pluginCards]);

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

  // Every view renders inline: selecting one switches the main window's active
  // view in every appMode. This is the default and only behavior, for plugin
  // views and built-in tabs alike, and there is no per-view detach
  // declaration to opt out of it.
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
      // The runtime boundary. Sidebar rows, the command palette, and
      // notification payloads all hand over a bare string; a value that is not
      // a place the main window can BE stops here instead of becoming
      // `activeView` and being rendered as a plugin view that does not exist.
      const parsed = parseInlineViewKey(key);
      if (!parsed) {
        console.warn(`[nav] ignoring unknown view key '${key}'`);
        return;
      }

      if (parsed.kind === "plugin") {
        const view = pluginViews.find((v) => toViewKey(v) === key);
        const card = pluginCards.find((c) => c.id === parsed.pluginId);
        // A plugin that is still preparing has a row in the picker — App builds
        // those from `card.uiExtensions` precisely so a user can reach a plugin
        // whose runtime has not finished starting — but no entry in
        // `pluginViews` yet, because the view is registered by the runtime.
        // Refusing the selection here dropped that click on the floor: the
        // picker closed, nothing opened, and nothing brought the user back when
        // the view landed a few seconds later. Open the destination instead and
        // let the host paint its loading state until the view registers.
        if (!view && !isPluginPreparing(pluginCards, parsed.pluginId)) return;
        const pluginId = view?.pluginId ?? parsed.pluginId;
        const loginTool = card?.auth?.loginTool;
        const authState = pluginAuthStatuses.get(pluginId)?.kind;
        const openPluginView = () => {
          // Always inline, regardless of appMode.
          setActiveView(parsed.key);
        };

        if (!loginTool || authState === "authed") {
          clearPluginAuthError(pluginId);
          failedPluginAuthOpenRef.current.delete(pluginId);
          openPluginView();
          return;
        }

        pendingInlineAuthOpenRef.current.set(pluginId, parsed.key);
        clearPluginAuthError(pluginId);
        failedPluginAuthOpenRef.current.delete(pluginId);

        const inflightKey = `${pluginId}:${loginTool}`;
        if (pluginAuthLoginInflightRef.current.has(inflightKey)) {
          return;
        }
        pluginAuthLoginInflightRef.current.add(inflightKey);
        void (async () => {
          try {
            await api.callPluginMethod(loginTool, undefined, { userAction: true });
            refreshPluginAuthStatus(pluginId);
          } catch (err) {
            // Raw err.message may carry OAuth/Bearer fragments — keep raw in
            // console only, and surface a sanitized code-oriented message.
            console.warn(
              `[plugin-auth] ${pluginId} loginTool '${loginTool}' failed`,
              err,
            );
            pendingInlineAuthOpenRef.current.delete(pluginId);
            failedPluginAuthOpenRef.current.add(pluginId);
            const message = formatPluginAuthLoginError(err);
            setPluginAuthErrors((prev) => {
              const next = new Map(prev);
              next.set(pluginId, message);
              return next;
            });
            statusPushToast({ severity: "error", message, ttlMs: 10000 });
          } finally {
            pluginAuthLoginInflightRef.current.delete(inflightKey);
          }
        })();
        return;
      }
      setActiveView(parsed.key);
    },
    [
      api,
      pluginViews,
      pluginCards,
      pluginAuthStatuses,
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
  // not found" placeholder for a stale plugin id. A plugin that is merely
  // still starting is not that case — leaving it here would undo the
  // navigation `handleViewSelect` just made for a preparing plugin.
  useEffect(() => {
    if (!activeView.startsWith("plugin:")) return;
    if (activePluginView) return;
    if (activePluginPreparing) return;
    setActiveView("home");
  }, [activeView, activePluginView, activePluginPreparing, setActiveView]);

  return { handleViewSelect, activePluginView, activePluginPreparing, activePluginAuthError };
}
