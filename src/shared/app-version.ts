/**
 * LVIS app version resolution — single source of truth.
 *
 * Reads the project `package.json` synchronously relative to the bundled
 * `dist/src/main/main.js` so the same logic works in:
 *   - dev   (`electron dist/src/main/main.js`)
 *   - packaged (`app.asar/dist/src/main/main.js`)
 *
 * Why not `app.getVersion()`?
 *   In dev mode `app.getVersion()` returns the *Electron binary* version
 *   (e.g. `41.6.1`) instead of the LVIS project version, because the
 *   project is not packaged. Resolving the LVIS `package.json` relative to
 *   the bundled main entry point gives the correct project version in both
 *   environments and avoids the `electron.app` runtime ordering issues
 *   that affect the bootstrap splash (which executes before `app.whenReady`).
 *
 * Robustness:
 *   - Cached after the first successful read (synchronous, cheap).
 *   - Falls back to `"unknown"` if every candidate path fails — callers
 *     surface this verbatim so regressions are visible (no silent default).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "unknown";

let cachedVersion: string | null = null;

function readVersionFromCandidates(): string {
  // Walk UP from wherever this module is bundled until we reach the LVIS
  // `package.json`. A fixed relative depth (`../../../package.json`) breaks the
  // moment esbuild relocates the code: the startup-bundle split moved it from
  // `dist/src/main/main.js` into `dist/src/main/chunks/*.js`, one level deeper,
  // so the old candidates resolved to `dist/` and the version fell back to
  // "unknown" — which the fail-closed plugin minAppVersion gate then treats as
  // incompatible, blocking every version-gated plugin. Searching upward is
  // depth-agnostic and works in dev (`<repo>/package.json`) and packaged
  // (`app.asar/.../package.json`) alike; the name guard skips any nested
  // (e.g. Electron) package.json encountered on the way up.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    try {
      const raw = readFileSync(resolve(dir, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (
        typeof parsed.version === "string" &&
        parsed.version.length > 0 &&
        (typeof parsed.name !== "string" || parsed.name === "lvis-app")
      ) {
        return parsed.version;
      }
    } catch {
      // No readable package.json at this level — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return FALLBACK_VERSION;
}

/** Returns the LVIS app version (cached). Never throws. */
export function getLvisAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = readVersionFromCandidates();
  return cachedVersion;
}

/** Test-only — resets the memoised value between unit tests. */
export function __resetLvisAppVersionCacheForTest(): void {
  cachedVersion = null;
}
