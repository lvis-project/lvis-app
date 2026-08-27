import { useCallback, useEffect, useState } from "react";
import type { LvisApi } from "../types.js";
import { projectRootEquals, projectRootKey } from "../../../shared/project-identity.js";

export interface UseProjectPreferencesResult {
  /** Pinned project roots (durable — SystemSettings round trip). */
  pinnedProjectRoots: string[];
  /** True when the given root is pinned (root-equality aware, case/slash-insensitive on Windows). */
  isProjectPinned: (projectRoot: string | undefined) => boolean;
  /** Pin/unpin a project root — persists immediately. */
  toggleProjectPin: (projectRoot: string) => void;
  /** True when the given root is archived — hidden from the default listing. */
  isProjectArchived: (projectRoot: string | undefined) => boolean;
  /** Archive/unarchive a project root — persists immediately. */
  toggleProjectArchived: (projectRoot: string) => void;
  /** The user's chosen name for this row, or undefined when they have not named it. */
  projectLabel: (projectRoot: string | undefined) => string | undefined;
  /** Rename the row. An empty label clears it back to the derived name. */
  setProjectLabel: (projectRoot: string, label: string) => void;
}

/**
 * The project ROW's preferences: whether it is pinned, whether it is archived,
 * and what the user chose to call it.
 *
 * All three are lightweight UI preferences rather than project-domain
 * mutations, so they persist the same way other UI preferences do (a
 * SystemSettings round trip) instead of earning an IPC domain. They live in one
 * hook because they are one thing from the row's side — its own card — and
 * because all three key on the same root identity: splitting them would be
 * three chances to disagree about whether two spellings of a path are the same
 * folder.
 *
 * Renaming a row NEVER renames the folder on disk, and archiving NEVER removes
 * the workspace root or its durable permission scope. Both are deliberately
 * weaker than the actions they sit next to.
 */
export function useProjectPreferences(api: LvisApi): UseProjectPreferencesResult {
  const [pinnedProjectRoots, setPinnedProjectRoots] = useState<string[]>([]);
  const [archivedProjectRoots, setArchivedProjectRoots] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const roots = settings?.system?.pinnedProjectRoots;
        if (Array.isArray(roots)) setPinnedProjectRoots(roots.filter((r): r is string => typeof r === "string"));
        const archived = settings?.system?.archivedProjectRoots;
        if (Array.isArray(archived)) setArchivedProjectRoots(archived.filter((r): r is string => typeof r === "string"));
        const stored = settings?.system?.projectLabels;
        if (stored && typeof stored === "object") setLabels({ ...stored });
      })
      .catch(() => {
        // Non-fatal: fall back to no preferences. The next toggle persists.
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

  const isProjectArchived = useCallback(
    (projectRoot: string | undefined) => {
      if (!projectRoot) return false;
      return archivedProjectRoots.some((root) => projectRootEquals(root, projectRoot));
    },
    [archivedProjectRoots],
  );

  const toggleProjectArchived = useCallback(
    (projectRoot: string) => {
      setArchivedProjectRoots((current) => {
        const next = current.some((root) => projectRootEquals(root, projectRoot))
          ? current.filter((root) => !projectRootEquals(root, projectRoot))
          : [...current, projectRoot];
        void api.updateSettings({ system: { archivedProjectRoots: next } });
        return next;
      });
    },
    [api],
  );

  const projectLabel = useCallback(
    (projectRoot: string | undefined) => {
      if (!projectRoot) return undefined;
      const key = projectRootKey(projectRoot);
      return key ? labels[key] : undefined;
    },
    [labels],
  );

  const setProjectLabel = useCallback(
    (projectRoot: string, label: string) => {
      const key = projectRootKey(projectRoot);
      if (!key) return;
      setLabels((current) => {
        const next = { ...current };
        const trimmed = label.trim();
        // Clearing the label is how the row goes back to its derived name, so
        // an empty string DELETES rather than storing "".
        if (trimmed) next[key] = trimmed;
        else delete next[key];
        void api.updateSettings({ system: { projectLabels: next } });
        return next;
      });
    },
    [api],
  );

  return {
    pinnedProjectRoots,
    isProjectPinned,
    toggleProjectPin,
    isProjectArchived,
    toggleProjectArchived,
    projectLabel,
    setProjectLabel,
  };
}
