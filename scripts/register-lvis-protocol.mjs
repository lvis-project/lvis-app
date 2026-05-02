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
 * What this does (macOS only):
 *   1. Locate `node_modules/electron/dist/Electron.app/Contents/Info.plist`
 *   2. If `CFBundleURLTypes` already includes `lvis`, no-op
 *   3. Otherwise insert a `[{ CFBundleURLName, CFBundleURLSchemes: ["lvis"] }]`
 *      array via `plutil` (which is the safe edit path — no XML rewriting)
 *
 * Idempotent: re-running is cheap and a no-op if already injected. Wired into
 * `postinstall` so every `bun install` re-applies after Electron is restored.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const plistPath = resolve(
  repoRoot,
  "node_modules/electron/dist/Electron.app/Contents/Info.plist",
);

if (!existsSync(plistPath)) {
  console.error(`[register-lvis-protocol] Info.plist not found: ${plistPath}`);
  process.exit(0); // soft-fail — postinstall must not break for missing electron
}

const SCHEME = "lvis";
const ENTRY_NAME = "com.lge.lvis";

function readUrlTypes() {
  const r = spawnSync(
    "plutil",
    ["-extract", "CFBundleURLTypes", "json", "-o", "-", plistPath],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

const existing = readUrlTypes();
if (Array.isArray(existing)) {
  const already = existing.some(
    (e) => Array.isArray(e?.CFBundleURLSchemes) && e.CFBundleURLSchemes.includes(SCHEME),
  );
  if (already) {
    process.exit(0);
  }
  const next = [
    ...existing,
    { CFBundleURLName: ENTRY_NAME, CFBundleURLSchemes: [SCHEME] },
  ];
  const r = spawnSync(
    "plutil",
    ["-replace", "CFBundleURLTypes", "-json", JSON.stringify(next), plistPath],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error("[register-lvis-protocol] plutil -replace failed:", r.stderr);
    process.exit(0);
  }
} else {
  // No CFBundleURLTypes key yet — insert fresh array.
  const fresh = [{ CFBundleURLName: ENTRY_NAME, CFBundleURLSchemes: [SCHEME] }];
  const r = spawnSync(
    "plutil",
    ["-insert", "CFBundleURLTypes", "-json", JSON.stringify(fresh), plistPath],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error("[register-lvis-protocol] plutil -insert failed:", r.stderr);
    process.exit(0);
  }
}

console.log(`[register-lvis-protocol] injected lvis:// scheme into ${plistPath}`);
