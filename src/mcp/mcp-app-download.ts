/**
 * MCP Apps `ui/download-file` — the pure parse/decode half of the host handler.
 *
 * The spec's params are `{ contents: (EmbeddedResource | ResourceLink)[] }`, and the two
 * member types are NOT symmetric from a trust standpoint:
 *
 *   · EMBEDDED — the app hands over the BYTES (`blob` base64 / `text`). The host decodes
 *     them, bounds them, and asks the user where to put them. Nothing is fetched.
 *   · RESOURCE LINK — a bare URI the app would like the host to go and GET. The ext-apps
 *     JSDoc example answers it with `window.open(item.uri)`. **That is not acceptable
 *     here.** A resource link is an arbitrary URI authored by an untrusted, sandboxed
 *     iframe; honouring it turns the host into a confused deputy — an egress channel
 *     with the host's network identity (and its cookies, and its allow-list), reachable
 *     without any of the gates a tool call would have taken. So this host does not fetch
 *     app-supplied URIs at all: a `resource_link` is REJECTED, once, right here.
 *
 * That is the whole trust story of this feature, and it is a PARSE-TIME rule rather than
 * a policy sprinkled over the IPC handler: whatever comes out of `parseMcpAppDownload`
 * is inline bytes the app already possessed, bounded, with a filename that cannot escape
 * the directory the user picks. The handler downstream only has to show a save dialog.
 *
 * Everything reachable through here is UNTRUSTED app input. This module classifies and
 * BOUNDS it; the user's own save dialog is the authorization.
 */
import { basename } from "node:path";

/**
 * Hard cap on the TOTAL decoded bytes one `ui/download-file` request may carry. Generous
 * for the real use case (a card exporting the CSV / PNG / PDF it just rendered), tight
 * enough that a card cannot make the host materialize an arbitrarily large buffer in
 * main. Enforced BEFORE any base64 is decoded — the check runs on the encoded length, so
 * an oversize request never allocates the buffer it asked for.
 */
export const MCP_APP_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Hard cap on files per request. Each file costs the user one save dialog, so this is a
 * dialog-spam bound as much as a memory bound.
 */
export const MCP_APP_DOWNLOAD_MAX_FILES = 8;

/** Filename fallback when the app's URI yields nothing usable after sanitizing. */
export const MCP_APP_DOWNLOAD_FALLBACK_FILENAME = "download";

/** Cap on the sanitized filename, well under every filesystem's per-component limit. */
export const MCP_APP_DOWNLOAD_MAX_FILENAME_CHARS = 128;

/**
 * What the host tells the renderer (and, through the bridge handler, the app) — an
 * accept/reject outcome and nothing else. A user CANCEL is `ok: true` with a
 * `cancelled` disposition: declining to save is not an error, and the spec's
 * `McpUiDownloadFileResult.isError` must not be raised for it.
 */
export type McpUiDownloadOutcome =
  | { ok: true; disposition: "saved" | "cancelled" }
  | { ok: false; error: string; message: string };

/** One decoded, bounded, safely-named file, ready for a save dialog. */
export interface McpAppDownloadFile {
  /** Sanitized — a bare filename, never a path. */
  filename: string;
  /** The app's declared type, validated as a media-type token. Used for dialog filters. */
  mimeType?: string;
  bytes: Buffer;
}

export type McpAppDownloadParse =
  | { kind: "ok"; files: McpAppDownloadFile[] }
  | { kind: "invalid"; error: string; message: string };

/** RFC 6838-ish media-type token. Only well-formed types survive; malformed → reject. */
const MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(error: string, message: string): McpAppDownloadParse {
  return { kind: "invalid", error, message };
}

/**
 * Derive a SAFE default filename from the resource's `uri`.
 *
 * The user still confirms the destination in a save dialog, so this is a suggestion —
 * but a suggestion that must not be able to *pre-fill a traversal*. Path separators (both
 * flavours), drive letters, `..` segments, NUL and control characters, and leading dots
 * are all removed, and the result is a bare filename or the fallback. `basename` alone is
 * not enough: it is platform-dependent (POSIX `basename` keeps `..\..\evil.exe` whole).
 */
