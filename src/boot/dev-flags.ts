/**
 * Dev-mode flag gate (Phase 1 §Step 4).
 *
 * Single source of truth for every `LVIS_DEV*` / `LVIS_ALLOW_*` env var read
 * in main-process code. Each helper hard-gates on `!app.isPackaged` so a
 * packaged production binary launched with these env vars in its environment
 * cannot silently weaken trust (env vars are user-controllable on every
 * desktop OS).
 *
 * Default behaviour: until `setIsPackaged()` is called by boot, helpers
 * report packaged-mode (i.e. flags are IGNORED). This keeps the failure
 * mode safe even if a module reads a flag before boot wires the gate.
 *
 * Electron is intentionally NOT imported here so this module remains
 * unit-testable in node (vitest) without an electron stub.
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
    || envEquals("LVIS_ALLOW_LINKED_PLUGIN_ENTRY", "1")
    || envEquals("LVIS_ALLOW_TEST_MARKETPLACE_KEYS", "1")
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
  return envEquals("LVIS_DEV", "1") || envEquals("LVIS_ALLOW_LINKED_PLUGIN_ENTRY", "1");
}

/**
 * Include marketplace test keys in the bundled publisher key set. Test keys
 * must NEVER be trusted in a packaged build.
 */
export function testMarketplaceKeysAllowed(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return envEquals("LVIS_ALLOW_TEST_MARKETPLACE_KEYS", "1") || envEquals("LVIS_DEV", "1");
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
 */
export function devNoSandboxAllowed(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return envEquals("LVIS_DEV_NO_SANDBOX", "1");
}

/**
 * Returns true if any LVIS_DEV* / LVIS_ALLOW_* env var is set in a packaged
 * build — caller should log a single audit warning so operators can detect
 * tampered launches without the helper leaking which flag.
 */
export function shouldWarnPackagedFlagsIgnored(packaged: boolean = isPackagedCached): boolean {
  if (!packaged) return false;
  return (
    process.env.LVIS_DEV !== undefined
    || process.env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY !== undefined
    || process.env.LVIS_ALLOW_TEST_MARKETPLACE_KEYS !== undefined
    || process.env.LVIS_DEV_SKIP_SIG !== undefined
    || process.env.LVIS_DEV_RELOAD !== undefined
    || process.env.LVIS_DEV_NO_SANDBOX !== undefined
  );
}

/** True once boot has called {@link setIsPackaged}. */
export function isConfigured(): boolean {
  return configured;
}
