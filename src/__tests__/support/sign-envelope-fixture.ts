/**
 * Shared test fixture: sign an arbitrary body into a `SignatureEnvelope`
 * (`version: 1`, `iat`, `artifact_sha256`, `signatures: [{key_id, alg,
 * sig}]`) with a caller-supplied ed25519 private key.
 *
 * Extracted from `whitelist/__tests__/whitelist-registry.test.ts` so the
 * plugin revocation registry's tests (`revocation/__tests__/`) can reuse it
 * instead of duplicating it — both suites sign a small JSON policy document
 * the exact same way, just with a different key/key_id and body shape.
 * `check:test-duplicates` flags a second copy of this helper.
 */
import { createHash, sign, type KeyObject } from "node:crypto";
import type { SignatureEnvelope } from "../../plugins/types.js";
import { canonicalJSON } from "../../plugins/whitelist/canonical-json.js";

/**
 * Sign `body` (utf-8) with `privateKey`, returning the JSON-stringified
 * envelope a `WhitelistCache`/`RevocationCache`-style fixture stores as the
 * `.sig` sidecar.
 *
 * `privateKey` must be a `KeyObject` (what `generateKeyPairSync("ed25519")`
 * returns when called with no options) — declare the caller's local as
 * `KeyObject` too, not `ReturnType<typeof generateKeyPairSync>["privateKey"]`,
 * which resolves to the union of every overload's return shape and does not
 * type-check against `crypto.sign()`.
 */
export function signEnvelopeFixture(
  body: string,
  privateKey: KeyObject,
  keyId: string,
): string {
  const sigBytes = sign(null, Buffer.from(body, "utf-8"), privateKey);
  const envelope: SignatureEnvelope = {
    version: 1,
    iat: Math.floor(Date.now() / 1000),
    artifact_sha256: createHash("sha256").update(Buffer.from(body, "utf-8")).digest("hex"),
    signatures: [
      { key_id: keyId, alg: "ed25519", sig: sigBytes.toString("base64") },
    ],
  };
  return JSON.stringify(envelope);
}

/**
 * The manifest digest an install receipt / rollback record carries:
 * sha256 over the canonical-JSON form, hex. Three plugin suites computed it
 * inline; the canonical form is the part that must not drift.
 */
export function manifestSha(manifest: unknown): string {
  return createHash("sha256").update(canonicalJSON(manifest)).digest("hex");
}
