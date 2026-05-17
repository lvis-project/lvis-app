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
// NOT `Object.freeze`-ed so the unit-test harness can swap in a per-test
// ed25519 keypair via `Object.defineProperty` without rebuilding the
// production demo snapshot for every run. Production code never mutates
// this map — adding a key in production goes through a host source-code
// edit (rotation lands a fresh key id like "whitelist-v2" here).
export const WHITELIST_PUBLIC_KEYS: Record<string, PublicKeyInput> = {
  // Base64 of raw 32-byte ed25519 public key. Demo snapshot is signed
  // by the matching private key (kept out of this repo); production
  // rotation lands a fresh key id (e.g. "whitelist-v2") here.
  "whitelist-v1": "zs4kTBATK36qDAwbQCijXJ2htbyO3+MNkOvI6j53E6Q=",
};

export const WHITELIST_PRIMARY_KEY_ID = "whitelist-v1" as const;
