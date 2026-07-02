/**
 * Workspace file-browser domain IPC handlers.
 * Covers: lvis:workspace:pick-root, lvis:workspace:list-roots,
 *         lvis:workspace:list-dir
 *
 * Renderer reaches these via window.lvis.workspace.*.
 *
 * Project-root SOT: there is NO new root store. A picked project folder is
 * persisted to `permissions.additionalDirectories` (~/.lvis/settings.json) —
 * the SAME list the executor's Layer 1 allow-list consumes — so a folder that
 * shows up in the browser is automatically readable by `read_file` and the
 * preview IPC, and vice-versa. Adding a separate store would create a
 * "visible but not readable" divergence (No-Fallback).
 *
 * The default root is process.cwd() (anchored to ~/.lvis/workspace by
 * ensureWorkspaceCwd) — deterministic across dev/packaged, unlike the bare
 * `process.cwd()` a Finder-launched app used to inherit.
 *
 * listDir re-validates every requested path against the same scope guard so a
 * compromised renderer cannot list outside the selected roots.
 */
import { dialog, ipcMain } from "electron";
import { t } from "../../i18n/index.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { validateSender, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { assertReadableFilePath } from "../../tools/file-read-core.js";
import {
  readPermissionSettings,
  addAllowedDirectoryPersist,
} from "../../permissions/permission-settings-store.js";
import {
  buildRuntimeAllowedDirectories,
  sanitizeRuntimeAllowedDirectories,
  validateDirectoryAddition,
} from "../../permissions/allowed-directories.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../../permissions/sensitive-paths.js";

/** Max directory entries returned per lazy listing (bounds huge dirs). */
const MAX_DIR_ENTRIES = 1_000;

export interface WorkspaceRoot {
  path: string;
  /** The default workspace root (`process.cwd()`), badged in the UI. */
  isDefault: boolean;
}

export interface WorkspaceListRootsResult {
  ok: boolean;
  defaultRoot?: string;
  roots?: WorkspaceRoot[];
  error?: string;
}

export interface WorkspacePickRootResult {
  ok: boolean;
  canceled?: boolean;
  added?: string;
  roots?: WorkspaceRoot[];
  /** Adjacency warnings (`.env`/`.git`/…) surfaced to the renderer. */
  warnings?: string[];
  /**
   * The pick had adjacency warnings and was NOT persisted — the renderer must
   * surface {@link warnings} and re-invoke `pickRoot({ acknowledgePath })` to
   * confirm. Mirrors the two-step `/permission dir allow … --ack-warnings` gate
   * in permission-slash.ts, so a folder pick can never silently widen the
   * Layer-1 read allow-list.
   */
  requiresAcknowledgement?: boolean;
  /** Echoed picked path awaiting acknowledgement (renderer sends it back). */
  pendingPath?: string;
  error?: string;
}

export interface WorkspaceDirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

export interface WorkspaceListDirResult {
  ok: boolean;
  path?: string;
  entries?: WorkspaceDirEntry[];
  truncated?: boolean;
  error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-a-dir" | "read-failed";
  message?: string;
}

function currentScope(): { cwd: string; extraAllowed: string[] } {
  const cwd = process.cwd();
  const additional = readPermissionSettings().permissions.additionalDirectories;
  return { cwd, extraAllowed: buildRuntimeAllowedDirectories(additional) };
}

function computeRoots(): WorkspaceRoot[] {
  const defaultRoot = process.cwd();
  const additional = readPermissionSettings().permissions.additionalDirectories;
  const canonicalAdds = sanitizeRuntimeAllowedDirectories(additional);
  const seen = new Set<string>([defaultRoot]);
  const roots: WorkspaceRoot[] = [{ path: defaultRoot, isDefault: true }];
  for (const dir of canonicalAdds) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    roots.push({ path: dir, isDefault: false });
  }
  return roots;
}

/**
 * Persist a picked project folder through the SAME validation + adjacency-ack
 * gate the `/permission dir allow` slash enforces (permission-slash.ts §allow):
 *
 *   1. `validateDirectoryAddition` — hard-refuses filesystem root / Layer 0
 *      sensitive dirs and surfaces `.env`/`.git`/`.ssh`/… adjacency warnings.
 *   2. Adjacency warnings present AND not acknowledged → DO NOT persist; return
 *      `requiresAcknowledgement` so the renderer can confirm (second gesture).
 *   3. Otherwise persist to `permissions.additionalDirectories` — the executor's
 *      Layer-1 read allow-list SOT.
 *
 * This is the single choke point that stops a folder pick from silently widening
 * the read allow-list by discarding warnings.
 */
