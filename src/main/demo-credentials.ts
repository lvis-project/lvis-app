/**
 * Demo credentials capture (#893 / PR #894 review B1).
 *
 * Mockup login keys (`LVIS_DEMO_KEY_<VENDOR>`) and the `LVIS_DEMO_ENABLED`
 * gate are *dev/demo affordances only*. In packaged builds, `main.ts` scrubs
 * `LVIS_DEV*` / `LVIS_DEMO*` from `process.env` before any preload/renderer
 * inherits the environment. The scrub itself happens early at boot — but
 * the auth IPC handler still needs to know whether demo was enabled and
 * which vendor keys were provided.
 *
 * Solution: capture demo state from `process.env` at module load (very
 * early in `main.ts`, BEFORE the scrub runs), store it in module-scoped
 * state, and expose only typed accessors. After the scrub, the captured
 * values remain but `process.env` no longer leaks them — closing the
 * forensic side-channel without breaking the demo loop. Production builds
 * never call `enableDemoCapture()` (or it would set `enabled=false`), so
 * `registerAuthHandlers` no-ops.
 */
import { createLogger } from "../lib/logger.js";

const log = createLogger("demo-credentials");

interface DemoState {
  enabled: boolean;
  user?: string;
  pass?: string;
  keys: Map<string, string>; // vendor → apiKey
}

let captured: DemoState = { enabled: false, keys: new Map() };
let didCapture = false;

/**
 * Capture demo credential state from `process.env`. Idempotent — repeat
 * calls after the first are no-ops, so the scrub in `main.ts` cannot
 * accidentally wipe a populated capture by re-invoking this helper.
 *
 * MUST be called BEFORE the `process.env` scrub strips `LVIS_DEMO_*`,
 * otherwise the captured map is empty and the auth handler's `no-demo-key`
 * fallback fires.
 */
export function captureDemoCredentials(): void {
  if (didCapture) return;
  didCapture = true;
  const enabled = process.env.LVIS_DEMO_ENABLED === "1";
  const user = process.env.LVIS_DEMO_USER;
  const pass = process.env.LVIS_DEMO_PASS;
  const keys = new Map<string, string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (!k.startsWith("LVIS_DEMO_KEY_")) continue;
    const suffix = k.slice("LVIS_DEMO_KEY_".length);
    if (suffix.length === 0) continue;
    keys.set(suffix, v);
  }
  captured = {
    enabled,
    ...(typeof user === "string" && user.length > 0 ? { user } : {}),
    ...(typeof pass === "string" && pass.length > 0 ? { pass } : {}),
    keys,
  };
  if (enabled) {
    log.info(`demo credentials captured: keys=${keys.size}`);
  }
}

/**
 * `true` when demo mode was enabled via `LVIS_DEMO_ENABLED=1` at boot.
 * Production builds without this env var return `false`, gating the
 * mockup login IPC handler off so the channel never registers.
 */
export function isDemoEnabled(): boolean {
  return captured.enabled;
}

/** Demo user/pass overrides, or `undefined` when the defaults apply. */
export function getDemoCredentials(): { user?: string; pass?: string } {
  return {
    ...(captured.user !== undefined ? { user: captured.user } : {}),
    ...(captured.pass !== undefined ? { pass: captured.pass } : {}),
  };
}

/**
 * Look up the demo apiKey for a vendor id (already kebab-cased). The
 * suffix translation (`azure-foundry` → `AZURE_FOUNDRY`) matches the env
 * naming convention in `demoKeyEnvVar()`.
 */
export function getDemoKey(vendor: string): string | undefined {
  const suffix = vendor.toUpperCase().replace(/-/g, "_");
  return captured.keys.get(suffix);
}

/** Test-only reset. Production code must never call this. */
export function resetDemoCredentialsForTesting(): void {
  captured = { enabled: false, keys: new Map() };
  didCapture = false;
}
