/**
 * Streaming-flow diagnostic logger.
 *
 * Gated by `VITE_DEBUG_STREAM=1` / preload bridge (cheap disabled fast-path).
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
 * Renderer-safe: prefers the preload bridge (`window.lvis.env.debugStream`)
 * and also honors `import.meta.env.VITE_DEBUG_STREAM` / `process.env` when
 * available.
 */
function isFlagEnabled(value: unknown): boolean {
  return value === "1" || value === "true" || value === true;
}

export function isDebugStreamEnabled(): boolean {
  // Preload is the canonical renderer source because BrowserWindow runs with
  // nodeIntegration disabled, so `process` is not available in normal UI code.
  if (typeof window !== "undefined" && window.lvis?.env?.debugStream === true) {
    return true;
  }

  // Vite-style env fallback for browser/test harnesses that inject it.
  const importMetaEnv = (import.meta as { env?: Record<string, unknown> }).env;
  if (isFlagEnabled(importMetaEnv?.VITE_DEBUG_STREAM)) {
    return true;
  }

  // Node/preload fallback keeps the helper usable outside the renderer.
  return typeof process !== "undefined" && isFlagEnabled(process.env?.VITE_DEBUG_STREAM);
}

export function debugLog(scope: string, ...args: unknown[]): void {
  if (!isDebugStreamEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(`[lvis-debug:${scope}]`, ...args);
}

/**
 * Shorthand for object-style logging when callers want a tagged payload
 * without composing a `{ tag: ... }` object themselves.
 */
export function debugTag(scope: string, tag: string, payload?: Record<string, unknown>): void {
  if (!isDebugStreamEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(`[lvis-debug:${scope}]`, tag, payload ?? {});
}
