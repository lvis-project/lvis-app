import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  A2A_SPECIFICATION_URI,
  EXACT_REPLAY_EXTENSION_URI,
  PINNED_TCK_COMMIT,
  PINNED_TCK_TAG,
  WIRE_CONFORMANCE_SCHEMA,
  assertCleanPinnedRepository,
  loadPinnedSigner,
  parseWireArguments,
  signCanonicalBundle,
  stableJson,
  validateHubWireBundle,
  writeImmutable,
} from "./a2a-p4-5-harness-lib.mjs";

const fullSha = "1".repeat(40);
const digest = "a".repeat(64);

function validArgs(overrides = {}) {
  const values = {
    appHead: fullSha,
    hubHead: "2".repeat(40),
    serverHead: fullSha,
    tckVersion: PINNED_TCK_TAG,
    tckCommit: PINNED_TCK_COMMIT,
    ...overrides,
  };
  return [
    "--app-head", values.appHead,
    "--hub-head", values.hubHead,
    "--server-head", values.serverHead,
    "--tck-version", values.tckVersion,
    "--tck-commit", values.tckCommit,
  ];
}

function validBundle(overrides = {}) {
  return {
    schema_version: WIRE_CONFORMANCE_SCHEMA,
    artifact_id: "p4-5-wire-test",
    agent_hub_head_sha: "2".repeat(40),
    lvis_app_head_sha: fullSha,
    remote_server_head_sha: fullSha,
    a2a_tck_tag: PINNED_TCK_TAG,
    a2a_tck_commit_sha: PINNED_TCK_COMMIT,
    agent_hub_lock_digest_sha256: digest,
    lvis_app_lock_digest_sha256: digest,
    remote_server_lock_digest_sha256: digest,
    a2a_tck_lock_digest_sha256: digest,
    a2a_specification_uri: A2A_SPECIFICATION_URI,
    extension_spec_uri: EXACT_REPLAY_EXTENSION_URI,
    extension_spec_digest_sha256: digest,
    agent_card_digest_sha256: digest,
    test_vectors_total: 3,
    test_vectors_passed: 3,
    test_vectors_failed: 0,
    test_vectors_skipped: 0,
    verification_state: "passed",
    ...overrides,
  };
}

test("stableJson matches the Agent Hub key-sorted canonical bytes", () => {
  assert.equal(stableJson({ z: [2, { b: true, a: "x" }], a: null }), '{"a":null,"z":[2,{"a":"x","b":true}]}');
});

test("wire arguments accept only exact immutable full pins", () => {
  assert.equal(parseWireArguments(validArgs()).tckCommit, PINNED_TCK_COMMIT);
  for (const argv of [
    validArgs({ appHead: "abc1234" }),
    validArgs({ hubHead: "main" }),
    validArgs({ tckVersion: "latest" }),
    validArgs({ tckCommit: "3".repeat(40) }),
    [...validArgs(), "--extra", "value"],
  ]) {
    assert.throws(() => parseWireArguments(argv));
  }
});

test("Hub wire bundle rejects extra keys, placeholders, and non-passing totals", () => {
  assert.equal(validateHubWireBundle(validBundle()).verification_state, "passed");
  assert.throws(() => validateHubWireBundle({ ...validBundle(), extra: true }));
  assert.throws(() => validateHubWireBundle(validBundle({ artifact_id: "replace-me" })));
  assert.throws(() => validateHubWireBundle(validBundle({ test_vectors_skipped: 1 })));
});

test("repository pin rejects dirty state and symlink aliases", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "p4-5-repository-"));
  const link = `${directory}-link`;
  try {
    execFileSync("git", ["init", "-q", directory]);
    execFileSync("git", ["-C", directory, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", directory, "config", "user.name", "P4-5 Test"]);
    writeFileSync(resolve(directory, "tracked.txt"), "clean\n");
    execFileSync("git", ["-C", directory, "add", "tracked.txt"]);
    execFileSync("git", ["-C", directory, "commit", "-qm", "fixture"]);
    const head = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(assertCleanPinnedRepository(directory, head, "fixture"), realpathSync.native(directory));
    writeFileSync(resolve(directory, "tracked.txt"), "dirty\n");
    assert.throws(() => assertCleanPinnedRepository(directory, head, "fixture"), /clean/u);
    writeFileSync(resolve(directory, "tracked.txt"), "clean\n");
    symlinkSync(directory, link);
    assert.throws(() => assertCleanPinnedRepository(link, head, "fixture"), /symbolic link|canonical path/u);
  } finally {
    rmSync(link, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("signer requires an exact Ed25519 trust pin and refuses key symlinks", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "p4-5-signer-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyPath = resolve(directory, "signing-key.pem");
    const linkPath = resolve(directory, "signing-key-link.pem");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    symlinkSync(keyPath, linkPath);
    const fingerprint = createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");
    const env = {
      A2A_P4_5_SIGNING_KEY_PATH: keyPath,
      A2A_P4_5_SIGNER_ID: "p4-5-ci-signer",
      A2A_P4_5_SIGNER_FINGERPRINT_SHA256: fingerprint,
    };
    const signer = loadPinnedSigner(env);
    assert.equal(signCanonicalBundle(validBundle(), signer).signature.length, 64);
    assert.throws(() => loadPinnedSigner({ ...env, A2A_P4_5_SIGNER_FINGERPRINT_SHA256: digest }), /trust pin/u);
    assert.throws(() => loadPinnedSigner({ ...env, A2A_P4_5_SIGNING_KEY_PATH: linkPath }), /symbolic link/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("immutable evidence writer refuses regular-file and symlink replacement", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "p4-5-immutable-"));
  try {
    const path = resolve(directory, "evidence.json");
    const target = resolve(directory, "target.json");
    const link = resolve(directory, "evidence-link.json");
    writeImmutable(path, Buffer.from("{}"));
    assert.throws(() => writeImmutable(path, Buffer.from("{}")), /already exists/u);
    writeFileSync(target, "trusted\n");
    symlinkSync(target, link);
    assert.throws(() => writeImmutable(link, Buffer.from("replaced\n")), /already exists/u);
    assert.equal(createHash("sha256").update("trusted\n").digest("hex"), createHash("sha256").update(readFileSync(target)).digest("hex"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
