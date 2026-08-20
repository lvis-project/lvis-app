/**
 * #893 Stage 2 — Host implementation of `hostApi.resolveApiKey()`.
 *
 * Wraps the four-tier secret gate (`runSecretGate`) and returns the SDK's
 * discriminated union (`@lvis/plugin-sdk` → `ResolveApiKeyResult`).
 * On `ok=true` the host yields a one-shot bearer thunk + `release()`; plugins
 * should call `release()` in a `finally` block so the in-memory copy of the
 * key has a deterministic lifetime.
 *
 * Decision tree — the same four tiers `hostApi.getSecret` runs, because both
 * call `runSecretGate`:
 *   - tier-1 own-namespace          → ok=true (vendor = requested vendor or active)
 *   - tier-2 manifest allowlist     → check
 *   - tier-3 whitelist registry     → check (BEFORE Tier-4 — see ORDER below)
 *   - tier-4 active-vendor cross    → reason "vendor-mismatch"
 *   - whitelist no-cache + offline  → reason "not-whitelisted" (closest SDK enum)
 *   - missing key in settings       → reason "no-host-vendor"
 *
 * Tier-3 / Tier-4 ORDER:
 *   Both `getSecret` and `resolveApiKey` now evaluate Tier-3 (whitelist
 *   registry) BEFORE Tier-4 (active-vendor cross-check). The whitelist is
 *   a coarse ACL — it is the static, signed declaration of which plugin
 *   may read which key. The vendor cross-check is per-call and dynamic
 *   (driven by `settings.llm.provider`). Running the coarse ACL first
 *   prevents an unwhitelisted plugin from leaking the dynamic vendor
 *   state via the deny-reason channel.
 *
 * Vendor alias normalization:
 *   The SDK enum (`@lvis/plugin-sdk`) uses
 *   `"openai" | "azure-openai" | "vertex" | "anthropic"`; the host's
 *   internal vendor union (`src/shared/llm-vendor-defaults.ts`) uses
 *   `"openai" | "azure-foundry" | "vertex-ai" | "claude"`. Map the SDK
 *   names to host names at the entry so a Claude-default user and an
 *   plugin that asks for `vendor:"anthropic"` doesn't silently fall into
 *   `not-whitelisted` for a non-existent `llm.apiKey.anthropic` key.
 *
 * Cancellation: when `signal.aborted`, returns `{ ok: false, reason: "aborted" }`
 * before any I/O. On a successful resolve the returned `release()` is wired
 * to fire automatically when the signal aborts mid-flight, so the captured
 * bearer reference is dropped without the plugin having to remember.
 */
import type { SettingsService } from "../../data/settings-store.js";
import type { PluginManifest } from "../../plugins/types.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { shouldBlockPluginSecretRead } from "../../plugins/secret-shape.js";
import {
  hostSecretKeyForVendor,
  runSecretGate,
} from "../../plugins/whitelist/secret-gate.js";
import type { SecretGateOutcome } from "../../plugins/whitelist/secret-gate.js";
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

export type ResolveApiKeyResult =
  | {
      ok: true;
      vendor: string;
      bearer: () => string;
      baseUrl?: string;
      release: () => void;
    }
  | {
      ok: false;
      reason:
        | "no-host-vendor"
        | "vendor-mismatch"
        | "not-whitelisted"
        | "user-mode-plugin"
        | "aborted"
        | "user-endpoint-with-host-key";
    };

export interface ResolveApiKeyRequest {
  purpose: ResolveApiKeyPurpose;
  vendor?: ResolveApiKeyVendor;
  signal?: AbortSignal;
}

