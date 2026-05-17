/**
 * Host-owned marketplace trust anchors.
 *
 * Plugin authors consume @lvis/plugin-sdk for type contracts only. Runtime
 * trust roots belong to the LVIS host, matching IDE/browser marketplace
 * models where the client owns verification and the SDK never carries keys.
 */
import type { PublicKeyInput } from "./envelope-verifier.js";

export const MARKETPLACE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "poc-v1": "Qm3FUAMek2r5OkXCurgX6dNYSqiT1GRnjb5fWfuOoao=",
});

export const MARKETPLACE_PRIMARY_KEY_ID = "poc-v1" as const;

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
  // Base64 of raw 32-byte ed25519 public key. Demo snapshot is signed
  // by the matching private key (kept out of this repo); production
  // rotation lands a fresh key id (e.g. "whitelist-v2") here.
  //
  // Ralph cycle 1 — this slot was rotated alongside the demo snapshot
  // re-sign that expanded vendor coverage to claude/gemini/azure-foundry/
  // vertex-ai. The private key that produced
  // `resources/marketplace-whitelist.demo.json.sig` is held by the
  // operator team out-of-band.
  "whitelist-v1": "XvsEdFTepXM7in7TnnsQqtzHLia/ro1idMBqr9kNJzM=",
});

export const WHITELIST_PRIMARY_KEY_ID = "whitelist-v1" as const;
