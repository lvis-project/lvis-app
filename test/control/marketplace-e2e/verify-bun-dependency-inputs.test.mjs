import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseBunLock,
  verifyBunDependencyInputs,
} from "./verify-bun-dependency-inputs.mjs";

const SDK_SHA = "82392854c7f3c84fa111956b153d3a46a582d4c7";
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function registryTuple(name = "safe", version = "1.2.3", metadata = {}) {
  return [`${name}@${version}`, "", metadata, INTEGRITY];
}

function hostFixture(specifier = "^1.2.3") {
  const manifest = {
    name: "host-candidate",
    dependencies: { safe: specifier },
  };
  const lock = {
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: {
      "": {
        name: manifest.name,
        dependencies: { ...manifest.dependencies },
      },
    },
    trustedDependencies: [],
    packages: { safe: registryTuple() },
  };
  return { manifest, lock, mode: "host" };
}

function epFixture() {
  const sdkSpecifier =
    `github:lvis-project/lvis-plugin-sdk#${SDK_SHA}`;
  const manifest = {
    name: "ep-candidate",
    dependencies: { safe: "^1.2.3" },
    devDependencies: { "@lvis/plugin-sdk": sdkSpecifier },
  };
  const lock = {
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: {
      "": {
        name: manifest.name,
        dependencies: { ...manifest.dependencies },
        devDependencies: { ...manifest.devDependencies },
      },
    },
    trustedDependencies: ["@lvis/plugin-sdk"],
    packages: {
      safe: registryTuple(),
      "@lvis/plugin-sdk": [
        `@lvis/plugin-sdk@github:lvis-project/lvis-plugin-sdk#${SDK_SHA.slice(0, 7)}`,
        { peerDependencies: { tsup: ">=8.0.0" } },
        `lvis-project-lvis-plugin-sdk-${SDK_SHA.slice(0, 7)}`,
        INTEGRITY,
      ],
    },
  };
  return { manifest, lock, mode: "ep", sdkSha: SDK_SHA };
}

function expectRejected(fixture, pattern) {
  assert.throws(
    () => verifyBunDependencyInputs(fixture),
    new RegExp(`Bun dependency input policy rejected candidate: .*${pattern}`, "i"),
  );
}

test("parses Bun JSONC without treating URL slashes inside strings as comments", () => {
  const parsed = parseBunLock(`{
    // generated lock comment
    "source": "https://127.0.0.1/redirect",
    "items": [1, 2,],
  }`);
  assert.deepEqual(parsed, {
    source: "https://127.0.0.1/redirect",
    items: [1, 2],
  });
});

test("current Host manifest and bun.lock satisfy registry-only policy", () => {
  const repositoryRoot = fileURLToPath(
    new URL("../../../", import.meta.url),
  );
  const manifest = JSON.parse(
    readFileSync(`${repositoryRoot}/package.json`, "utf8"),
  );
  const lock = parseBunLock(
    readFileSync(`${repositoryRoot}/bun.lock`, "utf8"),
  );
  const result = verifyBunDependencyInputs({
    manifest,
    lock,
    mode: "host",
  });
  assert.ok(result.packages > 1_000);
});

test("accepts the current EP SDK source and abbreviated Bun lock resolution", () => {
  const result = verifyBunDependencyInputs(epFixture());
  assert.equal(result.sdkSha, SDK_SHA);
});

for (const endpoint of [
  "http://127.0.0.1:3000/package.tgz",
  "http://10.0.0.1/package.tgz",
  "http://172.17.0.1/package.tgz",
  "http://192.168.1.1/package.tgz",
  "http://169.254.169.254/latest/meta-data",
  "https://packages.example.test/redirect",
]) {
  test(`rejects direct network dependency ${endpoint}`, () => {
    expectRejected(hostFixture(endpoint), "not a registry");
  });
}

for (const source of [
  "github:owner/repository#main",
  "git://example.test/repository.git",
  "git+https://example.test/repository.git",
  "git+ssh://git@example.test/repository.git",
  "git@example.test:owner/repository.git",
  "owner/repository",
]) {
  test(`rejects VCS dependency ${source}`, () => {
    expectRejected(hostFixture(source), "not a registry");
  });
}

for (const source of [
  "https://example.test/package.tgz",
  "./package.tgz",
  "file:../package",
  "link:../package",
  "workspace:*",
  "portal:../package",
  "patch:safe@npm%3A1.2.3#patches/safe.patch",
]) {
  test(`rejects non-registry dependency ${source}`, () => {
    expectRejected(hostFixture(source), "not a registry");
  });
}

test("rejects a transitive direct URL hidden in lock metadata", () => {
  const fixture = hostFixture();
  fixture.lock.packages.safe = registryTuple("safe", "1.2.3", {
    dependencies: {
      hidden: "http://169.254.169.254/latest/meta-data",
    },
  });
  expectRejected(fixture, "not a registry");
});

test("rejects an unknown lock metadata source field fail closed", () => {
  const fixture = hostFixture();
  fixture.lock.packages.safe = registryTuple("safe", "1.2.3", {
    resolved: "https://127.0.0.1/redirect",
  });
  expectRejected(fixture, "metadata field resolved");
});

test("rejects registry lock packages without integrity", () => {
  const fixture = hostFixture();
  fixture.lock.packages.safe[3] = "";
  expectRejected(fixture, "missing sha512 integrity");
});

test("rejects package dependency remapping surfaces", () => {
  for (const field of ["workspaces", "overrides", "resolutions", "catalogs"]) {
    const fixture = hostFixture();
    fixture.manifest[field] = {};
    expectRejected(fixture, field);
  }
});

test("rejects an EP SDK source from any other repository", () => {
  const fixture = epFixture();
  fixture.manifest.devDependencies["@lvis/plugin-sdk"] =
    `github:attacker/lvis-plugin-sdk#${SDK_SHA}`;
  fixture.lock.workspaces[""].devDependencies["@lvis/plugin-sdk"] =
    fixture.manifest.devDependencies["@lvis/plugin-sdk"];
  expectRejected(fixture, "expected exact SDK SHA");
});

test("rejects an EP SDK manifest source at the wrong SHA", () => {
  const fixture = epFixture();
  const wrongSha = "a".repeat(40);
  fixture.manifest.devDependencies["@lvis/plugin-sdk"] =
    `github:lvis-project/lvis-plugin-sdk#${wrongSha}`;
  fixture.lock.workspaces[""].devDependencies["@lvis/plugin-sdk"] =
    fixture.manifest.devDependencies["@lvis/plugin-sdk"];
  expectRejected(fixture, "expected exact SDK SHA");
});

test("rejects an EP SDK lock resolution at the wrong SHA prefix", () => {
  const fixture = epFixture();
  fixture.lock.packages["@lvis/plugin-sdk"][0] =
    "@lvis/plugin-sdk@github:lvis-project/lvis-plugin-sdk#aaaaaaa";
  expectRejected(fixture, "expected repository and SHA prefix");
});

test("rejects a second non-registry package in EP bun.lock", () => {
  const fixture = epFixture();
  fixture.lock.packages.evil = [
    "evil@github:attacker/evil#aaaaaaa",
    {},
    "attacker-evil-aaaaaaa",
    INTEGRITY,
  ];
  expectRejected(fixture, "not a registry package tuple");
});

test("rejects unknown Bun lock fields fail closed", () => {
  const fixture = hostFixture();
  fixture.lock.patchedDependencies = {
    safe: "patches/safe.patch",
  };
  expectRejected(fixture, "top-level field patchedDependencies");
});
