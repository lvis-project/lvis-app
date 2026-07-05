import { useCallback, useEffect, useState } from "react";
import type { LvisApi } from "../types.js";
import { projectRootEquals } from "../../../shared/project-identity.js";

export interface UsePinnedProjectsResult {
  /** Pinned project roots (durable — SystemSettings round trip). */
  pinnedProjectRoots: string[];
  /** True when the given root is pinned (root-equality aware, case/slash-insensitive on Windows). */
  isProjectPinned: (projectRoot: string | undefined) => boolean;
  /** Pin/unpin a project root — persists immediately. */
  toggleProjectPin: (projectRoot: string) => void;
}

/**
 * Pinned-projects preference — a lightweight list (not a project-domain
 * mutation, so it does not need its own IPC domain), persisted the same way
 * other UI preferences persist (SystemSettings round trip). Pinned projects
 * sort to the top of the sidebar's Projects tab via `sortWithPinnedFirst`.
 */
export function usePinnedProjects(api: LvisApi): UsePinnedProjectsResult {
  const [pinnedProjectRoots, setPinnedProjectRoots] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const roots = settings?.system?.pinnedProjectRoots;
        if (Array.isArray(roots)) setPinnedProjectRoots(roots.filter((r): r is string => typeof r === "string"));
      })
      .catch(() => {
        // Non-fatal: fall back to no pins. The next toggle persists.
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const isProjectPinned = useCallback(
    (projectRoot: string | undefined) => {
      if (!projectRoot) return false;
      return pinnedProjectRoots.some((root) => projectRootEquals(root, projectRoot));
    },
    [pinnedProjectRoots],
  );

  const toggleProjectPin = useCallback(
    (projectRoot: string) => {
      setPinnedProjectRoots((current) => {
        const next = current.some((root) => projectRootEquals(root, projectRoot))
          ? current.filter((root) => !projectRootEquals(root, projectRoot))
          : [...current, projectRoot];
        void api.updateSettings({ system: { pinnedProjectRoots: next } });
        return next;
      });
    },
    [api],
  );

  return { pinnedProjectRoots, isProjectPinned, toggleProjectPin };
}
