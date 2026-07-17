import { basename, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  assertArray,
  assertExactKeys,
  assertHeadSha,
  assertRecord,
  assertSafeString,
  assertSha256,
  fail,
  readRegularFile,
  sha256Buffer,
} from "./evidence-lib.mjs";
import { parseStrictJson } from "./strict-json.mjs";

export const SUPPORTED_INSTALLER_OSES = Object.freeze(["macos", "windows", "linux"]);

const DEFAULT_PROGRAM_TIMEOUT_MS = 5 * 60_000;
const MAX_PROGRAM_TIMEOUT_MS = 60 * 60_000;

const SAFE_CHILD_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP",
  "USERPROFILE", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
]);

function baseChildEnvironment() {
  return Object.fromEntries(SAFE_CHILD_ENV_KEYS
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
}

export function runFixedProgram(command, args, {
  env = {}, label = command, maxBuffer = 4 * 1024 * 1024, input,
  timeoutMs = DEFAULT_PROGRAM_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROGRAM_TIMEOUT_MS) {
    fail(`${label}: timeoutMs must be an integer from 1 to ${MAX_PROGRAM_TIMEOUT_MS}`);
  }
  const childEnv = { ...baseChildEnvironment(), ...env };
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: childEnv,
    input,
    maxBuffer,
    timeout: timeoutMs,
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

function normalizeHexFingerprint(value, label, { lengths = [64] } = {}) {
  const ordered = [...new Set(lengths)].sort((left, right) => left - right);
  const alternatives = ordered.map((length) => `[0-9A-Fa-f]{${length}}`).join("|");
  assertSafeString(value, label, { min: ordered[0], max: ordered.at(-1), pattern: new RegExp(`^(?:${alternatives})$`, "u") });
  return value.toUpperCase();
}

function parseMacIdentity(details, label) {
  const authority = /(?:^|\n)Authority=(.+)$/mu.exec(details)?.[1]?.trim();
  const teamId = /(?:^|\n)TeamIdentifier=([0-9A-Z]+)$/mu.exec(details)?.[1]?.trim();
  if (!authority || !teamId) fail(`${label}: missing Authority or TeamIdentifier`);
  return { authority, teamId };
}

function extractMacLeafCertificateSha256(subjectPath, run, label) {
  const directory = mkdtempSync(resolve(realpathSync(tmpdir()), "lvis-codesign-certificate-"));
  const prefix = resolve(directory, "certificate-");
  try {
    run("codesign", ["--display", "--extract-certificates", prefix, subjectPath], {
      label: `${label} embedded certificate extraction`,
    });
    return readRegularFile(`${prefix}0`, `${label} embedded leaf certificate`, {
      maxBytes: 1024 * 1024,
      loadBytes: false,
    }).sha256.toUpperCase();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const MAC_DEVICE_ENTRY_RE = /^\/dev\/disk[0-9]+(?:s[0-9]+)*$/u;

function isSafeMacMountPoint(value) {
  return value.startsWith("/Volumes/")
    && !value.includes("\0")
    && !value.includes("&")
    && !value.split("/").includes("..");
}

/**
 * Cleanup-only fallback for the raw plist returned by hdiutil. Acceptance
 * always uses plutil + strict JSON below; these candidates exist solely so a
 * converter/schema failure can still detach an image that was already mounted.
 */
function cleanupTargetsFromRawAttachPlist(rawPlist) {
  const devices = new Set();
  const mounts = new Set();
  const decodeXml = (value) => value.replace(/&(amp|lt|gt|quot|apos);/gu, (_entity, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]);
  for (const match of rawPlist.matchAll(/<key>(dev-entry|mount-point)<\/key>\s*<string>([^<]+)<\/string>/gu)) {
    const value = decodeXml(match[2]);
    if (MAC_DEVICE_ENTRY_RE.test(value)) devices.add(value);
    else if (isSafeMacMountPoint(value)) mounts.add(value);
  }
  return devices.size > 0 ? devices : mounts;
}

function verifyMacos(installerPath, run, expected) {
  const expectedTeamId = assertSafeString(expected.macTeamId, "expected macOS Team ID", {
    min: 10, max: 64, pattern: /^[0-9A-Z]+$/u,
  });
  const expectedCertificateSha256 = normalizeHexFingerprint(expected.macCertificateSha256, "expected macOS certificate SHA-256");
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", installerPath], { label: "codesign verification" });
  const details = requireNonemptyOutput(
    run("codesign", ["--display", "--verbose=4", installerPath], { label: "codesign identity" }),
    "codesign identity",
  );
  const identity = parseMacIdentity(details, "codesign identity");
  if (identity.teamId !== expectedTeamId) fail("codesign identity: TeamIdentifier does not match the pinned LVIS Team ID");
  const installerCertificateSha256 = extractMacLeafCertificateSha256(
    installerPath,
    run,
    "installer codesign identity",
  );
  if (installerCertificateSha256 !== expectedCertificateSha256) {
    fail("macOS signer certificate fingerprint does not match the pinned LVIS certificate");
  }
  const assessment = requireNonemptyOutput(
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", installerPath], { label: "spctl assessment" }),
    "spctl assessment",
  );
  if (!/accepted/iu.test(assessment)) fail("spctl assessment: installer was not accepted");
  const attach = run("hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", installerPath], { label: "read-only DMG mount" });
  const cleanupTargets = cleanupTargetsFromRawAttachPlist(attach.stdout);
  let appIdentity;
  let appAssessment;
  let verificationError;
  try {
    const mountJson = requireNonemptyOutput(
      run("plutil", ["-convert", "json", "-o", "-", "-"], {
        input: attach.stdout,
        label: "DMG mount plist conversion",
      }),
      "DMG mount plist conversion",
    );
    const mountPlist = assertRecord(parseStrictJson(mountJson, "DMG mount plist"), "DMG mount plist");
    const systemEntities = assertArray(mountPlist["system-entities"], "DMG mount plist.system-entities");
    const parsedCleanupTargets = new Set();
    const mountPoints = systemEntities.flatMap((entry, index) => {
      const entity = assertRecord(entry, `DMG mount plist.system-entities[${index}]`);
      const deviceEntry = entity["dev-entry"] === undefined
        ? undefined
        : assertSafeString(entity["dev-entry"], `DMG mount plist.system-entities[${index}].dev-entry`, { max: 128, pattern: MAC_DEVICE_ENTRY_RE });
      if (entity["mount-point"] === undefined) return [];
      const point = assertSafeString(entity["mount-point"], `DMG mount plist.system-entities[${index}].mount-point`, { max: 4096 });
      if (deviceEntry) parsedCleanupTargets.add(deviceEntry);
      else if (isSafeMacMountPoint(point)) parsedCleanupTargets.add(point);
      return [point];
    });
    if (parsedCleanupTargets.size > 0) {
      cleanupTargets.clear();
      for (const target of parsedCleanupTargets) cleanupTargets.add(target);
    }
    if (mountPoints.length !== 1) fail("read-only DMG mount: expected exactly one mount point");
    const [mountPoint] = mountPoints;
    if (!isSafeMacMountPoint(mountPoint)) fail("read-only DMG mount: unsafe mount point");
    const appPath = resolve(mountPoint, "LVIS.app");
    run("/usr/bin/test", ["-d", appPath], { label: "mounted LVIS.app directory" });
    run("/usr/bin/test", ["!", "-L", appPath], { label: "mounted LVIS.app symlink rejection" });
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath], { label: "inner app codesign verification" });
    const appDetails = requireNonemptyOutput(
      run("codesign", ["--display", "--verbose=4", appPath], { label: "inner app codesign identity" }),
      "inner app codesign identity",
    );
    appIdentity = parseMacIdentity(appDetails, "inner app codesign identity");
    if (appIdentity.teamId !== expectedTeamId || appIdentity.authority !== identity.authority) {
      fail("inner app codesign identity does not match the pinned installer identity");
    }
    const appCertificateSha256 = extractMacLeafCertificateSha256(
      appPath,
      run,
      "inner app codesign identity",
    );
    if (appCertificateSha256 !== expectedCertificateSha256
      || appCertificateSha256 !== installerCertificateSha256) {
      fail("inner app codesign certificate does not match the pinned installer certificate");
    }
    appAssessment = requireNonemptyOutput(
      run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], { label: "inner app Gatekeeper assessment" }),
      "inner app Gatekeeper assessment",
    );
    if (!/accepted/iu.test(appAssessment)) fail("inner app Gatekeeper assessment: app was not accepted");
  } catch (error) {
    verificationError = error;
    throw error;
  } finally {
    let firstDetachError;
    for (const target of cleanupTargets) {
      try {
        run("hdiutil", ["detach", target], { label: "DMG detach" });
      } catch (detachError) {
        firstDetachError ??= detachError;
      }
    }
    if (!verificationError && firstDetachError) throw firstDetachError;
  }
  return {
    platform: "macos",
    status: "publisher-verified",
    identityKind: "native-signature",
    installerCodesignIdentity: identity.authority,
    teamId: expectedTeamId,
    certificateSha256: expectedCertificateSha256,
    installerSpctlAssessment: assessment.slice(0, 2000),
    appCodesignIdentity: appIdentity.authority,
    appSpctlAssessment: appAssessment.slice(0, 2000),
    verifier: "codesign+spctl",
  };
}

