import { useCallback, useState } from "react";
import { projectBasename, type WorkspaceRootIdentity } from "../../../shared/project-identity.js";

export interface PendingRootWarning {
  path: string;
  warnings: string[];
  ackToken: string;
}

export interface UseAddProjectFolderResult {
  /** Adjacency warnings awaiting acknowledgement — null when idle. */
  pendingWarning: PendingRootWarning | null;
  /** Open the native folder picker (`workspace.pickRoot`). Resolves the new
   *  root list on success; caller decides what to do with it (e.g. switch the
   *  active project, refresh a project list). */
  addFolder: () => Promise<{ roots: WorkspaceRootIdentity[]; added: string | null } | null>;
  /** Echo the pending warning's ackToken to confirm the add despite adjacency warnings. */
  confirmPendingFolder: () => Promise<{ roots: WorkspaceRootIdentity[]; added: string | null } | null>;
  /** Dismiss the pending warning without adding the folder. */
  cancelPendingFolder: () => void;
  /** Raw setter — for producers that resolve a pending warning through a
   *  different IPC round trip than `pickRoot` (e.g. ChatSidePanel's drag-drop
   *  add-root, which validates via `workspace.dropPrepare` first). All
   *  producers still funnel into this ONE state + the same
   *  `confirmPendingFolder`/`cancelPendingFolder` resolution path. */
  setPendingWarning: (warning: PendingRootWarning | null) => void;
}

/**
 * Shared "add a project folder" flow — wraps `workspace.pickRoot` + the
 * adjacency-warning acknowledgement round trip (`pickRoot({ ackToken })`).
 * Extracted so every UI entry point that lets the user add a project root
 * (the workspace file-browser tab in ChatSidePanel, the empty-state composer's
 * project selector) shares ONE implementation instead of re-deriving the
 * ack-token state machine. Callers own what happens to the resulting root
 * list (e.g. ChatSidePanel keeps its own file-tree `roots` state; the composer
 * selector calls the shared `refreshWorkspaceProjects` + switches the active
 * project to the newly added root).
 */
export function useAddProjectFolder(): UseAddProjectFolderResult {
  const [pendingWarning, setPendingWarning] = useState<PendingRootWarning | null>(null);

  const addFolder = useCallback(async () => {
    const res = await window.lvis.workspace.pickRoot();
    if (!res.ok) return null;
    if (res.requiresAcknowledgement && res.pendingPath && res.ackToken) {
      setPendingWarning({ path: res.pendingPath, warnings: res.warnings ?? [], ackToken: res.ackToken });
      return null;
    }
    if (!res.roots) return null;
    return { roots: res.roots, added: res.added ?? null };
  }, []);

  const confirmPendingFolder = useCallback(async () => {
    const pending = pendingWarning;
    if (!pending) return null;
    // Second, explicit confirmation — echo the one-time token (never a path).
    // Main persists the token-bound dialog path and still hard-refuses a
    // sensitive/root path even when acknowledged.
    const res = await window.lvis.workspace.pickRoot({ ackToken: pending.ackToken });
    setPendingWarning(null);
    if (!res.ok || !res.roots) return null;
    return { roots: res.roots, added: res.added ?? null };
  }, [pendingWarning]);

  const cancelPendingFolder = useCallback(() => {
    setPendingWarning(null);
  }, []);

  return { pendingWarning, addFolder, confirmPendingFolder, cancelPendingFolder, setPendingWarning };
}

/** Display basename for an added root path, falling back to the raw path. */
export function addedRootDisplayName(path: string): string {
  return projectBasename(path) || path;
}
