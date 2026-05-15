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
  // Links [text](url) → text. Balance one level of parens inside the URL so
  // `[Foo](https://x.com/path_(v1))` collapses cleanly without a trailing `)`.
  // Run first so `*` inside link text is not eaten by the emphasis passes.
  s = s.replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  // Bold ** (asterisks do not appear in identifiers, so no boundary guard).
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, "$1");
  // Bold __ — guard against intra-identifier matches (`session__id__foo`
  // should NOT become `sessionidfoo`). Require non-word boundaries outside.
  s = s.replace(/(?<![A-Za-z0-9_])__([\s\S]+?)__(?![A-Za-z0-9_])/g, "$1");
  // Strikethrough ~~foo~~
  s = s.replace(/~~([\s\S]+?)~~/g, "$1");
  // Italic *foo*. `[^\s*]` rejects whitespace-led matches so `5 * 6 * 7`
  // is not mis-treated.
  s = s.replace(/\*([^\s*][^*]*?)\*/g, "$1");
  // Italic _foo_ — guard against intra-identifier matches (`my_file.ts`
  // must stay `my_file.ts`, not `myfile.ts`). CommonMark intra-word `_`
  // rule: only word-boundary `_` pairs are italic.
  s = s.replace(/(?<![A-Za-z0-9_])_([^\s_][^_]*?)_(?![A-Za-z0-9_])/g, "$1");
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
