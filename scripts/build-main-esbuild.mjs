#!/usr/bin/env node
// esbuild main-process bundler. Replaces the per-file tsc emit so the
// runtime dependency tree (`ai`, `@ai-sdk/*`, `zod`, `ajv`, `undici`,
// `adm-zip`, `proper-lockfile`) inlines into a single ESM module. Externals
// stay outside the bundle because they either ship native bindings, are
// provided by Electron at runtime, must share a singleton across plugins, or
// need real node_modules paths at runtime.
import { build, context } from "esbuild";
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outfile = resolve(repoRoot, "dist", "src", "main", "main.js");
const watchMode = process.argv.includes("--watch");

// Embedded activation key (internal-distribution builds). An explicit
// `LVIS_EMBED_DEMO_ACTIVATION` env var takes precedence over the
// gitignored repo-root `.env.demo`; neither source present → empty string
// and the login flow keeps the manual activation-key paste input. The
// activation string never enters git — it exists only in the produced
// bundle (see src/main/demo-embedded-activation.ts for the threat-model
// note on collapsing the codec's 2-factor delivery for these builds).
//
// Resolved once per process: under `--watch` the embed is frozen at
// watch-start, so adding or editing `.env.demo` mid-watch requires a
// watcher restart to take effect. The dev flow (`bun run dev`) is
// unaffected — run-electron.mjs injects `.env.demo` into process.env at
// runtime, so the embedded-key path is primarily a packaged-build concern.
//
// #1498 — public/external distribution channel guard. `LVIS_DISTRIBUTION_CHANNEL`
// defaults to "internal" (unset = internal, zero regression for every existing
// build/CI/dev invocation). Only an EXPLICIT "public" value activates the
// guard: embedding a demo activation key into a build destined for an external
// channel would collapse the codec's 2-factor delivery model for an audience
// outside the internal network boundary the threat model assumes (see
// src/main/demo-embedded-activation.ts). Fail loud — same pattern as the
// malformed-key guard below — rather than silently stripping the embed, so a
// misconfigured public release pipeline is caught at build time, not by an
// after-the-fact security review.
const DISTRIBUTION_CHANNEL = (process.env.LVIS_DISTRIBUTION_CHANNEL ?? "internal").trim();
function assertNoPublicEmbed() {
  if (DISTRIBUTION_CHANNEL !== "public") return;
  const hasExplicitEnv = Boolean(process.env.LVIS_EMBED_DEMO_ACTIVATION?.trim());
  const hasEnvDemoFile = existsSync(resolve(repoRoot, ".env.demo"));
  if (hasExplicitEnv || hasEnvDemoFile) {
    process.stderr.write(
      "[esbuild-main] LVIS_DISTRIBUTION_CHANNEL=public forbids an embedded demo " +
        "activation key. Remove LVIS_EMBED_DEMO_ACTIVATION / .env.demo from this " +
        "build's environment, or unset LVIS_DISTRIBUTION_CHANNEL for an internal " +
        "build (see docs/development/release-process.md).\n",
    );
    process.exit(1);
  }
}
assertNoPublicEmbed();

const ACTIVATION_WIRE_RE = /^LVIS-DEMO:v1:[A-Za-z0-9_-]+$/;
function resolveEmbeddedActivationCode() {
  const explicit = process.env.LVIS_EMBED_DEMO_ACTIVATION?.trim();
  if (explicit) {
    // Fail loud on a malformed env embed — same no-silent-downgrade rule
    // the `.env.demo` branch below honors. A typo'd / plaintext / truncated
    // value would otherwise ship `autoActivatable=true` and silently
    // degrade to the manual-paste fallback on first launch, defeating the
    // zero-input goal. Structural check only (cheap); the full GCM decrypt
    // still happens at runtime in lvis:demo:activate-embedded.
    if (!ACTIVATION_WIRE_RE.test(explicit)) {
      process.stderr.write(
        "[esbuild-main] LVIS_EMBED_DEMO_ACTIVATION is set but is not a valid " +
          "LVIS-DEMO:v1:<base64url> string — refusing to embed a malformed key\n",
      );
      process.exit(1);
    }
    return explicit;
  }
  const envDemoPath = resolve(repoRoot, ".env.demo");
  if (!existsSync(envDemoPath)) return "";
  // Reuse the canonical encrypt CLI so the embed path and the manual
  // issuance path share one codec source of truth (bun runs the TS
  // script natively — same toolchain as the rest of the build).
  const encrypt = spawnSync(
    "bun",
    [resolve(repoRoot, "scripts", "encrypt-demo-credentials.ts"), envDemoPath],
    { encoding: "utf8" },
  );
  if (encrypt.status !== 0) {
    // A present-but-unusable `.env.demo` is a build error, not a silent
    // downgrade to manual activation — fail loud so the packaging machine
    // never ships a build that quietly lost its zero-input demo flow.
    process.stderr.write(
      `[esbuild-main] embedded activation encrypt failed: ${encrypt.stderr || encrypt.error?.message || "unknown"}\n`,
    );
    process.exit(1);
  }
  return encrypt.stdout.trim();
}

