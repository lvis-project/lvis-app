import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { dirname, resolve } from "node:path";

export const WIRE_CONFORMANCE_SCHEMA = "lvis-wire-conformance-bundle/v1";
export const WIRE_RESULT_SCHEMA = "lvis-wire-conformance-result-bundle/v1";
export const A2A_SPECIFICATION_URI = "https://a2a-protocol.org/v1.0.0/specification/";
export const EXACT_REPLAY_EXTENSION_URI = "https://lvis.ai/a2a/extensions/exact-send-replay/v1";
export const PINNED_TCK_TAG = "1.0.0.alpha2";
export const PINNED_TCK_COMMIT = "29063fe95e903cddac5d8ff811ab94df1ad6ef86";

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MUTABLE_OR_PLACEHOLDER = /(?:^|[._:-])(latest|main|master|head|placeholder|replace(?:-?me)?|todo)(?:$|[._:-])/iu;

export const DETERMINISTIC_TEST_FILES = Object.freeze([
  "src/api/__tests__/a2a-route-control-client.test.ts",
  "src/api/__tests__/a2a-exact-replay-handler.test.ts",
  "src/api/__tests__/a2a-exact-replay-store.test.ts",
  "src/api/__tests__/a2a-remote-client.test.ts",
  "src/api/__tests__/a2a-remote-history.test.ts",
  "src/api/__tests__/a2a-remote-store-lifecycle.test.ts",
  "src/api/__tests__/a2a-remote-store-recovery.test.ts",
  "src/api/__tests__/a2a-remote-task-registry.test.ts",
  "src/api/__tests__/a2a-remote-transport.test.ts",
  "src/api/__tests__/a2a-router-advertised-origin.test.ts",
  "src/main/__tests__/a2a-remote-receiver-server.test.ts",
  "src/main/__tests__/a2a-remote-runtime.test.ts",
  "src/main/__tests__/remote-a2a-action-controller.test.ts",
]);

export const P4_5_CONSTANTS = Object.freeze({
  a2a_protocol_version: "1.0",
  a2a_specification_uri: A2A_SPECIFICATION_URI,
  exact_replay_extension_uri: EXACT_REPLAY_EXTENSION_URI,
  exact_replay_retention_seconds: 604800,
  exact_replay_error_codes: Object.freeze([-32090, -32091, -32092, -32093, -32094]),
  retry_after_error_code: -32092,
  retry_after_seconds: 1,
  tck_tag: PINNED_TCK_TAG,
  tck_commit_sha: PINNED_TCK_COMMIT,
});