function verifyWindows(installerPath, run, expected) {
  const expectedSubject = assertSafeString(expected.windowsPublisherSubject, "expected Windows publisher subject", { max: 2048 });
  const expectedThumbprint = normalizeHexFingerprint(expected.windowsCertificateThumbprint, "expected Windows certificate thumbprint", { lengths: [40, 64] });
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
  if (value.subject !== expectedSubject || value.thumbprint !== expectedThumbprint) {
    fail("Authenticode result: publisher subject or certificate thumbprint does not match the pinned LVIS identity");
  }
  return {
    platform: "windows",
    status: "publisher-verified",
    identityKind: "native-signature",
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
      platform: "linux", status: "metadata-only", identityKind: "package-metadata", format: "deb",
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
      platform: "linux", status: "metadata-only", identityKind: "package-metadata", format: "rpm",
      packageName: assertSafeString(fields[0], "rpm package name", { max: 128 }),
      version: assertSafeString(fields[1], "rpm package version", { max: 128 }),
      architecture: assertSafeString(fields[2], "rpm architecture", { max: 64 }),
      verifier: "rpm",
    };
  }
  // The workflow admits only release/*.AppImage. Preserve that canonical,
  // case-sensitive artifact name instead of widening the live-evidence gate.
  if (installerPath.endsWith(".AppImage")) {
    const fileIdentity = run("file", ["--brief", "--dereference", installerPath], { label: "AppImage file identity" }).stdout;
    if (!/ELF .+ executable/iu.test(fileIdentity)) fail("AppImage identity: expected an ELF executable");
    const elfHeader = run("readelf", ["--file-header", installerPath], { label: "AppImage ELF identity" }).stdout;
    const machine = /^\s*Machine:\s*(.+)$/mu.exec(elfHeader)?.[1]?.trim();
    if (!machine) fail("AppImage identity: missing ELF machine");
    const version = /^LVIS-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-linux-[A-Za-z0-9_-]+\.AppImage$/u.exec(basename(installerPath))?.[1];
    if (!version) fail("AppImage identity: filename does not bind an exact semantic version");
    return {
      platform: "linux", status: "metadata-only", identityKind: "package-metadata", format: "appimage",
      packageName: "LVIS", version,
      architecture: assertSafeString(machine, "AppImage machine", { max: 128 }),
      verifier: "file+readelf",
    };
  }
  fail(`linux installer: unsupported extension for ${basename(installerPath)}`);
}

