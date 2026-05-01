/**
 * Composer attachment domain IPC handlers.
 * Covers: lvis:attach:openFile, lvis:attach:readImage,
 *         lvis:attach:saveClipboardImage, lvis:attach:openExternal
 *
 * Renderer reaches these via window.lvis.attach.* (see preload.ts).
 */
import { dialog, ipcMain, nativeImage, shell } from "electron";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateSender, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";

const DENY_EXTENSIONS = new Set([
  "exe",
  "bat",
  "cmd",
  "com",
  "scr",
  "vbs",
  "msi",
  "app",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "sh",
  "ps1",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function getExt(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i + 1).toLowerCase() : "";
}

export interface OpenFileResult {
  canceled: boolean;
  files: Array<{
    path: string;
    name: string;
    ext: string;
    bytes: number;
    isImage: boolean;
    mimeType?: string;
  }>;
  rejected: string[]; // paths rejected by deny-list
}

export interface ReadImageResult {
  ok: boolean;
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  bytes?: number;
  error?: string;
}

export interface SaveClipboardImageInput {
  /** Base64-encoded PNG data (no data: prefix). */
  base64: string;
}

export interface SaveClipboardImageResult {
  ok: boolean;
  path?: string;
  width?: number;
  height?: number;
  bytes?: number;
  mimeType?: string;
  dataUrl?: string;
  error?: string;
}

export function registerAttachHandlers(deps: IpcDeps): void {
  const { auditLogger, getMainWindow } = deps;

  ipcMain.handle("lvis:attach:openFile", async (e): Promise<OpenFileResult> => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:attach:openFile", e);
      return { canceled: true, files: [], rejected: [] };
    }
    const win = getMainWindow();
    if (!win) return { canceled: true, files: [], rejected: [] };

    const result = await dialog.showOpenDialog(win, {
      title: "첨부 파일 선택",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, files: [], rejected: [] };
    }

    const files: OpenFileResult["files"] = [];
    const rejected: string[] = [];
    for (const p of result.filePaths) {
      const ext = getExt(p);
      if (DENY_EXTENSIONS.has(ext)) {
        rejected.push(p);
        continue;
      }
      try {
        const stat = await fs.stat(p);
        const isImage = IMAGE_EXTENSIONS.has(ext);
        files.push({
          path: p,
          name: path.basename(p),
          ext,
          bytes: stat.size,
          isImage,
          mimeType: isImage ? MIME_BY_EXT[ext] : undefined,
        });
      } catch {
        rejected.push(p);
      }
    }
    return { canceled: false, files, rejected };
  });

  ipcMain.handle(
    "lvis:attach:readImage",
    async (e, filePath: string): Promise<ReadImageResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:attach:readImage", e);
        return { ok: false, error: "unauthorized" };
      }
      try {
        const ext = getExt(filePath);
        if (!IMAGE_EXTENSIONS.has(ext)) {
          return { ok: false, error: "not_image" };
        }
        const buf = await fs.readFile(filePath);
        const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
        const img = nativeImage.createFromBuffer(buf);
        const { width, height } = img.getSize();
        const dataUrl = `data:${mimeType};base64,${buf.toString("base64")}`;
        return {
          ok: true,
          dataUrl,
          mimeType,
          width,
          height,
          bytes: buf.length,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "lvis:attach:saveClipboardImage",
    async (e, input: SaveClipboardImageInput): Promise<SaveClipboardImageResult> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:attach:saveClipboardImage", e);
        return { ok: false, error: "unauthorized" };
      }
      try {
        const buf = Buffer.from(input.base64, "base64");
        const img = nativeImage.createFromBuffer(buf);
        const { width, height } = img.getSize();
        const ts = new Date()
          .toISOString()
          .replace(/[:.]/g, "")
          .replace("T", "-")
          .slice(0, 17);
        const fileName = `lvis-clip-${ts}.png`;
        const target = path.join(os.tmpdir(), fileName);
        await fs.writeFile(target, buf);
        const mimeType = "image/png";
        const dataUrl = `data:${mimeType};base64,${input.base64}`;
        return {
          ok: true,
          path: target,
          width,
          height,
          bytes: buf.length,
          mimeType,
          dataUrl,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "lvis:attach:openExternal",
    async (e, filePath: string): Promise<{ ok: boolean; error?: string }> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:attach:openExternal", e);
        return { ok: false, error: "unauthorized" };
      }
      try {
        const result = await shell.openPath(filePath);
        if (result) return { ok: false, error: result };
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
