#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { resolve4 } from "node:dns/promises";
import { X509Certificate } from "node:crypto";

import {
  assertArray,
  assertArtifactStable,
  assertExactKeys,
  fail,
  verifySignedManifest,
} from "./a2a-p4-5-live/evidence-lib.mjs";
import { verifyHubDatabaseControlPlaneAndCanaryAbsence } from "./a2a-p4-5-live/hub-db-verifier.mjs";
import { independentlyVerifyInstallerAttestation, runFixedProgram } from "./a2a-p4-5-live/installer-provenance-lib.mjs";
import {
  PACKAGED_LIVE_CASE_IDS,
  STABLE_TEST_IDS,
  UI_CASE_EXPECTATIONS,
  parseTsharkFields,
  parseTsharkSniFields,
  readAndValidateManifestArtifacts,
  validatePackagedLiveManifest,
  verifyHubEvidenceAbsent,
  verifyCapturedEndpointSni,
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

function runTshark(captureArtifact, keyLogArtifact, expectedVersion, run = runFixedProgram) {
  const actualVersion = run("tshark", ["--version"], { label: "tshark version" }).stdout.split(/\r?\n/u)[0];
  if (actualVersion !== expectedVersion) fail(`tshark version mismatch (expected ${expectedVersion}, got ${actualVersion})`);
  // Wireshark documents `separator=/t` as the TShark fields token for ASCII
  // horizontal tab; the parsers below intentionally split the resulting "\t".
  // https://www.wireshark.org/docs/wsug_html_chunked/AppToolstshark.html
  const result = run("tshark", [
    "-r", captureArtifact.path,
    "-o", `tls.keylog_file:${keyLogArtifact.path}`,
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
  ], { label: "fixed tshark packet parser", maxBuffer: 256 * 1024 * 1024, timeoutMs: 30 * 60_000 });
  const sniResult = run("tshark", [
    "-r", captureArtifact.path,
    "-Y", "tls.handshake.extensions_server_name",
    "-T", "fields",
    "-E", "separator=/t",
    "-E", "occurrence=f",
    "-e", "ip.src",
    "-e", "ip.dst",
    "-e", "tcp.dstport",
    "-e", "tls.handshake.extensions_server_name",
  ], { label: "fixed tshark TLS SNI parser", maxBuffer: 16 * 1024 * 1024, timeoutMs: 30 * 60_000 });
  assertArtifactStable(captureArtifact, "packet capture", { maxBytes: 4 * 1024 * 1024 * 1024 });
  assertArtifactStable(keyLogArtifact, "TLS key log", { maxBytes: 64 * 1024 * 1024 });
  return { version: actualVersion, records: parseTsharkFields(result.stdout), sniRecords: parseTsharkSniFields(sniResult.stdout) };
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
    env: allowedEnvironment,
  });
  return validateUiResult(parseStrictJson(result.stdout, "fixed UI driver result"));
}

function normalizedCertificateSha256(certificate) {
  return certificate.fingerprint256.replaceAll(":", "").toLowerCase();
}

