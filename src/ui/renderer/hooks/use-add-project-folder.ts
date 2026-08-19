import { useCallback, useState } from "react";
import { projectBasename, type WorkspaceRootIdentity } from "../../../shared/project-identity.js";

export interface PendingRootWarning {
  path: string;
  warnings: string[];
  ackToken: string;
}

/**
 * How a project surface hands a refused mutation — or a project list the
 * backend could not vouch for — to the app-level toast.
 *
 * The operation is passed rather than a ready-made sentence because the code
 * usually resolves to a localized message on its own; the operation only names
 * the context for a code the shared IPC table does not know.
 */
export type ProjectErrorReporter = (
  operation: "add" | "remove" | "list",
  error?: string,
  message?: string,
) => void;

/**
 * What one `pickRoot` round trip actually did.
 *
 * The four outcomes used to collapse into a single `null`, which is why a
 * refused add — an unwritable settings file, a denied path, a rejected sender
 * frame — reached the user as nothing at all: indistinguishable from pressing
 * Escape in the folder dialog. They are separate cases because the UI owes the
 * user a different response to each, and only `failed` carries a code the
 * shared IPC error table can render.
 */
export type AddProjectFolderOutcome =
  | { status: "added"; roots: WorkspaceRootIdentity[]; added: string | null }
  | { status: "canceled" }
  | { status: "needs-acknowledgement" }
  | { status: "failed"; error?: string };

export interface UseAddProjectFolderResult {
  /** Adjacency warnings awaiting acknowledgement — null when idle. */
  pendingWarning: PendingRootWarning | null;
  /** Open the native folder picker (`workspace.pickRoot`). The caller owns what
   *  happens to the resulting root list (e.g. switch the active project,
   *  refresh a project list) AND surfacing a `failed` outcome. */
  addFolder: () => Promise<AddProjectFolderOutcome>;
  /** Echo the pending warning's ackToken to confirm the add despite adjacency warnings. */
  confirmPendingFolder: () => Promise<AddProjectFolderOutcome>;
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

  const addFolder = useCallback(async (): Promise<AddProjectFolderOutcome> => {
    const res = await window.lvis.workspace.pickRoot();
    if (!res.ok) return { status: "failed", ...(res.error ? { error: res.error } : {}) };
    if (res.requiresAcknowledgement && res.pendingPath && res.ackToken) {
      setPendingWarning({ path: res.pendingPath, warnings: res.warnings ?? [], ackToken: res.ackToken });
      return { status: "needs-acknowledgement" };
    }
    // `ok` without a root list is the dialog being dismissed — main answers a
    // cancel with `{ ok: true, canceled: true, roots }`, so an absent list can
    // only mean the pick produced nothing to apply.
    if (!res.roots) return { status: "canceled" };
    return { status: "added", roots: res.roots, added: res.added ?? null };
  }, []);

  const confirmPendingFolder = useCallback(async (): Promise<AddProjectFolderOutcome> => {
    const pending = pendingWarning;
    if (!pending) return { status: "canceled" };
    // Second, explicit confirmation — echo the one-time token (never a path).
    // Main persists the token-bound dialog path and still hard-refuses a
    // sensitive/root path even when acknowledged.
    const res = await window.lvis.workspace.pickRoot({ ackToken: pending.ackToken });
    setPendingWarning(null);
    if (!res.ok) return { status: "failed", ...(res.error ? { error: res.error } : {}) };
    if (!res.roots) return { status: "canceled" };
    return { status: "added", roots: res.roots, added: res.added ?? null };
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
