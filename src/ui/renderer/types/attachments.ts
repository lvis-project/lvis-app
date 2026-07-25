/**
 * Composer attachment data model.
 *
 * The composer's textarea is the single source of truth: attachments are
 * derived from markers in the body text via parseMarkers(). Each attachment
 * carries a stable `n` (display number) that is never reassigned even if a
 * lower-numbered attachment is removed — the body marker [Image #2] must
 * always refer to the same payload.
 */

export const ATTACH_MAX_COUNT = 5;

/** Long-text-paste detection threshold: 50+ chars OR 3+ newlines. */
export const PASTE_TEXT_MIN_CHARS = 50;
export const PASTE_TEXT_MIN_NEWLINES = 3;

/**
 * Path-collapse trigger threshold. The check applies to the *stem*: the
 * substring before the last `.` of the input path, including any parent
 * directory segments. See `collapsePath()` for why whole-path collapse
 * (rather than basename-only) is intentional in the overlay UX.
 */
export const PATH_COLLAPSE_THRESHOLD = 10;

/**
 * Extensions that are unconditionally rejected by the file picker.
 * Lowercase comparison; users see a non-blocking error toast on attempt.
 */
export { DENY_EXTENSIONS } from "../../../shared/attachments-deny-list.js";

export type AttachmentKind = "image" | "file" | "paste" | "resource";

export interface ImageAttachment {
  id: string;
  n: number;
  kind: "image";
  path: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  /** Base64 dataURL kept in renderer memory for thumbnail rendering. */
  dataUrl: string;
}

export interface FileAttachment {
  id: string;
  n: number;
  kind: "file";
  path: string;
  name: string;
  ext: string;
  bytes: number;
}

export interface PasteAttachment {
  id: string;
  n: number;
  kind: "paste";
  text: string;
  lines: number;
  chars: number;
}

/**
 * An MCP server resource the user attached with an `@server:uri` mention.
 *
 * `text` is the fenced block the HOST built and handed back — server-authored content
 * inside the host's own untrusted framing. The renderer never assembles or edits it,
 * and never inspects it: it stores the string and passes it back verbatim.
 *
 * It follows the IMAGE model, not the paste model, and that is the load-bearing choice
 * in this whole surface. A paste marker is replaced INLINE in the body at send time, so
 * a resource built that way would ride inside the user's own message text — the one
 * field the per-turn bound does not measure (see `mcp-resource-bounds.ts`). As an image
 * does, the marker stays in the body and the payload leaves as its own content part.
 */
export interface ResourceAttachment {
  id: string;
  n: number;
  kind: "resource";
  serverId: string;
  uri: string;
  /** Display label — the server's `title` or `name`, already bounded by main. */
  label: string;
  /** The host-built fenced block. Opaque to the renderer. */
  text: string;
  /**
   * The read clipped what the server returned, or dropped non-text blocks.
   *
   * The COUNT of omitted blocks is deliberately not carried: the fence body already
   * admits each omission in a line the model reads, so a second copy in renderer state
   * would be a number nothing renders and nothing checks.
   */
  truncated: boolean;
}

export type Attachment =
  | ImageAttachment
  | FileAttachment
  | PasteAttachment
  | ResourceAttachment;
