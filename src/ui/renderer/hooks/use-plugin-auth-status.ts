import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LvisApi, PluginAuthStatusResult, PluginCardSummary } from "../types.js";

export type PluginAuthState =
  | { kind: "loading" }
  | { kind: "authed"; account?: string }
  | { kind: "unauthed" }
  | { kind: "error"; message: string };

function parseStatusResult(raw: unknown): PluginAuthState {
  // Defensive parse — plugin may return additional fields; we only consume
  // two. architecture.md §9.4a Host UI Surface contract; outputSchema
  // validation is a separate cross-cutting follow-up.
  if (raw && typeof raw === "object") {
    const r = raw as Partial<PluginAuthStatusResult>;
    if (r.authenticated === true) {
      return {
        kind: "authed",
        account: typeof r.account === "string" && r.account.length > 0 ? r.account : undefined,
      };
    }
    return { kind: "unauthed" };
  }
  return { kind: "unauthed" };
}

/**
 * Live-polls every plugin that declares `manifest.auth` (architecture.md
 * §9.4a) and listens for `<pluginId>.auth.changed` events. Returns a state
 * map keyed by plugin id plus a manual `refresh` for callers that just
 * triggered login/logout.
 *
 * Implementation note: the effect dep is a JSON cache-key derived from the
 * auth-bearing entries — not the `plugins` array reference — because the
 * caller (PluginConfigTab) recomputes the cards array on every refresh
 * cycle. Using the array reference would re-subscribe on every parent
 * render, leaking event listeners and re-firing statusTool indefinitely.
 */
export function usePluginAuthStatuses(
  api: LvisApi | null,
  plugins: PluginCardSummary[],
): {
  statuses: Map<string, PluginAuthState>;
  refresh: (pluginId: string) => void;
} {
  const [statuses, setStatuses] = useState<Map<string, PluginAuthState>>(new Map());

  // Always-current view of which plugins declare auth, so callbacks captured
  // in the effect closure don't need to be re-bound when `plugins` changes.
  const pluginsRef = useRef(plugins);
  pluginsRef.current = plugins;

  // Stable cache key — only changes when the set of auth-bearing plugins or
  // their auth tool names actually change.
  const authCacheKey = useMemo(() => {
    return plugins
      .filter((p) => p.auth)
      .map((p) =>
        [
          p.id,
          p.auth?.statusTool ?? "",
          p.auth?.loginTool ?? "",
          p.auth?.logoutTool ?? "",
        ].join("|"),
      )
      .sort()
      .join(";");
  }, [plugins]);

  const refresh = useCallback(
    (pluginId: string) => {
      if (!api) return;
      const target = pluginsRef.current.find((p) => p.id === pluginId);
      const auth = target?.auth;
      if (!auth) return;
      // Fire and forget — error path lands in setStatuses.
      void (async () => {
        try {
          const raw = await api.callPluginMethod(auth.statusTool);
          setStatuses((prev) => {
            const next = new Map(prev);
            next.set(pluginId, parseStatusResult(raw));
            return next;
          });
        } catch (err) {
          // `throw null` is legal — `(err as Error).message` would crash. Narrow first.
          const message =
            err instanceof Error
              ? err.message
              : typeof err === "string"
                ? err
                : "auth status invocation failed";
          setStatuses((prev) => {
            const next = new Map(prev);
            next.set(pluginId, { kind: "error", message });
            return next;
          });
        }
      })();
    },
    [api],
  );

  useEffect(() => {
    if (!api) return;
    const authPlugins = pluginsRef.current.filter((p) => p.auth);
    if (authPlugins.length === 0) {
      setStatuses(new Map());
      return;
    }

    // Seed loading state for plugins we haven't observed yet (avoids the
    // "missing badge → suddenly red" flicker when the IPC roundtrip
    // returns and the state map gains a new key).
    setStatuses((prev) => {
      const next = new Map(prev);
      for (const p of authPlugins) {
        if (!next.has(p.id)) next.set(p.id, { kind: "loading" });
      }
      // Drop entries for plugins that no longer exist (uninstall).
      const liveIds = new Set(authPlugins.map((p) => p.id));
      for (const id of next.keys()) {
        if (!liveIds.has(id)) next.delete(id);
      }
      return next;
    });

    for (const p of authPlugins) refresh(p.id);

    const unsubs: Array<() => void> = [];
    if (typeof api.onPluginEvent === "function") {
      for (const p of authPlugins) {
        const eventType = `${p.id}.auth.changed`;
        const unsub = api.onPluginEvent(eventType, () => refresh(p.id));
        if (typeof unsub === "function") unsubs.push(unsub);
      }
    }
    return () => {
      for (const u of unsubs) u();
    };
    // Deliberate: depend on the cache key (not `plugins`) so this effect
    // only re-runs when the auth-bearing set changes shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, authCacheKey, refresh]);

  return { statuses, refresh };
}
