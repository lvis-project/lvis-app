/**
 * Plugin admission catalog JSON schema validator.
 *
 * The admission catalog is the distributor's ALLOW list: one signed document
 * that names every `slug@version` the marketplace currently admits for
 * installation, the sha256 of the exact bytes it admits under that name, and
 * the publisher it attributes them to.
 *
 * POLARITY — the single most important property of this module, and the
 * reason it is not folded into `revocation/revocation-schema.ts`:
 *
 *   A revocation document is a BLOCK list. Failing to parse it, or holding a
 *   stale one, is survivable by continuing to block — the safe direction is
 *   "keep enforcing what we already know".
 *
 *   An admission catalog is an ALLOW list. The same two conditions have the
 *   opposite safe direction: a document that does not parse must never
 *   collapse into "an empty catalog", and a document past its own `expiresAt`
 *   must stop admitting. Reusing the revocation handling here would silently
 *   invert the security property rather than partially implement it.
 *
 * So: a parse failure is "no valid document" and is fail-closed at the caller
 * (`admission-registry.ts`), which refuses the install. A catalog that
 * legitimately parses to zero admissions is a different in-memory state that
 * also refuses every install — the two must not converge on one value,
 * because only one of them is a statement the issuer actually made.
 *
 * Hand-written (no AJV) in the same style as `revocation-schema.ts`: the
 * document is small, hand-issued by one operator, and this validator sits in
 * the pre-trust path — so descriptive per-field errors and strict rejection of
 * anything unrecognised cost nothing and keep the attacker-reachable surface
 * as small as the primitive it guards.
 */
import { SEMVER_CORE_PATTERN } from "../../shared/semver-compare.js";
import { isValidIsoTimestamp } from "../../shared/marketplace-package-assets.js";

/** One admitted artifact. `(slug, version)` is unique within a document. */
export interface AdmissionEntry {
  slug: string;
  version: string;
  /** Hex sha256 of the artifact tarball bytes admitted under this name. */
  artifactSha256: string;
  /**
   * Who the distributor attributes this artifact to. Written by the issuer
   * from the publishing credential's owner — never copied from the plugin's
   * own manifest, which is attacker-controlled input at this boundary.
   */
  publisher: string;
  /** ISO-8601. When this `slug@version` was first admitted. */
  admittedAt: string;
}

/** Parsed admission catalog — what callers see after `parseAdmissionDocument`. */
export interface AdmissionDocument {
  version: 1;
  schemaVersion: 1;
  /** ISO-8601. Monotonicity anchor — see the rollback guard in the registry. */
  issuedAt: string;
  /**
   * ISO-8601. UNLIKE the revocation document's `expiresAt`, this is a HARD
   * enforcement boundary: once it has passed, this document admits nothing.
   * A stale ALLOW list that keeps allowing turns "we withdrew that version"
   * into "installable forever on every device that ever cached it".
   */
  expiresAt: string;
  /** Every artifact the distributor currently admits for installation. */
  admissions: AdmissionEntry[];
}

/** Keys this schema recognises at the document root. Anything else is rejected. */
const ROOT_KEYS = new Set([
  "version",
  "schemaVersion",
  "issuedAt",
  "expiresAt",
  "admissions",
]);

/** Keys this schema recognises on an entry. Anything else is rejected. */
const ENTRY_KEYS = new Set([
  "slug",
  "version",
  "artifactSha256",
  "publisher",
  "admittedAt",
]);

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function isValidSlug(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function assertNoUnknownKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(
        `[admission] ${where} has unrecognised field '${key}'`
          + ` — an unknown field in a signed statement is how that statement gets weakened later`,
      );
    }
  }
}

/**
 * Parse + validate a raw JSON string into an `AdmissionDocument`.
 *
 * Fail-closed: any structural or semantic violation throws. The caller treats
 * a throw as "no valid document", which for an ALLOW list means it admits
 * nothing — never "nothing is admitted because the list is empty".
 */
export function parseAdmissionDocument(raw: string): AdmissionDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[admission] JSON parse error: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[admission] root must be an object");
  }
  const doc = parsed as Record<string, unknown>;
  assertNoUnknownKeys(doc, ROOT_KEYS, "root");

  if (doc.version !== 1) {
    throw new Error(`[admission] unsupported version: ${String(doc.version)} (expected 1)`);
  }
  if (doc.schemaVersion !== 1) {
    throw new Error(
      `[admission] unsupported schemaVersion: ${String(doc.schemaVersion)} (expected 1)`,
    );
  }
  if (!isValidIsoTimestamp(doc.issuedAt)) {
    throw new Error("[admission] issuedAt must be an ISO-8601 timestamp");
  }
  if (!isValidIsoTimestamp(doc.expiresAt)) {
    throw new Error("[admission] expiresAt must be an ISO-8601 timestamp");
  }
  if (Date.parse(doc.expiresAt as string) <= Date.parse(doc.issuedAt as string)) {
    throw new Error("[admission] expiresAt must be strictly greater than issuedAt");
  }

  const admissionsRaw = doc.admissions;
  if (!Array.isArray(admissionsRaw)) {
    throw new Error("[admission] admissions must be an array");
  }
  const admissions: AdmissionEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < admissionsRaw.length; i += 1) {
    const entry = admissionsRaw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`[admission] admissions[${i}] must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    assertNoUnknownKeys(rec, ENTRY_KEYS, `admissions[${i}]`);

    if (!isValidSlug(rec.slug)) {
      throw new Error(`[admission] admissions[${i}].slug must be a non-empty string`);
    }
    if (typeof rec.version !== "string" || !SEMVER_CORE_PATTERN.test(rec.version)) {
      throw new Error(
        `[admission] admissions[${i}].version must be a semver string (got ${JSON.stringify(rec.version)})`,
      );
    }
    if (typeof rec.artifactSha256 !== "string" || !SHA256_HEX_PATTERN.test(rec.artifactSha256)) {
      throw new Error(
        `[admission] admissions[${i}].artifactSha256 must be 64 lowercase hex characters`,
      );
    }
    if (typeof rec.publisher !== "string" || rec.publisher.length === 0) {
      throw new Error(`[admission] admissions[${i}].publisher must be a non-empty string`);
    }
    if (!isValidIsoTimestamp(rec.admittedAt)) {
      throw new Error(`[admission] admissions[${i}].admittedAt must be an ISO-8601 timestamp`);
    }

    const slug = rec.slug as string;
    const version = rec.version as string;
    const dedupeKey = `${slug}@${version}`;
    if (seen.has(dedupeKey)) {
      // Not last-writer-wins: two rows for one name means two different
      // hashes could be admitted under it, and which one wins would depend on
      // array order in a document an attacker may have influenced.
      throw new Error(`[admission] admissions[${i}] duplicates an earlier entry for ${dedupeKey}`);
    }
    seen.add(dedupeKey);
    admissions.push({
      slug,
      version,
      artifactSha256: rec.artifactSha256 as string,
      publisher: rec.publisher as string,
      admittedAt: rec.admittedAt as string,
    });
  }

  return {
    version: 1,
    schemaVersion: 1,
    issuedAt: doc.issuedAt as string,
    expiresAt: doc.expiresAt as string,
    admissions,
  };
}
