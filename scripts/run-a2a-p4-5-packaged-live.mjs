#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";

import {
  assertArray,
  assertExactKeys,
  fail,
  verifySignedManifest,
} from "./a2a-p4-5-live/evidence-lib.mjs";
import { verifyHubDatabaseAbsent } from "./a2a-p4-5-live/hub-db-verifier.mjs";
import { runFixedProgram } from "./a2a-p4-5-live/installer-provenance-lib.mjs";
import {
  PACKAGED_LIVE_CASE_IDS,
  STABLE_TEST_IDS,
  UI_CASE_EXPECTATIONS,
  parseTsharkFields,
  readAndValidateManifestArtifacts,
  validatePackagedLiveManifest,
  verifyHubEvidenceAbsent,
  verifyRemoteServerEvidence,
  verifyTaskTraffic,
} from "./a2a-p4-5-live/packaged-live-contract.mjs";
import { parseStrictJson } from "./a2a-p4-5-live/strict-json.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDriver = resolve(root, "scripts/a2a-p4-5-live/ui-driver.mjs");

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--manifest" || !args[1] || args[1].startsWith("--")) {
    fail("packaged-live verifier accepts exactly --manifest <signed-manifest-path>");
  }
  return resolve(args[1]);
}

function validateUiResult(value) {
  assertExactKeys(value, ["schemaVersion", "stableTestIds", "caseResults"], "fixed UI driver result");
  if (value.schemaVersion !== 1 || JSON.stringify(value.stableTestIds) !== JSON.stringify(STABLE_TEST_IDS)) {
    fail("fixed UI driver result: schema/test-id set mismatch");
  }
  assertArray(value.caseResults, "fixed UI driver result.caseResults", { min: PACKAGED_LIVE_CASE_IDS.length, max: PACKAGED_LIVE_CASE_IDS.length });
  const ids = value.caseResults.map((entry, index) => {
    assertExactKeys(entry, ["id", "status", "skipped", "rendererState", "outcome", "taskState"], `fixed UI driver result.caseResults[${index}]`);
    if (entry.id !== PACKAGED_LIVE_CASE_IDS[index] || entry.status !== "passed" || entry.skipped !== false) {
      fail(`fixed UI driver result: case ${PACKAGED_LIVE_CASE_IDS[index]} did not pass without skip`);
    }
    const expected = UI_CASE_EXPECTATIONS[entry.id].final;
    if (entry.rendererState !== expected.state || entry.outcome !== expected.outcome || entry.taskState !== expected.taskState) {
      fail(`fixed UI driver result: case ${entry.id} renderer status does not match the fixed contract`);
    }
    return entry.id;
  });
  if (new Set(ids).size !== PACKAGED_LIVE_CASE_IDS.length) fail("fixed UI driver result: duplicate case ID");
  return value;
}

function runTshark(capturePath, keyLogPath, expectedVersion, run = runFixedProgram) {
  const actualVersion = run("tshark", ["--version"], { label: "tshark version" }).stdout.split(/\r?\n/u)[0];
  if (actualVersion !== expectedVersion) fail(`tshark version mismatch (expected ${expectedVersion}, got ${actualVersion})`);
  const result = run("tshark", [
    "-r", capturePath,
    "-o", `tls.keylog_file:${keyLogPath}`,
    "-Y", "http.file_data",
    "-T", "fields",
    "-E", "separator=/t",
    "-E", "occurrence=f",
    "-e", "frame.number",
    "-e", "ip.src",
    "-e", "ip.dst",
    "-e", "tcp.dstport",
    "-e", "http.host",
    "-e", "http.request.uri",
    "-e", "http.file_data",
  ], { label: "fixed tshark packet parser", maxBuffer: 256 * 1024 * 1024 });
  return { version: actualVersion, records: parseTsharkFields(result.stdout) };
}

