/**
 * #893 Stage 2 — Marketplace whitelist registry JSON schema validator.
 *
 * The whitelist is a signed remote document hosted at
 * `https://lvis-project.github.io/marketplace-whitelist/v1/whitelist.json`
 * (with a detached `.sig` sibling). Each entry grants a specific plugin id
 * the right to read host-owned secrets named in `hostSecrets.read[]` AND
 * pins the approved manifest sha256 so a swapped manifest is rejected at
 * Tier-3 of the secret gate (`plugin-runtime.ts`).
 *
 * Hand-rolled validator (no AJV) — the document is small (< 64 entries
 * expected) and shipping AJV here pulls in a second schema-compile cost on
 * boot. Mirror style of `src/plugins/runtime/manifest-validation.ts`:
 * descriptive per-field errors, fail-closed on any unknown shape.
 */
import type { SignatureEnvelope } from "../types.js";
import { marketplaceProviderPresetIdFromSecretKey } from "../../shared/marketplace-package-assets.js";

/** Per-plugin grant entry. */
export interface WhitelistPluginGrant {
  publisher: string;
  hostSecrets: {
    read: string[];
  };
  /** Hex sha256 of the approved plugin.json — Tier-3 manifest pin. */
  approvedManifestSha256: string;
}

/** Parsed whitelist document — what callers see after `parseWhitelistDocument`. */
export interface WhitelistDocument {
  version: 1;
  schemaVersion: 1;
  /** ISO-8601 timestamp; the registry uses this for monotonicity (rollback guard). */
  issuedAt: string;
  /** ISO-8601 timestamp; past `expiresAt` triggers the stale-grace window. */
  expiresAt: string;
  pluginGrants: Record<string, WhitelistPluginGrant>;
}

/** Sidecar signature envelope. Mirrors `SignatureEnvelope` for marketplace tarballs. */
export type WhitelistSignatureEnvelope = SignatureEnvelope;

/** Accepted `hostSecrets.read[]` keys — matches manifest-validation.ts. */
const LLM_API_KEY_PATTERN = /^llm\.apiKey\.[a-z]+(?:-[a-z]+)*$/;

function isAllowedHostSecretKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (LLM_API_KEY_PATTERN.test(value) ||
      marketplaceProviderPresetIdFromSecretKey(value) !== undefined)
  );
}

/** ISO-8601 — accept the subset Date.parse round-trips correctly. */
function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/** Hex sha-256 = 64 lowercase hex digits. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Parse + validate a raw JSON string into a `WhitelistDocument`.
 *
 * Fail-closed: any structural or semantic violation throws. The caller is
 * expected to surface the error via audit log; a `null` return would silently
 * accept malformed input.
 */
export function parseWhitelistDocument(raw: string): WhitelistDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[whitelist] JSON parse error: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[whitelist] root must be an object");
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.version !== 1) {
    throw new Error(`[whitelist] unsupported version: ${String(doc.version)} (expected 1)`);
  }
  if (doc.schemaVersion !== 1) {
    throw new Error(
      `[whitelist] unsupported schemaVersion: ${String(doc.schemaVersion)} (expected 1)`,
    );
  }
  if (!isValidIsoTimestamp(doc.issuedAt)) {
    throw new Error(`[whitelist] issuedAt must be ISO-8601 timestamp`);
  }
  if (!isValidIsoTimestamp(doc.expiresAt)) {
    throw new Error(`[whitelist] expiresAt must be ISO-8601 timestamp`);
  }
  if (Date.parse(doc.expiresAt as string) <= Date.parse(doc.issuedAt as string)) {
    throw new Error(`[whitelist] expiresAt must be strictly greater than issuedAt`);
  }
  const grantsRaw = doc.pluginGrants;
  if (!grantsRaw || typeof grantsRaw !== "object" || Array.isArray(grantsRaw)) {
    throw new Error("[whitelist] pluginGrants must be an object");
  }
  const grants: Record<string, WhitelistPluginGrant> = {};
  for (const [pluginId, rawGrant] of Object.entries(grantsRaw as Record<string, unknown>)) {
    if (typeof pluginId !== "string" || pluginId.length === 0) {
      throw new Error("[whitelist] pluginGrants key must be a non-empty string");
    }
    if (!rawGrant || typeof rawGrant !== "object" || Array.isArray(rawGrant)) {
      throw new Error(`[whitelist] pluginGrants['${pluginId}'] must be an object`);
    }
    const grant = rawGrant as Record<string, unknown>;
    if (typeof grant.publisher !== "string" || grant.publisher.length === 0) {
      throw new Error(`[whitelist] pluginGrants['${pluginId}'].publisher must be a non-empty string`);
    }
    if (typeof grant.approvedManifestSha256 !== "string" || !SHA256_HEX_PATTERN.test(grant.approvedManifestSha256)) {
      throw new Error(
        `[whitelist] pluginGrants['${pluginId}'].approvedManifestSha256 must be 64 lowercase hex digits`,
      );
    }
    const hostSecretsRaw = grant.hostSecrets;
    if (!hostSecretsRaw || typeof hostSecretsRaw !== "object" || Array.isArray(hostSecretsRaw)) {
      throw new Error(`[whitelist] pluginGrants['${pluginId}'].hostSecrets must be an object`);
    }
    const readRaw = (hostSecretsRaw as Record<string, unknown>).read;
    if (!Array.isArray(readRaw)) {
      throw new Error(`[whitelist] pluginGrants['${pluginId}'].hostSecrets.read must be an array`);
    }
    const read: string[] = [];
    for (let i = 0; i < readRaw.length; i += 1) {
      const k = readRaw[i];
      if (!isAllowedHostSecretKey(k)) {
        throw new Error(
          `[whitelist] pluginGrants['${pluginId}'].hostSecrets.read[${i}] '${String(k)}' does not match an allowed host-secret key`,
        );
      }
      read.push(k);
    }
    grants[pluginId] = {
      publisher: grant.publisher,
      hostSecrets: { read },
      approvedManifestSha256: grant.approvedManifestSha256.toLowerCase(),
    };
  }
  return {
    version: 1,
    schemaVersion: 1,
    issuedAt: doc.issuedAt as string,
    expiresAt: doc.expiresAt as string,
    pluginGrants: grants,
  };
}
