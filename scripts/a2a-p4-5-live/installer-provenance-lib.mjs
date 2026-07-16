import { basename, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  assertArray,
  assertExactKeys,
  assertHeadSha,
  assertRecord,
  assertSafeString,
  assertSha256,
  fail,
  readRegularFile,
} from "./evidence-lib.mjs";
import { parseStrictJson } from "./strict-json.mjs";

export const SUPPORTED_INSTALLER_OSES = Object.freeze(["macos", "windows", "linux"]);

export function runFixedProgram(command, args, { env = {}, inheritEnv = true, unsetEnv = [], label = command, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const childEnv = { ...(inheritEnv ? process.env : {}), ...env };
  for (const key of unsetEnv) delete childEnv[key];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: childEnv,
    maxBuffer,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label}: failed with exit ${result.status}: ${(result.stderr || result.stdout || "no output").trim().slice(0, 1000)}`);
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function requireNonemptyOutput(result, label) {
  const output = result.stdout || result.stderr;
  if (!output) fail(`${label}: verifier returned empty output`);
  return output;
}

function verifyMacos(installerPath, run) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", installerPath], { label: "codesign verification" });
  const details = requireNonemptyOutput(
    run("codesign", ["--display", "--verbose=4", installerPath], { label: "codesign identity" }),
    "codesign identity",
  );
  const identity = /(?:^|\n)Authority=(.+)$/mu.exec(details)?.[1]?.trim();
  if (!identity) fail("codesign identity: missing Authority");
  const assessment = requireNonemptyOutput(
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", installerPath], { label: "spctl assessment" }),
    "spctl assessment",
  );
  if (!/accepted/iu.test(assessment)) fail("spctl assessment: installer was not accepted");
  const attach = run("hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", installerPath], { label: "read-only DMG mount" });
  const mountMatches = [...attach.stdout.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/gu)];
  if (mountMatches.length !== 1) fail("read-only DMG mount: expected exactly one mount point");
  const decodeXml = (value) => value.replace(/&(amp|lt|gt|quot|apos);/gu, (entity, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]);
  const mountPoint = decodeXml(mountMatches[0][1]);
  if (!mountPoint.startsWith("/Volumes/") || mountPoint.includes("\0") || mountPoint.includes("&") || mountPoint.split("/").includes("..")) fail("read-only DMG mount: unsafe mount point");
  const appPath = resolve(mountPoint, "LVIS.app");
  let appIdentity;
  let appAssessment;
  try {
    run("/usr/bin/test", ["-d", appPath], { label: "mounted LVIS.app directory" });
    run("/usr/bin/test", ["!", "-L", appPath], { label: "mounted LVIS.app symlink rejection" });
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath], { label: "inner app codesign verification" });
    const appDetails = requireNonemptyOutput(
      run("codesign", ["--display", "--verbose=4", appPath], { label: "inner app codesign identity" }),
      "inner app codesign identity",
    );
    appIdentity = /(?:^|\n)Authority=(.+)$/mu.exec(appDetails)?.[1]?.trim();
    if (!appIdentity) fail("inner app codesign identity: missing Authority");
    appAssessment = requireNonemptyOutput(
      run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], { label: "inner app Gatekeeper assessment" }),
      "inner app Gatekeeper assessment",
    );
    if (!/accepted/iu.test(appAssessment)) fail("inner app Gatekeeper assessment: app was not accepted");
  } finally {
    run("hdiutil", ["detach", mountPoint], { label: "DMG detach" });
  }
  return {
    platform: "macos",
    status: "verified",
    installerCodesignIdentity: identity,
    installerSpctlAssessment: assessment.slice(0, 2000),
    appCodesignIdentity: appIdentity,
    appSpctlAssessment: appAssessment.slice(0, 2000),
    verifier: "codesign+spctl",
  };
}

function verifyWindows(installerPath, run) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:LVIS_INSTALLER_PATH",
    "if ($signature.Status -ne 'Valid') { throw \"Authenticode status: $($signature.Status)\" }",
    "if (-not $signature.SignerCertificate) { throw 'Missing signer certificate' }",
    "[ordered]@{ status=$signature.Status.ToString(); subject=$signature.SignerCertificate.Subject; thumbprint=$signature.SignerCertificate.Thumbprint; statusMessage=$signature.StatusMessage } | ConvertTo-Json -Compress",
  ].join("; ");
  const raw = requireNonemptyOutput(
    run("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { LVIS_INSTALLER_PATH: installerPath },
      label: "Authenticode verification",
    }),
    "Authenticode verification",
  );
  const value = parseStrictJson(raw, "Authenticode result");
  assertExactKeys(value, ["status", "subject", "thumbprint", "statusMessage"], "Authenticode result");
  if (value.status !== "Valid") fail("Authenticode result: status must be Valid");
  assertSafeString(value.subject, "Authenticode result.subject", { max: 2048 });
  assertSafeString(value.thumbprint, "Authenticode result.thumbprint", {
    min: 40,
    max: 128,
    pattern: /^[0-9A-F]+$/u,
  });
  return {
    platform: "windows",
    status: "verified",
    subject: value.subject,
    thumbprint: value.thumbprint,
    statusMessage: String(value.statusMessage).slice(0, 2000),
    verifier: "Get-AuthenticodeSignature",
  };
}

function verifyLinux(installerPath, run) {
  const extension = extname(installerPath).toLowerCase();
  if (extension === ".deb") {
    const raw = run("dpkg-deb", ["--field", installerPath, "Package", "Version", "Architecture"], { label: "dpkg-deb identity" }).stdout;
    const fields = Object.fromEntries(raw.split(/\r?\n/u).filter(Boolean).map((line) => {
      const separator = line.indexOf(":");
      if (separator < 1) fail("dpkg-deb identity: malformed field output");
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
    assertExactKeys(fields, ["Package", "Version", "Architecture"], "dpkg-deb identity");
    return {
      platform: "linux", status: "verified", format: "deb",
      packageName: assertSafeString(fields.Package, "deb package name", { max: 128 }),
      version: assertSafeString(fields.Version, "deb package version", { max: 128 }),
      architecture: assertSafeString(fields.Architecture, "deb architecture", { max: 64 }),
      verifier: "dpkg-deb",
    };
  }
  if (extension === ".rpm") {
    const raw = run("rpm", ["-qp", "--qf", "%{NAME}\n%{VERSION}-%{RELEASE}\n%{ARCH}\n", installerPath], { label: "rpm identity" }).stdout;
    const fields = raw.split(/\r?\n/u).filter(Boolean);
    if (fields.length !== 3) fail("rpm identity: expected name, version-release, architecture");
    return {
      platform: "linux", status: "verified", format: "rpm",
      packageName: assertSafeString(fields[0], "rpm package name", { max: 128 }),
      version: assertSafeString(fields[1], "rpm package version", { max: 128 }),
      architecture: assertSafeString(fields[2], "rpm architecture", { max: 64 }),
      verifier: "rpm",
    };
  }
  if (installerPath.endsWith(".AppImage")) {
    const fileIdentity = run("file", ["--brief", "--dereference", installerPath], { label: "AppImage file identity" }).stdout;
    if (!/ELF .+ executable/iu.test(fileIdentity)) fail("AppImage identity: expected an ELF executable");
    const elfHeader = run("readelf", ["--file-header", installerPath], { label: "AppImage ELF identity" }).stdout;
    const machine = /^\s*Machine:\s*(.+)$/mu.exec(elfHeader)?.[1]?.trim();
    if (!machine) fail("AppImage identity: missing ELF machine");
    const version = /^LVIS-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-linux-[A-Za-z0-9_-]+\.AppImage$/u.exec(basename(installerPath))?.[1];
    if (!version) fail("AppImage identity: filename does not bind an exact semantic version");
    return {
      platform: "linux", status: "verified", format: "appimage",
      packageName: "LVIS", version,
      architecture: assertSafeString(machine, "AppImage machine", { max: 128 }),
      verifier: "file+readelf",
    };
  }
  fail(`linux installer: unsupported extension for ${basename(installerPath)}`);
}

export function verifyInstallerIdentity(os, installerPath, run = runFixedProgram) {
  if (!SUPPORTED_INSTALLER_OSES.includes(os)) fail(`unsupported installer OS ${os}`);
  if (os === "macos") return verifyMacos(installerPath, run);
  if (os === "windows") return verifyWindows(installerPath, run);
  return verifyLinux(installerPath, run);
}

const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const VERIFICATION_RESULT_MEDIA_TYPE = "application/vnd.dev.sigstore.verificationresult+json;version=0.1";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const SIGNER_WORKFLOW_PATH = ".github/workflows/a2a-p4-5-packaged-evidence.yml";
const CERTIFICATE_KEYS = Object.freeze([
  "certificateIssuer",
  "subjectAlternativeName",
  "issuer",
  "githubWorkflowTrigger",
  "githubWorkflowSHA",
  "githubWorkflowName",
  "githubWorkflowRepository",
  "githubWorkflowRef",
  "buildSignerURI",
  "buildSignerDigest",
  "runnerEnvironment",
  "sourceRepositoryURI",
  "sourceRepositoryDigest",
  "sourceRepositoryRef",
  "sourceRepositoryIdentifier",
  "sourceRepositoryOwnerURI",
  "sourceRepositoryOwnerIdentifier",
  "buildConfigURI",
  "buildConfigDigest",
  "buildTrigger",
  "runInvocationURI",
  "sourceRepositoryVisibilityAtSigning",
]);

function assertRequiredAllowedKeys(value, required, allowed, label) {
  assertRecord(value, label);
  const actual = Object.keys(value);
  const missing = required.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !allowed.includes(key));
  if (missing.length || unknown.length) {
    fail(`${label}: schema mismatch (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`);
  }
}

function assertHttpsUrl(value, label) {
  assertSafeString(value, label, { max: 2048 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label}: expected absolute URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    fail(`${label}: expected credential-free HTTPS URL without a fragment`);
  }
  return parsed;
}

function assertSignerWorkflowUri(value, repository, label) {
  const workflowUri = `https://github.com/${repository}/${SIGNER_WORKFLOW_PATH}`;
  const marker = `${workflowUri}@`;
  assertHttpsUrl(value, label);
  if (!value.startsWith(marker)) fail(`${label}: expected exact signer workflow ${workflowUri}`);
  const sourceRef = value.slice(marker.length);
  if (!/^refs\/(?:heads|tags)\/[0-9A-Za-z._/-]+$/u.test(sourceRef) || sourceRef.includes("..")) {
    fail(`${label}: signer workflow must be pinned to a safe branch or tag ref`);
  }
  return value;
}

export function verifyAttestationReport(reportArtifact, {
  installerSha256,
  appHead,
  repository,
  workflowRunId,
  workflowRunAttempt,
}) {
  assertSha256(installerSha256, "installer attestation subject digest");
  assertHeadSha(appHead, "installer attestation source head");
  if (repository !== "lvis-project/lvis-app") fail("installer attestation repository must be lvis-project/lvis-app");
  if (!/^\d+$/u.test(String(workflowRunId)) || !/^\d+$/u.test(String(workflowRunAttempt))) {
    fail("installer attestation workflow run id and attempt must be decimal strings");
  }
  const report = parseStrictJson(reportArtifact.bytes.toString("utf8"), "gh attestation report");
  assertArray(report, "gh attestation report", { min: 1, max: 1 });
  const entry = report[0];
  assertExactKeys(entry, ["attestation", "verificationResult"], "gh attestation report[0]");

  assertExactKeys(entry.attestation, ["bundle", "bundle_url", "initiator"], "gh attestation report[0].attestation");
  assertRecord(entry.attestation.bundle, "gh attestation report[0].attestation.bundle");
  if (Object.keys(entry.attestation.bundle).length === 0) fail("gh attestation report[0].attestation.bundle: empty bundle");
  assertHttpsUrl(entry.attestation.bundle_url, "gh attestation report[0].attestation.bundle_url");
  assertSafeString(entry.attestation.initiator, "gh attestation report[0].attestation.initiator", { max: 256 });

  const result = entry.verificationResult;
  assertExactKeys(result, ["mediaType", "statement", "signature", "verifiedTimestamps", "verifiedIdentity"], "gh attestation report[0].verificationResult");
  if (result.mediaType !== VERIFICATION_RESULT_MEDIA_TYPE) fail("gh attestation report: unexpected verification result media type");
  assertArray(result.verifiedTimestamps, "gh attestation report[0].verificationResult.verifiedTimestamps", { min: 1, max: 16 });
  result.verifiedTimestamps.forEach((timestamp, index) => {
    const label = `gh attestation report[0].verificationResult.verifiedTimestamps[${index}]`;
    assertExactKeys(timestamp, ["type", "uri", "timestamp"], label);
    assertSafeString(timestamp.type, `${label}.type`, { max: 64 });
    assertHttpsUrl(timestamp.uri, `${label}.uri`);
    assertSafeString(timestamp.timestamp, `${label}.timestamp`, {
      max: 64,
      pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u,
    });
  });
  assertRecord(result.verifiedIdentity, "gh attestation report[0].verificationResult.verifiedIdentity");

  const statement = result.statement;
  assertExactKeys(statement, ["_type", "subject", "predicateType", "predicate"], "gh attestation report[0].verificationResult.statement");
  if (statement._type !== "https://in-toto.io/Statement/v1") fail("gh attestation report: expected in-toto Statement v1");
  if (statement.predicateType !== SLSA_PROVENANCE_V1) fail("gh attestation report: expected SLSA provenance v1 predicate");
  assertRecord(statement.predicate, "gh attestation report[0].verificationResult.statement.predicate");
  assertArray(statement.subject, "gh attestation report[0].verificationResult.statement.subject", { min: 1, max: 1 });
  const subject = statement.subject[0];
  assertExactKeys(subject, ["name", "digest"], "gh attestation report[0].verificationResult.statement.subject[0]");
  assertSafeString(subject.name, "gh attestation report[0].verificationResult.statement.subject[0].name", { max: 512 });
  assertExactKeys(subject.digest, ["sha256"], "gh attestation report[0].verificationResult.statement.subject[0].digest");
  if (subject.digest.sha256 !== installerSha256) fail("gh attestation report: subject digest does not equal installer digest");

  assertExactKeys(result.signature, ["certificate"], "gh attestation report[0].verificationResult.signature");
  const certificate = result.signature.certificate;
  const requiredCertificateKeys = [
    "certificateIssuer",
    "subjectAlternativeName",
    "issuer",
    "buildSignerURI",
    "buildSignerDigest",
    "runnerEnvironment",
    "sourceRepositoryURI",
    "sourceRepositoryDigest",
    "buildConfigURI",
    "buildConfigDigest",
    "runInvocationURI",
  ];
  assertRequiredAllowedKeys(certificate, requiredCertificateKeys, CERTIFICATE_KEYS, "gh attestation report[0].verificationResult.signature.certificate");
  assertSafeString(certificate.certificateIssuer, "attestation certificate.certificateIssuer", { max: 2048 });
  assertSignerWorkflowUri(certificate.subjectAlternativeName, repository, "attestation certificate.subjectAlternativeName");
  assertSignerWorkflowUri(certificate.buildSignerURI, repository, "attestation certificate.buildSignerURI");
  if (certificate.subjectAlternativeName !== certificate.buildSignerURI) {
    fail("gh attestation report: certificate SAN and build signer URI must match exactly");
  }
  if (certificate.issuer !== GITHUB_OIDC_ISSUER) fail("gh attestation report: unexpected certificate OIDC issuer");
  if (certificate.buildSignerDigest !== appHead) fail("gh attestation report: signer digest does not equal requested app head");
  if (certificate.runnerEnvironment !== "github-hosted") fail("gh attestation report: runner environment must be github-hosted");
  if (certificate.sourceRepositoryURI !== `https://github.com/${repository}`) fail("gh attestation report: source repository URI mismatch");
  if (certificate.sourceRepositoryDigest !== appHead) fail("gh attestation report: source repository digest does not equal requested app head");
  assertSignerWorkflowUri(certificate.buildConfigURI, repository, "attestation certificate.buildConfigURI");
  if (certificate.buildConfigDigest !== appHead) fail("gh attestation report: build config digest does not equal requested app head");
  const expectedRunInvocation = `https://github.com/${repository}/actions/runs/${workflowRunId}/attempts/${workflowRunAttempt}`;
  if (certificate.runInvocationURI !== expectedRunInvocation) fail("gh attestation report: run invocation URI mismatch");

  return {
    reportSha256: reportArtifact.sha256,
    subjectSha256: installerSha256,
    sourceHead: appHead,
    repository,
    workflowRunId: String(workflowRunId),
    workflowRunAttempt: String(workflowRunAttempt),
  };
}

export function collectFixedToolVersions(run = runFixedProgram) {
  const firstLine = (result, label) => assertSafeString(result.stdout.split(/\r?\n/u)[0], label, { max: 512 });
  return {
    node: process.version,
    bun: firstLine(run("bun", ["--version"], { label: "bun version" }), "bun version"),
    git: firstLine(run("git", ["--version"], { label: "git version" }), "git version"),
    gh: firstLine(run("gh", ["--version"], { label: "gh version" }), "gh version"),
  };
}

export function validateProvenance(value, label = "installer provenance") {
  assertExactKeys(value, ["schemaVersion", "generatedAt", "installer", "source", "workflow", "signature", "attestation", "locks", "tools"], label);
  if (value.schemaVersion !== 1) fail(`${label}.schemaVersion: expected 1`);
  assertSafeString(value.generatedAt, `${label}.generatedAt`, { pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u });
  assertExactKeys(value.installer, ["name", "size", "sha256"], `${label}.installer`);
  assertSafeString(value.installer.name, `${label}.installer.name`, { max: 512 });
  if (!Number.isSafeInteger(value.installer.size) || value.installer.size <= 0) fail(`${label}.installer.size: invalid`);
  assertSafeString(value.installer.sha256, `${label}.installer.sha256`, { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/u });
  assertExactKeys(value.source, ["repository", "appHead", "agentHubHead"], `${label}.source`);
  if (value.source.repository !== "lvis-project/lvis-app") fail(`${label}.source.repository: unexpected repository`);
  assertHeadSha(value.source.appHead, `${label}.source.appHead`);
  assertHeadSha(value.source.agentHubHead, `${label}.source.agentHubHead`);
  assertExactKeys(value.workflow, ["runId", "attempt"], `${label}.workflow`);
  if (!/^\d+$/u.test(value.workflow.runId) || !/^\d+$/u.test(value.workflow.attempt)) fail(`${label}.workflow: runId/attempt must be decimal strings`);
  assertRecordWithStatus(value.signature, `${label}.signature`);
  assertExactKeys(value.attestation, ["reportSha256", "subjectSha256", "sourceHead", "repository", "workflowRunId", "workflowRunAttempt"], `${label}.attestation`);
  if (value.attestation.subjectSha256 !== value.installer.sha256 || value.attestation.sourceHead !== value.source.appHead || value.attestation.repository !== value.source.repository || value.attestation.workflowRunId !== value.workflow.runId || value.attestation.workflowRunAttempt !== value.workflow.attempt) {
    fail(`${label}.attestation: source/subject bindings do not match provenance`);
  }
  for (const key of ["reportSha256", "subjectSha256"]) assertSafeString(value.attestation[key], `${label}.attestation.${key}`, { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/u });
  assertHeadSha(value.attestation.sourceHead, `${label}.attestation.sourceHead`);
  assertExactKeys(value.locks, ["packageJsonSha256", "bunLockSha256"], `${label}.locks`);
  for (const key of Object.keys(value.locks)) assertSafeString(value.locks[key], `${label}.locks.${key}`, { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/u });
  assertExactKeys(value.tools, ["node", "bun", "git", "gh", "signatureVerifier"], `${label}.tools`);
  for (const [key, tool] of Object.entries(value.tools)) assertSafeString(tool, `${label}.tools.${key}`, { max: 512 });
  return value;
}

function assertRecordWithStatus(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}: expected object`);
  if (value.status !== "verified" || !SUPPORTED_INSTALLER_OSES.includes(value.platform)) fail(`${label}: expected verified supported platform`);
  if (value.platform === "macos") {
    assertExactKeys(value, ["platform", "status", "installerCodesignIdentity", "installerSpctlAssessment", "appCodesignIdentity", "appSpctlAssessment", "verifier"], label);
    for (const key of ["installerCodesignIdentity", "installerSpctlAssessment", "appCodesignIdentity", "appSpctlAssessment"]) assertSafeString(value[key], `${label}.${key}`, { max: 2048 });
  } else if (value.platform === "windows") {
    assertExactKeys(value, ["platform", "status", "subject", "thumbprint", "statusMessage", "verifier"], label);
    assertSafeString(value.subject, `${label}.subject`, { max: 2048 });
    assertSafeString(value.thumbprint, `${label}.thumbprint`, { min: 40, max: 128, pattern: /^[0-9A-F]+$/u });
    assertSafeString(value.statusMessage, `${label}.statusMessage`, { max: 2048 });
  } else {
    assertExactKeys(value, ["platform", "status", "format", "packageName", "version", "architecture", "verifier"], label);
    if (!["deb", "rpm", "appimage"].includes(value.format)) fail(`${label}.format: invalid Linux package format`);
    for (const key of ["packageName", "version", "architecture"]) assertSafeString(value[key], `${label}.${key}`, { max: 256 });
  }
  assertSafeString(value.verifier, `${label}.verifier`, { max: 128 });
}

export function readAndValidateProvenance(path) {
  const artifact = readRegularFile(path, "installer provenance", { maxBytes: 2 * 1024 * 1024 });
  const value = parseStrictJson(artifact.bytes.toString("utf8"), "installer provenance");
  return { artifact, value: validateProvenance(value) };
}