function runUi(manifestPath, run = runFixedProgram) {
  const allowedEnvironment = Object.fromEntries([
    "HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP",
    "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    "DBUS_SESSION_BUS_ADDRESS", "LVIS_A2A_EVIDENCE_PUBLIC_KEY_FILE", "LVIS_A2A_EVIDENCE_SIGNER_SHA256",
  ].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  const result = run(process.execPath, [uiDriver, "--manifest", manifestPath], {
    label: "fixed packaged-app UI driver",
    maxBuffer: 8 * 1024 * 1024,
    inheritEnv: false,
    env: allowedEnvironment,
  });
  return validateUiResult(parseStrictJson(result.stdout, "fixed UI driver result"));
}

function writeExclusiveOutput(value) {
  const directory = resolve(root, "artifacts/a2a-p4-5");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("packaged-live output directory must be a regular directory");
  const outputPath = resolve(directory, "packaged-live.json");
  const descriptor = openSync(outputPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  return outputPath;
}

export function buildPackagedLiveEvidence({ manifestPath, run = runFixedProgram }) {
  const signed = verifySignedManifest(manifestPath);
  const manifest = validatePackagedLiveManifest(signed.manifest);
  const artifacts = readAndValidateManifestArtifacts(manifestPath, manifest);

  const ui = runUi(manifestPath, run);
  const capture = runTshark(artifacts.capturePcap.path, artifacts.tlsKeyLog.path, manifest.capture.tsharkVersion, run);
  const traffic = verifyTaskTraffic(capture.records, manifest.endpoints);
  verifyHubEvidenceAbsent(artifacts.hubEvidence);
  verifyRemoteServerEvidence(artifacts.remoteServerEvidence);
  const databaseCounts = verifyHubDatabaseAbsent({ run });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    heads: { ...manifest.heads },
    workflow: { ...manifest.workflow },
    manifest: {
      sha256: signed.artifact.sha256,
      signatureSha256: signed.signatureSha256,
      signerKeySha256: signed.signerKeySha256,
    },
    installer: {
      provenanceSha256: artifacts.provenance.sha256,
      installerSha256: artifacts.provenanceValue.installer.sha256,
      executableSha256: artifacts.installedExecutable.sha256,
      installReceiptSha256: artifacts.installReceipt.sha256,
      signaturePlatform: artifacts.provenanceValue.signature.platform,
      signatureStatus: artifacts.provenanceValue.signature.status,
      attestationReportSha256: artifacts.provenanceValue.attestation.reportSha256,
      attestationSourceHead: artifacts.provenanceValue.attestation.sourceHead,
    },
    network: {
      rawCaptureSha256: artifacts.captureRaw.sha256,
      parsedCaptureSha256: artifacts.capturePcap.sha256,
      tlsKeyLogSha256: artifacts.tlsKeyLog.sha256,
      tsharkVersion: capture.version,
      taskRequestCount: traffic.taskRequestCount,
      methods: traffic.methods,
      caseIds: traffic.caseIds,
      noSocketCaseIds: traffic.noSocketCaseIds,
      responseAssertions: traffic.responseAssertions,
      hubTaskTrafficCount: 0,
      remoteServerEvidenceSha256: artifacts.remoteServerEvidence.map((artifact) => artifact.sha256),
    },
    hubAbsence: {
      databaseCounts,
      logsChecked: artifacts.hubEvidence.logs.length,
      auditsChecked: artifacts.hubEvidence.audits.length,
      tracesChecked: artifacts.hubEvidence.traces.length,
      retainedCanaryCount: 0,
    },
    hosts: {
      identitySha256: artifacts.hostIdentity.sha256,
      clientIp: manifest.endpoints.clientIp,
      remoteIp: manifest.endpoints.remoteIp,
      hubIp: manifest.endpoints.hubIp,
    },
    target: { ...manifest.target },
    ui: {
      caseIds: ui.caseResults.map((entry) => entry.id),
      vectorCount: ui.caseResults.length,
      passed: ui.caseResults.length,
      skipped: 0,
      stableTestIds: [...ui.stableTestIds],
    },
    faultMatrixSha256: artifacts.faultMatrix.sha256,
    wireConformanceSha256: artifacts.wireConformance.sha256,
  };
}

function main() {
  const manifestPath = parseArguments(process.argv.slice(2));
  const evidence = buildPackagedLiveEvidence({ manifestPath });
  const outputPath = writeExclusiveOutput(evidence);
  process.stdout.write(`${outputPath}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
