#!/usr/bin/env node
/**
 * Phase 5 — ed25519 plugin manifest signing (host-side reference).
 *
 * Plugin repos each ship their own `scripts/sign-manifest.mjs`; this copy lives
 * in lvis-app for reference and for any host-side signing utilities (e.g.
 * bundled-plugin re-signing, CI verification).
 *
 * Usage:
 *   node scripts/sign-manifest.mjs <manifest-path>         # sign -> writes <manifest>.sig
 *   node scripts/sign-manifest.mjs --check <manifest-path> # verify existing .sig
 *   node scripts/sign-manifest.mjs --help
 *
 * Env vars:
 *   LVIS_PUBLISHER_SIGNING_KEY  PEM ed25519 private key (signing mode).
 *   LVIS_PUBLISHER_PUBLIC_KEY   PEM ed25519 public key (verify mode).
 *
 * Dev mode: if signing and LVIS_PUBLISHER_SIGNING_KEY is absent, warn + exit 0.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { resolve } from "node:path";

const USAGE = `Usage:
  node scripts/sign-manifest.mjs <manifest-path>
    Signs the manifest bytes using LVIS_PUBLISHER_SIGNING_KEY (PEM ed25519)
    and writes the base64 signature to <manifest-path>.sig.

  node scripts/sign-manifest.mjs --check <manifest-path>
    Verifies <manifest-path>.sig against LVIS_PUBLISHER_PUBLIC_KEY (PEM).

  node scripts/sign-manifest.mjs --help
    Show this help.

Env:
  LVIS_PUBLISHER_SIGNING_KEY  PEM ed25519 private key (sign mode).
  LVIS_PUBLISHER_PUBLIC_KEY   PEM ed25519 public key (verify mode).

Dev mode: if signing and LVIS_PUBLISHER_SIGNING_KEY is unset, the script warns
and exits 0 so "bun run build" still succeeds locally. Production builds set
the env var in CI secrets.
`;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(args.length === 0 ? 1 : 0);
}

const checkMode = args.includes("--check");
const manifestArg = args.find((a) => !a.startsWith("--"));
if (!manifestArg) {
  console.error("[sign-manifest] missing <manifest-path>");
  console.error(USAGE);
  process.exit(1);
}

const manifestPath = resolve(process.cwd(), manifestArg);
const sigPath = `${manifestPath}.sig`;

if (!existsSync(manifestPath)) {
  console.error(`[sign-manifest] manifest not found: ${manifestPath}`);
  process.exit(1);
}

if (checkMode) {
  const pubPem = process.env.LVIS_PUBLISHER_PUBLIC_KEY;
  if (!pubPem) {
    console.error("[sign-manifest] --check requires LVIS_PUBLISHER_PUBLIC_KEY (PEM).");
    process.exit(1);
  }
  if (!existsSync(sigPath)) {
    console.error(`[sign-manifest] signature file missing: ${sigPath}`);
    process.exit(1);
  }
  try {
    const manifestBytes = readFileSync(manifestPath);
    const sigText = readFileSync(sigPath, "utf-8").trim();
    const signature = Buffer.from(sigText.replace(/\s+/g, ""), "base64");
    if (signature.length !== 64) {
      throw new Error(`expected 64-byte ed25519 signature, got ${signature.length}`);
    }
    const key = createPublicKey({ key: pubPem, format: "pem" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error(`expected ed25519 public key, got ${key.asymmetricKeyType}`);
    }
    const ok = verify(null, manifestBytes, key, signature);
    if (!ok) {
      console.error("[sign-manifest] signature did NOT verify against provided public key.");
      process.exit(2);
    }
    console.log(`[sign-manifest] OK — ${sigPath} verifies against LVIS_PUBLISHER_PUBLIC_KEY.`);
    process.exit(0);
  } catch (err) {
    console.error(`[sign-manifest] verify failed: ${err.message}`);
    process.exit(1);
  }
}

// Signing mode
const pem = process.env.LVIS_PUBLISHER_SIGNING_KEY;
if (!pem) {
  console.warn(
    "[sign-manifest] LVIS_PUBLISHER_SIGNING_KEY not set — skipping signature (dev mode).",
  );
  process.exit(0);
}

try {
  const manifestBytes = readFileSync(manifestPath);
  const key = createPrivateKey({ key: pem, format: "pem" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`expected ed25519 key, got ${key.asymmetricKeyType}`);
  }
  const signature = sign(null, manifestBytes, key);
  writeFileSync(sigPath, signature.toString("base64"));
  console.log(`[sign-manifest] wrote ${sigPath} (${signature.length} bytes, base64).`);
} catch (err) {
  console.error(`[sign-manifest] signing failed: ${err.message}`);
  process.exit(1);
}
