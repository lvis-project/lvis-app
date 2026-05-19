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
 *
 * Extended env vars captured (#893 full-config expansion):
 *   LVIS_DEMO_BASEURL_<VENDOR>   — Azure Foundry / custom endpoint URL
 *   LVIS_DEMO_MODEL_<VENDOR>     — default model id (optional override)
 *   LVIS_DEMO_VERTEX_PROJECT     — Vertex AI GCP project (vertex-ai only)
 *   LVIS_DEMO_VERTEX_LOCATION    — Vertex AI GCP region (vertex-ai only)
 *
 * #893 top-level login toggle:
 *   LVIS_DEMO_VENDOR             — kebab-case vendor id the backend should
 *                                  log the user in as. Default
 *                                  `"azure-foundry"` (Path 2 hotfix: LGE
 *                                  internal demo target).
 *                                  Read via `getDemoActiveVendor()`.
 *
 * Path 2 hotfix (LGE internal demo):
 *   When `LVIS_DEMO_KEY_AZURE_FOUNDRY` / `LVIS_DEMO_BASEURL_AZURE_FOUNDRY`
 *   are absent and `getDemoVendorConfig("azure-foundry")` would otherwise
 *   return `null`, a baked-in LGE-issued endpoint + key is returned. This
 *   is *security-reviewed user-authorized hardcoding* — see the PR
 *   description for the constraint envelope (LGE internal demo only,
 *   reachable only via `/etc/hosts` map to 10.182.192.0/24).
 */
import { createLogger } from "../lib/logger.js";
import { isLLMVendor, type LLMVendor } from "../shared/llm-vendor-defaults.js";

const log = createLogger("demo-credentials");

/**
 * Full vendor configuration provided by the demo/login backend.
 * Fields are optional — only env vars that are present and non-empty
 * are populated. `apiKey` is always required for a successful login.
 */
export interface DemoVendorConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  vertexProject?: string;  // vertex-ai 전용
  vertexLocation?: string; // vertex-ai 전용
}

interface DemoState {
  enabled: boolean;
  user?: string;
  pass?: string;
  /**
   * #893 — vendor the demo/login backend should activate when the user
   * clicks the top-level Login button. Captured from `LVIS_DEMO_VENDOR`
   * (kebab-case); when absent the default `"openai"` is used.
   */
  activeVendor: LLMVendor;
  keys: Map<string, string>;     // vendorSuffix → apiKey
  baseUrls: Map<string, string>; // vendorSuffix → baseUrl
  models: Map<string, string>;   // vendorSuffix → model
  vertexProject?: string;
  vertexLocation?: string;
}

/**
 * Path 2 hotfix — switched from `"openai"` to `"azure-foundry"` so the
 * LGE internal demo loop activates by default. The Azure Foundry endpoint
 * is mapped via Electron `host-resolver-rules` in `demo-host-resolver.ts`
 * (no `/etc/hosts` mutation required).
 *
 * The actual API key + baseUrl MUST be supplied through environment
 * variables before launch (or via the gitignored `.env.demo` file that
 * `bun run start` sources). This file deliberately does NOT bake the
 * Azure API key into source — credentials in git get scanned, leaked,
 * and revoked. See `docs/onboarding/local-demo-setup.md` for the wiring.
 */
const DEFAULT_DEMO_VENDOR: LLMVendor = "azure-foundry";

let captured: DemoState = {
  enabled: false,
  activeVendor: DEFAULT_DEMO_VENDOR,
  keys: new Map(),
  baseUrls: new Map(),
  models: new Map(),
};
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
  const baseUrls = new Map<string, string>();
  const models = new Map<string, string>();

  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (k.startsWith("LVIS_DEMO_KEY_")) {
      const suffix = k.slice("LVIS_DEMO_KEY_".length);
      if (suffix.length > 0) keys.set(suffix, v);
    } else if (k.startsWith("LVIS_DEMO_BASEURL_")) {
      const suffix = k.slice("LVIS_DEMO_BASEURL_".length);
      if (suffix.length > 0) baseUrls.set(suffix, v);
    } else if (k.startsWith("LVIS_DEMO_MODEL_")) {
      const suffix = k.slice("LVIS_DEMO_MODEL_".length);
      if (suffix.length > 0) models.set(suffix, v);
    }
  }

  const vertexProject = process.env.LVIS_DEMO_VERTEX_PROJECT;
  const vertexLocation = process.env.LVIS_DEMO_VERTEX_LOCATION;
  const rawActiveVendor = process.env.LVIS_DEMO_VENDOR;
  const activeVendor: LLMVendor = isLLMVendor(rawActiveVendor)
    ? rawActiveVendor
    : DEFAULT_DEMO_VENDOR;

  captured = {
    enabled,
    activeVendor,
    ...(typeof user === "string" && user.length > 0 ? { user } : {}),
    ...(typeof pass === "string" && pass.length > 0 ? { pass } : {}),
    keys,
    baseUrls,
    models,
    ...(typeof vertexProject === "string" && vertexProject.length > 0 ? { vertexProject } : {}),
    ...(typeof vertexLocation === "string" && vertexLocation.length > 0 ? { vertexLocation } : {}),
  };
  if (enabled) {
    log.info(`demo credentials captured: vendor=${activeVendor} keys=${keys.size} baseUrls=${baseUrls.size} models=${models.size}`);
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

/**
 * #893 — Vendor the top-level Login button should activate. Captured from
 * `LVIS_DEMO_VENDOR`; defaults to `"openai"` when absent or invalid.
 *
 * The auth IPC handler reads this to decide which vendor to persist the
 * demo apiKey under; the renderer never has to pick a vendor when the user
 * is in `authMode === "login"`.
 */
export function getDemoActiveVendor(): LLMVendor {
  return captured.activeVendor;
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

/**
 * Returns the full vendor config (apiKey + optional baseUrl/model/vertex)
 * for the given vendor, or `null` when no apiKey is available.
 *
 * Callers use this instead of `getDemoKey` when they want all demo-sourced
 * fields in one shot so the auth handler can apply the full vendor block.
 */
export function getDemoVendorConfig(vendor: string): DemoVendorConfig | null {
  const suffix = vendor.toUpperCase().replace(/-/g, "_");
  const apiKey = captured.keys.get(suffix);
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;

  const config: DemoVendorConfig = { apiKey };

  const baseUrl = captured.baseUrls.get(suffix);
  if (typeof baseUrl === "string" && baseUrl.length > 0) config.baseUrl = baseUrl;

  const model = captured.models.get(suffix);
  if (typeof model === "string" && model.length > 0) config.model = model;

  if (vendor === "vertex-ai") {
    if (typeof captured.vertexProject === "string" && captured.vertexProject.length > 0) {
      config.vertexProject = captured.vertexProject;
    }
    if (typeof captured.vertexLocation === "string" && captured.vertexLocation.length > 0) {
      config.vertexLocation = captured.vertexLocation;
    }
  }

  return config;
}

/** Test-only reset. Production code must never call this. */
export function resetDemoCredentialsForTesting(): void {
  captured = {
    enabled: false,
    activeVendor: DEFAULT_DEMO_VENDOR,
    keys: new Map(),
    baseUrls: new Map(),
    models: new Map(),
  };
  didCapture = false;
}
