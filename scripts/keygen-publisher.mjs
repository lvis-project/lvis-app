#!/usr/bin/env node
/**
 * Phase 5 — generate a fresh ed25519 publisher keypair.
 *
 * Outputs PEM-encoded private + public keys to stdout (private first, then
 * public). Intended for bootstrapping a new publisher identity in dev/CI.
 *
 * Usage:
 *   node scripts/keygen-publisher.mjs          # both keys to stdout
 *   node scripts/keygen-publisher.mjs --help
 *
 * Store the private key in LGE IT secrets vault and inject at CI time as
 * LVIS_PUBLISHER_SIGNING_KEY. Add the public key to
 * src/plugins/publisher-keys.ts (BUNDLED_PUBLISHER_PUBLIC_KEYS) so the host
 * will accept signatures made with the new key.
 *
 * SECURITY: never commit a private key to git. Never paste it into chat or
 * issue trackers. Rotate within 24h if suspected compromise.
 */
import { generateKeyPairSync } from "node:crypto";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    `Generate an ed25519 publisher keypair.\n\n` +
      `Usage: node scripts/keygen-publisher.mjs [--annotated]\n\n` +
      `Default: emits raw PEM private key, blank line, then raw PEM public key.\n` +
      `         Safe to pipe directly into env var or secrets store.\n\n` +
      `--annotated: prefix each block with # comment lines for human readability.\n` +
      `             Do NOT use when pasting into an env var (comments break PEM parse).\n\n` +
      `Pipe private key to a secure secrets store; add public key to\n` +
      `src/plugins/publisher-keys.ts for host-side verification.\n`,
  );
  process.exit(0);
}

const annotated = args.includes("--annotated");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
const publicPem = publicKey.export({ format: "pem", type: "spki" });

if (annotated) {
  process.stdout.write("# ---- LVIS publisher PRIVATE key (ed25519, PKCS8 PEM) ----\n");
  process.stdout.write("# STORE IN SECRETS VAULT. NEVER COMMIT.\n");
}
process.stdout.write(privatePem);
process.stdout.write("\n");
if (annotated) {
  process.stdout.write("# ---- LVIS publisher PUBLIC key (ed25519, SPKI PEM) ----\n");
  process.stdout.write("# Add to src/plugins/publisher-keys.ts BUNDLED_PUBLISHER_PUBLIC_KEYS.\n");
}
process.stdout.write(publicPem);
