/**
 * Host-owned marketplace trust anchors.
 *
 * Plugin authors consume @lvis/plugin-sdk for type contracts only. Runtime
 * trust roots belong to the LVIS host, matching IDE/browser marketplace
 * models where the client owns verification and the SDK never carries keys.
 */
import type { PublicKeyInput } from "./envelope-verifier.js";

// Key rotation in progress: the marketplace server is migrating its plugin
// signing key from `poc-v1` (proof-of-concept) to `prod-v1` (production).
// Both are active trust anchors during the transition — most catalog plugins
// are still signed with `poc-v1`, while newer re-publishes (e.g. `meeting`)
// carry `prod-v1`. `verifyEnvelope` accepts any key in this map, so keeping
// both lets either generation install. Values are the base64 of the raw
// 32-byte ed25519 public keys. Retire `poc-v1` only after every catalog
// artifact has been re-signed with `prod-v1` (and any offline-cache TTL
// referencing it has expired). NOTE: commit `prod-v1.pub` to
// lvis-marketplace/schemas/keys/ so this anchor has an out-of-band source
// (the repo currently ships only poc-v1.pub).
export const MARKETPLACE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "poc-v1": "Qm3FUAMek2r5OkXCurgX6dNYSqiT1GRnjb5fWfuOoao=",
  "prod-v1": "JnmneLJZ3G9TiC+JU0naTDlOdIHC07PB+BToCIarL8E=",
});

export const MARKETPLACE_PRIMARY_KEY_ID = "prod-v1" as const;

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
  // signs both the offline demo snapshot (`resources/marketplace-whitelist.demo.json.sig`)
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
