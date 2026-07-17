import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  A2A_SPECIFICATION_URI,
  EXACT_REPLAY_EXTENSION_URI,
  PINNED_TCK_COMMIT,
  PINNED_TCK_TAG,
  WIRE_CONFORMANCE_SCHEMA,
  WIRE_RESULT_SCHEMA,
  assertCleanPinnedRepository,
  fileSha256,
  loadPinnedSigner,
  parseVitestReport,
  parseWireArguments,
  runCaptured,
  sha256,
  signCanonicalBundle,
  validateHubWireBundle,
  writeImmutable,
} from "./a2a-p4-5-harness-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "artifacts/a2a-p4-5");
const temporary = mkdtempSync(resolve(tmpdir(), "lvis-a2a-p4-5-wire-"));

function requiredPath(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

function compatibilitySummary(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const jsonrpc = report.per_transport?.jsonrpc;
  if (!jsonrpc || Number(jsonrpc.failed ?? 0) !== 0) {
    throw new Error("official TCK compatibility report is absent or failing");
  }
  return Object.freeze({
    total: Number(jsonrpc.total ?? 0),
    passed: Number(jsonrpc.passed ?? 0),
    failed: Number(jsonrpc.failed ?? 0),
    skipped: Number(jsonrpc.skipped ?? 0),
  });
}

try {
  const pins = parseWireArguments(process.argv.slice(2));
  if (pins.serverHead !== pins.appHead) {
    throw new Error("the first P4-5 remote server slice is lvis-app and requires --server-head to equal --app-head");
  }
  const hubPath = requiredPath("A2A_P4_5_AGENT_HUB_PATH");
  const tckPath = requiredPath("A2A_P4_5_TCK_PATH");
  const serverPath = resolve(process.env.A2A_P4_5_REMOTE_SERVER_PATH ?? root);
  if (serverPath !== root) {
    throw new Error("the first P4-5 remote server slice must use the exact lvis-app checkout");
  }
  assertCleanPinnedRepository(root, pins.appHead, "lvis-app");
  assertCleanPinnedRepository(hubPath, pins.hubHead, "Agent Hub");
  assertCleanPinnedRepository(serverPath, pins.serverHead, "remote server");
  assertCleanPinnedRepository(tckPath, pins.tckCommit, "A2A TCK", { exactTag: pins.tckVersion });

  const signer = loadPinnedSigner();
  const artifactId = `p4-5-wire-${pins.appHead.slice(0, 12)}-${pins.hubHead.slice(0, 12)}`;
  const vectorVitestReportPath = resolve(temporary, "wire-vitest.json");
  const vectorDetailPath = resolve(temporary, "wire-vectors.json");

  const checker = runCaptured(
    "check:a2a-p4-5-contract",
    "node",
    ["scripts/check-a2a-p4-5-contract.mjs"],
    { cwd: root },
  );
  const vectorsCommand = runCaptured(
    "p4-5-production-wire-vectors",
    "bun",
    [
      "run", "test:vitest", "--", "run", "src/api/__tests__/a2a-p4-5-wire.test.ts",
      "--reporter=json", `--outputFile=${vectorVitestReportPath}`,
    ],
    { cwd: root, env: { ...process.env, A2A_P4_5_VECTOR_REPORT: vectorDetailPath } },
  );
  const vectorCounts = parseVitestReport(vectorVitestReportPath, ["src/api/__tests__/a2a-p4-5-wire.test.ts"]);
  const vectorDetail = JSON.parse(readFileSync(vectorDetailPath, "utf8"));
  if (
    vectorDetail.verification_state !== "passed" ||
    vectorDetail.vector_count !== vectorCounts.total ||
    !Array.isArray(vectorDetail.vector_ids) ||
    vectorDetail.vector_ids.length !== vectorCounts.total ||
    new Set(vectorDetail.vector_ids).size !== vectorCounts.total ||
    !/^[0-9a-f]{64}$/u.test(vectorDetail.agent_card_digest_sha256) ||
    !/^[0-9a-f]{64}$/u.test(vectorDetail.extension_spec_digest_sha256)
  ) {
    throw new Error("wire vector detail report is incomplete, duplicated, or not passing");
  }
  const expectedSpecDigest = fileSha256(resolve(root, "docs/protocols/lvis-a2a-exact-send-replay.md"));
  if (vectorDetail.extension_spec_digest_sha256 !== expectedSpecDigest) {
    throw new Error("served extension specification digest does not match the executed lvis-app head");
  }

  const tckCommand = runCaptured(
    "official-a2a-tck-jsonrpc",
    "bun",
    ["scripts/run-a2a-p4-5-tck.ts"],
    { cwd: root, env: { ...process.env, A2A_P4_5_TCK_PATH: tckPath } },
  );
  const tckReportPath = resolve(tckPath, "reports/compatibility.json");
  const tckCounts = compatibilitySummary(tckReportPath);

  const hubBundle = validateHubWireBundle({
    schema_version: WIRE_CONFORMANCE_SCHEMA,
    artifact_id: artifactId,
    agent_hub_head_sha: pins.hubHead,
    lvis_app_head_sha: pins.appHead,
    remote_server_head_sha: pins.serverHead,
    a2a_tck_tag: PINNED_TCK_TAG,
    a2a_tck_commit_sha: PINNED_TCK_COMMIT,
    agent_hub_lock_digest_sha256: fileSha256(resolve(hubPath, "server/bun.lock")),
    lvis_app_lock_digest_sha256: fileSha256(resolve(root, "bun.lock")),
    remote_server_lock_digest_sha256: fileSha256(resolve(serverPath, "bun.lock")),
    a2a_tck_lock_digest_sha256: fileSha256(resolve(tckPath, "uv.lock")),
    a2a_specification_uri: A2A_SPECIFICATION_URI,
    extension_spec_uri: EXACT_REPLAY_EXTENSION_URI,
    extension_spec_digest_sha256: vectorDetail.extension_spec_digest_sha256,
    agent_card_digest_sha256: vectorDetail.agent_card_digest_sha256,
    test_vectors_total: vectorCounts.total,
    test_vectors_passed: vectorCounts.passed,
    test_vectors_failed: 0,
    test_vectors_skipped: 0,
    verification_state: "passed",
  });
  const signedHubBundle = signCanonicalBundle(hubBundle, signer);

  const commandResults = [
    { ...checker.summary, report_sha256: fileSha256(resolve(root, "scripts/check-a2a-p4-5-contract.mjs")) },
    { ...vectorsCommand.summary, report_sha256: fileSha256(vectorVitestReportPath) },
    { ...tckCommand.summary, report_sha256: fileSha256(tckReportPath) },
  ];
  const resultBundle = {
    schema_version: WIRE_RESULT_SCHEMA,
    artifact_id: artifactId,
    wire_bundle_sha256: signedHubBundle.payloadSha256,
    signer_id: signer.signerId,
    signer_fingerprint_sha256: signer.fingerprint,
    command_results: commandResults,
    report_digests: {
      contract_checker_sha256: fileSha256(resolve(root, "scripts/check-a2a-p4-5-contract.mjs")),
      wire_vitest_sha256: fileSha256(vectorVitestReportPath),
      wire_vectors_sha256: fileSha256(vectorDetailPath),
      tck_compatibility_sha256: fileSha256(tckReportPath),
    },
    test_vectors_total: vectorCounts.total,
    test_vectors_passed: vectorCounts.passed,
    test_vectors_failed: 0,
    test_vectors_skipped: 0,
    verification_state: "passed",
  };
  const signedResultBundle = signCanonicalBundle(resultBundle, signer);

  writeImmutable(resolve(outputDirectory, "wire-conformance.bundle.json"), signedHubBundle.payload);
  writeImmutable(resolve(outputDirectory, "wire-conformance.bundle.sig"), signedHubBundle.signature);
  writeImmutable(resolve(outputDirectory, "wire-conformance.result.bundle.json"), signedResultBundle.payload);
  writeImmutable(resolve(outputDirectory, "wire-conformance.result.bundle.sig"), signedResultBundle.signature);
  const summary = {
    schema_version: "lvis-a2a-p4-5-wire-summary/v1",
    artifact_id: artifactId,
    repository_heads: {
      agent_hub: pins.hubHead,
      lvis_app: pins.appHead,
      remote_server: pins.serverHead,
      remote_server_source: "lvis-app:first-slice",
      tck: pins.tckCommit,
      tck_tag: pins.tckVersion,
    },
    signer: {
      id: signer.signerId,
      trust_pin_sha256: signer.fingerprint,
    },
    signed_bundles: {
      hub_payload_sha256: signedHubBundle.payloadSha256,
      hub_signature_sha256: signedHubBundle.signatureSha256,
      result_payload_sha256: signedResultBundle.payloadSha256,
      result_signature_sha256: signedResultBundle.signatureSha256,
    },
    reports: resultBundle.report_digests,
    command_results: commandResults,
    vectors: vectorCounts,
    official_tck: tckCounts,
    zero_vector_skips: true,
    verification_state: "passed",
  };
  const summaryBytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeImmutable(resolve(outputDirectory, "wire-conformance.json"), summaryBytes);
  process.stdout.write(
    `${resolve(outputDirectory, "wire-conformance.json")} sha256=${sha256(summaryBytes)} vectors=${vectorCounts.total}\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