const embeddedActivationCode = resolveEmbeddedActivationCode();
process.stdout.write(
  `[esbuild-main] embedded activation key: ${embeddedActivationCode.length > 0 ? "present" : "absent"}\n`,
);

const buildOptions = {
  entryPoints: [resolve(repoRoot, "src", "main.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  legalComments: "none",
  define: {
    __LVIS_EMBEDDED_DEMO_ACTIVATION_CODE__: JSON.stringify(embeddedActivationCode),
  },
  external: [
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
    // Because this bundle is `bundle:true` + `format:esm` with no splitting,
    // esbuild would INLINE a reachable dynamic import of ASRT into main.js,
    // which rewrites `import.meta.url` to main.js's own path — so the
    // `../../vendor/...` walk resolves to the wrong directory and the vendor
    // binaries cannot be found at runtime (the same failure class pino hit).
    // Keeping ASRT external makes it a real node_modules entry that resolves
    // its vendor dir at runtime. Its transitive deps (`@pondwader/socks5-server`,
    // `shell-quote`, `node-forge`, `commander`, `zod`) ride along automatically:
    // esbuild stops at the external boundary and never bundles them, so they
    // resolve from node_modules normally. If either side of the pair is
    // dropped, the runtime vendor smoke (scripts/asrt-runtime-smoke.mjs) fails.
    "@anthropic-ai/sandbox-runtime",
  ],
  logLevel: "info",
  // Inlined CommonJS modules reference CJS-only `require` directly; the ESM
  // bundle doesn't define it, so we shim it from `import.meta.url`. We
  // intentionally do NOT declare `__dirname` / `__filename` here — esbuild
  // hoists `var __dirname = ...` from inlined CJS modules to the bundle's
  // top-level scope, which collides with `const __dirname = ...` from this
  // banner and produces `SyntaxError: Identifier '__dirname' has already
  // been declared` at load time. The inlined CJS modules compute their own
  // `__dirname` / `__filename` locally, so a banner shim is not needed.
  banner: {
    js:
      `import { createRequire as __lvisCreateRequire } from "node:module";\n` +
      `const require = __lvisCreateRequire(import.meta.url);\n`,
  },
};

// In one-shot mode, force a clean build by removing the stale output first.
// In watch mode, esbuild atomically overwrites the output — pre-deleting
// would only force the dev launcher to wait an extra round trip for the
// initial build (and momentarily breaks fs.watch on the output).
if (!watchMode) {
  rmSync(outfile, { force: true });
}

if (watchMode) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  process.stdout.write(`[esbuild-main] watching -> ${outfile}\n`);
} else {
  const result = await build(buildOptions);

  if (result.errors.length > 0) {
    process.stderr.write(`[esbuild-main] failed with ${result.errors.length} errors\n`);
    process.exit(1);
  }

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      process.stderr.write(`[esbuild-main] warning: ${warning.text}\n`);
    }
    if (process.env.LVIS_ALLOW_ESBUILD_WARN !== "1") {
      process.stderr.write(
        `[esbuild-main] ${result.warnings.length} warning(s); set LVIS_ALLOW_ESBUILD_WARN=1 to bypass\n`,
      );
      process.exit(1);
    }
  }

  process.stdout.write(`[esbuild-main] OK -> ${outfile}\n`);
}
