/**
 * Tracks plugins currently being installed, indexed by slug → InstallPhase.
 *
 * Subscribes to the existing `onPluginInstallProgress` / `onPluginInstallResult`
 * IPC events and returns a `ReadonlyMap<string, InstallPhase>`. The map grows
 * on progress events (latest phase wins per slug) and shrinks on result
 * events (both success and failure). The phase is what the plugin grid
 * popover renders inside its install spinner so the user sees the current
 * pipeline step (다운로드 중 → 검증 중 → 설치 중 → 등록 중 → 재시작 중).
 *
 * No new IPC channels — relies on the existing install event surface.
 */
import { useEffect, useState } from "react";
import type { LvisApi } from "../types.js";
import type { InstallPhase } from "./use-plugin-marketplace.js";

export function useInstallingPlugins(api: LvisApi): ReadonlyMap<string, InstallPhase> {
  const [phases, setPhases] = useState<Map<string, InstallPhase>>(() => new Map());

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    if (typeof api.onPluginInstallProgress === "function") {
      unsubs.push(
        api.onPluginInstallProgress((payload) => {
          setPhases((prev) => {
            if (prev.get(payload.slug) === payload.phase) return prev;
            const next = new Map(prev);
            next.set(payload.slug, payload.phase);
            return next;
          });
        }),
      );
    }

    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(
        api.onPluginInstallResult((payload) => {
          setPhases((prev) => {
            if (!prev.has(payload.slug)) return prev;
            const next = new Map(prev);
            next.delete(payload.slug);
            return next;
          });
        }),
      );
    }

    return () => {
      for (const u of unsubs) u();
    };
  }, [api]);

  return phases;
}
