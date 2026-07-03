/**
 * Workspace file-browser domain IPC handlers.
 * Covers: lvis:workspace:pick-root, lvis:workspace:list-roots,
 *         lvis:workspace:list-dir, lvis:workspace:remove-root,
 *         lvis:workspace:reveal
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
import { dialog, ipcMain, shell } from "electron";
import { t } from "../../i18n/index.js";
import { promises as fs } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import { validateSender, auditUnauthorized } from "../gated.js";
import { redactFsPath } from "../../audit/dlp-filter.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { assertReadableFilePath } from "../../tools/file-read-core.js";
import {
  readPermissionSettings,
  addAllowedDirectoryPersist,
  removeAllowedDirectoryPersist,
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

/** A minted acknowledgement token is valid for this window before it expires. */
const ACK_TOKEN_TTL_MS = 60_000;

/**
 * Main-process-held pending picks awaiting adjacency acknowledgement.
 *
 * Keyed by a one-time token minted only AFTER a real `showOpenDialog` returned a
 * warned path. The stored `path` is the MAIN-OWNED dialog result — never a
 * renderer-supplied string — so the acknowledgement pass can only ever persist a
 * directory the user actually chose in the native picker. Without this binding a
 * compromised renderer could hand back an arbitrary path with `acknowledge=true`
 * and silently widen the Layer-1 read allow-list.
 */
const pendingPicks = new Map<string, { path: string; expires: number; gesture: PickGesture }>();

/**
 * How the pending path entered the ack flow — recorded in the widening audit so
 * a native-picker widening (`dialog`) and a drag-drop widening (`drop`) are
 * distinguishable in the log. A dropped path is renderer-NAMED, so its audit
 * trail matters more than a native `showOpenDialog` result the OS vouched for.
 */
type PickGesture = "dialog" | "drop";

/** Drop expired tokens so a stream of un-acknowledged picks can't grow the map. */
function prunePendingPicks(now: number): void {
  for (const [token, pending] of pendingPicks) {
    if (now > pending.expires) pendingPicks.delete(token);
  }
}

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
   * surface {@link warnings} and re-invoke `pickRoot({ ackToken })` with the
   * one-time {@link ackToken} to confirm. Mirrors the two-step
   * `/permission dir allow … --ack-warnings` gate in permission-slash.ts, so a
   * folder pick can never silently widen the Layer-1 read allow-list.
   */
  requiresAcknowledgement?: boolean;
  /** Picked path awaiting acknowledgement — display only (never sent back). */
  pendingPath?: string;
  /**
   * One-time token that binds an acknowledgement to the exact dialog-picked path
   * the main process holds. The renderer confirms by presenting THIS token (not
   * a path), so it can never persist a directory the native picker did not
   * return. Expires after {@link ACK_TOKEN_TTL_MS}; consumed on first use.
   */
  ackToken?: string;
  error?: string;
}

/**
 * Result of the drag-drop add-root prepare step (#1458). A dropped folder path
 * is renderer-NAMED (resolved in preload via webUtils.getPathForFile), so unlike
 * a native picker it is NEVER persisted immediately: this step re-validates the
 * path and — on success — hands back a one-time ack token bound to the path the
 * MAIN process now owns. The renderer confirms via `pickRoot({ ackToken })`,
 * echoing the token (never a path), so it can never widen the Layer-1 read
 * allow-list to a directory of its own choosing without an explicit user ack.
 */
