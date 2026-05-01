import {
  PATH_COLLAPSE_THRESHOLD,
  type Attachment,
} from "../types/attachments.js";

/**
 * Marker recognized inside textarea body. Three shapes share `#N`:
 *   [Image #1]
 *   [File #2]
 *   [Pasted text #3 +12 lines]
 *
 * The trailing chars after `#N` are loose to tolerate the paste suffix
 * but the regex requires a closing `]` and forbids embedded `[`.
 */
const MARKER_RE = /\[(?:Image|File|Pasted text) #(\d+)(?:\s+\+\d+\s+lines)?\]/g;

/**
 * Parse all marker numbers present in the textarea body.
 * Order of appearance is preserved; duplicates are deduplicated.
 */
export function parseMarkers(text: string): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && !seen.has(n)) {
      seen.add(n);
      result.push(n);
    }
  }
  return result;
}

/**
 * Collapse a long path for display: when the stem (the substring before the
 * last `.`, including any parent directory segments) is ≥
 * PATH_COLLAPSE_THRESHOLD chars, return `first5 + "…" + last5 + .ext`.
 * Otherwise return the original string. The dot in the extension is preserved
 * verbatim — paths without an extension fall back to whole-string collapse.
 *
 * Whole-path (not basename-only) collapse is deliberate: in the overlay we
 * want long absolute paths like `/Users/ken/Desktop/budget-2026.pdf` to
 * remain recognizable on both ends rather than dropping all directory
 * context, which would yield a bare `budget-2026.pdf` and lose the user's
 * mental anchor for *where* the file sits on disk.
 */
export function collapsePath(path: string): string {
  const dotIdx = path.lastIndexOf(".");
  const hasExt = dotIdx > 0 && dotIdx < path.length - 1;
  const stem = hasExt ? path.slice(0, dotIdx) : path;
  const ext = hasExt ? path.slice(dotIdx) : "";
  if (stem.length < PATH_COLLAPSE_THRESHOLD) return path;
  return `${stem.slice(0, 5)}…${stem.slice(-5)}${ext}`;
}

/**
 * Build the textarea marker that represents a given attachment. The renderer
 * inserts this string at the current caret position when an attachment is
 * added, and removes the attachment from state when this marker is later
 * deleted from the body.
 */
export function buildMarkerText(att: Attachment): string {
  switch (att.kind) {
    case "image":
      return `[Image #${att.n}]`;
    case "file":
      return `[File #${att.n}]`;
    case "paste":
      return `[Pasted text #${att.n} +${att.lines} lines]`;
  }
}

/**
 * Locate the marker `[…]` that the caret is currently inside or just after.
 *
 * Backspace UX: when the user presses backspace inside or at the trailing
 * edge of a marker, the entire `[…]` block is removed in one keystroke
 * (Slack-style citation chip). Without this, partial-character deletes
 * invalidate the regex → the chip drops but a `[Image #` fragment is left
 * behind, forcing the user to clean up by hand.
 *
 * The cursor must be strictly after the opening `[` (so caret on the `[`
 * itself does not nuke the chip — that's a left-arrow, not a delete intent)
 * and at most at the position immediately after the closing `]`.
 *
 * Returns null when the caret is not inside any marker.
 */
export function findMarkerAt(
  text: string,
  cursor: number,
): { start: number; end: number } | null {
  if (cursor <= 0 || cursor > text.length) return null;
  let openIdx = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "[") {
      openIdx = i;
      break;
    }
    // A `]` at i = cursor - 1 is the closing bracket of OUR marker — keep
    // walking back. A `]` at any earlier position means the caret sits
    // outside the marker boundary.
    if (ch === "]" && i < cursor - 1) return null;
  }
  if (openIdx === -1) return null;
  const slice = text.slice(openIdx);
  const m = slice.match(/^\[(?:Image|File|Pasted text) #\d+(?:\s+\+\d+\s+lines)?\]/);
  if (!m) return null;
  const end = openIdx + m[0].length;
  if (cursor > openIdx && cursor <= end) return { start: openIdx, end };
  return null;
}
