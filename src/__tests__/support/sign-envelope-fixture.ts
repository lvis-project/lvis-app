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
 * A policy document with its detached signature, as a registry cache is served
 * the pair: `body` is the exact bytes that were signed, so a suite that mutates
 * `doc` afterwards is describing a tampered document rather than a second one.
 *
 * Both registry suites build this triple the same way; what differs is the
 * document, and each keeps its own builder for that.
 */
export function signedDocumentFixture<T>(
  doc: T,
  privateKey: KeyObject,
  keyId: string,
): { body: string; signature: string; doc: T } {
  const body = JSON.stringify(doc);
  return { body, signature: signEnvelopeFixture(body, privateKey, keyId), doc };
}

/**
 * The manifest digest an install receipt / rollback record carries:
 * sha256 over the canonical-JSON form, hex. Three plugin suites computed it
 * inline; the canonical form is the part that must not drift.
 */
export function manifestSha(manifest: unknown): string {
  return createHash("sha256").update(canonicalJSON(manifest)).digest("hex");
}

/**
 * A transport that serves one signed policy document and nothing else.
 *
 * The registries take their transport as a required `networkFetch`, so this
 * hands back a `fetch` rather than stubbing the global one: a suite that
 * passes it is exercising the same seam production wires, and a code path that
 * reached for the ambient `fetch` instead would no longer be served by this
 * fixture. `documentFileName` is the document each registry asks for
 * (`whitelist.json`, `revocation.json`); its `.sig` sidecar is served
 * alongside and every other path 404s, which is what an unmatched request
 * should look like.
 */
export function signedDocumentTransport(
  documentFileName: string,
  body: string,
  signature: string,
): typeof fetch {
  return (async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    const payload =
      path.endsWith(`/${documentFileName}`)
        ? body
        : path.endsWith(`/${documentFileName}.sig`)
          ? signature
          : null;
    if (payload === null) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => "not found",
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => payload,
    };
  }) as unknown as typeof fetch;
}
