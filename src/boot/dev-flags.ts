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
    || envEquals("LVIS_DEV_SKIP_SIG", "1")
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
 * Include marketplace test keys in the bundled publisher key set. Test keys
 * must NEVER be trusted in a packaged build.
 */
export function testMarketplaceKeysAllowed(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return envEquals("LVIS_DEV", "1");
}

/**
 * Skip plugin manifest signature verification entirely (dev escape hatch
 * for fast-iterate). Production builds must always verify.
 */
export function devSkipSignature(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return envEquals("LVIS_DEV_SKIP_SIG", "1");
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
 * Returns true if any LVIS_DEV* / LVIS_PLUGINS_DIR env var is set in a
 * packaged build — caller should log a single audit warning so operators
 * can detect tampered launches without the helper leaking which flag.
 *
 * `LVIS_PLUGINS_DIR` is intentionally retained here for one release cycle
 * even though path resolution no longer reads it: stale launchers and
 * external scripts may still set it, and the audit log is the only signal
 * an operator gets that someone is shipping packaged builds with dev
 * env vars in the environment.
 */
export function shouldWarnPackagedFlagsIgnored(packaged: boolean = isPackagedCached): boolean {
  if (!packaged) return false;
  return (
    process.env.LVIS_DEV !== undefined
    || process.env.LVIS_DEV_SKIP_SIG !== undefined
    || process.env.LVIS_DEV_RELOAD !== undefined
    || process.env.LVIS_WIN_NO_SANDBOX !== undefined
    || process.env.LVIS_PLUGINS_DIR !== undefined
  );
}

/** True once boot has called {@link setIsPackaged}. */
export function isConfigured(): boolean {
  return configured;
}

/**
 * Mock fetcher gate — packaged builds must never instantiate
 * `MockMarketplaceFetcher`, which serves catalog from a user-writable
 * `plugins/marketplace.json`. In production the only sanctioned source is
 * `RealCloudMarketplaceFetcher` talking to the marketplace server (envelope
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
      "[security] MockMarketplaceFetcher is dev-only — packaged builds must use RealCloudMarketplaceFetcher",
    );
  }
}
