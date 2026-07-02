/**
 * Preview file-read domain IPC handler.
 * Covers: lvis:preview:read-file
 *
 * Renderer reaches this via window.lvis.preview.readFile(path).
 *
 * SECURITY INVARIANT: the set of files this handler will read for preview is
 * EXACTLY the set the builtin `read_file` tool reads without approval — the
 * guard ({@link assertReadableFilePath}) and text-window core
 * ({@link readTextFileWindow}) are the SAME functions the tool uses
 * (`src/tools/file-read-core.ts`). This IPC adds ZERO new read authority.
 *
 * Not in PUBLIC_CHANNELS → external surfaces (local-api / cli / sdk) can never
 * reach it (fail-closed). Frame-guarded via validateSender.
 */
import { ipcMain } from "electron";
import { promises as fs } from "node:fs";
import { validateSender, auditUnauthorized } from "../gated.js";
import { redactFsPath } from "../../audit/dlp-filter.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import {
  MAX_TEXT_FILE_BYTES,
  assertReadableFilePath,
  isBinaryFile,
  readTextFileWindow,
} from "../../tools/file-read-core.js";
import { readPermissionSettings } from "../../permissions/permission-settings-store.js";
import { buildRuntimeAllowedDirectories } from "../../permissions/allowed-directories.js";

/** Line window read per preview request — matches read_file's default cap. */
const PREVIEW_LINE_LIMIT = 5_000;

export interface PreviewReadFileResult {
  ok: boolean;
  /** UTF-8 text (line-window + byte cap applied). */
  content?: string;
  /** Canonical resolved path (renderer uses the extension to pick a renderer). */
  path?: string;
  /** Original file size in bytes. */
  bytes?: number;
  /** Text was truncated by the line window. */
  truncated?: boolean;
  error?:
    | "unauthorized"
    | "path-not-allowed"
    | "sensitive-path"
    | "not-a-file"
    | "binary-file"
    | "too-large"
    | "read-failed";
  /** English dev detail (IPC Error Language Convention — renderer maps code→Korean). */
  message?: string;
}

/**
 * The runtime allow-list this preview shares with native tool execution.
 * cwd = process.cwd() (anchored to ~/.lvis/workspace by ensureWorkspaceCwd);
 * extras = the user's Settings `additionalDirectories` (the same SOT
 * `read_file` consumes). Read fresh each call so a just-added project folder
 * is immediately previewable without a restart.
 */
function currentReadScope(): { cwd: string; extraAllowed: string[] } {
  const cwd = process.cwd();
  const additional = readPermissionSettings().permissions.additionalDirectories;
  return { cwd, extraAllowed: buildRuntimeAllowedDirectories(additional) };
}

export function registerPreviewHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle(
    CHANNELS.preview.readFile,
    async (e, rawPath: string): Promise<PreviewReadFileResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.preview.readFile, e);
        return { ok: false, error: "unauthorized", message: "sender frame not authorized" };
      }
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { ok: false, error: "not-a-file", message: "path must be a non-empty string" };
      }

      const { cwd, extraAllowed } = currentReadScope();
      const verdict = assertReadableFilePath(rawPath, cwd, extraAllowed);
      if (!verdict.ok) {
        // "not-a-file" here means glob/argument, never a concrete file.
        return { ok: false, error: verdict.error, message: `read guard rejected: ${verdict.error}` };
      }
      const resolved = verdict.resolved;

      try {
        // Stat first — refuse to buffer a multi-GB file before opening it.
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) {
          return { ok: false, error: "not-a-file", path: resolved, message: "not a regular file" };
        }
        if (stat.size > MAX_TEXT_FILE_BYTES) {
          return {
            ok: false,
            error: "too-large",
            path: resolved,
            bytes: stat.size,
            message: `file ${stat.size} bytes exceeds ${MAX_TEXT_FILE_BYTES}`,
          };
        }
        if (await isBinaryFile(resolved)) {
          return { ok: false, error: "binary-file", path: resolved, bytes: stat.size, message: "binary file" };
        }
        const window = await readTextFileWindow(resolved, 0, PREVIEW_LINE_LIMIT);
        // Audit the preview read the same way a `read_file` tool call is audited
        // — a file left the sandbox boundary for display. The path is redacted
        // (username stripped) via the shared DLP filter, consistent with the
        // frame-guard audit above.
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "preview-read",
          type: "info",
          input: JSON.stringify({
            channel: CHANNELS.preview.readFile,
            path: redactFsPath(resolved),
            bytes: stat.size,
          }),
        });
        return {
          ok: true,
          content: window.lines.join("\n"),
          path: resolved,
          bytes: stat.size,
          truncated: window.truncated,
        };
      } catch (err) {
        return {
          ok: false,
          error: "read-failed",
          path: resolved,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
