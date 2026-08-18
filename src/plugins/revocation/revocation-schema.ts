/**
 * Plugin revocation document JSON schema validator.
 *
 * A security review found LVIS had no way to revoke a plugin version once
 * published: neither a compromised signing key nor a malicious artifact
 * already downloaded/installed could be stopped. Min-version pinning plus an
 * explicit `slug@version` blocklist is the lever every prior-art ecosystem
 * converges on (Firefox add-on blocklist is the closest documented model) —
 * crucially, it works even when the artifact's own signature is still
 * technically valid, because the decision does not depend on the
 * (possibly-compromised) signing key at all.
 *
 * The document is small and hand-validated (no AJV), mirroring
 * `whitelist/whitelist-schema.ts`'s style: descriptive per-field errors,
 * fail-closed on any unknown shape — a malformed document must never be
 * silently treated as "nothing revoked".
 */

/** One explicitly blocked `slug@version` — always requires a human-readable reason. */
export interface RevocationBlockedEntry {
  slug: string;
  version: string;
  reason: string;
}

/** Parsed revocation document — what callers see after `parseRevocationDocument`. */
export interface RevocationDocument {
  version: 1;
  schemaVersion: 1;
  /** ISO-8601 timestamp; the registry uses this for monotonicity (rollback guard). */
  issuedAt: string;
  /**
   * ISO-8601 timestamp. UNLIKE the whitelist's `expiresAt`, this never causes
   * the document to stop being enforced once it is past — a revocation list
   * is a BLOCK list, so the safe default on staleness is "keep blocking",
   * not "stop blocking". It only drives an operational staleness warning
   * (see `revocation-registry.ts`).
   */
  expiresAt: string;
  /** `pluginId → minimum allowed semver`. Below this version, install/load is blocked. */
  minVersions: Record<string, string>;
  /** Explicit `slug@version` blocks — independent of `minVersions`. */
  blocked: RevocationBlockedEntry[];
}

/** ISO-8601 — accept the subset Date.parse round-trips correctly. */
function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/** Loose semver core check — `major.minor.patch` prefix, optional pre-release/build. */
const SEMVER_CORE_PATTERN = /^\d+\.\d+\.\d+/;

function isValidPluginId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isValidVersionString(value: unknown): value is string {
  return typeof value === "string" && SEMVER_CORE_PATTERN.test(value);
}

/**
 * Parse + validate a raw JSON string into a `RevocationDocument`.
 *
 * Fail-closed: any structural or semantic violation throws. The caller
 * (`revocation-registry.ts`) treats a throw as "no valid document" — which
 * for revocation means falling BACK to the last known-good cached document
 * (or, absent any, fail-open) rather than silently accepting malformed input
 * as an empty blocklist.
 */
export function parseRevocationDocument(raw: string): RevocationDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[revocation] JSON parse error: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[revocation] root must be an object");
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.version !== 1) {
    throw new Error(`[revocation] unsupported version: ${String(doc.version)} (expected 1)`);
  }
  if (doc.schemaVersion !== 1) {
    throw new Error(
      `[revocation] unsupported schemaVersion: ${String(doc.schemaVersion)} (expected 1)`,
    );
  }
  if (!isValidIsoTimestamp(doc.issuedAt)) {
    throw new Error(`[revocation] issuedAt must be ISO-8601 timestamp`);
  }
  if (!isValidIsoTimestamp(doc.expiresAt)) {
    throw new Error(`[revocation] expiresAt must be ISO-8601 timestamp`);
  }
  if (Date.parse(doc.expiresAt as string) <= Date.parse(doc.issuedAt as string)) {
    throw new Error(`[revocation] expiresAt must be strictly greater than issuedAt`);
  }

  const minVersionsRaw = doc.minVersions;
  if (!minVersionsRaw || typeof minVersionsRaw !== "object" || Array.isArray(minVersionsRaw)) {
    throw new Error("[revocation] minVersions must be an object");
  }
  const minVersions: Record<string, string> = {};
  for (const [pluginId, rawVersion] of Object.entries(minVersionsRaw as Record<string, unknown>)) {
    if (!isValidPluginId(pluginId)) {
      throw new Error("[revocation] minVersions key must be a non-empty string");
    }
    if (!isValidVersionString(rawVersion)) {
      throw new Error(
        `[revocation] minVersions['${pluginId}'] must be a semver string (got ${JSON.stringify(rawVersion)})`,
      );
    }
    minVersions[pluginId] = rawVersion;
  }

  const blockedRaw = doc.blocked;
  if (!Array.isArray(blockedRaw)) {
    throw new Error("[revocation] blocked must be an array");
  }
  const blocked: RevocationBlockedEntry[] = [];
  const seenSlugVersion = new Set<string>();
  for (let i = 0; i < blockedRaw.length; i += 1) {
    const entry = blockedRaw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`[revocation] blocked[${i}] must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    if (!isValidPluginId(rec.slug)) {
      throw new Error(`[revocation] blocked[${i}].slug must be a non-empty string`);
    }
    if (!isValidVersionString(rec.version)) {
      throw new Error(
        `[revocation] blocked[${i}].version must be a semver string (got ${JSON.stringify(rec.version)})`,
      );
    }
    if (typeof rec.reason !== "string" || rec.reason.length === 0) {
      throw new Error(`[revocation] blocked[${i}].reason must be a non-empty string`);
    }
    const slug = rec.slug as string;
    const versionStr = rec.version as string;
    const dedupeKey = `${slug}@${versionStr}`;
    if (seenSlugVersion.has(dedupeKey)) {
      throw new Error(`[revocation] blocked[${i}] duplicates an earlier entry for ${dedupeKey}`);
    }
    seenSlugVersion.add(dedupeKey);
    blocked.push({ slug, version: versionStr, reason: rec.reason });
  }

  return {
    version: 1,
    schemaVersion: 1,
    issuedAt: doc.issuedAt as string,
    expiresAt: doc.expiresAt as string,
    minVersions,
    blocked,
  };
}