export interface ResolveApiKeyDeps {
  pluginId: string;
  // #885 v6 — reads only `hostSecrets` (shared by legacy + normalized manifests).
  manifest: Pick<PluginManifest, "hostSecrets">;
  manifestSha256?: string;
  settingsService: Pick<SettingsService, "get" | "getSecret">;
  auditLogger: Pick<AuditLogger, "log">;
  /**
   * Optional accessor for the PermissionManager's
   * per-plugin revoke signal. When provided, the returned bearer is wired
   * to release on EITHER the caller's signal OR this signal — so a
   * permission rule change aborts the outstanding bearer mid-flight even
   * when the plugin's own `opts.signal` is never aborted. Boot wiring in
   * `plugin-runtime.ts` binds this to `permissionManager.getPluginRevokeSignal`.
   */
  getPluginRevokeSignal?: (pluginId: string) => AbortSignal;
  /**
   * Install-source from the on-disk plugin registry
   * (`PluginRegistryEntry.installSource`). This is the only value that can
   * activate the Tier-3 admin-bypass gate:
   *   - `registry.installSource` is written by the host at install time
   *     under a verified actor; the file lives at
   *     `~/.lvis/plugins/registry.json` and is not part of the plugin's
   *     own writable surface.
   *   - `manifest.installPolicy` is a field inside `plugin.json` — a
   *     user-installed plugin (or a malicious post-install patch) can
   *     flip it to `"admin"` and inherit the Tier-3 bypass.
   * Trust source: registry only. A manifest-only `"admin"` value is advisory
   * metadata and cannot activate the secret-access bypass.
   */
  registryInstallSource?: "admin" | "user" | "local-dev";
  /**
   * Install-time canonical plugin.json SHA from the host-owned plugin
   * registry. Required for admin secret-access bypasses so the bypass cannot
   * survive a post-install manifest swap.
   */
  registryManifestSha256?: string;
}

/**
 * Map SDK-enum vendor names to host internal vendor names. The SDK ships
 * `"openai" | "azure-openai" | "vertex" | "anthropic"`; the host's
 * `LLM_VENDORS` union is
 * `"openai" | "azure-foundry" | "vertex-ai" | "claude" | "gemini" | "copilot"`.
 *
 * Only the three aliases that *differ* between the two surfaces are
 * mapped; `"openai"` passes through unchanged. Adding a new SDK alias
 * needs an entry here AND an `llm.apiKey.<host-vendor>` key wired into
 * the manifest allowlist and host whitelist.
 */
const VENDOR_ALIAS_MAP: Record<string, string> = {
  anthropic: "claude",
  "azure-openai": "azure-foundry",
  vertex: "vertex-ai",
};

