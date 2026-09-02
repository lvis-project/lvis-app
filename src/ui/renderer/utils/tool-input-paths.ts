/**
 * Single source of truth for "which file paths did this tool call touch".
 *
 * Two renderer derivations read a `ToolEntryItem`'s input and emit path
 * strings — the chat preview target list (`preview/preview-targets.ts`) and the
 * tool activity's file-change/read rows (`utils/tool-activity.ts`).
 * They are NOT independent summaries: `ChatView.routeActivity` resolves an
 * tool-activity row back against the preview model by exact string equality
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

/**
 * What a file-changing call did to the file. `create` / `delete` / `move` are
 * claimed only where the tool contract makes them certain; `modify` where the
 * tool refuses a path that is not an existing regular file; `write` where the
 * call may have created or overwritten and nothing in its arguments or result
 * says which (the builtin `write_file` reports bytes, not prior existence).
 */
export type FileChangeOperation = "create" | "modify" | "delete" | "move" | "write";

/**
 * Tool names whose invocation is a file change regardless of declared
 * category, and the change each one is contractually known to make.
 */
const FILE_CHANGE_TOOL_OPERATIONS: ReadonlyMap<string, FileChangeOperation> = new Map([
  // Both refuse anything but an existing regular file — an edit is a modify.
  ["edit_file", "modify"],
  ["apply_patch", "modify"],
  // "Create or overwrite": prior existence is not in the call's output.
  ["write_file", "write"],
  ["move_file", "move"],
  ["delete_file", "delete"],
]);

/** Tool names whose invocation is a file WRITE regardless of declared category. */
export const FILE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(FILE_CHANGE_TOOL_OPERATIONS.keys());

/**
 * The change a file-changing call made, from its name alone. A tool declared
 * `category: "write"` under a name this module does not know is a `write`:
 * the category says the file changed and nothing says how. `null` means the
 * call is not a file change at all.
 */
export function classifyFileChange(tool: { name: string; category?: string }): FileChangeOperation | null {
  const known = FILE_CHANGE_TOOL_OPERATIONS.get(tool.name);
  if (known) return known;
  return tool.category === "write" ? "write" : null;
}

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
  return extractPatchFileChanges(patch).map((change) => change.path);
}

const PATCH_HEADER_OPERATIONS: Readonly<Record<string, FileChangeOperation>> = {
  Add: "create",
  Update: "modify",
  Delete: "delete",
};

/**
 * The same headers with what each one did: a patch body is the one place a
 * file change states create / update / delete in so many words.
 */
export function extractPatchFileChanges(patch: string): Array<{ path: string; operation: FileChangeOperation }> {
  const changes: Array<{ path: string; operation: FileChangeOperation }> = [];
  const pattern = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(patch)) !== null) {
    const path = match[2]?.trim();
    const operation = PATCH_HEADER_OPERATIONS[match[1] ?? ""];
    if (path && operation) changes.push({ path, operation });
  }
  return changes;
}