export interface WorkspaceDropPrepareResult {
  ok: boolean;
  /**
   * A hard deny (Layer-0 sensitive/root path) OR the dropped entry is not a
   * directory (`not-a-dir` — a dropped file is rejected; the renderer never
   * guesses a parent dir). Present only when `ok` is false.
   */
  error?: string;
  /** Adjacency warnings (`.env`/`.git`/…) to surface alongside the ack prompt. */
  warnings?: string[];
  /** The validated, MAIN-OWNED path awaiting acknowledgement — display only. */
  pendingPath?: string;
  /**
   * One-time token bound to {@link pendingPath}. The renderer confirms the add
   * by presenting THIS token to `pickRoot`, never a path — mirroring the native
   * warned-pick ack so the drop trust tier equals the #1448 ack tier.
   */
  ackToken?: string;
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

export interface WorkspaceRemoveRootResult {
  ok: boolean;
  removed?: string;
  roots?: WorkspaceRoot[];
  error?: "unauthorized" | "invalid-path" | "not-an-additional-root" | "cannot-remove-default";
  message?: string;
}

export interface WorkspaceRevealResult {
  ok: boolean;
  error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-found";
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

  /**
   * Persist a MAIN-OWNED directory path into `permissions.additionalDirectories`
   * (the executor's Layer-1 read allow-list SOT) after re-validating it. This is
   * the single choke point through which a folder pick widens the read scope.
   *
   *   1. `validateDirectoryAddition` — hard-refuses filesystem root / Layer 0
   *      sensitive dirs. Re-run even on the acknowledgement pass: a valid token
   *      clears adjacency warnings, NEVER a hard deny.
   *   2. Persist, then audit the widening (redacted path) — the read scope grew,
   *      so the WRITE is recorded, mirroring the preview-read audit.
   *
   * `picked` is ALWAYS a path the main process owns (a `showOpenDialog` result or
   * the token-bound pending path) — never a raw renderer string.
   */
  async function persistValidatedRoot(
    picked: string,
    gesture: PickGesture,
  ): Promise<WorkspacePickRootResult> {
    const verdict = validateDirectoryAddition(picked);
    if (!verdict.ok) {
      return { ok: false, error: verdict.reason, warnings: verdict.adjacencyWarnings };
    }
    // Persist the picked absolute path (settings SOT stores the raw path;
    // sanitize/canonicalize happens at read time). Dedup handled by the store.
    await addAllowedDirectoryPersist(picked);
    // Audit the allow-list widening: the permission SOT just grew the executor's
    // Layer-1 read scope. Mirrors the preview-read audit (redacted path via the
    // shared DLP filter) so a read-scope WRITE is recorded, not only READS. The
    // `gesture` marker distinguishes a native-picker widening from a drag-drop
    // widening (a renderer-named path) in the audit trail.
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "workspace-pick-root",
      type: "info",
      input: JSON.stringify({
        channel: CHANNELS.workspace.pickRoot,
        path: redactFsPath(picked),
        gesture,
      }),
    });
    return {
      ok: true,
      added: picked,
      roots: computeRoots(),
      warnings: verdict.adjacencyWarnings,
    };
  }

  ipcMain.handle(CHANNELS.workspace.listRoots, async (e): Promise<WorkspaceListRootsResult> => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.workspace.listRoots, e);
      return { ok: false, error: "unauthorized" };
    }
    return { ok: true, defaultRoot: process.cwd(), roots: computeRoots() };
  });

  ipcMain.handle(
    CHANNELS.workspace.pickRoot,
    async (e, opts?: { ackToken?: string }): Promise<WorkspacePickRootResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.pickRoot, e);
        return { ok: false, error: "unauthorized" };
      }
      // Acknowledgement pass — the renderer presents the one-time token it was
      // handed on the initial warned pick (NOT an arbitrary path). We look the
      // token up, consume it (one-time — no replay), and persist the MAIN-OWNED
      // path it was bound to. A token the main process never minted (forged),
      // already spent, or past its TTL is refused — so a compromised renderer
      // cannot self-clear adjacency warnings for a directory of its own choosing
      // and silently widen the Layer-1 read allow-list. The re-validation inside
      // persistValidatedRoot still hard-refuses a Layer 0 / root path even with a
      // valid token (acknowledgement clears warnings, never a hard deny).
      const ackToken =
        typeof opts?.ackToken === "string" && opts.ackToken.length > 0 ? opts.ackToken : null;
      if (ackToken) {
        const now = Date.now();
        const pending = pendingPicks.get(ackToken);
        if (pending) pendingPicks.delete(ackToken); // consume regardless of validity
        if (!pending) return { ok: false, error: "ack-unknown" };
        if (now > pending.expires) return { ok: false, error: "ack-expired" };
        return persistValidatedRoot(pending.path, pending.gesture);
      }

      // Initial pick — the native folder picker IS the user gesture.
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

      const dialogPath = filePaths[0];
      const verdict = validateDirectoryAddition(dialogPath);
      if (!verdict.ok) {
        return { ok: false, error: verdict.reason, warnings: verdict.adjacencyWarnings };
      }
      if (verdict.adjacencyWarnings.length > 0) {
        // Withhold the pick: mint a one-time token bound to the MAIN-OWNED dialog
        // path and require the renderer to confirm by presenting the token. The
        // renderer never names the path that will ultimately be persisted.
        const now = Date.now();
        prunePendingPicks(now);
        const token = randomBytes(32).toString("base64url");
        pendingPicks.set(token, {
          path: dialogPath,
          expires: now + ACK_TOKEN_TTL_MS,
          gesture: "dialog",
        });
        return {
          ok: true,
          requiresAcknowledgement: true,
          pendingPath: dialogPath,
          ackToken: token,
          warnings: verdict.adjacencyWarnings,
          roots: computeRoots(),
        };
      }
      // No adjacency warnings — persist immediately (still audited).
      return persistValidatedRoot(dialogPath, "dialog");
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

  /**
   * Remove a project root from `permissions.additionalDirectories` (the
   * executor's Layer-1 read allow-list SOT). Security: a removal can ONLY target
   * a path already present in that list — never an arbitrary renderer-supplied
   * path — and the default root (`process.cwd()`, which is not stored in the
   * list) can never be removed. Matching is canonical/case-folded so a trailing
   * slash or case variant of a stored path still resolves to its entry. The
   * shrink is audited, mirroring the widening audit in persistValidatedRoot: the
   * read scope narrowed, so the WRITE is recorded.
   */
  ipcMain.handle(
    CHANNELS.workspace.removeRoot,
    async (e, rawPath: string): Promise<WorkspaceRemoveRootResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.removeRoot, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "invalid-path", message: "path must be a non-empty string" };
      }
      const targetCanon = caseFoldForMatch(canonicalizePathForMatch(resolvePath(rawPath)));
      const defaultCanon = caseFoldForMatch(canonicalizePathForMatch(process.cwd()));
      if (targetCanon === defaultCanon) {
        return { ok: false, error: "cannot-remove-default", message: "default root cannot be removed" };
      }
      const additional = readPermissionSettings().permissions.additionalDirectories;
      const match = additional.find(
        (d) => caseFoldForMatch(canonicalizePathForMatch(d)) === targetCanon,
      );
      if (!match) {
        return { ok: false, error: "not-an-additional-root", message: "path is not a removable project root" };
      }
      await removeAllowedDirectoryPersist(match);
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "workspace-remove-root",
        type: "info",
        input: JSON.stringify({
          channel: CHANNELS.workspace.removeRoot,
          path: redactFsPath(match),
        }),
      });
      return { ok: true, removed: match, roots: computeRoots() };
    },
  );

  /**
   * Reveal a file/folder in the OS file manager (Finder / Explorer). This is a
   * strictly WEAKER capability than "open": `showItemInFolder` only selects the
   * item's location, it never launches/executes it — consistent with the
   * `canOpenExternal:false` policy that deliberately disables the OS "open"
   * button in the preview pane.
   *
   * Trust boundary (identical to listDir): the renderer-supplied `rawPath` is
   * NOT trusted. `assertReadableFilePath` re-validates it against the SAME scope
   * (cwd + additionalDirectories), rejecting globs, Layer 0 sensitive paths, and
   * anything outside the allowed roots. Only `verdict.resolved` — the main-owned,
   * realpath'd, scope-checked absolute path — is ever handed to the shell, never
   * the raw renderer string.
   */
  ipcMain.handle(
    CHANNELS.workspace.reveal,
    async (e, rawPath: string): Promise<WorkspaceRevealResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.reveal, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "not-found", message: "path must be a non-empty string" };
      }
      const { cwd, extraAllowed } = currentScope();
      const verdict = assertReadableFilePath(rawPath, cwd, extraAllowed);
      if (!verdict.ok) {
        const error = verdict.error === "not-a-file" ? "not-found" : verdict.error;
        return { ok: false, error, message: `scope guard rejected: ${verdict.error}` };
      }
      const target = verdict.resolved;
      try {
        await fs.stat(target);
      } catch {
        return { ok: false, error: "not-found", message: "path no longer exists" };
      }
      shell.showItemInFolder(target);
      return { ok: true };
    },
  );

  /**
   * Drag-drop add-root, step 1 (#1458). A dropped folder path is renderer-NAMED
   * — the preload webUtils bridge turned a dropped `File` into a candidate path,
   * which carries no capability on its own. This handler is the trust gate that
   * gives the drop the SAME defense as the #1448 native warned-pick:
   *
   *   1. `validateSender` — a plugin-ui-shell / external frame is refused.
   *   2. `validateDirectoryAddition` — Layer-0 HARD-DENY (filesystem root /
   *      sensitive dir). An ack can NEVER clear a hard deny, so a dropped
   *      `~/.lvis/secrets` is rejected here and never reaches persistence.
   *   3. `fs.stat` is-a-directory — a dropped FILE is rejected (`not-a-dir`);
   *      the renderer never guesses a parent dir (No-Fallback).
   *
   * On success it mints a one-time, MAIN-OWNED ack token bound to the validated
   * path and stores it in `pendingPicks`. A drop ALWAYS requires acknowledgement
   * (even with zero adjacency warnings): unlike a native picker, the OS dialog
   * never vouched for the path, so the explicit user ack is that missing vouch.
   * The renderer confirms via `pickRoot({ ackToken })`, echoing the token (never
   * a path) — so the renderer names the candidate exactly once, and the moment
   * this handler validates it, the path becomes main-owned. This preserves the
   * #1448 invariant that persistence only ever touches a path the main process
   * owns, never a raw renderer string handed back with `acknowledge=true`.
   */
  ipcMain.handle(
    CHANNELS.workspace.dropPrepare,
    async (e, rawPath: string): Promise<WorkspaceDropPrepareResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.workspace.dropPrepare, e);
        return { ok: false, error: "unauthorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "invalid-path" };
      }
      // Layer-0 hard-deny FIRST — a sensitive/root path is refused outright and
      // no token is ever minted, so it can never be acknowledged into scope.
      const verdict = validateDirectoryAddition(rawPath);
      if (!verdict.ok) {
        return { ok: false, error: verdict.reason, warnings: verdict.adjacencyWarnings };
      }
      // A dropped FILE is not a root — reject rather than inferring its parent.
      try {
        const stat = await fs.stat(rawPath);
        if (!stat.isDirectory()) return { ok: false, error: "not-a-dir" };
      } catch {
        return { ok: false, error: "not-found" };
      }
      // Mint a MAIN-OWNED ack token bound to the validated path. The path is now
      // owned by the main process; the renderer can only echo the token back.
      const now = Date.now();
      prunePendingPicks(now);
      const token = randomBytes(32).toString("base64url");
      pendingPicks.set(token, {
        path: rawPath,
        expires: now + ACK_TOKEN_TTL_MS,
        gesture: "drop",
      });
      return {
        ok: true,
        pendingPath: rawPath,
        ackToken: token,
        warnings: verdict.adjacencyWarnings,
      };
    },
  );
}
