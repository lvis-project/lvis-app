import { isIP } from "node:net";
import { basename } from "node:path";

import {
  assertArray,
  assertExactKeys,
  assertHeadSha,
  assertSafeString,
  assertSha256,
  assertUnique,
  fail,
  readEvidenceDescriptor,
  validateDescriptor,
} from "./evidence-lib.mjs";
import { validateProvenance, verifyAttestationReport } from "./installer-provenance-lib.mjs";
import { parseStrictJson } from "./strict-json.mjs";

export const TASK_METHODS = Object.freeze(["SendMessage", "GetTask", "CancelTask"]);
export const CANARIES = Object.freeze([
  "LVIS_P4_5_TASK_PAYLOAD_CANARY_8f2bd6a1",
  "LVIS_P4_5_SECRET_CANARY_42ce019b",
  "LVIS_P4_5_REFERENCE_CANARY_7204dcae",
]);
export const STABLE_TEST_IDS = Object.freeze([
  "remote-a2a-trigger",
  "remote-a2a-panel",
  "remote-a2a-target",
  "remote-a2a-intent",
  "remote-a2a-status",
  "remote-a2a-send",
  "remote-a2a-task-actions",
  "remote-a2a-get",
  "remote-a2a-resume",
  "remote-a2a-cancel",
  "remote-a2a-replay",
]);

export const PACKAGED_LIVE_CASE_IDS = Object.freeze([
  "result-message",
  "result-task",
  "error--32090-conflict",
  "error--32091-retention-expired",
  "error--32092-in-progress-retry-after",
  "error--32093-outcome-unknown",
  "error--32094-capacity",
  "a2a-version-all-operations-extension-initial-replay-only",
  "route-policy-required-false-mandate",
  "denied-auth-no-retry",
  "auth-required-same-binding-revision-get",
  "prepared-revision-drift-not-sent",
  "concurrent-intended-revision-conflict",
  "input-required-resume",
  "cancel-idempotent",
  "prompt-free-get-task",
  "initial-orphan-cleanup",
  "continuation-cancel-metadata-only",
  "lost-response-replay-restarts",
  "live-owner-expiry-late-commit",
  "missing-ciphertext-manual-reconciliation",
  "missing-replay-extension-manual-reconciliation",
  "malformed-extension-ineligible",
  "additional-required-extension-rejected",
  "unrelated-optional-extension-ignored",
  "revocation-before-resolve-no-socket",
  "timeout-partition-no-fallback",
  "zero-hub-retention",
]);
export const NO_SOCKET_CASE_IDS = Object.freeze([
  "prepared-revision-drift-not-sent",
  "initial-orphan-cleanup",
  "malformed-extension-ineligible",
  "additional-required-extension-rejected",
  "revocation-before-resolve-no-socket",
]);
export const REMOTE_OBSERVED_CASE_IDS = Object.freeze(PACKAGED_LIVE_CASE_IDS.filter((caseId) => !NO_SOCKET_CASE_IDS.includes(caseId)));

