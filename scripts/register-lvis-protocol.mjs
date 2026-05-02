#!/usr/bin/env node
/**
 * macOS-only: inject `CFBundleURLTypes` for `lvis://` into the vendored
 * Electron.app's Info.plist so unpackaged dev builds can claim the protocol.
 *
 * Why: `app.setAsDefaultProtocolClient("lvis", execPath, args)` only works
 * reliably when the calling process's Info.plist *statically* declares the
 * URL scheme. Without this, macOS LaunchServices stores `LSHandlerRoleAll =
 * com.github.electron` but no app instance actually claims the URL — every
 * `lvis://...` click fails with "주소가 유효하지 않다" / "no application knows
 * how to open URL". See issue #459.
 *
 * Dev-only — does NOT touch production builds: `electron-builder` regenerates
 * the packaged `.app`'s Info.plist from `package.json` `build.mac.*` at
 * release time, so the dev edit here has no effect on the signed artifact.
 *
 * Code-signing note: mutating any file inside `Electron.app` invalidates
 * Apple's signature on the vendored bundle. This is fine for dev (Electron
 * launches via direct path; macOS Gatekeeper only checks on first quarantine
 * download). `electron-rebuild` already breaks the same signature when it
 * swaps native modules, so this is additive, not novel.
 *
 * What this does (macOS only):
 *   1. Locate `node_modules/electron/dist/Electron.app/Contents/Info.plist`
 *   2. If `CFBundleURLTypes` already includes `lvis`, no-op
 *   3. Otherwise compose a deduped array (filtering malformed entries) and
 *      `plutil -replace` it. `-replace` creates-or-overwrites in one shot,
 *      which is also why the second run on an already-injected plist is a
 *      no-op (the early-exit at step 2 catches it before any mutation).
 *
 * Idempotent: re-running is a no-op when the scheme is present. Wired into
 * `postinstall` so every `bun install` re-applies after Electron is restored.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const electronDir = resolve(repoRoot, "node_modules/electron");
const plistPath = resolve(electronDir, "dist/Electron.app/Contents/Info.plist");

if (!existsSync(plistPath)) {
  console.error(`[register-lvis-protocol] Info.plist not found: ${plistPath}`);
  process.exit(0); // soft-fail — postinstall must not break for missing electron
}

// Containment check — refuse to mutate a path that escapes the expected
// vendored Electron directory (e.g. via a planted symlink). The script writes
// blindly via plutil so a malicious symlink could otherwise redirect the edit
// to e.g. `~/Library/LaunchAgents/foo.plist`. Soft-fail if real path drifts.
let realRoot;
let realPlist;
try {
  realRoot = realpathSync(electronDir);
  realPlist = realpathSync(plistPath);
} catch (err) {
  console.error("[register-lvis-protocol] realpath failed:", err?.message);
  process.exit(0);
}
if (!realPlist.startsWith(realRoot + "/")) {
  console.error(
    `[register-lvis-protocol] Info.plist resolves outside electron dir (${realPlist}) — refusing to edit`,
  );
  process.exit(0);
}

const SCHEME = "lvis";
const ENTRY_NAME = "com.lge.lvis.dev"; // disambiguate from production build.appId in lsregister dumps

function reportSpawnFailure(label, r) {
  if (r.error) {
    console.error(`[register-lvis-protocol] ${label} spawn error:`, r.error.message);
  } else {
    console.error(`[register-lvis-protocol] ${label} failed:`, r.stderr || `(exit ${r.status})`);
  }
}

function readUrlTypes() {
  const r = spawnSync(
    "plutil",
    ["-extract", "CFBundleURLTypes", "json", "-o", "-", realPlist],
    { encoding: "utf8" },
  );
  // `r.error` is the canonical spawn-time failure signal (ENOENT, EACCES) —
  // surface that loudly so a stripped CI image isn't an invisible regression.
  // `r.error` set ⇒ `r.status === null`, but the converse isn't true (a
  // signal-killed plutil also gives `r.status === null` with `r.signal` set
  // and `r.error == null`), so prefer the explicit `r.error` check.
  if (r.error) {
    reportSpawnFailure("plutil -extract", r);
    return null;
  }
  // Non-zero status here typically means the CFBundleURLTypes key isn't
  // present — that's a legitimate first-run state on a clean Electron.app.
  // Stay silent on read failures; any real plist corruption will resurface
  // when `plutil -replace` runs below.
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

const existing = readUrlTypes();
const baseList = Array.isArray(existing) ? existing : [];

// Dedupe: keep only well-formed dict entries that don't already declare lvis.
// A malformed entry (string, null, missing CFBundleURLSchemes) would be
// preserved as-is by a naive spread and `plutil -replace` would then rewrite
// the array with the malformed entry intact — risking a structurally invalid
// CFBundleURLTypes. Filter to objects only.
const cleaned = baseList.filter(
  (e) => e !== null && typeof e === "object" && !Array.isArray(e),
);
const already = cleaned.some(
  (e) => Array.isArray(e?.CFBundleURLSchemes) && e.CFBundleURLSchemes.includes(SCHEME),
);
if (already) {
  process.exit(0);
}

const next = [
  ...cleaned,
  { CFBundleURLName: ENTRY_NAME, CFBundleURLSchemes: [SCHEME] },
];
const r = spawnSync(
  "plutil",
  ["-replace", "CFBundleURLTypes", "-json", JSON.stringify(next), realPlist],
  { encoding: "utf8" },
);
if (r.status !== 0) {
  reportSpawnFailure("plutil -replace", r);
  process.exit(0);
}

console.log(`[register-lvis-protocol] injected lvis:// scheme into ${realPlist}`);