async function verifyLiveEndpointIdentity(endpoints, expected, { run = runFixedProgram, resolveIpv4 = resolve4 } = {}) {
  const result = Object.create(null);
  for (const side of ["remote", "hub"]) {
    const endpointUrl = new URL(side === "remote" ? endpoints.remoteUrl : endpoints.hubUrl);
    const endpointIp = side === "remote" ? endpoints.remoteIp : endpoints.hubIp;
    const signed = expected[side];
    const resolved = [...new Set(await resolveIpv4(endpointUrl.hostname))].sort();
    const signedResolved = [...signed.resolvedIpv4].sort();
    if (JSON.stringify(resolved) !== JSON.stringify(signedResolved) || !resolved.includes(endpointIp)) {
      fail(`${side} endpoint: live DNS resolution does not match signed/captured IPv4 evidence`);
    }
    const handshake = run("openssl", [
      "s_client",
      "-connect", `${endpointIp}:443`,
      "-servername", endpointUrl.hostname,
      "-verify_hostname", endpointUrl.hostname,
      "-verify_return_error",
      "-showcerts",
    ], { label: `${side} endpoint TLS certificate verification`, maxBuffer: 8 * 1024 * 1024, input: "" });
    const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u.exec(handshake.stdout)?.[0];
    if (!pem) fail(`${side} endpoint: TLS verifier did not return a leaf certificate`);
    let certificate;
    try {
      certificate = new X509Certificate(pem);
    } catch (error) {
      fail(`${side} endpoint: invalid TLS leaf certificate (${error.message})`);
    }
    // Node returns the matching subject name on success and undefined on a
    // mismatch; make that contract explicit instead of relying on truthiness.
    const matchedSubject = certificate.checkHost(endpointUrl.hostname);
    if (matchedSubject === undefined) fail(`${side} endpoint: leaf certificate does not cover the exact hostname`);
    const certificateSha256 = normalizedCertificateSha256(certificate);
    if (certificateSha256 !== signed.certificateSha256) fail(`${side} endpoint: live certificate fingerprint does not match signed evidence`);
    result[side] = { hostname: endpointUrl.hostname, resolvedIpv4: resolved, certificateSha256 };
  }
  return result;
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

export async function buildPackagedLiveEvidence({ manifestPath, run = runFixedProgram, resolveIpv4 = resolve4 }) {
  const signed = verifySignedManifest(manifestPath);
  const manifest = validatePackagedLiveManifest(signed.manifest);
  const artifacts = readAndValidateManifestArtifacts(manifestPath, manifest);

  const independentAttestation = independentlyVerifyInstallerAttestation(artifacts.installer, {
    appHead: manifest.heads.app,
    repository: manifest.repository,
    workflowRunId: manifest.workflow.runId,
    workflowRunAttempt: manifest.workflow.attempt,
    run,
  });
  assertArtifactStable(artifacts.installer, "attested installer", { maxBytes: 4 * 1024 * 1024 * 1024 });
  const ui = runUi(manifestPath, run);
  assertArtifactStable(artifacts.installedExecutable, "installed packaged executable", { maxBytes: 1024 * 1024 * 1024 });
  const capture = runTshark(artifacts.capturePcap, artifacts.tlsKeyLog, manifest.capture.tsharkVersion, run);
  const traffic = verifyTaskTraffic(capture.records, manifest.endpoints);
  const capturedSni = verifyCapturedEndpointSni(capture.sniRecords, manifest.endpoints);
  const liveEndpointIdentity = await verifyLiveEndpointIdentity(manifest.endpoints, artifacts.endpointIdentityValue, { run, resolveIpv4 });
  verifyHubEvidenceAbsent(artifacts.hubEvidence);
  verifyRemoteServerEvidence(artifacts.remoteServerEvidence);
  const hubDatabase = verifyHubDatabaseControlPlaneAndCanaryAbsence({
    run,
    expected: {
      snapshotId: manifest.hubControlPlane.snapshotId,
      databaseIdentitySha256: manifest.hubControlPlane.databaseIdentitySha256,
      agentHubHead: manifest.heads.hub,
      appHead: manifest.heads.app,
      serverHead: manifest.heads.server,
      agentHubLockDigestSha256: manifest.hubControlPlane.agentHubLockDigestSha256,
      wireConformanceArtifactDigestSha256: manifest.hubControlPlane.wireConformanceArtifactDigestSha256,
      remoteUrl: manifest.endpoints.remoteUrl,
    },
  });

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
      attestationReportSha256: artifacts.attestationReport.sha256,
      executableSha256: artifacts.installedExecutable.sha256,
      installReceiptSha256: artifacts.installReceipt.sha256,
      platformIdentityPlatform: artifacts.provenanceValue.platformIdentity.platform,
      platformIdentityStatus: artifacts.provenanceValue.platformIdentity.status,
      storedAttestationSourceHead: artifacts.storedAttestation.sourceHead,
      independentAttestationSourceHead: independentAttestation.sourceHead,
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
      capturedSni,
      liveEndpointIdentity,
      hubTaskTrafficCount: 0,
      remoteServerEvidenceSha256: artifacts.remoteServerEvidence.map((artifact) => artifact.sha256),
    },
    hubAbsence: {
      databaseIdentitySha256: hubDatabase.databaseIdentitySha256,
      controlPlaneSnapshotId: hubDatabase.snapshotId,
      databaseCounts: hubDatabase.counts,
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

async function main() {
  const manifestPath = parseArguments(process.argv.slice(2));
  const evidence = await buildPackagedLiveEvidence({ manifestPath });
  const outputPath = writeExclusiveOutput(evidence);
  process.stdout.write(`${outputPath}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
