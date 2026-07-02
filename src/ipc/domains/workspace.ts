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

export function registerWorkspaceHandlers(deps: IpcDeps): void {
  const { auditLogger, getMainWindow } = deps;

  ipcMain.handle(CHANNELS.workspace.listRoots, async (e): Promise<WorkspaceListRootsResult> => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.workspace.listRoots, e);
      return { ok: false, error: "unauthorized" };
    }
    return { ok: true, defaultRoot: process.cwd(), roots: computeRoots() };
  });

  ipcMain.handle(CHANNELS.workspace.pickRoot, async (e): Promise<WorkspacePickRootResult> => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.workspace.pickRoot, e);
      return { ok: false, error: "unauthorized" };
    }
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

    // Pre-flight the picked directory through the same Layer 0/root guard the
    // Settings permission flow uses — filesystem-root / sensitive dirs rejected,
    // `.env`/`.git`/… adjacency surfaced as warnings.
    const verdict = validateDirectoryAddition(filePaths[0]);
    if (!verdict.ok) {
      return { ok: false, error: verdict.reason, warnings: verdict.adjacencyWarnings };
    }
    // Persist the user-typed absolute path (settings SOT stores the raw path;
    // sanitize/canonicalize happens at read time). Dedup handled by the store.
    await addAllowedDirectoryPersist(filePaths[0]);
    return {
      ok: true,
      added: filePaths[0],
      roots: computeRoots(),
      warnings: verdict.adjacencyWarnings,
    };
  });

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
          // Only surface plain files and directories; skip symlinks/sockets/etc
          // so a symlink can't advertise an out-of-scope target as an entry.
          if (ent.isFile()) entries.push({ name: ent.name, path: join(dir, ent.name), type: "file" });
          else if (ent.isDirectory()) entries.push({ name: ent.name, path: join(dir, ent.name), type: "directory" });
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
