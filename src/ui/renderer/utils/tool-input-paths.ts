/**
 * Single source of truth for "which file paths did this tool call touch".
 *
 * Two renderer derivations read a `ToolEntryItem`'s input and emit path
 * strings — the chat preview target list (`preview/preview-targets.ts`) and the
 * action panel's file-change/read rows (`utils/action-panel-activity.ts`).
 * They are NOT independent summaries: `ChatView.routeActivity` resolves an
 * action-panel row back against the preview model by exact string equality
 * (`previewModel.targets.find(c => "path" in c && c.path === target)`), so any
 * string one side emits and the other does not is by construction a lookup miss
 * that falls to the file-browser dead-end branch.
 *
 * The tables and the two shape rules therefore live here, once. The remaining
 * traversal/predicate differences between the two modules are deliberate (they
 * have different depth budgets and different bare-filename policies); what must
 * not diverge is the classification vocabulary below.
 */

/** Object keys whose value is understood to name a file, not merely contain one. */
export const TOOL_PATH_KEYS: ReadonlySet<string> = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filepath",
  "filepaths",
  "filename",
  "filenames",
  "target",
  "targets",
]);

/** Tool names whose invocation is a file WRITE regardless of declared category. */
export const FILE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit_file",
  "apply_patch",
  "write_file",
]);

/** Tool-name shape that reads/searches files. */
export const READ_TOOL_PATTERN = /(^|[._:-])(read|open|cat|grep|rg|search|find|list|glob)([._:-]|$)/i;

/**
 * http(s) URLs embedded in free text. Global — only ever used with
 * `String.prototype.matchAll`, which does not mutate `lastIndex`; do not call
 * `.test()` on it.
 */
export const TOOL_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

/**
 * A glob pattern (`**\/*architecture*.md`, `foo?.ts`, `a{b,c}`) is a tool
 * ARGUMENT, not a concrete file, and must never become a file target: it has a
 * `/` and a `.md` tail, so a generic path predicate accepts it. The pattern's
 * real MATCHES are surfaced separately from the tool's result.
 */
export function isGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value) || value.includes("**");
}

/**
 * File paths named by an `apply_patch` body. The patch text is the only place
 * those paths appear — the call's own arguments do not list them — so without
 * this the files an `apply_patch` actually wrote are invisible.
 */
export function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  const pattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(patch)) !== null) {
    const value = match[1]?.trim();
    if (value) paths.push(value);
  }
  return paths;
}
