/**
 * Streaming-flow diagnostic logger.
 *
 * Gated by `VITE_DEBUG_STREAM=1` env var (zero overhead when disabled).
 * Used to trace the chat-streaming path top-to-bottom: IPC events,
 * stream-state mutations, classifier output, WorkGroup mount/effect, and
 * handleAsk lifecycle.
 *
 * Usage:
 *   debugLog("WG", "render", { streaming, open });
 *   debugLog("stream", "BEGIN", requestId);
 *
 * Output format:
 *   [lvis-debug:<scope>] <args...>
 *
 * Renderer-safe: guards against missing `process` (esbuild --platform=browser
 * does not shim process.env unless `define` is set). The same guard pattern
 * is used in use-chat-state.ts:78 and is the canonical way to read env in
 * the renderer.
 */
export function debugLog(scope: string, ...args: unknown[]): void {
  // process may be undefined in the bundled renderer — bail safely.
  // Vite/esbuild substitutes `import.meta.env.*` but here we honor the
  // existing convention (process.env.VITE_DEBUG_STREAM) so users only need
  // one switch.
  if (
    typeof process === "undefined" ||
    process.env?.VITE_DEBUG_STREAM !== "1"
  ) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[lvis-debug:${scope}]`, ...args);
}

/**
 * Shorthand for object-style logging when callers want a tagged payload
 * without composing a `{ tag: ... }` object themselves.
 */
export function debugTag(scope: string, tag: string, payload?: Record<string, unknown>): void {
  if (
    typeof process === "undefined" ||
    process.env?.VITE_DEBUG_STREAM !== "1"
  ) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[lvis-debug:${scope}]`, tag, payload ?? {});
}
