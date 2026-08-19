/**
 * Host-owned marketplace trust anchors.
 *
 * Plugin authors consume @lvis/plugin-sdk for type contracts only. Runtime
 * trust roots belong to the LVIS host, matching IDE/browser marketplace
 * models where the client owns verification and the SDK never carries keys.
 */
import type { PublicKeyInput } from "./envelope-verifier.js";

// `prod-v1` is the sole trust anchor. Values are base64 of the raw 32-byte
// ed25519 public key.
//
// `poc-v1` was removed here. Its PRIVATE half is public — it shipped in the
// marketplace repo's test fixtures and was exposed again in a merged public PR
// — so while it stayed in this map anyone able to serve an artifact could sign
// one that every LVIS build accepted. `verifyEnvelope` accepts ANY key in this
// map, which is what made a single burned anchor sufficient.
//
// It could only be dropped once nothing installable still needed it. The
// catalog was re-signed to `prod-v1` (804 of 860 version rows); the 56 that
// remain on `poc-v1` have no artifact file on disk at all — archived plugins
// (`email`, `calendar`) and pre-rename versions (`pageindex`,
// `work-proactive`) — so their download 404s before any signature check runs.
// Verified against the production database and storage before this change.
//
// Adding a second anchor again is a rotation, not a convenience: ship both for
// an overlap window, re-sign the catalog head, then remove the old one.
export const MARKETPLACE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "prod-v1": "JnmneLJZ3G9TiC+JU0naTDlOdIHC07PB+BToCIarL8E=",
});

/**
 * #893 Stage 2 — Trust roots for the marketplace whitelist registry.
 *
 * SEPARATE from `MARKETPLACE_PUBLIC_KEYS` on purpose: the whitelist signs the
 * "which plugin may read which host secret" policy document, the marketplace
 * key signs plugin tarballs. Splitting the trust domains means a marketplace
 * publisher-key compromise cannot rewrite the secret-access policy, and
 * vice versa.
 *
 * Rotation: add the new key id, keep the old one. The cache may still hold a
 * document signed by the previous key; `verifyEnvelope` accepts any key in
 * this map. Remove the old entry once the cache TTL has expired
 * everywhere (currently 7d grace window — see `whitelist-registry.ts`).
 */
// Ralph cycle 1 HIGH fix — `Object.freeze`-ed in production. Tests no
// longer mutate this map; instead `WhitelistRegistry` accepts a
// `publicKeys` constructor parameter (or the singleton's
// `setPublicKeysForTesting()` swap helper). A frozen production map
// closes the supply-chain footgun where an in-process compromise could
// have injected a per-run trust root.
export const WHITELIST_PUBLIC_KEYS: Readonly<Record<string, PublicKeyInput>> = Object.freeze({
  // Base64 of raw 32-byte ed25519 public key. The matching private key
  // signs the bundled offline whitelist snapshot
  // and the live remote registry at
  // `https://lvis-project.github.io/marketplace-whitelist/v1/whitelist.json`.
  // Private key custody: GitHub Actions secret `WHITELIST_SIGNING_KEY`
  // on `lvis-project/marketplace-whitelist` (see SECURITY.md there).
  // Add a new entry (e.g. `whitelist-v2`) on rotation; never remove an
  // active id until every signed artifact referencing it has been
  // republished.
  "whitelist-v1": "N2BcUoKwVGZugKE5w3V8jE/TS/5Mmn8xMTaycBmMzPI=",
});

export const WHITELIST_PRIMARY_KEY_ID = "whitelist-v1" as const;

/**
 * Trust roots for the plugin ADMISSION CATALOG (`plugins/admission/`) — the
 * signed document that binds `slug@version → sha256 + publisher` and is the
 * authority for whether an artifact may be installed at all.
 *
 * A THIRD, SEPARATE domain, and both separations are load-bearing:
 *
 * - Not `MARKETPLACE_PUBLIC_KEYS`. The catalog and the per-artifact envelope
 *   are verified conjunctively while both exist, and the entire value of that
 *   overlap is that one compromised key is not sufficient. Sharing the anchor
 *   would collapse the conjunction back to a single key.
 * - Not the whitelist/revocation domain. Compromising an admission key means
 *   admitting arbitrary bytes under arbitrary slugs — the same power that
 *   compromising the artifact key has today. The revocation document is what
 *   a defender reaches for when exactly that has happened, so it cannot be
 *   signed by the key under suspicion; sharing would hand the same attacker
 *   the ability to un-revoke.
 *
 * Retirement works by REMOVAL, not by annotation: `verifyEnvelope` accepts any
 * key in the map it is handed, so a key that stays in this map stays an
 * admission authority no matter what a comment says about it. Rotation is
 * O(1) here — add the new id, re-sign the ONE document, drop the old id after
 * one catalog TTL — which is the property the per-artifact envelope lacks,
 * where retiring an anchor cost a re-sign of 804 of 860 version rows.
 *
 * EMPTY TODAY, and that is the fail-closed state rather than a placeholder:
 * `admission-registry.ts` refuses every install while this map is empty, and
 * says so with a distinct reason instead of reporting a signature failure.
 * The issuance keypair is generated and held by the operator of
 * `lvis-project/marketplace-whitelist` as a workflow-scoped secret — the same
 * custody model as `WHITELIST_SIGNING_KEY` — so the public half arrives here
 * in the commit that publishes the first catalog and flips
 * `ADMISSION_ENFORCEMENT` to `"enforce"`. Provisioning a value here before
 * that document exists would put a trust anchor in the client for a signer
 * nobody holds.
 */
export const ADMISSION_PUBLIC_KEYS: Readonly<Record<string, PublicKeyInput>> = Object.freeze({});

// Trust root for the plugin revocation registry (min-version pins +
// an explicit `slug@version` blocklist, see `plugins/revocation/`).
//
// Deliberately REUSES the whitelist trust domain above (`WHITELIST_PUBLIC_KEYS`
// / `WHITELIST_PRIMARY_KEY_ID`, imported directly by `revocation-registry.ts`
// under a `REVOCATION_*` alias) rather than minting a third one: like the
// whitelist, this is a small, host-consumed SECURITY POLICY document (not a
// plugin tarball) issued by the same `lvis-project/marketplace-whitelist`
// operator and hosted alongside `whitelist.json`. Reusing the key means one
// rotation event covers both documents, and — the property that actually
// matters here — the revocation trust anchor stays SEPARATE from
// `MARKETPLACE_PUBLIC_KEYS` (the tarball-signing key) for the same reason the
// whitelist does: if the key that signs plugin artifacts is ever
// compromised, that compromise must NOT also let the attacker rewrite which
// versions are revoked. A revocation document is the thing a defender
// reaches for precisely when the artifact-signing key's integrity is in
// question, so it cannot share that key's trust domain.
//
// No separate `REVOCATION_PUBLIC_KEYS` constant is declared here — re-exporting
// the exact same object under a second name is a duplicate-export smell (and
// `check:knip` catches it); the alias is applied at the one import site instead.
