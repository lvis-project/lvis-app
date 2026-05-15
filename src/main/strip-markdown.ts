/**
 * Strip common markdown formatting for plain-text display.
 *
 * macOS, Windows, and Linux native desktop notifications all treat the
 * `body` field as plain text — a body of `"**Confirm** action"` shows up
 * with the literal asterisks. In-app toast notifications go through
 * the React renderer (which DOES support markdown) and must not be
 * passed through this helper.
 *
 * Handles the small subset of markdown that realistically lands in a
 * notification body capped at ~80 chars: bold, italic, inline code,
 * strikethrough, links, headers, blockquotes, list markers. Block-level
 * elements (fenced code blocks, tables, raw HTML) are out of scope —
 * they should not appear in a notification body.
 */
export function stripMarkdown(input: string): string {
  let s = input;
  // Links [text](url) → text. Run first so `*` inside link text is not
  // eaten by the emphasis passes below.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Bold **foo** / __foo__ — before italic so the doubled markers do not
  // collide with the single-marker italic regex.
  s = s.replace(/(\*\*|__)([\s\S]+?)\1/g, "$2");
  // Strikethrough ~~foo~~
  s = s.replace(/~~([\s\S]+?)~~/g, "$1");
  // Italic *foo* / _foo_. `[^\s*_]` rejects empty / whitespace-led
  // matches so `5 * 6 * 7` isn't mis-treated as `6`.
  s = s.replace(/(\*|_)([^\s*_][^*_]*?)\1/g, "$2");
  // Inline code `foo`
  s = s.replace(/`([^`]+)`/g, "$1");
  // ATX headers (# / ## / ... / ######) at line start
  s = s.replace(/^#{1,6}\s+/gm, "");
  // Blockquote markers at line start
  s = s.replace(/^>\s+/gm, "");
  // Unordered list markers at line start
  s = s.replace(/^[-*+]\s+/gm, "");
  // Ordered list markers at line start
  s = s.replace(/^\d+\.\s+/gm, "");
  return s;
}