export function sanitizeDownloadFilename(raw: unknown): string {
  if (typeof raw !== "string") return MCP_APP_DOWNLOAD_FALLBACK_FILENAME;

  // Take the last segment of BOTH separators before basename, so a Windows-style path
  // parsed on POSIX (and vice versa) collapses the same way.
  const lastSegment = raw.split(/[\\/]/).pop() ?? "";
  const name = basename(lastSegment)
    // ONE allow-list, not a stack of per-hazard blocklists: everything outside a
    // conservative, cross-platform-safe set becomes `_`. That covers NUL and control
    // characters, `:` (Windows drive letter / alternate data stream), and the
    // `?`/`*`/`"`/`<`/`>`/`|` class in a single pass.
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // No leading dots (`.`, `..`, and dotfiles that hide the download from the user).
    .replace(/^\.+/, "")
    .slice(0, MCP_APP_DOWNLOAD_MAX_FILENAME_CHARS);

  return name.length > 0 ? name : MCP_APP_DOWNLOAD_FALLBACK_FILENAME;
}

/** Decoded size of a base64 payload — computed from the ENCODED string, before decoding. */
function base64DecodedLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/**
 * Classify + decode one `ui/download-file` request.
 *
 * Fail-closed and ALL-OR-NOTHING: one bad item (a resource link, a malformed resource, a
 * bad media type, an over-cap total) rejects the whole request. Partial honouring would
 * mean the app learns which of its items the host accepted — a probe — and would leave
 * the user staring at a dialog for file 1 of a request the host had already decided was
 * malformed.
 */
export function parseMcpAppDownload(params: unknown): McpAppDownloadParse {
  const record = asRecord(params);
  const contents = record?.contents;
  if (!Array.isArray(contents) || contents.length === 0) {
    return invalid("invalid-contents", "contents must be a non-empty array");
  }
  if (contents.length > MCP_APP_DOWNLOAD_MAX_FILES) {
    return invalid(
      "too-many-files",
      `at most ${MCP_APP_DOWNLOAD_MAX_FILES} files may be downloaded in one request`,
    );
  }

  const files: McpAppDownloadFile[] = [];
  let totalBytes = 0;

  for (const item of contents) {
    const block = asRecord(item);
    if (!block) return invalid("invalid-content-block", "each content item must be an object");

    // THE rule: the host never fetches a URI on an untrusted app's behalf.
    if (block.type === "resource_link") {
      return invalid(
        "resource-link-unsupported",
        "the host does not fetch app-supplied URIs; embed the bytes as a resource instead",
      );
    }
    if (block.type !== "resource") {
      return invalid("invalid-content-block", `unsupported content type '${String(block.type)}'`);
    }

    const resource = asRecord(block.resource);
    if (!resource) return invalid("invalid-content-block", "resource must be an object");

    const mimeType = resource.mimeType;
    if (mimeType !== undefined && (typeof mimeType !== "string" || !MIME_TYPE_RE.test(mimeType))) {
      return invalid("invalid-mime-type", "mimeType must be a well-formed media type");
    }

    const { blob, text } = resource;
    let bytes: Buffer;
    if (typeof blob === "string") {
      // Bound BEFORE decoding — the whole point of checking the encoded length.
      if (totalBytes + base64DecodedLength(blob) > MCP_APP_DOWNLOAD_MAX_BYTES) {
        return invalid("too-large", `download exceeds ${MCP_APP_DOWNLOAD_MAX_BYTES} bytes`);
      }
      bytes = Buffer.from(blob, "base64");
    } else if (typeof text === "string") {
      if (totalBytes + Buffer.byteLength(text, "utf8") > MCP_APP_DOWNLOAD_MAX_BYTES) {
        return invalid("too-large", `download exceeds ${MCP_APP_DOWNLOAD_MAX_BYTES} bytes`);
      }
      bytes = Buffer.from(text, "utf8");
    } else {
      return invalid("invalid-resource", "resource must carry `blob` (base64) or `text`");
    }

    // `Buffer.from(…, "base64")` is lenient (it silently drops non-alphabet characters),
    // so re-check the DECODED length rather than trusting the estimate above.
    totalBytes += bytes.byteLength;
    if (totalBytes > MCP_APP_DOWNLOAD_MAX_BYTES) {
      return invalid("too-large", `download exceeds ${MCP_APP_DOWNLOAD_MAX_BYTES} bytes`);
    }

    files.push({
      filename: sanitizeDownloadFilename(resource.uri),
      ...(typeof mimeType === "string" ? { mimeType } : {}),
      bytes,
    });
  }

  return { kind: "ok", files };
}
