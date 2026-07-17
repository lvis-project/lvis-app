import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdtempSync,
  renameSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  linuxExecutablePreferenceSuffixes,
  pickBestByExactSuffix,
} from "../../lib/packaged-executable-selection.mjs";

import {
  assertExactKeys,
  assertArtifactStable,
  assertNoFollowFallbackPath,
  assertSafeString,
  readEvidenceDescriptor,
  readRegularFile,
  sha256Buffer,
  verifySignedManifest,
} from "../evidence-lib.mjs";
import {
  buildHubVerificationSql,
  parseHubCanaryCounts,
  parseHubVerificationOutput,
} from "../hub-db-verifier.mjs";
import {
  independentlyVerifyInstallerAttestation,
  runFixedProgram,
  validateProvenance,
  verifyAttestationReport,
  verifyInstallerIdentity,
} from "../installer-provenance-lib.mjs";
import {
  CANARIES,
  PACKAGED_LIVE_CASE_IDS,
  REMOTE_OBSERVED_CASE_IDS,
  assertPublicHttpsUrl,
  parseTsharkFields,
  parseTsharkSniFields,
  validateFaultMatrix,
  validateHostIdentity,
  validateEndpointIdentity,
  validatePackagedLiveManifest,
  validateWireConformance,
  verifyHubEvidenceAbsent,
  verifyCapturedEndpointSni,
  verifyRemoteServerEvidence,
  verifyTaskTraffic,
} from "../packaged-live-contract.mjs";
import { parseStrictJson } from "../strict-json.mjs";
import { buildPackagedUiEnvironment } from "../ui-driver-environment.mjs";
import { resolveCanonicalUiManifestPath } from "../ui-driver-input.mjs";
import { writeExclusiveOutput } from "../../run-a2a-p4-5-packaged-live.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const HEAD = "a".repeat(40);
const HUB_HEAD = "b".repeat(40);
const SERVER_HEAD = "c".repeat(40);
// These syntactically public names are assembled only inside the test process;
// production endpoints always come from the signed packaged-live manifest.
const TEST_REMOTE_HOST = ["a2a-remote-383a1d70", "com"].join(".");
const TEST_HUB_HOST = ["a2a-hub-383a1d70", "com"].join(".");

function makeTempDirectory(prefix) {
  return mkdtempSync(resolve(realpathSync(tmpdir()), prefix));
}

function descriptor(path, sha256 = SHA) {
  return { path, sha256 };
}

function validManifest() {
  return {
    schemaVersion: 1,
    repository: "lvis-project/lvis-app",
    heads: { app: HEAD, hub: HUB_HEAD, server: SERVER_HEAD },
    workflow: { runId: "12345", attempt: "1" },
    target: { targetAgentId: 17, label: "Evidence Remote Agent" },
    endpoints: {
      clientIp: "192.168.50.10",
      remoteIp: "8.8.8.8",
      hubIp: "1.1.1.1",
      remoteUrl: `https://${TEST_REMOTE_HOST}/rpc`,
      hubUrl: `https://${TEST_HUB_HOST}/control`,
    },
    installerArtifact: descriptor("LVIS-1.0.0.dmg"),
    attestationReport: descriptor("LVIS-1.0.0.dmg.attestation.json", SHA_B),
    installerProvenance: descriptor("provenance.json"),
    installedExecutable: descriptor("installed/LVIS.app/Contents/MacOS/LVIS", SHA_B),
    installReceipt: descriptor("install-receipt.json", "c".repeat(64)),
    capture: {
      format: "pcapng",
      raw: descriptor("capture.pcapng", "d".repeat(64)),
      decodedPcap: null,
      tlsKeyLog: descriptor("tls.keys", "e".repeat(64)),
      tsharkVersion: "TShark (Wireshark) 4.6.0",
    },
    hubEvidence: {
      logs: [descriptor("hub.log", "f".repeat(64))],
      audits: [descriptor("hub.audit", "1".repeat(64))],
      traces: [descriptor("hub.trace", "2".repeat(64))],
    },
    remoteServerEvidence: [descriptor("remote-server.log", "6".repeat(64))],
    hostIdentity: descriptor("hosts.json", "3".repeat(64)),
    endpointIdentity: descriptor("endpoints.json", "7".repeat(64)),
    hubControlPlane: {
      snapshotId: "8".repeat(64),
      databaseIdentitySha256: "9".repeat(64),
      agentHubLockDigestSha256: "c".repeat(64),
      wireConformanceArtifactDigestSha256: SHA,
    },
    wireConformance: descriptor("wire.json", "4".repeat(64)),
    faultMatrix: descriptor("faults.json", "5".repeat(64)),
    caseIds: [...PACKAGED_LIVE_CASE_IDS],
    vectorCount: PACKAGED_LIVE_CASE_IDS.length,
  };
}

function validProvenance() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-16T00:00:00.000Z",
    installer: { name: "LVIS-1.0.0.dmg", size: 123, sha256: SHA },
    source: { repository: "lvis-project/lvis-app", appHead: HEAD, agentHubHead: HUB_HEAD, agentHubLockDigestSha256: "c".repeat(64) },
    workflow: { runId: "12345", attempt: "1" },
    platformIdentity: {
      platform: "macos", status: "publisher-verified", identityKind: "native-signature",
      installerCodesignIdentity: "Developer ID Application: LVIS",
      teamId: "ABCDE12345",
      certificateSha256: "A".repeat(64),
      installerSpctlAssessment: "accepted",
      appCodesignIdentity: "Developer ID Application: LVIS",
      appSpctlAssessment: "accepted",
      verifier: "codesign+spctl",
    },
    attestation: {
      reportSha256: SHA_B, subjectSha256: SHA, sourceHead: HEAD,
      repository: "lvis-project/lvis-app", workflowRunId: "12345", workflowRunAttempt: "1",
    },
    locks: { packageJsonSha256: "c".repeat(64), bunLockSha256: "d".repeat(64) },
    tools: { node: "v26.1.0", bun: "1.3.14", git: "git version 2.51.0", gh: "gh version 2.76.0", identityVerifier: "codesign+spctl" },
  };
}

