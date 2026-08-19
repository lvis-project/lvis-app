/**
 * The packages the main-process bundle must NOT inline.
 *
 * Extracted from `build-main-esbuild.mjs` so the CHILD-ENTRY smoke test can
 * bundle `plugin-child-main.ts` against the same boundary the shipped entry is
 * built against. A second hand-written list would be a second thing to keep in
 * step with the reasons below, and each reason is a runtime failure someone
 * already hit.
 */
export const MAIN_BUNDLE_EXTERNALS = [
  "electron",
  "electron-updater",
  "better-sqlite3",
  // node-pty is a native addon (`.node` + spawn-helper) the main process
  // resolves unbundled from node_modules (asarUnpack'd). Bundling it inline
  // would break the prebuild `.node` resolution the same way better-sqlite3
  // / ASRT would — keep it external so it ships as a real node_modules entry.
  "node-pty",
  "@sentry/electron",
  "fsevents",
  // Pino transports spawn worker_threads via thread-stream and resolve the
  // worker entry + transport target (e.g. pino-pretty) as filesystem paths
  // under node_modules. Bundling pino inlines the source but leaves the
  // worker unable to resolve those paths — first log call exits with
  // "the worker has exited" (reproduced on Windows after PR #706). Keep
  // pino + its transitive worker deps external so they ship as real
  // node_modules entries the worker can resolve.
  "pino",
  "pino-pretty",
  "thread-stream",
  "@pinojs/redact",
  "pino-abstract-transport",
  "pino-std-serializers",
  "sonic-boom",
  "quick-format-unescaped",
  "split2",
  "safe-stable-stringify",
  "process-warning",
  "real-require",
  "atomic-sleep",
  "on-exit-leak-free",
  // ── ASRT (Anthropic sandbox-runtime) — MUST stay external ────────────
  // INVARIANT (PAIRED with the `asarUnpack` of
  // `node_modules/@anthropic-ai/sandbox-runtime/vendor/**` in package.json;
  // the foundation PR added that unpack): ASRT locates its own vendor
  // binaries (Linux seccomp loader, Windows srt-win.exe) filesystem-relative
  // to its module — `dist/sandbox/generate-seccomp-filter.js` does
  // `dirname(fileURLToPath(import.meta.url))` then joins `../../vendor/...`.
  // Because this build is `bundle:true` + `format:esm`, esbuild would INLINE
  // ASRT into an emitted chunk,
  // which rewrites `import.meta.url` to that chunk's own path — so the
  // `../../vendor/...` walk resolves to the wrong directory and the vendor
  // binaries cannot be found at runtime (the same failure class pino hit).
  // Keeping ASRT external makes it a real node_modules entry that resolves
  // its vendor dir at runtime. Its transitive deps (`@pondwader/socks5-server`,
  // `shell-quote`, `node-forge`, `commander`, `zod`) ride along automatically:
  // esbuild stops at the external boundary and never bundles them, so they
  // resolve from node_modules normally. If either side of the pair is
  // dropped, the runtime vendor smoke (scripts/asrt-runtime-smoke.mjs) fails.
  "@anthropic-ai/sandbox-runtime",
];