const status = (state, outcome, taskState = null) => Object.freeze({ state, outcome, taskState });
export const UI_CASE_EXPECTATIONS = Object.freeze({
  "result-message": { action: null, preAction: null, final: status("sent", "success") },
  "result-task": { action: null, preAction: null, final: status("sent", "success", "TASK_STATE_SUBMITTED") },
  "error--32090-conflict": { action: null, preAction: null, final: status("failed", "conflict") },
  "error--32091-retention-expired": { action: null, preAction: null, final: status("failed", "retention-expired") },
  "error--32092-in-progress-retry-after": { action: null, preAction: null, final: status("failed", "reconciling") },
  "error--32093-outcome-unknown": { action: null, preAction: null, final: status("failed", "unknown-manual-reconciliation-required") },
  "error--32094-capacity": { action: null, preAction: null, final: status("failed", "capacity-manual-intervention-required") },
  "a2a-version-all-operations-extension-initial-replay-only": { action: "get", preAction: status("sent", "success", "TASK_STATE_WORKING"), final: status("sent", "success", "TASK_STATE_COMPLETED") },
  "route-policy-required-false-mandate": { action: null, preAction: null, final: status("sent", "success") },
  "denied-auth-no-retry": { action: null, preAction: null, final: status("failed", "authentication-failed") },
  "auth-required-same-binding-revision-get": { action: "get", preAction: status("sent", "success", "TASK_STATE_AUTH_REQUIRED"), final: status("sent", "success", "TASK_STATE_COMPLETED") },
  "prepared-revision-drift-not-sent": { action: null, preAction: null, final: status("failed", "intended-credential-revision-conflict") },
  "concurrent-intended-revision-conflict": { action: null, preAction: null, final: status("failed", "intended-credential-revision-conflict") },
  "input-required-resume": { action: "resume", preAction: status("sent", "success", "TASK_STATE_INPUT_REQUIRED"), final: status("sent", "success", "TASK_STATE_COMPLETED") },
  "cancel-idempotent": { action: "cancel", preAction: status("sent", "success", "TASK_STATE_WORKING"), final: status("sent", "success", "TASK_STATE_CANCELED") },
  "prompt-free-get-task": { action: "get", preAction: status("sent", "success", "TASK_STATE_WORKING"), final: status("sent", "success", "TASK_STATE_COMPLETED") },
  "initial-orphan-cleanup": { action: null, preAction: null, final: status("failed", "not-sent") },
  "continuation-cancel-metadata-only": { action: "resume", preAction: status("sent", "success", "TASK_STATE_INPUT_REQUIRED"), final: status("sent", "success", "TASK_STATE_COMPLETED") },
  "lost-response-replay-restarts": { action: "replay-restart", preAction: status("failed", "unknown-manual-reconciliation-required"), final: status("sent", "success") },
  "live-owner-expiry-late-commit": { action: null, preAction: null, final: status("failed", "retention-expired") },
  "missing-ciphertext-manual-reconciliation": { action: "replay", preAction: status("failed", "unknown-manual-reconciliation-required"), final: status("failed", "unknown-manual-reconciliation-required") },
  "missing-replay-extension-manual-reconciliation": { action: "replay", preAction: status("failed", "unknown-manual-reconciliation-required"), final: status("failed", "unknown-manual-reconciliation-required") },
  "malformed-extension-ineligible": { action: null, preAction: null, final: status("failed", "not-sent") },
  "additional-required-extension-rejected": { action: null, preAction: null, final: status("failed", "not-sent") },
  "unrelated-optional-extension-ignored": { action: null, preAction: null, final: status("sent", "success") },
  "revocation-before-resolve-no-socket": { action: null, preAction: null, final: status("failed", "not-sent") },
  "timeout-partition-no-fallback": { action: null, preAction: null, final: status("failed", "unknown-manual-reconciliation-required") },
  "zero-hub-retention": { action: null, preAction: null, final: status("sent", "success") },
});

function assertDecimal(value, label) {
  return assertSafeString(value, label, { min: 1, max: 32, pattern: /^(?:0|[1-9]\d*)$/u });
}

function assertIpv4(value, label, { publicOnly = false } = {}) {
  assertSafeString(value, label, { max: 45 });
  if (isIP(value) !== 4) fail(`${label}: only an explicit IPv4 capture identity is supported`);
  const octets = value.split(".").map(Number);
  const privateOrReserved = octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 0)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19))
    || (octets[0] === 198 && octets[1] === 51 && octets[2] === 100)
    || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113);
  if (octets.every((octet) => octet === 0) || octets.every((octet) => octet === 255) || octets[0] === 127) {
    fail(`${label}: loopback/unspecified/broadcast is forbidden`);
  }
  if (publicOnly && privateOrReserved) fail(`${label}: expected a globally routable address`);
  return value;
}

const SPECIAL_USE_HOSTS = Object.freeze(new Set([
  "localhost", "localhost.localdomain", "local", "internal", "invalid", "test", "example", "home.arpa", "onion",
]));