async function persistPickedRoot(
  picked: string,
  acknowledge: boolean,
): Promise<WorkspacePickRootResult> {
  const verdict = validateDirectoryAddition(picked);
  if (!verdict.ok) {
    return { ok: false, error: verdict.reason, warnings: verdict.adjacencyWarnings };
  }
  if (verdict.adjacencyWarnings.length > 0 && !acknowledge) {
    return {
      ok: true,
      requiresAcknowledgement: true,
      pendingPath: picked,
      warnings: verdict.adjacencyWarnings,
      roots: computeRoots(),
    };
  }
  // Persist the user-picked absolute path (settings SOT stores the raw path;
  // sanitize/canonicalize happens at read time). Dedup handled by the store.
  await addAllowedDirectoryPersist(picked);
  return {
    ok: true,
    added: picked,
    roots: computeRoots(),
    warnings: verdict.adjacencyWarnings,
  };
}

export function registerWorkspaceHandlers(deps: IpcDeps): void {
  const { auditLogger, getMainWindow } = deps;

  ipcMain.handle(CHANNELS.workspace.listRoots, async (e): Promise<WorkspaceListRootsResult> => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.workspace.listRoots, e);
      return { ok: false, error: "unauthorized" };
    }
    return { ok: true, defaultRoot: process.cwd(), roots: computeRoots() };
  });

  ipcMain.handle(
    CHANNELS.workspace.pickRoot,
    async (e, opts?: { acknowledgePath?: string }): Promise<WorkspacePickRootResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.pickRoot, e);
        return { ok: false, error: "unauthorized" };
      }
      // Phase 2 — the renderer confirmed the adjacency warnings for a path it was
      // handed in phase 1. Persist WITHOUT reopening the dialog, but still through
      // the SAME gate: a hostile renderer passing a Layer 0 / root path is still
      // hard-refused (acknowledgement only clears adjacency warnings, never a hard
      // deny — identical to `/permission dir allow … --ack-warnings`).
      const acknowledgePath =
        typeof opts?.acknowledgePath === "string" && opts.acknowledgePath.length > 0
          ? opts.acknowledgePath
          : null;
      if (acknowledgePath) {
        return persistPickedRoot(acknowledgePath, true);
      }

      // Phase 1 — the native folder picker IS the user gesture.
      const win = getMainWindow();
      const { filePaths, canceled } = win
        ? await dialog.showOpenDialog(win, {
            title: t("chatPreviewRail.pickRootTitle"),
            properties: ["openDirectory", "createDirectory"],
          })
        : await dialog.showOpenDialog({
            title: t("chatPreviewRail.pickRootTitle"),
            properties: ["openDirectory", "createDirectory"],
          });
      if (canceled || !filePaths[0]) return { ok: true, canceled: true, roots: computeRoots() };
      return persistPickedRoot(filePaths[0], false);
    },
  );

  ipcMain.handle(
    CHANNELS.workspace.listDir,
    async (e, rawPath: string): Promise<WorkspaceListDirResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.listDir, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "not-a-dir", message: "path must be a non-empty string" };
      }
      const { cwd, extraAllowed } = currentScope();
      const verdict = assertReadableFilePath(rawPath, cwd, extraAllowed);
      if (!verdict.ok) {
        const error = verdict.error === "not-a-file" ? "not-a-dir" : verdict.error;
        return { ok: false, error, message: `scope guard rejected: ${verdict.error}` };
      }
      const dir = verdict.resolved;
      try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) {
          return { ok: false, error: "not-a-dir", path: dir, message: "not a directory" };
        }
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        const entries: WorkspaceDirEntry[] = [];
        let truncated = false;
        for (const ent of dirents) {
          if (entries.length >= MAX_DIR_ENTRIES) {
            truncated = true;
            break;
          }
          const full = join(dir, ent.name);
          // Layer 0 filtering, identical to the read/list tools (file-tools.ts
          // walk): a `.env`/`.ssh`/`secrets`/… entry inside an allowed root is
          // never enumerated, so the browser can't surface a path the preview /
          // read_file guard would then hard-block.
          if (isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(full)))) continue;
          // Only surface plain files and directories; skip symlinks/sockets/etc
          // so a symlink can't advertise an out-of-scope target as an entry.
          if (ent.isFile()) entries.push({ name: ent.name, path: full, type: "file" });
          else if (ent.isDirectory()) entries.push({ name: ent.name, path: full, type: "directory" });
        }
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return { ok: true, path: dir, entries, truncated };
      } catch (err) {
        return {
          ok: false,
          error: "read-failed",
          path: dir,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
