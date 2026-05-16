/**
 * Dev watcher gate: pure helpers for run-electron-dev.mjs.
 *
 * Extracted into a separate module so the polling logic can be unit-tested
 * without spawning real watcher processes. The dev launcher imports these
 * and supplies its own logger / clock.
 */

import { statSync } from "node:fs";

/**
 * Wait for a single watcher's first build.
 *
 * Two detection modes, in priority order:
 *
 * 1. **Process stdout signal** (`watcher.readyPromise`) — when the caller
 *    can intercept the watcher's stdout (e.g. tailwindcss prints
 *    "Done in NNNms", esbuild prints "build finished"), it resolves the
 *    supplied promise on the first match. This is the correct signal
 *    source for any tool with idempotent skip-write — the watcher can
 *    report "rebuilt" without touching the output file.
 *
 * 2. **Output file mtime** (`watcher.output`) — falls back to polling
 *    `mtimeMs ≥ since` when no readyPromise is supplied. Works for
 *    watchers that always rewrite on first invocation.
 *
 * Returns true if either signal arrives within `timeoutMs`, false on timeout.
 */
export async function waitForFirstBuild(watcher, since, timeoutMs, sleepMs = 100) {
  if (watcher.readyPromise) {
    const timeout = new Promise((r) => setTimeout(() => r("__timeout__"), timeoutMs));
    const result = await Promise.race([watcher.readyPromise.then(() => "__ready__"), timeout]);
    return result === "__ready__";
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const st = statSync(watcher.output);
      if (st.mtimeMs >= since) return true;
    } catch {
      // ENOENT — keep polling
    }
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  return false;
}

/**
 * Wait for ALL watchers' first build to complete. Logs per-watcher progress
 * via the supplied `log(tag, msg)` callback so callers can route output
 * however they like (terminal, file, IPC). Returns true only if every
 * watcher succeeded inside `timeoutMs`.
 */
export async function waitForAllFirstBuilds(
  watchers,
  since,
  log,
  options = {},
) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const sleepMs = options.sleepMs ?? 100;
  const remaining = new Set(watchers.map((w) => w.tag));
  const list = () =>
    watchers.filter((w) => remaining.has(w.tag)).map((w) => w.tag).join(" ");

  log(
    "progress",
    `waiting for first build (${watchers.length} watcher${watchers.length === 1 ? "" : "s"}): ${list()}`,
  );

  const results = await Promise.all(
    watchers.map(async (w) => {
      const wStart = Date.now();
      const ok = await waitForFirstBuild(w, since, timeoutMs, sleepMs);
      const elapsedSec = ((Date.now() - wStart) / 1000).toFixed(1);
      if (ok) {
        remaining.delete(w.tag);
        const left = remaining.size;
        if (left === 0) {
          log("progress", `OK ${w.tag} (${elapsedSec}s) — all watchers ready`);
        } else {
          log("progress", `OK ${w.tag} (${elapsedSec}s) — ${left} remaining: ${list()}`);
        }
      } else {
        log(
          "progress",
          `FAIL ${w.tag} timeout after ${elapsedSec}s — ${w.label} (${w.output})`,
        );
      }
      return { tag: w.tag, ok, elapsedSec };
    }),
  );
  return results.every((r) => r.ok);
}