export function verifyInstallerIdentity(os, installerPath, { run = runFixedProgram, expected = {} } = {}) {
  if (!SUPPORTED_INSTALLER_OSES.includes(os)) fail(`unsupported installer OS ${os}`);
  if (os === "macos") return verifyMacos(installerPath, run, expected);
  if (os === "windows") return verifyWindows(installerPath, run, expected);
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

function assertOptionalHttpsLocator(value, label) {
  // gh's JSON verification contract carries the verified bundle inline. The
  // auxiliary bundle_url locator can be empty, including for an attestation
  // that was uploaded to GitHub and Rekor, so it must not be a trust input.
  if (value === "") return value;
  return assertHttpsUrl(value, label);
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
  assertOptionalHttpsLocator(entry.attestation.bundle_url, "gh attestation report[0].attestation.bundle_url");
  // gh may omit the display-only initiator for GitHub Actions attestations.
  // Identity remains bound by the verified certificate and SLSA statement below.
  if (entry.attestation.initiator !== "") {
    assertSafeString(entry.attestation.initiator, "gh attestation report[0].attestation.initiator", { max: 256 });
  }

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

export function independentlyVerifyInstallerAttestation(installerArtifact, {
  appHead,
  repository,
  workflowRunId,
  workflowRunAttempt,
  run = runFixedProgram,
  token = process.env.GH_TOKEN,
}) {
  if (!token) fail("GH_TOKEN is required only for independent installer attestation verification");
  const result = run("gh", [
    "attestation", "verify", installerArtifact.path,
    "--repo", repository,
    "--source-digest", appHead,
    "--signer-workflow", "lvis-project/lvis-app/.github/workflows/a2a-p4-5-packaged-evidence.yml",
    "--predicate-type", SLSA_PROVENANCE_V1,
    "--deny-self-hosted-runners",
    "--format", "json",
  ], {
    env: { GH_TOKEN: token },
    label: "independent gh installer attestation verification",
    maxBuffer: 8 * 1024 * 1024,
  });
  const bytes = Buffer.from(result.stdout, "utf8");
  if (bytes.length === 0) fail("independent gh installer attestation verification returned no report");
  return verifyAttestationReport({ bytes, sha256: sha256Buffer(bytes) }, {
    installerSha256: installerArtifact.sha256,
    appHead,
    repository,
    workflowRunId,
    workflowRunAttempt,
  });
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
  assertExactKeys(value, ["schemaVersion", "generatedAt", "installer", "source", "workflow", "platformIdentity", "attestation", "locks", "tools"], label);
  if (value.schemaVersion !== 1) fail(`${label}.schemaVersion: expected 1`);
  assertSafeString(value.generatedAt, `${label}.generatedAt`, { pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u });
  assertExactKeys(value.installer, ["name", "size", "sha256"], `${label}.installer`);
  assertSafeString(value.installer.name, `${label}.installer.name`, { max: 512 });
  if (!Number.isSafeInteger(value.installer.size) || value.installer.size <= 0) fail(`${label}.installer.size: invalid`);
  assertSafeString(value.installer.sha256, `${label}.installer.sha256`, { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/u });
  assertExactKeys(value.source, ["repository", "appHead", "agentHubHead", "agentHubLockDigestSha256"], `${label}.source`);
  if (value.source.repository !== "lvis-project/lvis-app") fail(`${label}.source.repository: unexpected repository`);
  assertHeadSha(value.source.appHead, `${label}.source.appHead`);
  assertHeadSha(value.source.agentHubHead, `${label}.source.agentHubHead`);
  assertSha256(value.source.agentHubLockDigestSha256, `${label}.source.agentHubLockDigestSha256`);
  assertExactKeys(value.workflow, ["runId", "attempt"], `${label}.workflow`);
  if (!/^\d+$/u.test(value.workflow.runId) || !/^\d+$/u.test(value.workflow.attempt)) fail(`${label}.workflow: runId/attempt must be decimal strings`);
  assertPlatformIdentity(value.platformIdentity, `${label}.platformIdentity`);
  assertExactKeys(value.attestation, ["reportSha256", "subjectSha256", "sourceHead", "repository", "workflowRunId", "workflowRunAttempt"], `${label}.attestation`);
  if (value.attestation.subjectSha256 !== value.installer.sha256 || value.attestation.sourceHead !== value.source.appHead || value.attestation.repository !== value.source.repository || value.attestation.workflowRunId !== value.workflow.runId || value.attestation.workflowRunAttempt !== value.workflow.attempt) {
    fail(`${label}.attestation: source/subject bindings do not match provenance`);
  }
  for (const key of ["reportSha256", "subjectSha256"]) assertSafeString(value.attestation[key], `${label}.attestation.${key}`, { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/u });
  assertHeadSha(value.attestation.sourceHead, `${label}.attestation.sourceHead`);
  assertExactKeys(value.locks, ["packageJsonSha256", "bunLockSha256"], `${label}.locks`);
  for (const key of Object.keys(value.locks)) assertSafeString(value.locks[key], `${label}.locks.${key}`, { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/u });
  assertExactKeys(value.tools, ["node", "bun", "git", "gh", "identityVerifier"], `${label}.tools`);
  for (const [key, tool] of Object.entries(value.tools)) assertSafeString(tool, `${label}.tools.${key}`, { max: 512 });
  return value;
}

function assertPlatformIdentity(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}: expected object`);
  if (!SUPPORTED_INSTALLER_OSES.includes(value.platform)) fail(`${label}: expected supported platform`);
  if (value.platform === "macos") {
    assertExactKeys(value, ["platform", "status", "identityKind", "installerCodesignIdentity", "teamId", "certificateSha256", "installerSpctlAssessment", "appCodesignIdentity", "appSpctlAssessment", "verifier"], label);
    if (value.status !== "publisher-verified" || value.identityKind !== "native-signature") fail(`${label}: expected pinned macOS publisher identity`);
    for (const key of ["installerCodesignIdentity", "installerSpctlAssessment", "appCodesignIdentity", "appSpctlAssessment"]) assertSafeString(value[key], `${label}.${key}`, { max: 2048 });
    assertSafeString(value.teamId, `${label}.teamId`, { min: 10, max: 64, pattern: /^[0-9A-Z]+$/u });
    normalizeHexFingerprint(value.certificateSha256, `${label}.certificateSha256`);
  } else if (value.platform === "windows") {
    assertExactKeys(value, ["platform", "status", "identityKind", "subject", "thumbprint", "statusMessage", "verifier"], label);
    if (value.status !== "publisher-verified" || value.identityKind !== "native-signature") fail(`${label}: expected pinned Windows publisher identity`);
    assertSafeString(value.subject, `${label}.subject`, { max: 2048 });
    normalizeHexFingerprint(value.thumbprint, `${label}.thumbprint`, { lengths: [40, 64] });
    assertSafeString(value.statusMessage, `${label}.statusMessage`, { max: 2048 });
  } else {
    assertExactKeys(value, ["platform", "status", "identityKind", "format", "packageName", "version", "architecture", "verifier"], label);
    if (value.status !== "metadata-only" || value.identityKind !== "package-metadata") fail(`${label}: Linux evidence must be labeled non-cryptographic package metadata`);
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
