/**
 * Composer attachment domain IPC handlers.
 * Covers: lvis:attach:openFile, lvis:attach:readImage,
 *         lvis:attach:saveClipboardImage, lvis:attach:openExternal
 *
 * Renderer reaches these via window.lvis.attach.* (see preload.ts).
 */
import { dialog, ipcMain, nativeImage, shell } from "electron";
import { t } from "../../i18n/index.js";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { validateSender, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { DENY_EXTENSIONS as DENY_LIST } from "../../shared/attachments-deny-list.js";

// Convert the shared array into a Set once at module load for O(1) lookup
// in the file-picker hot path. Source of truth lives in the shared module.
const DENY_EXTENSIONS = new Set<string>(DENY_LIST);

/**
 * Session-scoped allowlist of paths the user has explicitly authorized
 * (via the OS file picker or clipboard paste). `readImage` and
 * `openExternal` MUST consult this set before touching the filesystem
 * — otherwise a compromised renderer could pass an arbitrary path
 * (`/Users/.../secrets.json` symlinked to `*.png`) and exfiltrate
 * its contents via the returned dataURL, or launch an attacker-planted
 * binary via shell.openPath.
 *
 * Module-scope, app-lifetime — there is no security benefit to clearing
 * across navigations, and re-prompting the user every chat would be
 * hostile UX. The threat model only requires that paths are
 * user-acknowledged at LEAST ONCE in this app run.
 *
 * Bounded by {@link ATTACH_ALLOWLIST_MAX} with insertion-order LRU
 * eviction (Set iteration order = insertion order; oldest evicted first).
 * Prevents unbounded memory growth in long-lived sessions where a power
 * user might attach thousands of files. Eviction risk is benign — if the
 * user re-attaches a previously evicted path, the OS picker re-authorizes
 * it. The cap is high enough (10k) that normal usage never trips it.
 */
const ATTACH_ALLOWLIST_MAX = 10_000;
const ATTACH_PATH_ALLOWLIST = new Set<string>();
function authorizePath(p: string): void {
  // Re-add to move existing entries to the tail (Set iteration is
  // insertion-order, so deleting + re-adding refreshes recency).
  if (ATTACH_PATH_ALLOWLIST.has(p)) ATTACH_PATH_ALLOWLIST.delete(p);
  ATTACH_PATH_ALLOWLIST.add(p);
  while (ATTACH_PATH_ALLOWLIST.size > ATTACH_ALLOWLIST_MAX) {
    const oldest = ATTACH_PATH_ALLOWLIST.values().next().value;
    if (oldest === undefined) break;
    ATTACH_PATH_ALLOWLIST.delete(oldest);
  }
}

/** Max bytes for a single image read — vision APIs reject larger anyway. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Max bytes for a single clipboard-paste payload before the IPC discards. */
const MAX_CLIP_BYTES = 25 * 1024 * 1024;

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

/**
 * Sniff the image format from the leading bytes of a buffer. Clipboard
 * payloads are not always PNG (Preview pastes WebP, browsers paste JPEG,
 * etc.), so we route extension + mimeType from the actual signature
 * instead of trusting a hard-coded default.
 */
function detectImageFormat(buf: Buffer): { ext: string; mimeType: string } {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mimeType: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mimeType: "image/jpeg" };
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { ext: "gif", mimeType: "image/gif" };
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { ext: "webp", mimeType: "image/webp" };
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { ext: "bmp", mimeType: "image/bmp" };
  }
  // Fallback: trust caller intent — most clipboard pastes from screen-
  // capture utilities are PNG, so we default to PNG rather than
  // application/octet-stream which most vision APIs reject.
  return { ext: "png", mimeType: "image/png" };
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
  /**
   * Base64-encoded image bytes (no `data:` prefix). Format is autodetected
   * from the leading magic bytes — PNG / JPEG / GIF / WebP / BMP all
   * supported. Renderer does not need to negotiate the format up front.
   */
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
      title: t("mainDialog.attachTitle"),
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
        // Authorize this exact path for downstream readImage / openExternal.
        // The user just acknowledged it via the OS picker, so subsequent
        // reads are no longer blind-trusting renderer-supplied paths.
        authorizePath(p);
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
        // Path-allowlist gate: the renderer can ask to read any string,
        // so we MUST verify the path was previously authorized via the
        // OS file picker. Without this gate, a compromised renderer
        // (XSS in a plugin webview, malicious paste-bridge, etc.) could
        // exfiltrate arbitrary files by symlinking them to a `.png`
        // and calling readImage(arbitrary_path).
        if (!ATTACH_PATH_ALLOWLIST.has(filePath)) {
          return { ok: false, error: "path_not_authorized" };
        }
        const ext = getExt(filePath);
        if (!IMAGE_EXTENSIONS.has(ext)) {
          return { ok: false, error: "not_image" };
        }
        // Stat first so we can refuse to buffer a multi-GB file. Vision
        // APIs reject anything beyond ~20MB, so 25MB cap is generous.
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_IMAGE_BYTES) {
          return {
            ok: false,
            error: `image_too_large: ${stat.size} > ${MAX_IMAGE_BYTES}`,
          };
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
        // Cap base64 size before decoding. Without this, a compromised
        // renderer can flood `os.tmpdir()` with multi-GB writes and/or
        // trigger native image-decoder vulnerabilities (e.g. WebP libwebp
        // CVE class) on attacker-shaped buffers in the main process.
        if (typeof input?.base64 !== "string") {
          return { ok: false, error: "invalid_payload" };
        }
        if (input.base64.length > MAX_CLIP_BYTES * 2) {
          // base64 is ~4/3 the binary size, *2 is a generous bound that
          // still rejects pathological multi-GB strings before Buffer.from.
          return {
            ok: false,
            error: `clipboard_too_large: ${input.base64.length} > ${MAX_CLIP_BYTES * 2}`,
          };
        }
        const buf = Buffer.from(input.base64, "base64");
        if (buf.length > MAX_CLIP_BYTES) {
          return {
            ok: false,
            error: `clipboard_too_large: ${buf.length} > ${MAX_CLIP_BYTES}`,
          };
        }
        // Detect actual format from magic bytes — clipboard buffers can be
        // PNG, JPEG, GIF, or WebP depending on source app, and unconditionally
        // labelling everything PNG produces a corrupt data URL on round-trip.
        const detected = detectImageFormat(buf);
        const img = nativeImage.createFromBuffer(buf);
        const { width, height } = img.getSize();
        // Collision-resistant filename: ms-precision timestamp + 8 random
        // hex chars. The previous truncated-to-second ISO format collided
        // when the user pasted multiple images within the same second
        // (e.g. dragging a screenshot burst).
        const ts = Date.now();
        const rand = randomBytes(4).toString("hex");
        const fileName = `lvis-clip-${ts}-${rand}.${detected.ext}`;
        const target = path.join(os.tmpdir(), fileName);
        await fs.writeFile(target, buf);
        // Authorize for downstream readImage / openExternal — we just
        // wrote this file ourselves so it's safe to read back.
        authorizePath(target);
        const dataUrl = `data:${detected.mimeType};base64,${input.base64}`;
        return {
          ok: true,
          path: target,
          width,
          height,
          bytes: buf.length,
          mimeType: detected.mimeType,
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
        // Same allowlist gate as readImage. Without it, a compromised
        // renderer could trigger `shell.openPath("/path/to/malicious.app")`
        // and execute attacker-planted binaries. Re-applying the
        // deny-list also blocks dangerous extensions even if the path
        // somehow ends up in the allowlist via a future bug.
        if (!ATTACH_PATH_ALLOWLIST.has(filePath)) {
          return { ok: false, error: "path_not_authorized" };
        }
        if (DENY_EXTENSIONS.has(getExt(filePath))) {
          return { ok: false, error: "denied_extension" };
        }
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
