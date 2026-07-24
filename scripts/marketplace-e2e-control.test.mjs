import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createSafeSourceArchive,
  createFinalEvidence,
  createOutputManifest,
  extractSafeSourceArchive,
  inspectSafeZip,
  inspectSafeUstar,
  validateInputManifest,
  validateLifecycleEvidence,
  validateSafeSourceArchive,
  walkSafeTree,
} from "./marketplace-e2e-control.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "marketplace-e2e-control-"));
  mkdirSync(join(root, "src"), { mode: 0o700 });
  writeFileSync(join(root, "src", "index.mjs"), "export default 1;\n", {
    mode: 0o600,
  });
  return root;
}

function makeRepo(root, files) {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "fixture@example.com",
  ]);
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function rewriteTarType(bytes, typeFlag) {
  const copy = Buffer.from(bytes);
  copy[156] = typeFlag.charCodeAt(0);
  copy.fill(0, 157, 257);
  if (typeFlag === "1" || typeFlag === "2") {
    copy.write("target", 157, "utf8");
  }
  copy.fill(0x20, 148, 156);
  const checksum = copy.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  copy.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return copy;
}

test("creates deterministic ustar from regular non-linked files only", () => {
  const root = fixtureRoot();
  const first = join(root, "first.tar");
  const second = join(root, "second.tar");
  const a = createSafeSourceArchive(join(root, "src"), first);
  const b = createSafeSourceArchive(join(root, "src"), second);

  assert.equal(a.sha256, b.sha256);
  assert.deepEqual(
    inspectSafeUstar(readFileSync(first)).map(({ path, type }) => ({
      path,
      type,
    })),
    [{ path: "index.mjs", type: "file" }],
  );
});

test("archives through a pinned no-follow descriptor instead of reopening a checked path", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./marketplace-e2e-control.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(source, /openSync\(\s*entry\.absolute,/u);
  assert.match(source, /constants\.O_NOFOLLOW/u);
  assert.match(source, /readFileSync\(descriptor\)/u);
  assert.match(source, /fstatSync\(descriptor\)/u);
  assert.doesNotMatch(source, /readFileSync\(entry\.absolute\)/u);
});

test("extracts only after archive validation into a new private root", () => {
  const root = fixtureRoot();
  const archive = join(root, "source.tar");
  const extracted = join(root, "extracted");
  createSafeSourceArchive(join(root, "src"), archive);
  extractSafeSourceArchive(archive, extracted);
  assert.equal(
    readFileSync(join(extracted, "index.mjs"), "utf8"),
    "export default 1;\n",
  );
});

test("rejects source symlinks and hard links", () => {
  const symlinkRoot = fixtureRoot();
  symlinkSync("index.mjs", join(symlinkRoot, "src", "linked.mjs"));
  assert.throws(
    () => walkSafeTree(join(symlinkRoot, "src")),
    /forbidden symlink/u,
  );

  const hardlinkRoot = fixtureRoot();
  linkSync(
    join(hardlinkRoot, "src", "index.mjs"),
    join(hardlinkRoot, "src", "hard-linked.mjs"),
  );
  assert.throws(
    () => walkSafeTree(join(hardlinkRoot, "src")),
    /forbidden hard link/u,
  );
});

test(
  "rejects special source files",
  { skip: process.platform === "win32" },
  () => {
    const root = fixtureRoot();
    const fifo = join(root, "src", "candidate.fifo");
    const result = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.throws(
      () => walkSafeTree(join(root, "src")),
      /forbidden special file/u,
    );
  },
);

test("rejects symlink, hardlink, and fifo members even with a valid ustar checksum", () => {
  const root = fixtureRoot();
  const archive = join(root, "source.tar");
  createSafeSourceArchive(join(root, "src"), archive);
  const safeBytes = readFileSync(archive);

  for (const [typeFlag, label] of [
    ["2", "symlink"],
    ["1", "hard link"],
    ["6", "fifo"],
  ]) {
    const hostile = join(root, `hostile-${typeFlag}.tar`);
    writeFileSync(hostile, rewriteTarType(safeBytes, typeFlag), {
      mode: 0o600,
    });
    assert.throws(
      () => validateSafeSourceArchive(hostile),
      new RegExp(label, "u"),
    );
  }
});

test("accepts a regular EP ZIP and rejects Unix symlink metadata", () => {
  const root = fixtureRoot();
  const archive = join(root, "ep.zip");
  const zipped = spawnSync("zip", ["-X", "-q", archive, "index.mjs"], {
    cwd: join(root, "src"),
    encoding: "utf8",
  });
  assert.equal(zipped.status, 0, zipped.stderr);
  const safe = readFileSync(archive);
  assert.deepEqual(inspectSafeZip(safe), [{ path: "index.mjs", type: "file" }]);

  const hostile = Buffer.from(safe);
  const centralOffset = hostile.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(centralOffset, -1);
  hostile.writeUInt32LE((0o120777 * 0x10000) >>> 0, centralOffset + 38);
  assert.throws(() => inspectSafeZip(hostile), /forbidden symlink/u);
});