function validAttestationReport() {
  const workflowUri = "https://github.com/lvis-project/lvis-app/.github/workflows/a2a-p4-5-packaged-evidence.yml@refs/heads/main";
  return [{
    attestation: {
      bundle: { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" },
      bundle_url: "https://api.github.com/repos/lvis-project/lvis-app/attestations/1",
      initiator: "github-actions",
    },
    verificationResult: {
      mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: "LVIS-1.0.0.dmg", digest: { sha256: SHA } }],
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: { buildDefinition: {} },
      },
      signature: {
        certificate: {
          certificateIssuer: "CN=GitHub Artifact Attestation CA",
          subjectAlternativeName: workflowUri,
          issuer: "https://token.actions.githubusercontent.com",
          buildSignerURI: workflowUri,
          buildSignerDigest: HEAD,
          runnerEnvironment: "github-hosted",
          sourceRepositoryURI: "https://github.com/lvis-project/lvis-app",
          sourceRepositoryDigest: HEAD,
          buildConfigURI: workflowUri,
          buildConfigDigest: HEAD,
          runInvocationURI: "https://github.com/lvis-project/lvis-app/actions/runs/12345/attempts/1",
        },
      },
      verifiedTimestamps: [{
        type: "Tlog",
        uri: "https://rekor.sigstore.dev",
        timestamp: "2026-07-16T00:00:00Z",
      }],
      verifiedIdentity: {},
    },
  }];
}

function verifyFixtureAttestation(report) {
  return verifyAttestationReport({
    bytes: Buffer.from(JSON.stringify(report)),
    sha256: SHA_B,
  }, {
    installerSha256: SHA,
    appHead: HEAD,
    repository: "lvis-project/lvis-app",
    workflowRunId: "12345",
    workflowRunAttempt: "1",
  });
}

test("strict JSON rejects duplicate members, trailing data, invalid numbers, and excessive depth", () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate object member/u);
  assert.throws(() => parseStrictJson('{"a":1}x'), /trailing data/u);
  assert.throws(() => parseStrictJson('{"a":01}'), /expected/u);
  assert.throws(() => parseStrictJson("[[[]]]", "deep", { maxDepth: 1 }), /depth limit/u);
  assert.deepEqual({ ...parseStrictJson('{"ok":true}') }, { ok: true });
});

test("exact schema and placeholder checks fail closed", () => {
  assert.throws(() => assertExactKeys({ a: 1, command: "run" }, ["a"], "fixture"), /unknown=command/u);
  assert.throws(() => assertExactKeys({}, ["required"], "fixture"), /missing=required/u);
  for (const value of ["placeholder", "change-me", "unknown", "demo/example/path", "todo-value"]) {
    assert.throws(() => assertSafeString(value, "fixture"), /placeholder/u);
  }
});

