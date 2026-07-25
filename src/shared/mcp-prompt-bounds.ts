/**
 * Bounds and name validation for MCP server prompts — shared by all three layers.
 *
 * WHY `shared/`. These constants are a CONTRACT between the client discovery
 * boundary (main), the `mcp:get-prompt` handler (main), and the argument form
 * (renderer). A field the form lets the user fill that main then drops is worse
 * than no field, so they cannot be re-declared per layer. They lived in
 * `mcp/mcp-prompt-render.ts` first, which made the dialog the ONE renderer→`src/mcp`
 * edge that is a value import rather than an erased `import type` — safe only while
 * that module happens to import nothing, an invariant nothing enforced. One added
 * `createLogger` there would have pulled main-process code into the renderer bundle.
 *
 * Pure: no imports, so it stays importable from every process.
 */

/** Hard bound on a prompt NAME (interpolated into audit rows and host chrome). */
export const MCP_PROMPT_NAME_MAX_CHARS = 128;
/** Hard bound on an argument NAME — the handler's key filter and the form agree. */
export const MCP_PROMPT_ARG_NAME_MAX_CHARS = 64;
/** Hard bound on an argument VALUE, applied in the form and again in main. */
export const MCP_PROMPT_ARG_VALUE_MAX_CHARS = 4 * 1024;
/** Hard bound on the rendered text so one prompt cannot flood a turn. */
export const MCP_PROMPT_MAX_CHARS = 16 * 1024;
/** Hard bound on how many message blocks are rendered. */
export const MCP_PROMPT_MAX_BLOCKS = 64;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Is this a name every consumer can carry? Wire data is typed but NOT checked —
 * `prompts/list` output arrives as a cast — so a non-string name would reach the
 * renderer and throw when rendered as a React child, and a name used to index a
 * plain object (`toString`) would read off `Object.prototype`. Control characters
 * are rejected because the name is interpolated into audit lines and labels.
 */
export function isUsablePromptName(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maxChars
    && !CONTROL_CHARS_RE.test(value)
  );
}
