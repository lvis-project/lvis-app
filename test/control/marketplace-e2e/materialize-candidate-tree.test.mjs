import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  materializeCandidateTree,
  overlayMaterializedTree,
  parseTreeEntries,
  verifyMaterializedTree,
} from "./materialize-candidate-tree.mjs";

const temporaryRoots = [];
const materializerPath = fileURLToPath(
  new URL("./materialize-candidate-tree.mjs", import.meta.url),
);

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "lvis-candidate-tree-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepository(files = {}) {
  const repo = join(temporaryRoot(), "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Candidate Fixture");
  git(repo, "config", "user.email", "candidate-fixture@example.invalid");
  for (const [path, value] of Object.entries(files)) {
    const destination = join(repo, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, value);
  }
  git(repo, "add", "--all");
  git(repo, "commit", "-qm", "fixture");
  return repo;
}

function outputPaths(root, name = "candidate") {
  const output = join(root, "output");
  mkdirSync(join(output, "contexts"), { recursive: true });
  mkdirSync(join(output, "snapshots"), { recursive: true });
  return {
    contextPath: join(output, "contexts", name),
    archivePath: join(output, "snapshots", `${name}.tar`),
    manifestPath: join(output, "snapshots", `${name}.tree.json`),
    evidencePath: join(output, "snapshots", `${name}.json`),
  };
}

function materialize(repo, options = {}) {
  const root = temporaryRoot();
  const paths = outputPaths(root, options.name);
  return {
    ...paths,
    ...materializeCandidateTree({
      name: options.name ?? "candidate",
      repo,
      expectedCommit: git(repo, "rev-parse", "HEAD"),
      ...paths,
      allowedGitlinks: options.allowedGitlinks ?? [],
    }),
  };
}

