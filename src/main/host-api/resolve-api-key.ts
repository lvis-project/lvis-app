/**
 * #893 Stage 2 — Host implementation of `hostApi.resolveApiKey()`.
 *
 * Wraps the four-tier secret gate (`plugin-runtime.ts:getSecret`) and
 * returns the SDK's discriminated union (`@lvis/plugin-sdk` → `ResolveApiKeyResult`).
 * On `ok=true` the host yields a one-shot bearer thunk + `release()`; plugins
 * should call `release()` in a `finally` block so the in-memory copy of the
 * key has a deterministic lifetime.
 *
 * Decision tree (mirrors `plugin-runtime.ts:getSecret`):
 *   - tier-1 own-namespace          → ok=true (vendor = requested vendor or active)
 *   - tier-2 manifest allowlist     → check
 *   - tier-3 whitelist registry     → check
 *   - tier-4 active-vendor cross    → reason "vendor-mismatch"
 *   - whitelist no-cache + offline  → reason "not-whitelisted" (closest SDK enum)
 *   - missing key in settings       → reason "no-host-vendor"
 *
 * Cancellation: when `signal.aborted`, returns `{ ok: false, reason: "aborted" }`
 * before any I/O.
 */
import type { ResolveApiKeyResult } from "@lvis/plugin-sdk";
import type { SettingsService } from "../../data/settings-store.js";
import type { PluginManifest } from "../../plugins/types.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { whitelistRegistry } from "../../plugins/whitelist/whitelist-registry.js";
import {
  incrementHostSecretCounter,
  sanitizeKeyPrefix,
} from "../../telemetry/host-secret-counters.js";

export type ResolveApiKeyPurpose = "llm" | "stt" | "embedding" | "vision";
export type ResolveApiKeyVendor =
  | "openai"
  | "azure-openai"
  | "vertex"
  | "anthropic";

export interface ResolveApiKeyRequest {
  purpose: ResolveApiKeyPurpose;
  vendor?: ResolveApiKeyVendor;
  signal?: AbortSignal;
}

export interface ResolveApiKeyDeps {
  pluginId: string;
  manifest: PluginManifest;
  manifestSha256?: string;
  settingsService: Pick<SettingsService, "get" | "getSecret">;
  auditLogger: Pick<AuditLogger, "log">;
}

function audit(deps: ResolveApiKeyDeps, level: "info" | "warn", message: string): void {
  try {
    deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "plugin",
      type: level,
      input: `[plugin:${deps.pluginId}] ${message}`,
    });
  } catch {
    /* audit must not break host */
  }
}

/**
 * One-shot bearer thunk. The captured string is dropped after `release()` so
 * subsequent `bearer()` calls observe an empty string. Strings in JS are
 * immutable so we cannot literally zero the buffer; the "zeroize" here is a
 * best-effort signal: the reference is dropped, and tests can assert the
 * post-release state.
 */
function makeSuccess(vendor: string, value: string): ResolveApiKeyResult & { ok: true } {
  let captured: string | null = value;
  return {
    ok: true,
    vendor,
    bearer: () => captured ?? "",
    release: () => {
      captured = null;
    },
  };
}

/**
 * Resolve an API key for a plugin. Mirrors the 4-tier gate in
 * `plugin-runtime.ts:getSecret`, returning the SDK's discriminated union so
 * plugins can branch on each refusal cause.
 */
export async function resolveApiKey(
  request: ResolveApiKeyRequest,
  deps: ResolveApiKeyDeps,
): Promise<ResolveApiKeyResult> {
  if (request.signal?.aborted) {
    return { ok: false, reason: "aborted" };
  }
  // Default vendor to the user's active LLM provider when the plugin omits
  // it (purpose-only call). This matches the SDK example where the plugin
  // declines to pin a specific provider and asks the host to pick.
  const activeProvider = deps.settingsService.get("llm").provider as string;
  const vendor = request.vendor ?? activeProvider;
  if (typeof vendor !== "string" || vendor.length === 0) {
    return { ok: false, reason: "no-host-vendor" };
  }
  const llmKey = `llm.apiKey.${vendor}`;
  const keyPrefix = sanitizeKeyPrefix(llmKey);

  // Tier-1 own namespace shortcut — the plugin asked for *its* key, not a
  // host secret. We still return the bearer through `resolveApiKey` to
  // unify the lifetime contract on the plugin side.
  const ownNamespaceKey = `plugin.${deps.pluginId}.llm.apiKey.${vendor}`;
  const ownValue = deps.settingsService.getSecret(ownNamespaceKey);
  if (typeof ownValue === "string" && ownValue.length > 0) {
    audit(
      deps,
      "info",
      `resolveApiKey allow source=plugin-namespace vendor=${vendor} purpose=${request.purpose}`,
    );
    incrementHostSecretCounter("hostSecret_read", deps.pluginId, keyPrefix);
    return makeSuccess(vendor, ownValue);
  }

  // Tier-2 manifest allowlist.
  const allowlist = deps.manifest.hostSecrets?.read ?? [];
  if (!allowlist.includes(llmKey)) {
    audit(
      deps,
      "warn",
      `resolveApiKey deny reason=not-whitelisted vendor=${vendor} (manifest)`,
    );
    incrementHostSecretCounter("hostSecret_denied", deps.pluginId, keyPrefix);
    return { ok: false, reason: "not-whitelisted" };
  }

  // Tier-4 active-vendor cross-check (run before the registry so a
  // vendor-mismatch surfaces with the dedicated SDK enum rather than being
  // masked by the registry's `not-whitelisted` denial).
  if (vendor !== activeProvider) {
    audit(
      deps,
      "warn",
      `resolveApiKey deny reason=vendor-mismatch requested=${vendor} active=${activeProvider}`,
    );
    incrementHostSecretCounter("hostSecret_denied", deps.pluginId, keyPrefix);
    return { ok: false, reason: "vendor-mismatch" };
  }

  // Tier-3 whitelist registry.
  const decision = whitelistRegistry.isAllowed(
    deps.pluginId,
    llmKey,
    deps.manifestSha256,
  );
  if (decision.kind === "deny") {
    audit(
      deps,
      "warn",
      `resolveApiKey deny reason=${decision.reason} vendor=${vendor} (whitelist)`,
    );
    incrementHostSecretCounter("hostSecret_denied", deps.pluginId, keyPrefix);
    // Map registry reasons to SDK enum. `manifest-sha-mismatch` /
    // `whitelist-unreachable` / `whitelist-stale-exceeded` all surface as
    // `not-whitelisted` to the plugin — the SDK enum is intentionally
    // narrow; the detailed reason lives in the audit log for operators.
    return { ok: false, reason: "not-whitelisted" };
  }

  // All four tiers passed — fetch the key from settings.
  const value = deps.settingsService.getSecret(llmKey);
  if (typeof value !== "string" || value.length === 0) {
    audit(deps, "info", `resolveApiKey deny reason=no-host-vendor vendor=${vendor}`);
    incrementHostSecretCounter("hostSecret_denied", deps.pluginId, keyPrefix);
    return { ok: false, reason: "no-host-vendor" };
  }
  audit(
    deps,
    "info",
    `resolveApiKey allow source=whitelist-registry vendor=${vendor} purpose=${request.purpose}`,
  );
  incrementHostSecretCounter("hostSecret_read", deps.pluginId, keyPrefix);
  return makeSuccess(vendor, value);
}