test("evidence descriptors reject escapes, empty files, symlinks, and digest mismatch", () => {
  const directory = makeTempDirectory("lvis-evidence-");
  const manifestPath = resolve(directory, "manifest.json");
  const artifactPath = resolve(directory, "artifact.bin");
  writeFileSync(manifestPath, "{}\n");
  writeFileSync(artifactPath, "immutable bytes");
  const sha256 = sha256Buffer(Buffer.from("immutable bytes"));
  assert.equal(readEvidenceDescriptor(manifestPath, descriptor("artifact.bin", sha256), "artifact").sha256, sha256);
  const originalCwd = process.cwd();
  try {
    process.chdir("/");
    assert.equal(readEvidenceDescriptor(manifestPath, descriptor("artifact.bin", sha256), "cwd-independent artifact").sha256, sha256);
  } finally {
    process.chdir(originalCwd);
  }
  assert.throws(() => readEvidenceDescriptor(manifestPath, descriptor("../escape", sha256), "artifact"), /confined|escapes/u);
  assert.throws(() => readEvidenceDescriptor(manifestPath, descriptor("artifact.bin", SHA), "artifact"), /digest mismatch/u);
  writeFileSync(resolve(directory, "empty"), "");
  assert.throws(() => readEvidenceDescriptor(manifestPath, descriptor("empty", sha256), "artifact"), /file size/u);
  assert.throws(
    () => readRegularFile(resolve(directory, "missing"), "missing artifact"),
    /cannot read canonical regular file \(.*ENOENT/u,
  );
  symlinkSync(artifactPath, resolve(directory, "link"));
  assert.throws(() => readEvidenceDescriptor(manifestPath, descriptor("link", sha256), "artifact"), /non-symlink|symlink path components/u);
  const outside = makeTempDirectory("lvis-outside-");
  writeFileSync(resolve(outside, "escaped.bin"), "immutable bytes");
  symlinkSync(outside, resolve(directory, "linked-directory"), "dir");
  assert.throws(() => readEvidenceDescriptor(manifestPath, descriptor("linked-directory/escaped.bin", sha256), "artifact"), /symlink path components/u);
  assert.throws(
    () => readRegularFile(resolve(directory, "linked-directory/escaped.bin"), "direct linked artifact"),
    /symlink path components|non-canonical aliases/u,
  );
});

test("O_NOFOLLOW fallback rejects symlink path components explicitly", () => {
  // Resolve the fixture root first so macOS's /tmp -> /private/tmp alias is
  // not itself the path component under test.
  const directory = makeTempDirectory("lvis-no-follow-fallback-");
  const artifactPath = resolve(directory, "artifact.bin");
  const linkPath = resolve(directory, "artifact-link.bin");
  writeFileSync(artifactPath, "immutable bytes");
  symlinkSync(artifactPath, linkPath);

  assert.doesNotThrow(() => assertNoFollowFallbackPath(artifactPath, "artifact", undefined));
  assert.throws(
    () => assertNoFollowFallbackPath(linkPath, "artifact", undefined),
    /symlink path components are forbidden/u,
  );
});

test("packaged verifier keeps TShark's documented /t tab separator token", () => {
  const source = readFileSync(resolve(ROOT, "scripts/run-a2a-p4-5-packaged-live.mjs"), "utf8");
  assert.equal(source.match(/"separator=\/t"/gu)?.length, 2);
  assert.match(source, /documents `separator=\/t` as the TShark fields token/u);
});

test("large evidence uses bounded streaming hashing/scanning and detects descriptor races", () => {
  const directory = makeTempDirectory("lvis-streaming-");
  const path = resolve(directory, "large.log");
  const marker = CANARIES[0];
  const prefix = Buffer.alloc((1024 * 1024) - 5, "x");
  writeFileSync(path, Buffer.concat([prefix, Buffer.from(marker), Buffer.alloc(1024 * 1024, "y")]));
  const artifact = readRegularFile(path, "large streaming fixture", {
    maxBytes: 3 * 1024 * 1024,
    loadBytes: false,
    needles: [marker],
  });
  assert.equal(artifact.bytes, undefined);
  assert.equal(artifact.needleMatches[marker], true, "marker spanning the 1 MiB chunk boundary must be found");
  assertArtifactStable(artifact, "large streaming fixture", { maxBytes: 3 * 1024 * 1024 });

  const replacement = resolve(directory, "replacement.log");
  writeFileSync(replacement, Buffer.alloc(artifact.size, "z"));
  renameSync(replacement, path);
  assert.throws(() => assertArtifactStable(artifact, "large streaming fixture", { maxBytes: 3 * 1024 * 1024 }), /identity or digest changed/u);
});

test("Ed25519 manifest verification pins the signer fingerprint and raw bytes", () => {
  const directory = makeTempDirectory("lvis-signed-");
  const manifestPath = resolve(directory, "live-input.json");
  const keyPath = resolve(directory, "evidence.pub.pem");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifestBytes = Buffer.from('{"schemaVersion":1}\n');
  const der = publicKey.export({ format: "der", type: "spki" });
  const fingerprint = createHash("sha256").update(der).digest("hex");
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(keyPath, publicKey.export({ format: "pem", type: "spki" }));
  writeFileSync(`${manifestPath}.sig`, `${JSON.stringify({
    algorithm: "ed25519",
    signatureBase64: sign(null, manifestBytes, privateKey).toString("base64"),
    signerKeySha256: fingerprint,
  })}\n`);
  const verified = verifySignedManifest(manifestPath, { publicKeyPath: keyPath, expectedSignerSha256: fingerprint });
  assert.equal(verified.signerKeySha256, fingerprint);
  writeFileSync(manifestPath, '{"schemaVersion":2}\n');
  assert.throws(() => verifySignedManifest(manifestPath, { publicKeyPath: keyPath, expectedSignerSha256: fingerprint }), /signature verification failed/u);
});

test("packaged-live manifest requires the exact closed schema and case/vector set", () => {
  const manifest = validManifest();
  assert.equal(validatePackagedLiveManifest(manifest), manifest);
  assert.throws(() => validatePackagedLiveManifest({ ...manifest, verificationCommands: [] }), /unknown=verificationCommands/u);
  assert.throws(() => validatePackagedLiveManifest({ ...manifest, vectorCount: 0 }), /vectorCount/u);
  assert.throws(() => validatePackagedLiveManifest({ ...manifest, caseIds: manifest.caseIds.slice(1) }), /array length/u);
  const mutableRef = structuredClone(manifest);
  mutableRef.heads.app = "main";
  assert.throws(() => validatePackagedLiveManifest(mutableRef), /length 40|invalid format/u);
  const missingAttestation = structuredClone(manifest);
  delete missingAttestation.attestationReport;
  assert.throws(() => validatePackagedLiveManifest(missingAttestation), /missing=attestationReport/u);
});

test("public endpoint identity binds canonical DNS, TLS certificate, SNI, and captured IP", () => {
  const endpoints = validManifest().endpoints;
  assert.equal(assertPublicHttpsUrl(endpoints.remoteUrl, "remote").hostname, TEST_REMOTE_HOST);
  assert.equal(assertPublicHttpsUrl(`https://${TEST_REMOTE_HOST}/rpc?tenant=17`, "remote").search, "?tenant=17");
  for (const invalid of ["https://localhost/rpc", "https://internal/rpc", "https://node.local/rpc", "https://127.0.0.1/rpc", `https://${TEST_REMOTE_HOST}./rpc`, `https://${TEST_REMOTE_HOST}/rpc#fragment`]) {
    assert.throws(() => assertPublicHttpsUrl(invalid, "remote"), /public|IP-literal|trailing dot|multi-label|special-use/u);
  }
  const identity = {
    schemaVersion: 1,
    remote: { hostname: TEST_REMOTE_HOST, resolvedIpv4: [endpoints.remoteIp], tlsServerName: TEST_REMOTE_HOST, certificateSha256: SHA, certificateSanDnsNames: [TEST_REMOTE_HOST], captureDestinationIp: endpoints.remoteIp },
    hub: { hostname: TEST_HUB_HOST, resolvedIpv4: [endpoints.hubIp], tlsServerName: TEST_HUB_HOST, certificateSha256: SHA_B, certificateSanDnsNames: [TEST_HUB_HOST], captureDestinationIp: endpoints.hubIp },
  };
  validateEndpointIdentity(identity, endpoints);
  const sni = parseTsharkSniFields([
    `${endpoints.clientIp}\t${endpoints.remoteIp}\t443\t${TEST_REMOTE_HOST}`,
    `${endpoints.clientIp}\t${endpoints.hubIp}\t443\t${TEST_HUB_HOST}`,
  ].join("\n"));
  assert.equal(verifyCapturedEndpointSni(sni, endpoints).length, 2);
  identity.remote.tlsServerName = TEST_HUB_HOST;
  assert.throws(() => validateEndpointIdentity(identity, endpoints), /exact endpoint/u);
  assert.throws(() => verifyCapturedEndpointSni(sni.slice(0, 1), endpoints), /missing exact/u);
});

test("host identity proves independent machine and network identities", () => {
  const endpoints = validManifest().endpoints;
  const identity = {
    schemaVersion: 1,
    client: { machineIdSha256: SHA, networkNamespaceSha256: SHA_B, hostname: "client.lvis.internal", interfaceIp: endpoints.clientIp },
    remote: { machineIdSha256: "c".repeat(64), networkNamespaceSha256: "d".repeat(64), hostname: "remote.lvis.internal", interfaceIp: endpoints.remoteIp },
  };
  validateHostIdentity(identity, endpoints);
  identity.remote.networkNamespaceSha256 = identity.client.networkNamespaceSha256;
  assert.throws(() => validateHostIdentity(identity, endpoints), /must differ/u);
});

function captureJson(message, sourceIp, destinationIp, destinationPort = "443", uri = "/rpc") {
  return ["1", sourceIp, destinationIp, destinationPort, TEST_REMOTE_HOST, uri, Buffer.from(JSON.stringify(message)).toString("hex")].join("\t");
}

function captureLine(method, sourceIp, destinationIp, payload = {}, id = method) {
  return captureJson({ jsonrpc: "2.0", id, method, params: { ...payload } }, sourceIp, destinationIp);
}

test("actual tshark field parser proves Task methods client-to-remote and zero Hub Task traffic", () => {
  const endpoints = validManifest().endpoints;
  const responseCases = ["result-message", "result-task", "error--32090-conflict", "error--32091-retention-expired", "error--32092-in-progress-retry-after", "error--32093-outcome-unknown", "error--32094-capacity"];
  const lines = responseCases.map((caseId) => captureLine("SendMessage", endpoints.clientIp, endpoints.remoteIp, { canary: CANARIES[0], case: `[LVIS-P4-5:${caseId}]` }, caseId));
  lines.push(captureLine("SendMessage", endpoints.clientIp, endpoints.remoteIp, {
    canary: CANARIES[0],
    cases: REMOTE_OBSERVED_CASE_IDS.filter((caseId) => !responseCases.includes(caseId)).map((caseId) => `[LVIS-P4-5:${caseId}]`),
  }, "remaining-cases"));
  lines.push(
    captureLine("GetTask", endpoints.clientIp, endpoints.remoteIp),
    captureLine("CancelTask", endpoints.clientIp, endpoints.remoteIp),
    captureJson({ jsonrpc: "2.0", id: "result-message", result: { message: {} } }, endpoints.remoteIp, endpoints.clientIp, "52100"),
    captureJson({ jsonrpc: "2.0", id: "result-task", result: { task: {} } }, endpoints.remoteIp, endpoints.clientIp, "52100"),
  );
  for (const [caseId, code] of Object.entries({
    "error--32090-conflict": -32090,
    "error--32091-retention-expired": -32091,
    "error--32092-in-progress-retry-after": -32092,
    "error--32093-outcome-unknown": -32093,
    "error--32094-capacity": -32094,
  })) lines.push(captureJson({ jsonrpc: "2.0", id: caseId, error: { code, message: "fixed", data: [{}] } }, endpoints.remoteIp, endpoints.clientIp, "52100"));
  const text = lines.join("\n");
  const result = verifyTaskTraffic(parseTsharkFields(text), endpoints);
  assert.equal(result.responseAssertions.length, 7);
  const queriedEndpoints = { ...endpoints, remoteUrl: `https://${TEST_REMOTE_HOST}/rpc?tenant=17` };
  const queryText = text.replaceAll("\t/rpc\t", "\t/rpc?tenant=17\t");
  assert.equal(verifyTaskTraffic(parseTsharkFields(queryText), queriedEndpoints).responseAssertions.length, 7);
  const tamperedQuery = queryText.replace("\t/rpc?tenant=17\t", "\t/rpc?tenant=18\t");
  assert.throws(() => verifyTaskTraffic(parseTsharkFields(tamperedQuery), queriedEndpoints), /exact remote interface Host\/path/u);
  const hubText = `${text}\n${captureLine("GetTask", endpoints.clientIp, endpoints.hubIp)}`;
  assert.throws(() => verifyTaskTraffic(parseTsharkFields(hubText), endpoints), /reached Agent Hub/u);
  const duplicateJson = Buffer.from('{"jsonrpc":"2.0","method":"SendMessage","method":"GetTask"}').toString("hex");
  assert.throws(() => parseTsharkFields(["2", endpoints.clientIp, endpoints.remoteIp, "443", TEST_REMOTE_HOST, "/rpc", duplicateJson].join("\t")), /duplicate object member/u);
});

test("Hub file and database checks derive zero canary retention", () => {
  const evidence = { logs: [{ bytes: Buffer.from("clean log") }], audits: [{ bytes: Buffer.from("clean audit") }], traces: [{ bytes: Buffer.from("clean trace") }] };
  verifyHubEvidenceAbsent(evidence);
  evidence.logs[0].bytes = Buffer.from(CANARIES[1]);
  assert.throws(() => verifyHubEvidenceAbsent(evidence), /retained forbidden canary/u);
  const zeroRows = [...CANARIES].sort().map((canary) => `${canary}\t0`).join("\n");
  assert.equal(Object.keys(parseHubCanaryCounts(zeroRows)).length, 3);
  assert.throws(() => parseHubCanaryCounts(zeroRows.replace("\t0", "\t1")), /retained forbidden canary/u);

  const identity = { systemIdentifier: "7612345678901234567", databaseOid: "16384", databaseName: "agent_hub", serverAddress: "10.0.0.12", serverPort: "5432" };
  const databaseIdentitySha256 = createHash("sha256").update(JSON.stringify(identity, Object.keys(identity).sort())).digest("hex");
  const manifest = validManifest();
  const expected = {
    snapshotId: manifest.hubControlPlane.snapshotId,
    databaseIdentitySha256,
    agentHubHead: manifest.heads.hub,
    appHead: manifest.heads.app,
    serverHead: manifest.heads.server,
    agentHubLockDigestSha256: manifest.hubControlPlane.agentHubLockDigestSha256,
    wireConformanceArtifactDigestSha256: manifest.hubControlPlane.wireConformanceArtifactDigestSha256,
    remoteUrl: manifest.endpoints.remoteUrl,
  };
  const output = [
    ["identity", identity.systemIdentifier, identity.databaseOid, identity.databaseName, identity.serverAddress, identity.serverPort].join("\t"),
    ["control", expected.snapshotId, expected.agentHubHead, expected.appHead, expected.serverHead, expected.agentHubLockDigestSha256, expected.wireConformanceArtifactDigestSha256, expected.remoteUrl].join("\t"),
    ...[...CANARIES].sort().map((canary) => ["canary", canary, "0"].join("\t")),
  ].join("\n");
  assert.equal(parseHubVerificationOutput(output, expected).snapshotId, expected.snapshotId);
  assert.match(buildHubVerificationSql(expected.snapshotId), /a2a_route_snapshot_issuance_audit/u);
  assert.throws(() => parseHubVerificationOutput(output, { ...expected, databaseIdentitySha256: SHA }), /database identity/u);
  assert.throws(() => parseHubVerificationOutput(output, { ...expected, agentHubHead: SERVER_HEAD }), /control-plane record/u);
});

test("remote server raw evidence cross-binds every fixed case and canary", () => {
  const bytes = Buffer.from([...CANARIES, ...REMOTE_OBSERVED_CASE_IDS.map((caseId) => `[LVIS-P4-5:${caseId}]`)].join("\n"));
  verifyRemoteServerEvidence([{ bytes }]);
  assert.throws(() => verifyRemoteServerEvidence([{ bytes: Buffer.from("incomplete") }]), /missing canary/u);
});

test("wire and fault artifacts require pinned heads, positive vectors, all pass, and zero skips", () => {
  const heads = validManifest().heads;
  validateWireConformance({
    schemaVersion: 1, appHead: heads.app, hubHead: heads.hub, serverHead: heads.server,
    tckVersion: "v1.0.0", tckCommit: "d".repeat(40), vectorCount: 50, skipped: 0, passed: 50, bundleSha256: SHA,
  }, heads);
  assert.throws(() => validateWireConformance({
    schemaVersion: 1, appHead: heads.app, hubHead: heads.hub, serverHead: heads.server,
    tckVersion: "v1.0.0", tckCommit: "d".repeat(40), vectorCount: 50, skipped: 1, passed: 49, bundleSha256: SHA,
  }, heads), /zero skips/u);
  validateFaultMatrix({ schemaVersion: 1, caseIds: [...PACKAGED_LIVE_CASE_IDS] });
  assert.throws(() => validateFaultMatrix({ schemaVersion: 1, caseIds: [...PACKAGED_LIVE_CASE_IDS].reverse() }), /exact ordered case set/u);
});

test("native verifier commands are fixed and require verified identities", () => {
  const calls = [];
  const installerCertificate = Buffer.from("installer-leaf-certificate");
  const installerCertificateSha256 = createHash("sha256").update(installerCertificate).digest("hex");
  const macRun = (command, args, options = {}) => {
    calls.push([command, args]);
    if (command === "hdiutil" && args[0] === "attach") return { stdout: "<plist><dict><key>dev-entry</key><string>/dev/disk9s1</string><key>mount-point</key><string>/Volumes/LVIS</string></dict></plist>", stderr: "" };
    if (command === "plutil") {
      assert.deepEqual(args, ["-convert", "json", "-o", "-", "-"]);
      assert.match(options.input, /<plist>/u);
      return { stdout: JSON.stringify({ "system-entities": [{ "dev-entry": "/dev/disk9s1", "mount-point": "/Volumes/LVIS" }] }), stderr: "" };
    }
    if (command === "hdiutil" || command === "/usr/bin/test") return { stdout: "ok", stderr: "" };
    if (command === "codesign" && args[1] === "--extract-certificates") {
      writeFileSync(`${args[2]}0`, installerCertificate);
      return { stdout: "", stderr: "certificate extracted" };
    }
    if (command === "codesign" && args[0] === "--display") return { stdout: "Authority=Developer ID Application: LVIS\nTeamIdentifier=ABCDE12345", stderr: "" };
    if (command === "spctl") return { stdout: "accepted", stderr: "" };
    return { stdout: "", stderr: "verified" };
  };
  const macExpected = { macTeamId: "ABCDE12345", macCertificateSha256: installerCertificateSha256 };
  assert.equal(verifyInstallerIdentity("macos", "/Applications/LVIS.dmg", { run: macRun, expected: macExpected }).status, "publisher-verified");
  assert.deepEqual(calls.map(([command]) => command), ["codesign", "codesign", "codesign", "spctl", "hdiutil", "plutil", "/usr/bin/test", "/usr/bin/test", "codesign", "codesign", "codesign", "spctl", "hdiutil"]);
  assert.equal(calls.some(([command]) => command === "security"), false, "keychain lookup must not substitute for embedded certificate extraction");
  assert.throws(() => verifyInstallerIdentity("macos", "/Applications/LVIS.dmg", { run: macRun, expected: { ...macExpected, macTeamId: "ZZZZZ12345" } }), /TeamIdentifier/u);
  const duplicateDetaches = [];
  const duplicateMountRun = (command, args, options = {}) => {
    if (command === "plutil") {
      return { stdout: JSON.stringify({ "system-entities": [
        { "dev-entry": "/dev/disk10s1", "mount-point": "/Volumes/LVIS" },
        { "dev-entry": "/dev/disk11s1", "mount-point": "/Volumes/LVIS 2" },
      ] }), stderr: "" };
    }
    if (command === "hdiutil" && args[0] === "detach") {
      duplicateDetaches.push(args[1]);
      return { stdout: "detached", stderr: "" };
    }
    return macRun(command, args, options);
  };
  assert.throws(
    () => verifyInstallerIdentity("macos", "/Applications/LVIS.dmg", { run: duplicateMountRun, expected: macExpected }),
    /expected exactly one mount point/u,
  );
  assert.deepEqual(duplicateDetaches, ["/dev/disk10s1", "/dev/disk11s1"]);
  const conversionFailureDetaches = [];
  const conversionFailureRun = (command, args, options = {}) => {
    if (command === "plutil") throw new Error("plist conversion failed");
    if (command === "hdiutil" && args[0] === "detach") {
      conversionFailureDetaches.push(args[1]);
      return { stdout: "detached", stderr: "" };
    }
    return macRun(command, args, options);
  };
  assert.throws(
    () => verifyInstallerIdentity("macos", "/Applications/LVIS.dmg", { run: conversionFailureRun, expected: macExpected }),
    /plist conversion failed/u,
  );
  assert.deepEqual(conversionFailureDetaches, ["/dev/disk9s1"]);
  const mismatchedAppRun = (command, args, options = {}) => {
    if (command === "hdiutil" && args[0] === "attach") return { stdout: "<plist><dict><key>dev-entry</key><string>/dev/disk9s1</string><key>mount-point</key><string>/Volumes/LVIS</string></dict></plist>", stderr: "" };
    if (command === "plutil") return macRun(command, args, options);
    if (command === "hdiutil" && args[0] === "detach") throw new Error("detach failed after primary verification failure");
    if (command === "hdiutil" || command === "/usr/bin/test") return { stdout: "ok", stderr: "" };
    if (command === "codesign" && args[1] === "--extract-certificates") {
      const certificate = args[3].endsWith(".app") ? Buffer.from("different-app-certificate") : installerCertificate;
      writeFileSync(`${args[2]}0`, certificate);
      return { stdout: "", stderr: "certificate extracted" };
    }
    if (command === "codesign" && args[0] === "--display") return { stdout: "Authority=Developer ID Application: LVIS\nTeamIdentifier=ABCDE12345", stderr: "" };
    if (command === "spctl") return { stdout: "accepted", stderr: "" };
    return { stdout: "", stderr: "verified" };
  };
  assert.throws(
    () => verifyInstallerIdentity("macos", "/Applications/LVIS.dmg", { run: mismatchedAppRun, expected: macExpected }),
    /inner app codesign certificate/u,
  );
  const winRun = (command, args, options) => {
    assert.equal(command, "powershell");
    assert.equal(options.env.LVIS_INSTALLER_PATH, "C:\\LVIS.exe");
    return { stdout: JSON.stringify({ status: "Valid", subject: "CN=LVIS", thumbprint: "A".repeat(40), statusMessage: "Signature verified." }), stderr: "" };
  };
  const winExpected = { windowsPublisherSubject: "CN=LVIS", windowsCertificateThumbprint: "A".repeat(40) };
  assert.equal(verifyInstallerIdentity("windows", "C:\\LVIS.exe", { run: winRun, expected: winExpected }).status, "publisher-verified");
  assert.throws(() => verifyInstallerIdentity("windows", "C:\\LVIS.exe", { run: winRun, expected: { ...winExpected, windowsPublisherSubject: "CN=Other" } }), /pinned LVIS identity/u);
  const debRun = () => ({ stdout: "Package: lvis\nVersion: 1.0.0\nArchitecture: amd64", stderr: "" });
  const linux = verifyInstallerIdentity("linux", "/opt/LVIS.deb", { run: debRun });
  assert.equal(linux.format, "deb");
  assert.equal(linux.status, "metadata-only");
  assert.equal(linux.identityKind, "package-metadata");
  const appImageRun = (command) => command === "file"
    ? { stdout: "ELF 64-bit LSB pie executable", stderr: "" }
    : { stdout: "Machine: Advanced Micro Devices X86-64", stderr: "" };
  assert.equal(verifyInstallerIdentity("linux", "/opt/LVIS-1.0.0-linux-x64.AppImage", { run: appImageRun }).format, "appimage");
  assert.throws(
    () => verifyInstallerIdentity("linux", "/opt/LVIS-1.0.0-linux-x64.appimage", { run: appImageRun }),
    /unsupported extension/u,
  );
});

test("provenance schema binds installer, signature, attestation, heads, workflow, locks, and fixed tools", () => {
  const provenance = validProvenance();
  assert.equal(validateProvenance(provenance), provenance);
  const mismatch = structuredClone(provenance);
  mismatch.attestation.sourceHead = SERVER_HEAD;
  assert.throws(() => validateProvenance(mismatch), /bindings do not match/u);
  const unknown = structuredClone(provenance);
  unknown.commandResult = { ok: true };
  assert.throws(() => validateProvenance(unknown), /unknown=commandResult/u);
});

test("attestation report binds exact subject, SLSA predicate, certificate source, signer workflow, and run attempt", () => {
  const verified = verifyFixtureAttestation(validAttestationReport());
  assert.equal(verified.subjectSha256, SHA);
  assert.equal(verified.sourceHead, HEAD);
  assert.equal(verified.workflowRunId, "12345");
  assert.equal(verified.workflowRunAttempt, "1");
});

test("attestation report accepts empty display metadata but still requires the verified embedded bundle", () => {
  const withoutLocator = validAttestationReport();
  withoutLocator[0].attestation.bundle_url = "";
  withoutLocator[0].attestation.initiator = "";
  assert.equal(verifyFixtureAttestation(withoutLocator).subjectSha256, SHA);

  const emptyBundle = validAttestationReport();
  emptyBundle[0].attestation.bundle_url = "";
  emptyBundle[0].attestation.bundle = {};
  assert.throws(() => verifyFixtureAttestation(emptyBundle), /empty bundle/u);

  const unsafeLocator = validAttestationReport();
  unsafeLocator[0].attestation.bundle_url = "http://api.github.com/attestations/1";
  assert.throws(() => verifyFixtureAttestation(unsafeLocator), /credential-free HTTPS URL/u);

  const unsafeInitiator = validAttestationReport();
  unsafeInitiator[0].attestation.initiator = " github-actions";
  assert.throws(() => verifyFixtureAttestation(unsafeInitiator), /expected trimmed string/u);
});

test("attestation report rejects missing, duplicate, and wrong-location bindings", () => {
  const missing = validAttestationReport();
  delete missing[0].verificationResult.signature.certificate.runInvocationURI;
  assert.throws(() => verifyFixtureAttestation(missing), /missing=runInvocationURI/u);

  const duplicate = validAttestationReport();
  duplicate.push(structuredClone(duplicate[0]));
  assert.throws(() => verifyFixtureAttestation(duplicate), /array length 1\.\.1/u);

  const wrongLocation = validAttestationReport();
  wrongLocation[0].verificationResult.statement.predicate.sourceRepositoryDigest = HEAD;
  delete wrongLocation[0].verificationResult.signature.certificate.sourceRepositoryDigest;
  assert.throws(() => verifyFixtureAttestation(wrongLocation), /missing=sourceRepositoryDigest/u);

  const wrongSubject = validAttestationReport();
  wrongSubject[0].verificationResult.statement.subject[0].digest.sha256 = SHA_B;
  assert.throws(() => verifyFixtureAttestation(wrongSubject), /subject digest/u);
});

test("Linux packaged executable selection prefers exact native-architecture suffixes", () => {
  const preferences = linuxExecutablePreferenceSuffixes("arm64", "/");
  const mixed = [
    "/release/linux-unpacked/lvis-app",
    "/release/linux-x64-unpacked/LVIS",
    "/release/linux-arm64-unpacked/lvis",
  ];
  assert.equal(
    pickBestByExactSuffix(mixed, preferences),
    "/release/linux-arm64-unpacked/lvis",
  );
  assert.equal(
    pickBestByExactSuffix(["/release/linux-arm64-unpacked/lvis-app", "/release/linux-arm64-unpacked/LVIS"], preferences),
    "/release/linux-arm64-unpacked/LVIS",
  );
  assert.equal(
    pickBestByExactSuffix([
      "/release/linux-x64-unpacked/resources/notlinux-arm64-unpacked/LVIS",
      "/release/linux-unpacked/LVIS",
    ], preferences),
    "/release/linux-unpacked/LVIS",
  );
  assert.equal(pickBestByExactSuffix([], preferences), null);
});

test("independent attestation rerun keeps source-digest and scopes GH_TOKEN to gh only", () => {
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "sensitive-test-token";
  try {
    const child = runFixedProgram(process.execPath, ["-e", "process.stdout.write(String(process.env.GH_TOKEN))"]);
    assert.equal(child.stdout, "undefined", "generic child processes must not inherit GH_TOKEN");
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify(validAttestationReport()), stderr: "" };
    };
    const verified = independentlyVerifyInstallerAttestation({ path: "/tmp/LVIS-1.0.0.dmg", sha256: SHA }, {
      appHead: HEAD,
      repository: "lvis-project/lvis-app",
      workflowRunId: "12345",
      workflowRunAttempt: "1",
      run,
      token: "scoped-token",
    });
    assert.equal(verified.sourceHead, HEAD);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "gh");
    assert.deepEqual(calls[0].options.env, { GH_TOKEN: "scoped-token" });
    assert.ok(calls[0].args.includes("--source-digest"));
    assert.ok(calls[0].args.includes("--deny-self-hosted-runners"));
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  }
});