export function stableJson(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("P4-5 evidence contains an unsupported JSON value");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function fileSha256(path) {
  return sha256(readFileSync(path));
}

export function git(repoPath, ...args) {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertNoSymlinkPath(path, field) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${field} does not exist: ${absolute}`);
  if (lstatSync(absolute).isSymbolicLink()) throw new Error(`${field} must not be a symbolic link`);
  // macOS exposes /tmp itself as the system-owned /private/tmp alias. Reject a
  // caller-controlled final symlink while canonicalizing trusted parent aliases.
  return realpathSync.native(absolute);
}

export function assertCleanPinnedRepository(path, expectedHead, field, options = {}) {
  if (!COMMIT_SHA.test(expectedHead)) throw new Error(`${field} head must be a full lowercase commit SHA`);
  const absolute = assertNoSymlinkPath(path, field);
  const actualHead = git(absolute, "rev-parse", "HEAD");
  if (actualHead !== expectedHead) {
    throw new Error(`${field} head mismatch: expected ${expectedHead}, got ${actualHead}`);
  }
  const status = git(absolute, "status", "--porcelain", "--untracked-files=all");
  if (status !== "") throw new Error(`${field} checkout must be clean`);
  if (options.exactTag !== undefined) {
    const tags = git(absolute, "tag", "--points-at", "HEAD").split("\n").filter(Boolean);
    if (tags.length !== 1 || tags[0] !== options.exactTag) {
      throw new Error(`${field} must be the clean exact ${options.exactTag} tag checkout`);
    }
  }
  return absolute;
}

export function parseWireArguments(argv) {
  const expected = new Set(["--app-head", "--hub-head", "--server-head", "--tck-version", "--tck-commit"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!expected.has(flag) || value === undefined || value.startsWith("--") || values.has(flag)) {
      throw new Error(
        "usage: test:a2a-p4-5:wire -- --app-head <full-sha> --hub-head <full-sha> " +
        "--server-head <full-sha> --tck-version <tag> --tck-commit <full-sha>",
      );
    }
    values.set(flag, value);
  }
  if (values.size !== expected.size || argv.length !== expected.size * 2) {
    throw new Error("all five P4-5 wire pin arguments are required exactly once");
  }
  const result = {
    appHead: values.get("--app-head"),
    hubHead: values.get("--hub-head"),
    serverHead: values.get("--server-head"),
    tckVersion: values.get("--tck-version"),
    tckCommit: values.get("--tck-commit"),
  };
  for (const [field, value] of Object.entries(result)) {
    if (MUTABLE_OR_PLACEHOLDER.test(value)) throw new Error(`${field} contains a mutable or placeholder reference`);
  }
  for (const [field, value] of [["appHead", result.appHead], ["hubHead", result.hubHead], ["serverHead", result.serverHead], ["tckCommit", result.tckCommit]]) {
    if (!COMMIT_SHA.test(value)) throw new Error(`${field} must be a full lowercase commit SHA`);
  }
  if (result.tckVersion !== PINNED_TCK_TAG || result.tckCommit !== PINNED_TCK_COMMIT) {
    throw new Error(`P4-5 wire evidence requires official TCK ${PINNED_TCK_TAG} at ${PINNED_TCK_COMMIT}`);
  }
  return Object.freeze(result);
}

export function runCaptured(name, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;
  const summary = Object.freeze({
    name,
    exit_code: exitCode,
    stdout_sha256: sha256(Buffer.from(stdout, "utf8")),
    stderr_sha256: sha256(Buffer.from(stderr, "utf8")),
  });
  if (result.error || exitCode !== 0) {
    const bounded = `${stdout}\n${stderr}`.split(/\r?\n/u).filter(Boolean).slice(-30).join("\n");
    if (bounded) process.stderr.write(`${bounded}\n`);
    throw Object.assign(new Error(`${name} failed with exit code ${exitCode}`), { commandSummary: summary });
  }
  return { summary, stdout, stderr };
}

export function parseVitestReport(path, expectedFiles) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const total = Number(report.numTotalTests);
  const passed = Number(report.numPassedTests);
  const failed = Number(report.numFailedTests);
  const skipped = Number(report.numPendingTests) + Number(report.numTodoTests ?? 0);
  if (
    report.success !== true ||
    !Number.isSafeInteger(total) || total <= 0 ||
    passed !== total || failed !== 0 || skipped !== 0
  ) {
    throw new Error(`P4-5 suite must pass every real case with zero skips: total=${total} passed=${passed} failed=${failed} skipped=${skipped}`);
  }
  const files = [...new Set((report.testResults ?? []).map((entry) => entry.name))].sort();
  if (expectedFiles !== undefined) {
    const expected = [...expectedFiles].map((file) => file.replaceAll("\\", "/")).sort();
    const actual = files.map((file) => file.replaceAll("\\", "/")).sort();
    if (
      actual.length !== expected.length ||
      actual.some((file, index) => !file.endsWith(`/${expected[index]}`))
    ) {
      throw new Error(`P4-5 suite file enumeration mismatch: expected ${expected.join(", ")}`);
    }
    return Object.freeze({ total, passed, failed, skipped, files: expected });
  }
  return Object.freeze({ total, passed, failed, skipped, files });
}

export function loadPinnedSigner(env = process.env) {
  const keyPath = env.A2A_P4_5_SIGNING_KEY_PATH;
  const signerId = env.A2A_P4_5_SIGNER_ID;
  const fingerprintPin = env.A2A_P4_5_SIGNER_FINGERPRINT_SHA256;
  if (!keyPath || !signerId || !fingerprintPin) {
    throw new Error("A2A_P4_5_SIGNING_KEY_PATH, A2A_P4_5_SIGNER_ID, and A2A_P4_5_SIGNER_FINGERPRINT_SHA256 are required");
  }
  if (!BOUNDED_ID.test(signerId) || MUTABLE_OR_PLACEHOLDER.test(signerId)) {
    throw new Error("A2A_P4_5_SIGNER_ID must be a non-placeholder bounded identifier");
  }
  if (!SHA256.test(fingerprintPin)) throw new Error("A2A_P4_5_SIGNER_FINGERPRINT_SHA256 must be lowercase SHA-256");
  const absoluteKeyPath = assertNoSymlinkPath(keyPath, "evidence signing key");
  const privateKey = createPrivateKey(readFileSync(absoluteKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("P4-5 evidence signer must use Ed25519");
  const publicKey = createPublicKey(privateKey);
  const fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
  if (fingerprint !== fingerprintPin) throw new Error("P4-5 evidence signer fingerprint does not match the trust pin");
  return Object.freeze({ signerId, fingerprint, privateKey });
}

export function signCanonicalBundle(bundle, signer) {
  const payload = Buffer.from(stableJson(bundle), "utf8");
  const signature = sign(null, payload, signer.privateKey);
  if (signature.length !== 64) throw new Error("Ed25519 signature must be exactly 64 bytes");
  return Object.freeze({
    payload,
    signature,
    payloadSha256: sha256(payload),
    signatureSha256: sha256(signature),
  });
}

export function writeImmutable(path, bytes) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(
      absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o444,
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o444);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`immutable evidence already exists: ${absolute}`, { cause: error });
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return absolute;
}

export function validateHubWireBundle(bundle) {
  const expectedKeys = [
    "a2a_specification_uri", "a2a_tck_commit_sha", "a2a_tck_lock_digest_sha256", "a2a_tck_tag",
    "agent_card_digest_sha256", "agent_hub_head_sha", "agent_hub_lock_digest_sha256", "artifact_id",
    "extension_spec_digest_sha256", "extension_spec_uri", "lvis_app_head_sha", "lvis_app_lock_digest_sha256",
    "remote_server_head_sha", "remote_server_lock_digest_sha256", "schema_version", "test_vectors_failed",
    "test_vectors_passed", "test_vectors_skipped", "test_vectors_total", "verification_state",
  ];
  const keys = Object.keys(bundle).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("wire bundle is not byte-compatible with the Agent Hub v1 schema");
  }
  if (bundle.schema_version !== WIRE_CONFORMANCE_SCHEMA || bundle.a2a_specification_uri !== A2A_SPECIFICATION_URI || bundle.extension_spec_uri !== EXACT_REPLAY_EXTENSION_URI) {
    throw new Error("wire bundle does not use the locked LVIS profile");
  }
  if (!BOUNDED_ID.test(bundle.artifact_id) || MUTABLE_OR_PLACEHOLDER.test(bundle.artifact_id)) {
    throw new Error("wire artifact_id is invalid or placeholder-like");
  }
  for (const field of ["agent_hub_head_sha", "lvis_app_head_sha", "remote_server_head_sha", "a2a_tck_commit_sha"]) {
    if (!COMMIT_SHA.test(bundle[field])) throw new Error(`${field} must be a full lowercase commit SHA`);
  }
  for (const field of ["agent_hub_lock_digest_sha256", "lvis_app_lock_digest_sha256", "remote_server_lock_digest_sha256", "a2a_tck_lock_digest_sha256", "extension_spec_digest_sha256", "agent_card_digest_sha256"]) {
    if (!SHA256.test(bundle[field])) throw new Error(`${field} must be lowercase SHA-256`);
  }
  if (bundle.a2a_tck_tag !== PINNED_TCK_TAG || bundle.a2a_tck_commit_sha !== PINNED_TCK_COMMIT) {
    throw new Error("wire bundle TCK pin mismatch");
  }
  if (!Number.isSafeInteger(bundle.test_vectors_total) || bundle.test_vectors_total <= 0 || bundle.test_vectors_passed !== bundle.test_vectors_total || bundle.test_vectors_failed !== 0 || bundle.test_vectors_skipped !== 0 || bundle.verification_state !== "passed") {
    throw new Error("wire bundle must prove all vectors passed with zero failures/skips");
  }
  return bundle;
}