function expectSealingFailure(action, pattern) {
  assert.throws(action, (error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

test("materializes exact tree blobs without interpreting nested export attributes", () => {
  const repo = createRepository({
    "nested/.gitattributes": "secret.txt export-ignore\nsubst.txt export-subst\n",
    "nested/.dockerignore": "*\n",
    "nested/secret.txt": "must remain in the sealed context\n",
    "nested/subst.txt": "$Format:%H$\n",
    "run.sh": "#!/bin/sh\nexit 0\n",
  });
  chmodSync(join(repo, "run.sh"), 0o755);
  git(repo, "add", "run.sh");
  git(repo, "commit", "-qm", "mark executable");

  const first = materialize(repo);
  const second = materialize(repo);
  assert.equal(
    readFileSync(join(first.contextPath, "nested/secret.txt"), "utf8"),
    "must remain in the sealed context\n",
  );
  assert.equal(
    readFileSync(join(first.contextPath, "nested/subst.txt"), "utf8"),
    "$Format:%H$\n",
  );
  assert.equal(first.evidence.value.archiveSha256, second.evidence.value.archiveSha256);
  assert.deepEqual(first.manifest.entries, second.manifest.entries);
  assert.equal(first.manifest.entries.find(({ path }) => path === "run.sh").mode, "100755");
  const extracted = join(temporaryRoot(), "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xf", first.archivePath, "-C", extracted]);
  assert.equal(
    readFileSync(join(extracted, "nested/secret.txt"), "utf8"),
    "must remain in the sealed context\n",
  );
  assert.equal(statSync(join(extracted, "run.sh")).mode & 0o777, 0o755);
});

test("rejects every symlink including parent escapes and multi-hop chains", () => {
  for (const links of [
    [["p", ".."]],
    [["pivot", ".."], ["p", "pivot/outside"]],
  ]) {
    const repo = createRepository({ "regular.txt": "safe\n" });
    for (const [path, target] of links) symlinkSync(target, join(repo, path));
    git(repo, "add", "--all");
    git(repo, "commit", "-qm", "hostile symlink");
    expectSealingFailure(
      () => materialize(repo),
      /symlink is forbidden/u,
    );
  }
});

test("rejects a root dockerignore while permitting a nested dockerignore", () => {
  const nested = createRepository({
    "server/.dockerignore": "*\n",
    "server/app.txt": "included\n",
  });
  assert.equal(
    readFileSync(join(materialize(nested).contextPath, "server/app.txt"), "utf8"),
    "included\n",
  );

  const root = createRepository({ ".dockerignore": "*\n", "app.txt": "hidden\n" });
  expectSealingFailure(
    () => materialize(root),
    /root \.dockerignore may filter/u,
  );
});

test("allows only the explicit Marketplace SDK gitlink and overlays sealed SDK bytes", () => {
  const sdk = createRepository({ "package.json": "{\"name\":\"sdk\"}\n", "bin/run": "ok\n" });
  chmodSync(join(sdk, "bin/run"), 0o755);
  git(sdk, "add", "bin/run");
  git(sdk, "commit", "-qm", "executable sdk file");

  const marketplace = createRepository({ "server/app.py": "print('marketplace')\n" });
  const sdkCommit = git(sdk, "rev-parse", "HEAD");
  git(
    marketplace,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${sdkCommit},vendor/lvis-plugin-sdk`,
  );
  git(marketplace, "commit", "-qm", "sdk gitlink");

  expectSealingFailure(
    () => materialize(marketplace),
    /unsupported tree mode 160000/u,
  );
  expectSealingFailure(
    () =>
      materialize(marketplace, {
        name: "marketplace",
        allowedGitlinks: [{ path: "vendor/not-sdk", oid: sdkCommit }],
      }),
    /only the Marketplace SDK gitlink may be allowed/u,
  );
  expectSealingFailure(
    () =>
      materialize(marketplace, {
        name: "marketplace",
        allowedGitlinks: [
          { path: "vendor/lvis-plugin-sdk", oid: "f".repeat(40) },
        ],
      }),
    /gitlink vendor\/lvis-plugin-sdk resolves .* expected f{40}/u,
  );
  expectSealingFailure(
    () =>
      materialize(marketplace, {
        name: "sdk",
        allowedGitlinks: [
          { path: "vendor/lvis-plugin-sdk", oid: sdkCommit },
        ],
      }),
    /only the Marketplace SDK gitlink may be allowed/u,
  );
  expectSealingFailure(
    () => materialize(marketplace, { allowedGitlinks: [] }),
    /unsupported tree mode 160000/u,
  );

  const sealedMarketplace = materialize(marketplace, {
    name: "marketplace",
    allowedGitlinks: [
      { path: "vendor/lvis-plugin-sdk", oid: sdkCommit },
    ],
  });
  const sealedSdk = materialize(sdk, { name: "sdk" });
  const overlay = overlayMaterializedTree({
    sourceContext: sealedSdk.contextPath,
    sourceManifest: sealedSdk.manifest,
    destinationRoot: sealedMarketplace.contextPath,
    destinationManifest: sealedMarketplace.manifest,
    destinationPath: "vendor/lvis-plugin-sdk",
  });
  assert.equal(
    readFileSync(
      join(sealedMarketplace.contextPath, "vendor/lvis-plugin-sdk/package.json"),
      "utf8",
    ),
    "{\"name\":\"sdk\"}\n",
  );
  assert.deepEqual(
    {
      targetPath: overlay.targetPath,
      gitlinkOid: overlay.gitlinkOid,
      sdkTree: overlay.sdkTree,
      sdkArchiveSha256: overlay.sdkArchiveSha256,
    },
    {
      targetPath: "vendor/lvis-plugin-sdk",
      gitlinkOid: sdkCommit,
      sdkTree: sealedSdk.manifest.tree,
      sdkArchiveSha256: sealedSdk.evidence.value.archiveSha256,
    },
  );
  assert.match(overlay.imageInputArchiveSha256, /^[0-9a-f]{64}$/u);

  const other = createRepository({ "server/app.py": "safe\n" });
  git(
    other,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${sdkCommit},vendor/other`,
  );
  git(other, "commit", "-qm", "unapproved gitlink");
  expectSealingFailure(
    () =>
      materialize(other, {
        name: "marketplace",
        allowedGitlinks: [
          { path: "vendor/lvis-plugin-sdk", oid: sdkCommit },
        ],
      }),
    /unsupported tree mode 160000 at vendor\/other/u,
  );
});

test("verification detects byte, mode, and path-set mismatches", () => {
  const repo = createRepository({ "file.txt": "original\n" });

  const bytes = materialize(repo);
  writeFileSync(join(bytes.contextPath, "file.txt"), "changed\n");
  expectSealingFailure(
    () => verifyMaterializedTree(bytes.contextPath, bytes.manifest),
    /byte mismatch/u,
  );

  const mode = materialize(repo);
  chmodSync(join(mode.contextPath, "file.txt"), 0o755);
  expectSealingFailure(
    () => verifyMaterializedTree(mode.contextPath, mode.manifest),
    /mode\/link mismatch/u,
  );

  const path = materialize(repo);
  writeFileSync(join(path.contextPath, "extra.txt"), "unexpected\n");
  expectSealingFailure(
    () => verifyMaterializedTree(path.contextPath, path.manifest),
    /path set differs/u,
  );
});

test("CLI preserves the exact gitlink binding in overlay evidence", () => {
  const sdk = createRepository({ "package.json": "{\"name\":\"sdk-cli\"}\n" });
  const sdkCommit = git(sdk, "rev-parse", "HEAD");
  const marketplace = createRepository({ "server/app.py": "print('cli')\n" });
  git(
    marketplace,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${sdkCommit},vendor/lvis-plugin-sdk`,
  );
  git(marketplace, "commit", "-qm", "sdk gitlink");

  const root = temporaryRoot();
  const marketplacePaths = outputPaths(root, "marketplace");
  const sdkPaths = outputPaths(root, "sdk");
  execFileSync(process.execPath, [
    materializerPath,
    "materialize",
    "--name",
    "marketplace",
    "--repo",
    marketplace,
    "--expected",
    git(marketplace, "rev-parse", "HEAD"),
    "--context",
    marketplacePaths.contextPath,
    "--archive",
    marketplacePaths.archivePath,
    "--manifest",
    marketplacePaths.manifestPath,
    "--evidence",
    marketplacePaths.evidencePath,
    "--allow-gitlink",
    `vendor/lvis-plugin-sdk=${sdkCommit}`,
  ]);
  execFileSync(process.execPath, [
    materializerPath,
    "materialize",
    "--name",
    "sdk",
    "--repo",
    sdk,
    "--expected",
    sdkCommit,
    "--context",
    sdkPaths.contextPath,
    "--archive",
    sdkPaths.archivePath,
    "--manifest",
    sdkPaths.manifestPath,
    "--evidence",
    sdkPaths.evidencePath,
  ]);
  const overlayEvidence = join(root, "output", "snapshots", "sdk-overlay.json");
  execFileSync(process.execPath, [
    materializerPath,
    "overlay",
    "--source-context",
    sdkPaths.contextPath,
    "--source-manifest",
    sdkPaths.manifestPath,
    "--destination-root",
    marketplacePaths.contextPath,
    "--destination-manifest",
    marketplacePaths.manifestPath,
    "--destination",
    "vendor/lvis-plugin-sdk",
    "--evidence",
    overlayEvidence,
  ]);
  const evidence = JSON.parse(readFileSync(overlayEvidence, "utf8"));
  assert.equal(evidence.gitlinkOid, sdkCommit);
  assert.equal(evidence.targetPath, "vendor/lvis-plugin-sdk");
  assert.match(evidence.imageInputArchiveSha256, /^[0-9a-f]{64}$/u);
});

test("tree parser rejects unsafe paths and unsupported mode records remain explicit", () => {
  expectSealingFailure(
    () =>
      parseTreeEntries(
        Buffer.from(`100644 blob ${"a".repeat(40)}\t../escape\0`),
      ),
    /unsafe tree path/u,
  );
  const special = parseTreeEntries(
    Buffer.from(`100664 blob ${"a".repeat(40)}\tspecial\0`),
  );
  assert.equal(special[0].mode, "100664");
});