test("fixed programs validate and honor per-call timeouts", () => {
  assert.throws(
    () => runFixedProgram(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 0 }),
    /timeoutMs must be an integer/u,
  );
  assert.throws(
    () => runFixedProgram(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 25 }),
    /ETIMEDOUT/u,
  );
  assert.equal(
    runFixedProgram(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 1000 }).stdout,
    "ok",
  );
});

test("packaged UI environment allowlists runtime state and excludes parent secrets", () => {
  const environment = buildPackagedUiEnvironment({
    PATH: "/usr/bin:/bin",
    DISPLAY: ":99",
    SystemRoot: "C:\\Windows",
    LVIS_A2A_EVIDENCE_PUBLIC_KEY_FILE: "/evidence/public.pem",
    GH_TOKEN: "github-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    NPM_TOKEN: "npm-secret",
    NODE_OPTIONS: "--require=/tmp/untrusted.cjs",
  });
  assert.deepEqual(environment, {
    PATH: "/usr/bin:/bin",
    SystemRoot: "C:\\Windows",
    DISPLAY: ":99",
    LVIS_A2A_EVIDENCE_PUBLIC_KEY_FILE: "/evidence/public.pem",
  });
  for (const secret of ["GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "NODE_OPTIONS"]) {
    assert.equal(Object.hasOwn(environment, secret), false, `${secret} must not reach the packaged app`);
  }
});

test("packaged UI manifest path is cwd-independent and canonical", () => {
  const directory = makeTempDirectory("lvis-ui-manifest-");
  const manifestPath = resolve(directory, "manifest.json");
  writeFileSync(manifestPath, "{}\n");
  assert.equal(resolveCanonicalUiManifestPath("manifest.json", { cwd: directory }), manifestPath);
  const linkPath = resolve(directory, "manifest-link.json");
  symlinkSync(manifestPath, linkPath);
  assert.throws(
    () => resolveCanonicalUiManifestPath("manifest-link.json", { cwd: directory }),
    /manifest path must be canonical/u,
  );
});

test("packaged-live output rejects a symlinked ancestor before writing", () => {
  const baseDirectory = makeTempDirectory("lvis-packaged-output-");
  const outsideDirectory = makeTempDirectory("lvis-packaged-output-outside-");
  symlinkSync(outsideDirectory, resolve(baseDirectory, "artifacts"), "dir");
  assert.throws(
    () => writeExclusiveOutput({ verificationState: "passed" }, { baseDirectory }),
    /output parent path must be canonical/u,
  );
});

test("isolated evidence workflow is dispatch-only, immutable-action pinned, exact-head/lock pinned, publisher-verified, and independently attested", () => {
  const workflow = readFileSync(resolve(ROOT, ".github/workflows/a2a-p4-5-packaged-evidence.yml"), "utf8");
  for (const required of [
    "head_sha:", "agent_hub_head_sha:", "platform:", "select Linux ARM64 separately", "linux-arm64", "ubuntu-24.04-arm",
    "runs-on: ubuntu-latest", "PLATFORM_PROFILE: ${{ inputs.platform }}", 'case "$PLATFORM_PROFILE" in',
    "fromJSON(needs.plan.outputs.matrix)", "matrix.artifact_name", "contents: read", "id-token: write", "attestations: write",
    "git rev-parse HEAD", "git -C .evidence/agent-hub rev-parse HEAD", ".evidence/agent-hub/server/bun.lock", "AGENT_HUB_LOCK_DIGEST_SHA256",
    "readRegularFile", "Agent Hub server lock", "loadBytes:false",
    "repository: lvis-project/agent-hub", "codesign --verify --deep --strict", "spctl --assess", "Get-AuthenticodeSignature",
    "dpkg-deb --field", "rpm -qp", "readelf --file-header", "actions/attest@a1948c3f048ba23858d222213b7c278aabede763 # v4", "gh attestation verify",
    "write-installer-provenance.mjs", "codesign --display --verbose=4 \"$mount_point/LVIS.app\"",
    "hdiutil attach -readonly -nobrowse -plist", "plutil -convert json -o - -", "system-entities",
    "spctl --assess --type execute", "Verify Windows Authenticode signature validity", "--source-digest \"$REQUESTED_HEAD\"",
    "--signer-workflow lvis-project/lvis-app/.github/workflows/a2a-p4-5-packaged-evidence.yml", "--deny-self-hosted-runners",
    "--predicate-type https://slsa.dev/provenance/v1", "Requested head must equal the immutable workflow source head",
    "LVIS_MAC_SIGNER_CERT_SHA256", "LVIS_WINDOWS_PUBLISHER_SUBJECT", "LVIS_WINDOWS_SIGNER_THUMBPRINT", "env -u GH_TOKEN node",
  ]) assert.ok(workflow.includes(required), `missing workflow invariant: ${required}`);
  for (const forbidden of ["skip_code_sign", "--skip-code-sign", "graceful degradation", "inputs.ref", 'case "${{ inputs.platform }}" in', "\n  push:", "publish-release", "softprops/action-gh-release", "vars.AGENT_HUB_RELEASE_HEAD_SHA", "actions/checkout@v7", "actions/cache@v6", "actions/attest@v4", "actions/upload-artifact@v7", "oven-sh/setup-bun@v2", "awk -F '\\t'"]) {
    assert.ok(!workflow.includes(forbidden), `forbidden workflow fallback: ${forbidden}`);
  }
  assert.ok(!workflow.includes("readFileSync(process.argv[1])"), "Hub lock digest must use descriptor-safe canonical file reading");
  const installerJobEnv = workflow.slice(workflow.indexOf("jobs:"), workflow.indexOf("    steps:"));
  for (const secretName of ["CSC_LINK", "APPLE_ID", "WIN_CSC_LINK"]) assert.ok(!installerJobEnv.includes(secretName), `${secretName} leaked into job-wide env`);

  const releaseWorkflow = readFileSync(resolve(ROOT, ".github/workflows/build-installers.yml"), "utf8");
  for (const existingBehavior of ["skip_code_sign:", "inputs.ref", "publish-release:", "softprops/action-gh-release@v3"]) {
    assert.ok(releaseWorkflow.includes(existingBehavior), `existing installer workflow behavior changed: ${existingBehavior}`);
  }

  const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["test:a2a-p4-5:evidence"],
    "node --test scripts/a2a-p4-5-live/__tests__/evidence.test.mjs",
    "evidence test command must not depend on shell glob expansion",
  );
});