function normalizeVendor(v: string): string {
  return VENDOR_ALIAS_MAP[v] ?? v;
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
 * One-shot bearer thunk wired to the request's `AbortSignal`. The captured
 * string is dropped after `release()` so subsequent `bearer()` calls throw
 * `Error("released")` per SDK contract
 * (see `sdk/src/index.ts` `bearer()` docs). Strings in JS are immutable
 * so we cannot literally zero the buffer; the "zeroize" here is a
 * best-effort signal: the reference is dropped, and tests can assert
 * the post-release state.
 *
 * The signal is load-bearing, not advisory: an already-aborted signal at
 * construction time releases immediately, and a mid-flight abort fires a
 * one-shot listener that drops the reference without the caller acting.
 */
function makeSuccess(
  vendor: string,
  value: string,
  signal?: AbortSignal,
  baseUrl?: string,
): ResolveApiKeyResult & { ok: true } {
  let captured: string | null = value;
  const release = () => {
    captured = null;
  };
  if (signal) {
    if (signal.aborted) {
      release();
    } else {
      // `once: true` so the host doesn't leak listeners across hundreds
      // of plugin calls sharing the same long-lived signal (e.g. an
      // overlay session controller's signal).
      signal.addEventListener("abort", release, { once: true });
    }
  }
  const result: ResolveApiKeyResult & { ok: true } = {
    ok: true,
    vendor,
    bearer: () => {
      if (captured === null) {
        throw new Error("released");
      }
      return captured;
    },
    release,
  };
  if (baseUrl !== undefined) {
    (result as { baseUrl?: string }).baseUrl = baseUrl;
  }
  return result;
}

/**
 * Resolve an API key for a plugin. Runs the same 4-tier `runSecretGate` as
 * `hostApi.getSecret`, returning the SDK's discriminated union so plugins can
 * branch on each refusal cause.
 */
export async function resolveApiKey(
  request: ResolveApiKeyRequest,
  deps: ResolveApiKeyDeps,
): Promise<ResolveApiKeyResult> {
  // Merge the caller's per-request signal with the
  // PermissionManager's per-plugin revoke signal so a permission rule
  // change aborts an in-flight bearer even when the plugin's own signal
  // never fires. The merged signal flows into `makeSuccess` and short-
  // circuits the entry-guard below when either signal is already aborted.
  const revokeSignal = deps.getPluginRevokeSignal?.(deps.pluginId);
  const mergedSignal = mergeSignals(request.signal, revokeSignal);
  if (mergedSignal?.aborted) {
    return { ok: false, reason: "aborted" };
  }
  // Default vendor to the user's active LLM provider when the plugin omits
  // it (purpose-only call). This matches the SDK example where the plugin
  // declines to pin a specific provider and asks the host to pick.
  const llmSettings = deps.settingsService.get("llm") as {
    provider?: unknown;
    marketplaceProviderPresetId?: unknown;
  };
  const defaultActiveProvider =
    typeof llmSettings.provider === "string" ? llmSettings.provider : "";
  // Map the SDK vendor enum to the host vendor name so a Claude-default user
  // + `vendor:"anthropic"` request lands on `llm.apiKey.claude`, not a
  // non-existent `llm.apiKey.anthropic`.
  const requestedVendor = request.vendor ?? defaultActiveProvider;
  const normalizedVendor =
    typeof requestedVendor === "string" ? normalizeVendor(requestedVendor) : requestedVendor;
  if (typeof normalizedVendor !== "string" || normalizedVendor.length === 0) {
    return { ok: false, reason: "no-host-vendor" };
  }
  // Audit log records BOTH the requested SDK name and the normalized
  // host name so operators see the alias resolution.
  if (typeof requestedVendor === "string" && requestedVendor !== normalizedVendor) {
    audit(
      deps,
      "info",
      `resolveApiKey vendor_alias requested=${requestedVendor} normalized=${normalizedVendor}`,
    );
  }
  const vendor = normalizedVendor;
  const readGateSettings = () => ({
    llmProvider: defaultActiveProvider,
    marketplaceProviderPresetId: llmSettings.marketplaceProviderPresetId,
    readInstalledProviderPresetIds: () =>
      (
        (
          deps.settingsService.get("marketplace") as {
            installedProviderPresets?: readonly { providerId: string }[];
          }
        ).installedProviderPresets ?? []
      ).map((preset) => preset.providerId),
  });
  // WHICH key holds this vendor's credential is asked once, in the shared gate
  // module. Building `llm.apiKey.<vendor>` inline here is what made the
  // `llm.marketplaceProvider.<presetId>.apiKey` family structurally unreachable
  // through this API even when the manifest and the signed whitelist granted it.
  const llmKey = hostSecretKeyForVendor(vendor, {
    llmProvider: defaultActiveProvider,
    marketplaceProviderPresetId: llmSettings.marketplaceProviderPresetId,
  });
  const keyPrefix = sanitizeKeyPrefix(llmKey);

  // Tier-1 own-namespace shortcut — the plugin asked for *its* key, not a host
  // secret. We still return the bearer through `resolveApiKey` to unify the
  // lifetime contract on the plugin side. A MISS falls through to the host
  // tiers rather than terminating, which is this API's own semantics: it was
  // asked for "a key for this vendor", not for one named key.
  const ownNamespaceKey = `plugin.${deps.pluginId}.llm.apiKey.${vendor}`;
  const ownValue = deps.settingsService.getSecret(ownNamespaceKey);
  if (shouldBlockPluginSecretRead({ pluginId: deps.pluginId, storageKey: ownNamespaceKey, value: ownValue })) {
    audit(
      deps,
      "warn",
      `resolveApiKey deny source=plugin-namespace reason=endpoint-url-in-api-key-like-secret vendor=${vendor} purpose=${request.purpose}`,
    );
    incrementHostSecretCounter("hostSecret_denied", deps.pluginId, keyPrefix);
    return { ok: false, reason: "no-host-vendor" };
  }
  if (typeof ownValue === "string" && ownValue.length > 0) {
    audit(
      deps,
      "info",
      `resolveApiKey allow source=plugin-namespace vendor=${vendor} purpose=${request.purpose}`,
    );
    incrementHostSecretCounter("hostSecret_read", deps.pluginId, keyPrefix);
    return makeSuccess(vendor, ownValue, mergedSignal);
  }

  // #958/#959 security — trust source for the Tier-3 admin-bypass gate:
  // registry-recorded `installSource` (verified at install time, lives outside
  // the plugin's writable surface) is the only admin bypass source.
  // `manifest.installPolicy` is user-writable advisory metadata and never
  // activates the secret-access bypass.
  const gateOutcome = runSecretGate({
    pluginId: deps.pluginId,
    key: llmKey,
    allowlist: deps.manifest.hostSecrets?.read ?? [],
    manifestSha256: deps.manifestSha256,
    installedManifestSha256: deps.registryManifestSha256,
    installPolicy: deps.registryInstallSource === "admin" ? "admin" : "user",
    readSettings: readGateSettings,
  });
  if (gateOutcome.kind === "deny") {
    audit(
      deps,
      "warn",
      `resolveApiKey deny reason=${gateOutcome.reason} vendor=${vendor} (${gateOutcome.tier})`,
    );
    incrementHostSecretCounter("hostSecret_denied", deps.pluginId, keyPrefix);
    if (gateOutcome.tier === "tier-4") {
      return { ok: false, reason: "vendor-mismatch" };
    }
    // Tier-2/Tier-3 deny — map the gate's reasons (`not-allowlisted`,
    // `manifest-sha-mismatch`, `whitelist-unreachable`,
    // `whitelist-stale-exceeded`, `not-whitelisted`) to the SDK enum's narrow
    // `not-whitelisted` slot. The precise reason lives in the audit log.
    return { ok: false, reason: "not-whitelisted" };
  }
  // Admin-bypass audit + counter. Emit an explicit audit line BEFORE the
  // host-secret read so operators can pivot on
  // `policy=admin manifest-allowlist-bypassed` in the audit log even if the
  // subsequent settings lookup fails for an unrelated reason. The dedicated
  // `hostSecret_admin_bypass` counter is on top of the regular
  // `hostSecret_read` increment downstream so totals stay comparable.
  if (gateOutcome.via === "admin-bypass") {
    audit(
      deps,
      "info",
      `resolveApiKey policy=admin manifest-allowlist-bypassed vendor=${vendor} purpose=${request.purpose} source=registry.installSource`,
    );
    incrementHostSecretCounter(
      "hostSecret_admin_bypass",
      deps.pluginId,
      keyPrefix,
    );
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
    `resolveApiKey allow source=${grantAuditSource(gateOutcome.via)} vendor=${vendor} purpose=${request.purpose}`,
  );
  incrementHostSecretCounter("hostSecret_read", deps.pluginId, keyPrefix);

  // azure-foundry needs a baseUrl alongside the bearer — the SDK contract
  // already exposes it. Reach into the per-vendor settings block when
  // the vendor is azure-foundry; otherwise leave baseUrl unset.
  let baseUrl: string | undefined;
  if (vendor === "azure-foundry") {
    const llmSettings = deps.settingsService.get("llm") as {
      vendors?: Record<string, { baseUrl?: string } | undefined>;
    };
    baseUrl = llmSettings?.vendors?.["azure-foundry"]?.baseUrl;
  }
  return makeSuccess(vendor, value, mergedSignal, baseUrl);
}

/**
 * Name the gate path that produced a grant, for the `resolveApiKey allow`
 * audit line.
 *
 * The line used to say `source=whitelist-registry` unconditionally, including
 * on the admin-bypass path — where the signed Tier-3 whitelist ACL is exactly
 * the gate that was NOT consulted. That misreported the grant source to
 * operators auditing host-secret reads.
 *
 * Derived from the `via` discriminator so the source claim has a single
 * authority (`TierOutcome`), and exhaustively matched so a future bypass
 * variant is a compile-time error here rather than a silently wrong audit
 * line — which is the contract `TierOutcome`'s own doc comment promises.
 */
function grantAuditSource(
  via: Extract<SecretGateOutcome, { kind: "allow" }>["via"],
): string {
  switch (via) {
    case "admin-bypass":
      return "registry.installSource";
    case "own-namespace":
      return "plugin-namespace";
    case undefined:
      return "whitelist-registry";
    default: {
      const exhaustive: never = via;
      return exhaustive;
    }
  }
}

/**
 * Combine the caller's per-request signal with the
 * PermissionManager's per-plugin revoke signal into a single AbortSignal.
 * Returns `undefined` when both inputs are absent so the bearer thunk skips
 * the listener wiring entirely. Falls back gracefully when `AbortSignal.any`
 * is unavailable (older Node) by returning the first defined signal — the
 * loss of merge fidelity is preferable to a hard crash on plugin call.
 */
function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (!a && b) return b;
  // Both signals present — use AbortSignal.any when available so the
  // returned signal aborts on whichever fires first.
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") {
    return anyFn([a!, b!]);
  }
  // Fallback for runtimes without AbortSignal.any — prefer the revoke
  // signal so the security guarantee is preserved at the cost of losing
  // the caller's cancellation propagation.
  return b ?? a;
}