test("input manifest requires the nonce, workflow SHA, exact refs, and source digests", () => {
  const root = fixtureRoot();
  const refs = {
    host: "1".repeat(40),
    marketplace: "2".repeat(40),
    sdk: "3".repeat(40),
    epApi: "4".repeat(40),
  };
  const manifest = {
    schemaVersion: 1,
    kind: "marketplace-e2e-inputs",
    nonce: "a".repeat(64),
    workflowSha: "5".repeat(40),
    refs,
    schemaSha256: "b".repeat(64),
    sources: Object.fromEntries(
      ["host", "marketplace", "sdk", "ep"].map((name) => [
        name,
        { file: `${name}-source.tar`, sha256: "c".repeat(64), size: 512 },
      ]),
    ),
  };
  const path = join(root, "input-manifest.json");
  writeFileSync(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);

  assert.equal(
    validateInputManifest(path, { workflowSha: manifest.workflowSha, refs })
      .nonce,
    manifest.nonce,
  );
  manifest.nonce = "predictable";
  writeFileSync(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  assert.throws(
    () => validateInputManifest(path, { workflowSha: "5".repeat(40), refs }),
    /nonce is invalid/u,
  );
});

test("stage CLI binds clean exact checkouts and contract identity into separate archives", () => {
  const root = mkdtempSync(join(tmpdir(), "marketplace-e2e-stage-"));
  const schema = '{"type":"object"}\n';
  const hostRoot = join(root, "lvis-app");
  const sdkRoot = join(root, "lvis-plugin-sdk");
  const marketplaceRoot = join(root, "lvis-marketplace");
  const epRoot = join(root, "lvis-plugin-lge-api");
  const hostSha = makeRepo(hostRoot, {
    "schemas/plugin-manifest.schema.json": schema,
  });
  const sdkSha = makeRepo(sdkRoot, {
    "schemas/plugin-manifest.schema.json": schema,
  });
  const marketplaceSha = makeRepo(marketplaceRoot, {
    "schemas/host/plugin-manifest.schema.json": schema,
  });
  const epSha = makeRepo(epRoot, {
    "package.json": `${JSON.stringify({
      devDependencies: {
        "@lvis/plugin-sdk": `github:lvis-project/lvis-plugin-sdk#${sdkSha}`,
      },
    })}\n`,
    "bun.lock": `"@lvis/plugin-sdk": ["@lvis/plugin-sdk@github:lvis-project/lvis-plugin-sdk#${sdkSha.slice(0, 12)}"]\n`,
  });
  const output = join(root, "staged");
  const control = fileURLToPath(
    new URL("./marketplace-e2e-control.mjs", import.meta.url),
  );

  execFileSync(process.execPath, [
    control,
    "stage",
    "--workflow-sha",
    "f".repeat(40),
    "--host-sha",
    hostSha,
    "--marketplace-sha",
    marketplaceSha,
    "--sdk-sha",
    sdkSha,
    "--ep-api-sha",
    epSha,
    "--host-root",
    hostRoot,
    "--marketplace-root",
    marketplaceRoot,
    "--sdk-root",
    sdkRoot,
    "--ep-root",
    epRoot,
    "--output-dir",
    output,
  ]);

  const manifest = JSON.parse(
    readFileSync(join(output, "input-manifest.json"), "utf8"),
  );
  assert.equal(manifest.refs.host, hostSha);
  assert.equal(manifest.refs.epApi, epSha);
  assert.match(manifest.nonce, /^[0-9a-f]{64}$/u);
  for (const name of ["host", "marketplace", "sdk", "ep"]) {
    const archive = validateSafeSourceArchive(
      join(output, `${name}-source.tar`),
    );
    assert.equal(archive.sha256, manifest.sources[name].sha256);
  }
});

function lifecycleEvidence(refs) {
  const referenceFields = {
    hostSha: refs.host,
    marketplaceSha: refs.marketplace,
    sdkSha: refs.sdk,
    epApiSha: refs.epApi,
  };
  return {
    liveLifecycle: { ...referenceFields, zeroOrphans: true },
    actualEpAttendance: {
      ...referenceFields,
      artifact: { exactSourceArchive: true },
      marketplace: { productionWriteExecuted: false },
      provider: {
        productionCredentialsUsed: false,
        calendarReads: 2,
        calendarWrites: 1,
      },
      attendance: {
        missingGrantRejected: true,
        forgedGrantRejected: true,
        explicitConfirmation: true,
        providerVerified: true,
        writeStatus: "success",
        readback: { status: "confirmed" },
      },
      retirement: {
        disabled: {
          skillRetired: true,
          toolsRetired: true,
          runtimeRetired: true,
        },
        uninstalled: { skillRetired: true, toolsRetired: true },
        hookAndMcpAbsenceMatchesExactManifest: true,
        zeroOrphans: true,
      },
    },
    containmentRehearsal: {
      productionWriteExecuted: false,
      orderedActions: [
        "version-yank",
        "plugin-yank",
        "corrective-sdk",
        "host-decision",
      ],
      hostRollbackBlockedBeforeContainment: true,
      hostRollbackAllowed: true,
    },
  };
}

test("final lifecycle evidence is exact-ref bound and covers attendance plus retirement", () => {
  const refs = {
    host: "1".repeat(40),
    marketplace: "2".repeat(40),
    sdk: "3".repeat(40),
    epApi: "4".repeat(40),
  };
  const evidence = lifecycleEvidence(refs);
  assert.equal(
    validateLifecycleEvidence(evidence, refs).attendance,
    evidence.actualEpAttendance,
  );

  evidence.actualEpAttendance.retirement.zeroOrphans = false;
  assert.throws(
    () => validateLifecycleEvidence(evidence, refs),
    /attendance zero orphans/u,
  );
});

test("trusted finalizer binds candidate evidence to both transferred output digests", () => {
  const root = mkdtempSync(join(tmpdir(), "marketplace-e2e-finalize-"));
  const refs = {
    host: "1".repeat(40),
    marketplace: "2".repeat(40),
    sdk: "3".repeat(40),
    epApi: "4".repeat(40),
  };
  const expected = { workflowSha: "5".repeat(40), refs };
  const inputManifest = join(root, "input-manifest.json");
  const manifest = {
    schemaVersion: 1,
    kind: "marketplace-e2e-inputs",
    nonce: "a".repeat(64),
    workflowSha: expected.workflowSha,
    refs,
    schemaSha256: "b".repeat(64),
    sources: Object.fromEntries(
      ["host", "marketplace", "sdk", "ep"].map((name) => [
        name,
        { file: `${name}-source.tar`, sha256: "c".repeat(64), size: 512 },
      ]),
    ),
  };
  writeFileSync(inputManifest, `${JSON.stringify(manifest)}\n`, {
    mode: 0o600,
  });

  const marketplaceArtifact = join(root, "marketplace-image.tar");
  writeFileSync(marketplaceArtifact, "verified docker image\n", {
    mode: 0o600,
  });
  const marketplaceManifest = join(root, "marketplace-image-manifest.json");
  createOutputManifest({
    kind: "marketplace-image",
    inputManifestPath: inputManifest,
    expected,
    artifactPath: marketplaceArtifact,
    outputPath: marketplaceManifest,
  });

  const epSource = join(root, "ep-source");
  mkdirSync(epSource);
  writeFileSync(join(epSource, "plugin.json"), "{}\n");
  const epArtifact = join(root, `lvis-plugin-ep-${refs.epApi}.zip`);
  const zipped = spawnSync("zip", ["-X", "-q", epArtifact, "plugin.json"], {
    cwd: epSource,
    encoding: "utf8",
  });
  assert.equal(zipped.status, 0, zipped.stderr);
  const epManifest = join(root, "ep-bundle-manifest.json");
  createOutputManifest({
    kind: "ep-bundle",
    inputManifestPath: inputManifest,
    expected,
    artifactPath: epArtifact,
    outputPath: epManifest,
  });

  const evidenceRoot = join(root, "candidate-evidence");
  mkdirSync(evidenceRoot);
  const candidateEvidence = join(
    evidenceRoot,
    "marketplace-live-lifecycle-evidence.json",
  );
  writeFileSync(
    candidateEvidence,
    `${JSON.stringify(lifecycleEvidence(refs))}\n`,
    { mode: 0o600 },
  );
  const finalEvidence = join(root, "final-evidence.json");
  const result = createFinalEvidence({
    inputManifestPath: inputManifest,
    marketplaceManifestPath: marketplaceManifest,
    marketplaceArtifactPath: marketplaceArtifact,
    epManifestPath: epManifest,
    epArtifactPath: epArtifact,
    candidateEvidenceRoot: evidenceRoot,
    candidateEvidencePath: candidateEvidence,
    outputPath: finalEvidence,
    expected,
  });

  assert.equal(result.nonce, manifest.nonce);
  assert.equal(result.refs.epApi, refs.epApi);
  assert.equal(result.proofs.productionWriteExecuted, false);
  assert.match(result.artifacts.epBundleSha256, /^[0-9a-f]{64}$/u);
});