test("packaged-live runner has no manifest-provided command or result adapter", () => {
  const runner = readFileSync(resolve(ROOT, "scripts/run-a2a-p4-5-packaged-live.mjs"), "utf8");
  const driver = readFileSync(resolve(ROOT, "scripts/a2a-p4-5-live/ui-driver.mjs"), "utf8");
  for (const forbidden of ["verificationCommands", "manifest.command", "resultPath", "shell: true"]) {
    assert.ok(!runner.includes(forbidden), `runner contains forbidden adapter: ${forbidden}`);
  }
  assert.ok(runner.includes("const matchedSubject = certificate.checkHost(endpointUrl.hostname)"));
  assert.ok(runner.includes("if (matchedSubject === undefined)"), "checkHost must fail only when Node returns no matching subject");
  assert.ok(!runner.includes("!certificate.checkHost("), "checkHost return semantics must remain explicit");
  for (const testId of ["remote-a2a-trigger", "remote-a2a-status", "remote-a2a-send", "remote-a2a-replay"]) {
    assert.ok(driver.includes(testId), `fixed UI driver missing stable test ID ${testId}`);
  }
  assert.ok(driver.includes("_electron as electron"));
  assert.ok(driver.includes("executablePath"));
  assert.ok(driver.includes("buildPackagedUiEnvironment()"));
  assert.ok(!driver.includes("env: { ...process.env }"));
  assert.ok(driver.includes("selectOption(String(target.targetAgentId))"));
  assert.ok(!driver.includes("P4-5 PASS"));
});
