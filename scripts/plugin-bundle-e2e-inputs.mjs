#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const LOCKED_SDK = /@lvis\/plugin-sdk@github:lvis-project\/lvis-plugin-sdk#([0-9a-f]{7,40})/;

function fail(message) {
  throw new Error(`[plugin-bundle-e2e-inputs] ${message}`);
}

export function requireFullSha(label, value) {
  if (!FULL_SHA.test(value ?? "")) {
    fail(`${label} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function git(repoRoot, ...args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function requireCheckout(label, repoRoot, expectedSha) {
  const actual = git(repoRoot, "rev-parse", "HEAD");
  if (actual !== expectedSha) {
    fail(`${label} checkout is ${actual}, expected ${expectedSha}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function verifyPluginBundleE2EInputs({
  hostRoot,
  sdkRoot,
  marketplaceRoot,
  epApiRoot,
  hostSha,
  sdkSha,
  marketplaceSha,
  epApiSha,
}) {
  const refs = {
    host: requireFullSha("HOST_SHA", hostSha),
    sdk: requireFullSha("SDK_SHA", sdkSha),
    marketplace: requireFullSha("MARKETPLACE_SHA", marketplaceSha),
    epApi: requireFullSha("EP_API_SHA", epApiSha),
  };

  requireCheckout("Host", hostRoot, refs.host);
  requireCheckout("SDK", sdkRoot, refs.sdk);
  requireCheckout("Marketplace", marketplaceRoot, refs.marketplace);
  requireCheckout("ep-api", epApiRoot, refs.epApi);

  const epPackage = readJson(resolve(epApiRoot, "package.json"));
  const expectedDependency = `github:lvis-project/lvis-plugin-sdk#${refs.sdk}`;
  const runtimeDependency = epPackage.dependencies?.["@lvis/plugin-sdk"];
  const buildDependency = epPackage.devDependencies?.["@lvis/plugin-sdk"];
  if (runtimeDependency !== undefined && buildDependency !== undefined) {
    fail("ep-api must declare @lvis/plugin-sdk in exactly one dependency section");
  }
  const actualDependency = runtimeDependency ?? buildDependency;
  if (actualDependency !== expectedDependency) {
    fail(`ep-api must consume ${expectedDependency}; found ${String(actualDependency)}`);
  }

  const lock = readFileSync(resolve(epApiRoot, "bun.lock"), "utf8");
  const lockedPrefix = lock.match(LOCKED_SDK)?.[1];
  if (!lockedPrefix) {
    fail("ep-api bun.lock has no resolved @lvis/plugin-sdk Git commit");
  }
  const lockedCommit = git(sdkRoot, "rev-parse", `${lockedPrefix}^{commit}`);
  if (lockedCommit !== refs.sdk) {
    fail(`ep-api bun.lock resolves SDK ${lockedCommit}, expected ${refs.sdk}`);
  }

  const schemas = {
    host: readFileSync(resolve(hostRoot, "schemas/plugin-manifest.schema.json")),
    sdk: readFileSync(resolve(sdkRoot, "schemas/plugin-manifest.schema.json")),
    marketplace: readFileSync(
      resolve(marketplaceRoot, "schemas/host/plugin-manifest.schema.json"),
    ),
  };
  const schemaDigests = Object.fromEntries(
    Object.entries(schemas).map(([name, bytes]) => [name, sha256(bytes)]),
  );
  if (new Set(Object.values(schemaDigests)).size !== 1) {
    fail(`manifest schema digests differ: ${JSON.stringify(schemaDigests)}`);
  }

  return {
    refs,
    sdkDependency: actualDependency,
    sdkLockPrefix: lockedPrefix,
    schemaSha256: schemaDigests.host,
  };
}

function fromEnvironment() {
  const workspaceRoot = resolve(process.env.BUNDLE_E2E_WORKSPACE ?? "..");
  const evidence = verifyPluginBundleE2EInputs({
    hostRoot: resolve(process.env.HOST_ROOT ?? "."),
    sdkRoot: process.env.SDK_ROOT
      ? resolve(process.env.SDK_ROOT)
      : resolve(workspaceRoot, "lvis-plugin-sdk"),
    marketplaceRoot: process.env.MARKETPLACE_ROOT
      ? resolve(process.env.MARKETPLACE_ROOT)
      : resolve(workspaceRoot, "lvis-marketplace"),
    epApiRoot: process.env.EP_API_ROOT
      ? resolve(process.env.EP_API_ROOT)
      : resolve(workspaceRoot, "lvis-plugin-lge-api"),
    hostSha: process.env.HOST_SHA,
    sdkSha: process.env.SDK_SHA,
    marketplaceSha: process.env.MARKETPLACE_SHA,
    epApiSha: process.env.EP_API_SHA,
  });
  const rendered = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.env.BUNDLE_E2E_EVIDENCE_PATH) {
    writeFileSync(process.env.BUNDLE_E2E_EVIDENCE_PATH, rendered, { flag: "wx" });
  } else {
    process.stdout.write(rendered);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  fromEnvironment();
}
