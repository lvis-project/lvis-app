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

export type AttachmentKind = "image" | "file" | "paste";

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

export type Attachment = ImageAttachment | FileAttachment | PasteAttachment;
