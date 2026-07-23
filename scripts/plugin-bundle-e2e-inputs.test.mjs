import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  requireFullSha,
  verifyPluginBundleE2EInputs,
} from "./plugin-bundle-e2e-inputs.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(root, files) {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Bundle E2E Test");
  git(root, "config", "user.email", "bundle-e2e@example.invalid");
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, body);
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return git(root, "rev-parse", "HEAD");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bundle-e2e-inputs-"));
  const schema = '{"type":"object"}\n';
  const hostRoot = join(root, "lvis-app");
  const sdkRoot = join(root, "lvis-plugin-sdk");
  const marketplaceRoot = join(root, "lvis-marketplace");
  const epApiRoot = join(root, "lvis-plugin-lge-api");
  const hostSha = makeRepo(hostRoot, { "schemas/plugin-manifest.schema.json": schema });
  const sdkSha = makeRepo(sdkRoot, { "schemas/plugin-manifest.schema.json": schema });
  const marketplaceSha = makeRepo(marketplaceRoot, {
    "schemas/host/plugin-manifest.schema.json": schema,
  });
  const epApiSha = makeRepo(epApiRoot, {
    "package.json": `${JSON.stringify({
      devDependencies: {
        "@lvis/plugin-sdk": `github:lvis-project/lvis-plugin-sdk#${sdkSha}`,
      },
    })}\n`,
    "bun.lock": `"@lvis/plugin-sdk": ["@lvis/plugin-sdk@github:lvis-project/lvis-plugin-sdk#${sdkSha.slice(0, 12)}"]\n`,
  });
  return { hostRoot, sdkRoot, marketplaceRoot, epApiRoot, hostSha, sdkSha, marketplaceSha, epApiSha };
}

test("rejects mutable or abbreviated workflow refs", () => {
  assert.throws(() => requireFullSha("SDK_SHA", "main"), /40-character/);
  assert.throws(() => requireFullSha("SDK_SHA", "a".repeat(39)), /40-character/);
});

test("proves checkout, consumed SDK, lock resolution, and schema identity", () => {
  const f = fixture();
  const evidence = verifyPluginBundleE2EInputs(f);
  assert.equal(evidence.refs.sdk, f.sdkSha);
  assert.equal(evidence.sdkLockPrefix, f.sdkSha.slice(0, 12));
  assert.match(evidence.schemaSha256, /^[0-9a-f]{64}$/);
});

test("CLI honors explicit checkout roots without appending repository names", () => {
  const f = fixture();
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./plugin-bundle-e2e-inputs.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOST_ROOT: f.hostRoot,
        SDK_ROOT: f.sdkRoot,
        MARKETPLACE_ROOT: f.marketplaceRoot,
        EP_API_ROOT: f.epApiRoot,
        HOST_SHA: f.hostSha,
        SDK_SHA: f.sdkSha,
        MARKETPLACE_SHA: f.marketplaceSha,
        EP_API_SHA: f.epApiSha,
        // The workflow itself writes consolidated evidence. This child test
        // proves stdout mode and must not inherit the parent's evidence sink.
        BUNDLE_E2E_EVIDENCE_PATH: "",
      },
    },
  );
  assert.equal(JSON.parse(output).refs.epApi, f.epApiSha);
});

test("rejects an SDK ref that ep-api does not consume", () => {
  const f = fixture();
  const packagePath = join(f.epApiRoot, "package.json");
  writeFileSync(packagePath, '{"dependencies":{"@lvis/plugin-sdk":"github:lvis-project/lvis-plugin-sdk#main"}}\n');
  assert.throws(() => verifyPluginBundleE2EInputs(f), /ep-api must consume/);
});

test("rejects duplicate runtime and build-time SDK declarations", () => {
  const f = fixture();
  const packagePath = join(f.epApiRoot, "package.json");
  const dependency = `github:lvis-project/lvis-plugin-sdk#${f.sdkSha}`;
  writeFileSync(packagePath, `${JSON.stringify({
    dependencies: { "@lvis/plugin-sdk": dependency },
    devDependencies: { "@lvis/plugin-sdk": dependency },
  })}\n`);
  assert.throws(() => verifyPluginBundleE2EInputs(f), /exactly one dependency section/);
});

test("rejects cross-repository schema drift", () => {
  const f = fixture();
  writeFileSync(
    join(f.marketplaceRoot, "schemas/host/plugin-manifest.schema.json"),
    '{"type":"array"}\n',
  );
  assert.throws(() => verifyPluginBundleE2EInputs(f), /schema digests differ/);
});
