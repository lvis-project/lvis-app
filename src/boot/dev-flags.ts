/**
 * Dev-mode flag gate (Phase 1 §Step 4).
 *
 * Single source of truth for every `LVIS_DEV*` env var read in main-process
 * code. Each helper hard-gates on `!app.isPackaged` so a packaged production
 * binary launched with these env vars in its environment cannot silently
 * weaken trust (env vars are user-controllable on every desktop OS).
 *
 * Default behaviour: until `setIsPackaged()` is called by boot, helpers
 * report packaged-mode (i.e. flags are IGNORED). This keeps the failure
 * mode safe even if a module reads a flag before boot wires the gate.
 *
 * Electron is intentionally NOT imported here so this module remains
 * unit-testable in node (vitest) without an electron stub.
 *
 * Round-3 cleanup (single direction):
 *  - `LVIS_ALLOW_LINKED_PLUGIN_ENTRY` removed — `LVIS_DEV=1` is the master
 *    dev unlock and already subsumed every use site.
 *  - `LVIS_ALLOW_TEST_MARKETPLACE_KEYS` removed — same rationale.
 *  - Sidecar signature bypass removed with the sidecar gate. Marketplace
 *    envelope verification and install receipt integrity are not bypassable by
 *    dev env flags.
 *  - `LVIS_PLUGINS_DIR` env tier removed from path resolution. Plugin path
 *    overrides flow through constructor injection (`resolvePluginPaths`'s
 *    `pluginsRoot` argument). The env name remains in
 *    {@link shouldWarnPackagedFlagsIgnored} for one release cycle so the
 *    tamper-detect log catches stale launchers.
 *  - `LVIS_DEV_NO_SANDBOX` → `LVIS_WIN_NO_SANDBOX` (separated from the dev
 *    mask; it's a Windows-only sandbox bypass for corp/VDI boxes, not a
 *    dev-mode flag).
 */

let isPackagedCached = true;
let configured = false;

/**
 * Round-4 tamper-detect snapshot.
 *
 * `main.ts` scrubs `LVIS_DEV*` and `LVIS_WIN_NO_SANDBOX` from `process.env`
 * before the renderer / preload / plugin runtime boots in packaged mode. That
 * scrub runs at `main.ts:67-73`, AFTER this module's import (line 20) but
 * BEFORE {@link shouldWarnPackagedFlagsIgnored} is invoked from
 * `plugin-runtime.ts`. Reading `process.env` inside the helper would observe
 * the scrubbed (empty) state and silently disable the audit log.
 *
 * The fix: snapshot which forbidden vars were present at the moment this
 * module first loads. ESM execution order guarantees this top-level body
 * runs before any code in `main.ts`'s module body (including the scrub
 * loop), so the snapshot captures the pre-scrub truth.
 *
 * The snapshot is intentionally a frozen `Set<string>` so neither the helper
 * nor a malicious caller can mutate it after capture.
 */
const PACKAGED_FORBIDDEN_VARS = [
  "LVIS_DEV",
  "LVIS_DEV_RELOAD",
  "LVIS_DEV_CONSOLE",
  "LVIS_WIN_NO_SANDBOX",
  "LVIS_PLUGINS_DIR",
] as const;

const tamperedAtBoot: ReadonlySet<string> = Object.freeze(
  new Set(PACKAGED_FORBIDDEN_VARS.filter((name) => process.env[name] !== undefined)),
);

/**
 * Test-only override of the boot snapshot. Production code never calls
 * this — it only exists because the real snapshot is captured at
 * module-load time and tests can't re-trigger module-load to exercise the
 * warn-true / warn-false branches. Reset to `null` to fall back to the
 * real frozen snapshot.
 */
let tamperedOverrideForTest: ReadonlySet<string> | null = null;

function effectiveTamperedSet(): ReadonlySet<string> {
  return tamperedOverrideForTest ?? tamperedAtBoot;
}

/**
 * Boot calls this once with `app.isPackaged`. Subsequent calls overwrite —
 * tests use this to flip between packaged / unpackaged scenarios.
 */
export function setIsPackaged(packaged: boolean): void {
  isPackagedCached = packaged;
  configured = true;
}

/** Test-only — reset internal state. Not exported via barrel. */
export function _resetForTest(): void {
  isPackagedCached = true;
  configured = false;
  tamperedOverrideForTest = null;
}

function envEquals(name: string, value: string): boolean {
  return process.env[name] === value;
}

/**
 * Core gate: dev mode is unlocked iff (a) the build is unpackaged AND (b) at
 * least one explicit LVIS_DEV* opt-in env var is set. Override `packaged`
 * for tests to avoid relying on the cached state.
 */
export function isDevModeUnlocked(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return (
    envEquals("LVIS_DEV", "1")
    || envEquals("LVIS_DEV_RELOAD", "1")
  );
}

/**
 * Allow a plugin manifest's `entry` to traverse outside the plugin directory
 * (e.g. `../../../node_modules/@lvis/plugin-NAME/dist/hostPlugin.js`). Used
 * by runtime.ts and ipc-bridge.ts.
 */