export function assertPublicHttpsUrl(value, label) {
  assertSafeString(value, label, { max: 2048 });
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label}: invalid URL`);
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash) {
    fail(`${label}: expected credential-free public HTTPS/443 URL without a fragment`);
  }
  if (isIP(url.hostname)) fail(`${label}: IP-literal targets are forbidden`);
  if (url.hostname !== url.hostname.toLowerCase() || url.hostname.endsWith(".")) fail(`${label}: hostname must be canonical lowercase without trailing dot`);
  const labels = url.hostname.split(".");
  if (labels.length < 2 || labels.some((part) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/u.test(part))) {
    fail(`${label}: expected a canonical multi-label public DNS hostname`);
  }
  const suffix = labels.at(-1);
  const lastTwo = labels.slice(-2).join(".");
  if (SPECIAL_USE_HOSTS.has(url.hostname) || SPECIAL_USE_HOSTS.has(suffix) || SPECIAL_USE_HOSTS.has(lastTwo)) {
    fail(`${label}: special-use and private hostnames are forbidden`);
  }
  return url;
}

function validateCaseIds(values, label) {
  assertArray(values, label, { min: PACKAGED_LIVE_CASE_IDS.length, max: PACKAGED_LIVE_CASE_IDS.length });
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-z0-9-]+$/u.test(value)) fail(`${label}[${index}]: invalid fixed case ID`);
  });
  assertUnique(values, label);
  if (JSON.stringify(values) !== JSON.stringify(PACKAGED_LIVE_CASE_IDS)) fail(`${label}: exact ordered case set is required`);
}

function validateEndpointBlock(value) {
  assertExactKeys(value, ["clientIp", "remoteIp", "hubIp", "remoteUrl", "hubUrl"], "manifest.endpoints");
  assertIpv4(value.clientIp, "manifest.endpoints.clientIp");
  assertIpv4(value.remoteIp, "manifest.endpoints.remoteIp", { publicOnly: true });
  assertIpv4(value.hubIp, "manifest.endpoints.hubIp", { publicOnly: true });
  if (new Set([value.clientIp, value.remoteIp, value.hubIp]).size !== 3) fail("manifest.endpoints: client, remote, and Hub IPs must differ");
  const remote = assertPublicHttpsUrl(value.remoteUrl, "manifest.endpoints.remoteUrl");
  const hub = assertPublicHttpsUrl(value.hubUrl, "manifest.endpoints.hubUrl");
  if (remote.hostname === hub.hostname) fail("manifest.endpoints: remote A2A and Agent Hub hosts must differ");
}

function validateEndpointPeer(value, label, expectedUrl, expectedIp) {
  assertExactKeys(value, ["hostname", "resolvedIpv4", "tlsServerName", "certificateSha256", "certificateSanDnsNames", "captureDestinationIp"], label);
  const hostname = new URL(expectedUrl).hostname;
  if (value.hostname !== hostname || value.tlsServerName !== hostname || value.captureDestinationIp !== expectedIp) {
    fail(`${label}: DNS, TLS SNI, and capture destination must bind the exact endpoint`);
  }
  assertArray(value.resolvedIpv4, `${label}.resolvedIpv4`, { min: 1, max: 32 });
  value.resolvedIpv4.forEach((address, index) => assertIpv4(address, `${label}.resolvedIpv4[${index}]`, { publicOnly: true }));
  assertUnique(value.resolvedIpv4, `${label}.resolvedIpv4`);
  if (!value.resolvedIpv4.includes(expectedIp)) fail(`${label}: signed DNS evidence does not include the captured endpoint IP`);
  assertSha256(value.certificateSha256, `${label}.certificateSha256`);
  assertArray(value.certificateSanDnsNames, `${label}.certificateSanDnsNames`, { min: 1, max: 128 });
  value.certificateSanDnsNames.forEach((name, index) => assertSafeString(name, `${label}.certificateSanDnsNames[${index}]`, { max: 253 }));
  assertUnique(value.certificateSanDnsNames, `${label}.certificateSanDnsNames`);
  if (!value.certificateSanDnsNames.includes(hostname)) fail(`${label}: certificate SAN evidence must contain the exact canonical hostname`);
}

export function validateEndpointIdentity(value, endpoints) {
  assertExactKeys(value, ["schemaVersion", "remote", "hub"], "endpoint identity");
  if (value.schemaVersion !== 1) fail("endpoint identity.schemaVersion: expected 1");
  validateEndpointPeer(value.remote, "endpoint identity.remote", endpoints.remoteUrl, endpoints.remoteIp);
  validateEndpointPeer(value.hub, "endpoint identity.hub", endpoints.hubUrl, endpoints.hubIp);
  if (value.remote.certificateSha256 === value.hub.certificateSha256) fail("endpoint identity: remote and Hub certificates must differ");
  return value;
}

function validateHubControlPlane(value) {
  assertExactKeys(value, ["snapshotId", "databaseIdentitySha256", "agentHubLockDigestSha256", "wireConformanceArtifactDigestSha256"], "manifest.hubControlPlane");
  assertSafeString(value.snapshotId, "manifest.hubControlPlane.snapshotId", { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/u });
  for (const key of ["databaseIdentitySha256", "agentHubLockDigestSha256", "wireConformanceArtifactDigestSha256"]) {
    assertSha256(value[key], `manifest.hubControlPlane.${key}`);
  }
}

function validateCapture(value) {
  assertExactKeys(value, ["format", "raw", "decodedPcap", "tlsKeyLog", "tsharkVersion"], "manifest.capture");
  if (!new Set(["pcap", "pcapng", "etl"]).has(value.format)) fail("manifest.capture.format: expected pcap, pcapng, or etl");
  validateDescriptor(value.raw, "manifest.capture.raw");
  validateDescriptor(value.tlsKeyLog, "manifest.capture.tlsKeyLog");
  assertSafeString(value.tsharkVersion, "manifest.capture.tsharkVersion", { max: 256, pattern: /^TShark \(Wireshark\) \d+\.\d+\.\d+/u });
  if (value.format === "etl") validateDescriptor(value.decodedPcap, "manifest.capture.decodedPcap");
  else if (value.decodedPcap !== null) fail("manifest.capture.decodedPcap: must be null unless format is etl");
}

function validateDescriptorArray(values, label) {
  assertArray(values, label, { min: 1, max: 64 });
  values.forEach((entry, index) => validateDescriptor(entry, `${label}[${index}]`));
  assertUnique(values.map((entry) => entry.path), `${label} paths`);
  assertUnique(values.map((entry) => entry.sha256), `${label} digests`);
}

export function validatePackagedLiveManifest(value) {
  assertExactKeys(value, ["schemaVersion", "repository", "heads", "workflow", "target", "endpoints", "installerArtifact", "attestationReport", "installerProvenance", "installedExecutable", "installReceipt", "capture", "hubEvidence", "remoteServerEvidence", "hostIdentity", "endpointIdentity", "hubControlPlane", "wireConformance", "faultMatrix", "caseIds", "vectorCount"], "manifest");
  if (value.schemaVersion !== 1) fail("manifest.schemaVersion: expected 1");
  if (value.repository !== "lvis-project/lvis-app") fail("manifest.repository: unexpected repository");
  assertExactKeys(value.heads, ["app", "hub", "server"], "manifest.heads");
  for (const key of Object.keys(value.heads)) assertHeadSha(value.heads[key], `manifest.heads.${key}`);
  assertExactKeys(value.workflow, ["runId", "attempt"], "manifest.workflow");
  assertDecimal(value.workflow.runId, "manifest.workflow.runId");
  assertDecimal(value.workflow.attempt, "manifest.workflow.attempt");
  assertExactKeys(value.target, ["targetAgentId", "label"], "manifest.target");
  if (!Number.isSafeInteger(value.target.targetAgentId) || value.target.targetAgentId <= 0 || value.target.targetAgentId > 2_147_483_647) fail("manifest.target.targetAgentId: expected bounded positive integer");
  assertSafeString(value.target.label, "manifest.target.label", { max: 256 });
  validateEndpointBlock(value.endpoints);
  validateDescriptor(value.installerArtifact, "manifest.installerArtifact");
  validateDescriptor(value.attestationReport, "manifest.attestationReport");
  validateDescriptor(value.installerProvenance, "manifest.installerProvenance");
  validateDescriptor(value.installedExecutable, "manifest.installedExecutable");
  if (!value.installedExecutable.path.startsWith("installed/")) fail("manifest.installedExecutable.path: expected a manifest-root installed bundle path");
  validateDescriptor(value.installReceipt, "manifest.installReceipt");
  validateCapture(value.capture);
  assertExactKeys(value.hubEvidence, ["logs", "audits", "traces"], "manifest.hubEvidence");
  for (const key of ["logs", "audits", "traces"]) validateDescriptorArray(value.hubEvidence[key], `manifest.hubEvidence.${key}`);
  validateDescriptorArray(value.remoteServerEvidence, "manifest.remoteServerEvidence");
  validateDescriptor(value.hostIdentity, "manifest.hostIdentity");
  validateDescriptor(value.endpointIdentity, "manifest.endpointIdentity");
  validateHubControlPlane(value.hubControlPlane);
  validateDescriptor(value.wireConformance, "manifest.wireConformance");
  validateDescriptor(value.faultMatrix, "manifest.faultMatrix");
  validateCaseIds(value.caseIds, "manifest.caseIds");
  if (value.vectorCount !== PACKAGED_LIVE_CASE_IDS.length) fail(`manifest.vectorCount: expected ${PACKAGED_LIVE_CASE_IDS.length}`);
  return value;
}

export function readAndValidateManifestArtifacts(manifestPath, manifest) {
  const artifacts = Object.create(null);
  artifacts.provenance = readEvidenceDescriptor(manifestPath, manifest.installerProvenance, "installer provenance", { maxBytes: 2 * 1024 * 1024 });
  const provenance = validateProvenance(parseStrictJson(artifacts.provenance.bytes.toString("utf8"), "installer provenance"));
  if (provenance.source.appHead !== manifest.heads.app || provenance.source.agentHubHead !== manifest.heads.hub
    || provenance.source.agentHubLockDigestSha256 !== manifest.hubControlPlane.agentHubLockDigestSha256
    || provenance.workflow.runId !== manifest.workflow.runId || provenance.workflow.attempt !== manifest.workflow.attempt) {
    fail("installer provenance: head/workflow bindings do not match signed live manifest");
  }
  artifacts.provenanceValue = provenance;
  artifacts.installer = readEvidenceDescriptor(manifestPath, manifest.installerArtifact, "attested installer", { maxBytes: 4 * 1024 * 1024 * 1024, loadBytes: false });
  artifacts.attestationReport = readEvidenceDescriptor(manifestPath, manifest.attestationReport, "stored gh attestation report", { maxBytes: 8 * 1024 * 1024 });
  if (artifacts.installer.sha256 !== provenance.installer.sha256 || artifacts.installer.size !== provenance.installer.size
    || basename(artifacts.installer.path) !== provenance.installer.name || artifacts.attestationReport.sha256 !== provenance.attestation.reportSha256) {
    fail("installer provenance: installer/report artifacts do not match the signed provenance claims");
  }
  artifacts.storedAttestation = verifyAttestationReport(artifacts.attestationReport, {
    installerSha256: artifacts.installer.sha256,
    appHead: manifest.heads.app,
    repository: manifest.repository,
    workflowRunId: manifest.workflow.runId,
    workflowRunAttempt: manifest.workflow.attempt,
  });
  artifacts.installedExecutable = readEvidenceDescriptor(manifestPath, manifest.installedExecutable, "installed packaged executable", { maxBytes: 1024 * 1024 * 1024, loadBytes: false });
  artifacts.installReceipt = readEvidenceDescriptor(manifestPath, manifest.installReceipt, "install receipt", { maxBytes: 1024 * 1024 });
  validateInstallReceipt(parseStrictJson(artifacts.installReceipt.bytes.toString("utf8"), "install receipt"), manifest, provenance);
  artifacts.captureRaw = readEvidenceDescriptor(manifestPath, manifest.capture.raw, "raw packet capture", { maxBytes: 4 * 1024 * 1024 * 1024, loadBytes: false });
  artifacts.capturePcap = manifest.capture.format === "etl"
    ? readEvidenceDescriptor(manifestPath, manifest.capture.decodedPcap, "ETL decoded pcap", { maxBytes: 4 * 1024 * 1024 * 1024, loadBytes: false })
    : artifacts.captureRaw;
  artifacts.tlsKeyLog = readEvidenceDescriptor(manifestPath, manifest.capture.tlsKeyLog, "TLS key log", { maxBytes: 64 * 1024 * 1024, loadBytes: false });
  artifacts.hostIdentity = readEvidenceDescriptor(manifestPath, manifest.hostIdentity, "two-host identity", { maxBytes: 1024 * 1024 });
  artifacts.endpointIdentity = readEvidenceDescriptor(manifestPath, manifest.endpointIdentity, "DNS TLS endpoint identity", { maxBytes: 1024 * 1024 });
  artifacts.wireConformance = readEvidenceDescriptor(manifestPath, manifest.wireConformance, "wire conformance", { maxBytes: 8 * 1024 * 1024 });
  artifacts.faultMatrix = readEvidenceDescriptor(manifestPath, manifest.faultMatrix, "fault matrix", { maxBytes: 2 * 1024 * 1024 });
  artifacts.hubEvidence = Object.fromEntries(["logs", "audits", "traces"].map((kind) => [kind, manifest.hubEvidence[kind].map((descriptor, index) => readEvidenceDescriptor(manifestPath, descriptor, `Hub ${kind}[${index}]`, { maxBytes: 512 * 1024 * 1024, loadBytes: false, needles: CANARIES }))]));
  const remoteNeedles = [...CANARIES, ...PACKAGED_LIVE_CASE_IDS.map((caseId) => `[LVIS-P4-5:${caseId}]`)];
  artifacts.remoteServerEvidence = manifest.remoteServerEvidence.map((descriptor, index) => readEvidenceDescriptor(manifestPath, descriptor, `remote server evidence[${index}]`, { maxBytes: 512 * 1024 * 1024, loadBytes: false, needles: remoteNeedles }));
  validateHostIdentity(parseStrictJson(artifacts.hostIdentity.bytes.toString("utf8"), "two-host identity"), manifest.endpoints);
  artifacts.endpointIdentityValue = validateEndpointIdentity(parseStrictJson(artifacts.endpointIdentity.bytes.toString("utf8"), "DNS TLS endpoint identity"), manifest.endpoints);
  artifacts.wireConformanceValue = validateWireConformance(parseStrictJson(artifacts.wireConformance.bytes.toString("utf8"), "wire conformance"), manifest.heads);
  if (artifacts.wireConformanceValue.bundleSha256 !== manifest.hubControlPlane.wireConformanceArtifactDigestSha256) {
    fail("wire conformance: bundle digest does not match the immutable Hub control-plane record expectation");
  }
  validateFaultMatrix(parseStrictJson(artifacts.faultMatrix.bytes.toString("utf8"), "fault matrix"));
  return artifacts;
}

export function validateHostIdentity(value, endpoints) {
  assertExactKeys(value, ["schemaVersion", "client", "remote"], "two-host identity");
  if (value.schemaVersion !== 1) fail("two-host identity.schemaVersion: expected 1");
  for (const side of ["client", "remote"]) {
    const identity = value[side];
    assertExactKeys(identity, ["machineIdSha256", "networkNamespaceSha256", "hostname", "interfaceIp"], `two-host identity.${side}`);
    assertSha256(identity.machineIdSha256, `two-host identity.${side}.machineIdSha256`);
    assertSha256(identity.networkNamespaceSha256, `two-host identity.${side}.networkNamespaceSha256`);
    assertSafeString(identity.hostname, `two-host identity.${side}.hostname`, { max: 253 });
    assertIpv4(identity.interfaceIp, `two-host identity.${side}.interfaceIp`, { publicOnly: side === "remote" });
  }
  for (const key of ["machineIdSha256", "networkNamespaceSha256", "hostname", "interfaceIp"]) {
    if (value.client[key] === value.remote[key]) fail(`two-host identity: client and remote ${key} must differ`);
  }
  if (value.client.interfaceIp !== endpoints.clientIp || value.remote.interfaceIp !== endpoints.remoteIp) fail("two-host identity: interface IPs do not match capture endpoints");
}

export function validateInstallReceipt(value, manifest, provenance) {
  assertExactKeys(value, ["schemaVersion", "platform", "installedAt", "installerSha256", "executablePath", "executableSha256"], "install receipt");
  if (value.schemaVersion !== 1 || !["macos", "windows", "linux"].includes(value.platform)) fail("install receipt: invalid schema or platform");
  assertSafeString(value.installedAt, "install receipt.installedAt", { pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u });
  assertSha256(value.installerSha256, "install receipt.installerSha256");
  assertSha256(value.executableSha256, "install receipt.executableSha256");
  assertSafeString(value.executablePath, "install receipt.executablePath", { max: 2048 });
  if (value.installerSha256 !== provenance.installer.sha256 || value.executablePath !== manifest.installedExecutable.path || value.executableSha256 !== manifest.installedExecutable.sha256) {
    fail("install receipt: installer/executable bindings do not match provenance and manifest");
  }
}

export function validateWireConformance(value, heads) {
  assertExactKeys(value, ["schemaVersion", "appHead", "hubHead", "serverHead", "tckVersion", "tckCommit", "vectorCount", "skipped", "passed", "bundleSha256"], "wire conformance");
  if (value.schemaVersion !== 1 || value.appHead !== heads.app || value.hubHead !== heads.hub || value.serverHead !== heads.server) fail("wire conformance: exact heads do not match live manifest");
  assertSafeString(value.tckVersion, "wire conformance.tckVersion", { max: 64, pattern: /^v?\d+\.\d+\.\d+$/u });
  assertHeadSha(value.tckCommit, "wire conformance.tckCommit");
  assertSha256(value.bundleSha256, "wire conformance.bundleSha256");
  if (!Number.isSafeInteger(value.vectorCount) || value.vectorCount <= 0 || value.skipped !== 0 || value.passed !== value.vectorCount) fail("wire conformance: positive vector count, zero skips, and all-pass are required");
  return value;
}

export function validateFaultMatrix(value) {
  assertExactKeys(value, ["schemaVersion", "caseIds"], "fault matrix");
  if (value.schemaVersion !== 1) fail("fault matrix.schemaVersion: expected 1");
  validateCaseIds(value.caseIds, "fault matrix.caseIds");
}

function decodeTsharkPayload(encoded, label) {
  const compact = encoded.replaceAll(":", "");
  if (!/^(?:[0-9a-fA-F]{2})+$/u.test(compact)) fail(`${label}: expected non-empty hex payload`);
  return Buffer.from(compact, "hex").toString("utf8");
}

const ERROR_CASE_CODES = Object.freeze({
  "error--32090-conflict": -32090,
  "error--32091-retention-expired": -32091,
  "error--32092-in-progress-retry-after": -32092,
  "error--32093-outcome-unknown": -32093,
  "error--32094-capacity": -32094,
});

function assertResponseEnvelope(response, request, caseId) {
  if (response.jsonrpc !== "2.0" || JSON.stringify(response.id) !== JSON.stringify(request.id)) fail(`capture: ${caseId} response did not echo the exact JSON-RPC ID`);
  const expectedCode = ERROR_CASE_CODES[caseId];
  if (expectedCode !== undefined) {
    assertExactKeys(response, ["jsonrpc", "id", "error"], `capture ${caseId} response`);
    assertExactKeys(response.error, ["code", "message", "data"], `capture ${caseId} error`);
    if (response.error.code !== expectedCode || typeof response.error.message !== "string" || !Array.isArray(response.error.data) || response.error.data.length !== 1) {
      fail(`capture: ${caseId} did not carry its exact complete error envelope`);
    }
    return;
  }
  assertExactKeys(response, ["jsonrpc", "id", "result"], `capture ${caseId} response`);
  assertExactKeys(response.result, [caseId === "result-message" ? "message" : "task"], `capture ${caseId} result oneof`);
}

function verifyCapturedResponseBranches(records, endpoints) {
  const assertions = [];
  for (const caseId of ["result-message", "result-task", ...Object.keys(ERROR_CASE_CODES)]) {
    const requestRecord = records.find((record) => record.message.method === "SendMessage" && record.payloadText.includes(`[LVIS-P4-5:${caseId}]`));
    if (!requestRecord || !("id" in requestRecord.message)) fail(`capture: missing request envelope for ${caseId}`);
    const responseRecords = records.filter((record) => !("method" in record.message)
      && "id" in record.message
      && JSON.stringify(record.message.id) === JSON.stringify(requestRecord.message.id));
    if (responseRecords.length !== 1) fail(`capture: expected one exact response envelope for ${caseId}`);
    if (responseRecords[0].sourceIp !== endpoints.remoteIp || responseRecords[0].destinationIp !== endpoints.clientIp) {
      fail(`capture: ${caseId} response did not travel exact remote -> client`);
    }
    assertResponseEnvelope(responseRecords[0].message, requestRecord.message, caseId);
    assertions.push(caseId);
  }
  return assertions;
}

export function parseTsharkFields(text) {
  const records = [];
  for (const [lineIndex, line] of text.split(/\r?\n/u).entries()) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== 7) fail(`tshark line ${lineIndex + 1}: expected exactly 7 fields`);
    const [frame, sourceIp, destinationIp, destinationPort, host, uri, encodedPayload] = fields;
    if (!/^[1-9]\d*$/u.test(frame) || !/^\d+$/u.test(destinationPort)) fail(`tshark line ${lineIndex + 1}: invalid frame or port`);
    assertIpv4(sourceIp, `tshark line ${lineIndex + 1} source IP`);
    assertIpv4(destinationIp, `tshark line ${lineIndex + 1} destination IP`);
    const payloadText = decodeTsharkPayload(encodedPayload, `tshark line ${lineIndex + 1}`);
    const opening = payloadText.indexOf("{");
    const closing = payloadText.lastIndexOf("}");
    if (opening < 0 || closing < opening) continue;
    const message = parseStrictJson(payloadText.slice(opening, closing + 1), `tshark frame ${frame} JSON-RPC`);
    if (!message || typeof message !== "object" || Array.isArray(message)) fail(`tshark frame ${frame}: JSON-RPC payload must be an object`);
    records.push({ frame, sourceIp, destinationIp, destinationPort, host, uri, payloadText, message });
  }
  return records;
}

export function parseTsharkSniFields(text) {
  const records = [];
  for (const [lineIndex, line] of text.split(/\r?\n/u).entries()) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== 4) fail(`tshark SNI line ${lineIndex + 1}: expected exactly 4 fields`);
    const [sourceIp, destinationIp, destinationPort, serverName] = fields;
    assertIpv4(sourceIp, `tshark SNI line ${lineIndex + 1} source IP`);
    assertIpv4(destinationIp, `tshark SNI line ${lineIndex + 1} destination IP`);
    if (destinationPort !== "443") fail(`tshark SNI line ${lineIndex + 1}: expected destination port 443`);
    assertSafeString(serverName, `tshark SNI line ${lineIndex + 1} server name`, { max: 253, pattern: /^[a-z0-9.-]+$/u });
    records.push({ sourceIp, destinationIp, destinationPort, serverName });
  }
  return records;
}

export function verifyCapturedEndpointSni(records, endpoints) {
  const required = [
    { label: "remote", hostname: new URL(endpoints.remoteUrl).hostname, destinationIp: endpoints.remoteIp },
    { label: "Hub", hostname: new URL(endpoints.hubUrl).hostname, destinationIp: endpoints.hubIp },
  ];
  for (const endpoint of required) {
    const matches = records.filter((record) => record.sourceIp === endpoints.clientIp
      && record.destinationIp === endpoint.destinationIp
      && record.destinationPort === "443"
      && record.serverName === endpoint.hostname);
    if (matches.length < 1) fail(`capture: missing exact client -> ${endpoint.label} TLS SNI/IP binding`);
  }
  return required.map((endpoint) => ({ hostname: endpoint.hostname, destinationIp: endpoint.destinationIp }));
}

export function verifyTaskTraffic(records, endpoints) {
  const taskRecords = records.filter((record) => TASK_METHODS.includes(record.message.method));
  const methods = new Set(taskRecords.map((record) => record.message.method));
  for (const method of TASK_METHODS) if (!methods.has(method)) fail(`capture: missing ${method} request`);
  for (const record of taskRecords) {
    if (record.sourceIp === endpoints.hubIp || record.destinationIp === endpoints.hubIp) fail(`capture: Task method ${record.message.method} reached Agent Hub`);
    if (record.sourceIp !== endpoints.clientIp || record.destinationIp !== endpoints.remoteIp || record.destinationPort !== "443") {
      fail(`capture: Task method ${record.message.method} did not travel client -> exact remote HTTPS/443`);
    }
    const interfaceUrl = new URL(endpoints.remoteUrl);
    if (![interfaceUrl.hostname, `${interfaceUrl.hostname}:443`].includes(record.host)
      || record.uri !== `${interfaceUrl.pathname}${interfaceUrl.search}`) {
      fail(`capture: Task method ${record.message.method} did not use the exact remote interface Host/path`);
    }
  }
  const taskRequestIds = taskRecords.filter((record) => "id" in record.message).map((record) => JSON.stringify(record.message.id));
  for (const response of records.filter((record) => !("method" in record.message) && "id" in record.message && taskRequestIds.includes(JSON.stringify(record.message.id)))) {
    if (response.sourceIp !== endpoints.remoteIp || response.destinationIp !== endpoints.clientIp) fail("capture: a Task response did not travel exact remote -> client");
  }
  const taskCorpus = taskRecords.map((record) => record.payloadText).join("\n");
  if (!taskCorpus.includes(CANARIES[0])) fail("capture: Task payload canary was not observed on direct data plane");
  const caseIds = PACKAGED_LIVE_CASE_IDS.filter((caseId) => taskCorpus.includes(`[LVIS-P4-5:${caseId}]`));
  const missingRemoteCases = REMOTE_OBSERVED_CASE_IDS.filter((caseId) => !caseIds.includes(caseId));
  if (missingRemoteCases.length) fail(`capture: missing expected direct data-plane case ${missingRemoteCases[0]}`);
  const unexpectedSocketCases = NO_SOCKET_CASE_IDS.filter((caseId) => caseIds.includes(caseId));
  if (unexpectedSocketCases.length) fail(`capture: no-socket case reached the data plane: ${unexpectedSocketCases[0]}`);
  const unknownCaseMarkers = [...taskCorpus.matchAll(/\[LVIS-P4-5:([^\]]+)\]/gu)].map((match) => match[1]).filter((caseId) => !PACKAGED_LIVE_CASE_IDS.includes(caseId));
  if (unknownCaseMarkers.length) fail(`capture: unknown case marker ${unknownCaseMarkers[0]}`);
  const responseAssertions = verifyCapturedResponseBranches(records, endpoints);
  return { taskRequestCount: taskRecords.length, methods: [...methods].sort(), caseIds, noSocketCaseIds: [...NO_SOCKET_CASE_IDS], responseAssertions };
}

export function verifyHubEvidenceAbsent(hubEvidence) {
  const contains = (artifact, needle, label) => {
    if (artifact.bytes) return artifact.bytes.includes(Buffer.from(needle, "utf8"));
    if (!artifact.needleMatches || !Object.hasOwn(artifact.needleMatches, needle)) fail(`${label}: missing bounded streaming scan result`);
    return artifact.needleMatches[needle] === true;
  };
  for (const [kind, artifacts] of Object.entries(hubEvidence)) {
    for (const artifact of artifacts) {
      for (const canary of CANARIES) {
        const found = contains(artifact, canary, `Hub ${kind}`);
        if (found) fail(`Hub ${kind}: retained forbidden canary ${canary}`);
      }
    }
  }
}

export function verifyRemoteServerEvidence(artifacts) {
  const contains = (needle) => artifacts.some((artifact) => {
    if (artifact.bytes) return artifact.bytes.includes(Buffer.from(needle, "utf8"));
    if (!artifact.needleMatches || !Object.hasOwn(artifact.needleMatches, needle)) fail("remote server evidence: missing bounded streaming scan result");
    return artifact.needleMatches[needle] === true;
  });
  for (const canary of CANARIES) if (!contains(canary)) fail(`remote server evidence: missing canary ${canary}`);
  for (const caseId of REMOTE_OBSERVED_CASE_IDS) if (!contains(`[LVIS-P4-5:${caseId}]`)) fail(`remote server evidence: missing case marker ${caseId}`);
  for (const caseId of NO_SOCKET_CASE_IDS) if (contains(`[LVIS-P4-5:${caseId}]`)) fail(`remote server evidence: no-socket case unexpectedly arrived: ${caseId}`);
}