export function devLinkedEntryAllowed(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return envEquals("LVIS_DEV", "1");
}

/**
 * Allow marketplace `install()` to take the file:-spec / npm-install branch.
 * That branch resolves a sibling repo (e.g. `file:../lvis-plugin-meeting`),
 * spawns `npm install` against `<appRoot>/node_modules`, and writes a manifest
 * entry pointing at the npm-installed package. Useful for fast dev-iterate
 * but must NEVER fire in a packaged build:
 *   1. `<appRoot>/node_modules` is read-only inside Electron's `app.asar`,
 *      so the install hard-fails (Architect B1).
 *   2. The branch bypasses signature envelope verification (Security H-2).
 * Production installs always go through the signed-zip download path.
 */
export function devLinkedInstallAllowed(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return envEquals("LVIS_DEV", "1");
}

/**
 * Plugin live-reload watcher activation gate.
 */
export function devPluginReloadEnabled(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return envEquals("LVIS_DEV_RELOAD", "1");
}

/**
 * Re-inject `--no-sandbox` into the OS-registered `lvis://` protocol command
 * so OS-launched second instances on corp/VDI boxes can clear Chromium's
 * sandbox init failure. Hard-gated on `!packaged` for the same reason as
 * every other dev flag — a packaged binary that inherits this env var must
 * not silently weaken Chromium sandboxing.
 *
 * Round-3: renamed from `LVIS_DEV_NO_SANDBOX` to `LVIS_WIN_NO_SANDBOX` to
 * make the Windows-only intent explicit and decouple it from the dev-mode
 * mask (this flag is needed for `bun run start` on corp Windows even
 * outside a dev session).
 */
export function devNoSandboxAllowed(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return envEquals("LVIS_WIN_NO_SANDBOX", "1");
}

/**
 * Returns true if any LVIS_DEV* / LVIS_WIN_NO_SANDBOX / LVIS_PLUGINS_DIR env
 * var was present at module-load time in a packaged build — caller should
 * log a single audit warning so operators can detect tampered launches.
 *
 * Reads from the {@link tamperedAtBoot} snapshot, NOT live `process.env`.
 * `main.ts:67-73` scrubs these vars from `process.env` before this helper
 * is called from `plugin-runtime.ts`, so a live read would always return
 * `false` and silently defeat the audit log. The snapshot captures presence
 * before the scrub runs (ESM import-order guarantee).
 *
 * `LVIS_PLUGINS_DIR` is intentionally retained here for one release cycle
 * even though path resolution no longer reads it: stale launchers and
 * external scripts may still set it, and the audit log is the only signal
 * an operator gets that someone is shipping packaged builds with dev
 * env vars in the environment.
 */
export function shouldWarnPackagedFlagsIgnored(packaged: boolean = isPackagedCached): boolean {
  if (!packaged) return false;
  return effectiveTamperedSet().size > 0;
}

/**
 * Names of forbidden env vars that were present at module-load time. Empty
 * array if none were set. Callers (e.g. the boot audit log) can use this to
 * surface which specific flags triggered the warning without hand-rolling
 * the same probe at every site.
 *
 * Returns a defensive copy — the underlying snapshot is frozen but this
 * keeps the API symmetric with idiomatic readonly array returns.
 */
export function tamperedVarsAtBoot(): readonly string[] {
  return Array.from(effectiveTamperedSet());
}

/**
 * Test-only — override the boot snapshot. Pass an array of var names to
 * simulate that those vars were present at boot, or `null` to restore the
 * real captured snapshot. Not exported via barrel.
 */
export function _setTamperedSnapshotForTest(names: readonly string[] | null): void {
  tamperedOverrideForTest = names === null ? null : Object.freeze(new Set(names));
}

/** True once boot has called {@link setIsPackaged}. */
export function isConfigured(): boolean {
  return configured;
}

/**
 * Mock fetcher gate — packaged builds must never instantiate
 * `MockMarketplaceFetcher`, which serves catalog from a user-writable
 * `plugins/marketplace.json`. In production the only sanctioned source is
 * `MarketplaceApiFetcher` talking to the marketplace server (envelope
 * signatures are the trust anchor). Pre-Phase-2 review (security-reviewer
 * H-1) showed that allowing the mock in packaged builds would let any user
 * advertise their own plugin as `installPolicy:"admin"` and get it
 * auto-installed by the managed bootstrap.
 *
 * Throws if called in a packaged build. The call site is the
 * `MockMarketplaceFetcher` constructor; the throw is preferred over a quiet
 * return so test fixtures and dev workflows fail loudly when accidentally
 * shipped packaged.
 */
export function assertMockMarketplaceAllowed(packaged: boolean = isPackagedCached): void {
  if (packaged) {
    throw new Error(
      "[security] MockMarketplaceFetcher is dev-only — packaged builds must use MarketplaceApiFetcher",
    );
  }
}

