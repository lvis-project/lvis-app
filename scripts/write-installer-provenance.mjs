#!/usr/bin/env node

import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSync, lstatSync, openSync, realpathSync, writeFileSync } from "node:fs";

import {
  assertHeadSha,
  assertSafeString,
  fail,
  readRegularFile,
  sha256Buffer,
} from "./a2a-p4-5-live/evidence-lib.mjs";
import {
  collectFixedToolVersions,
  runFixedProgram,
  validateProvenance,
  verifyAttestationReport,
  verifyInstallerIdentity,
} from "./a2a-p4-5-live/installer-provenance-lib.mjs";

const REQUIRED_OPTIONS = Object.freeze([
  "installer",
  "os",
  "app-head",
  "hub-head",
  "workflow-run-id",
  "workflow-run-attempt",
  "repository",
  "attestation",
  "output",
]);

function parseArguments(args) {
  if (args.length !== REQUIRED_OPTIONS.length * 2) fail(`expected exactly ${REQUIRED_OPTIONS.length} named options`);
  const values = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith("--") || value === undefined || value.startsWith("--")) fail(`invalid argument pair at position ${index + 1}`);
    const key = option.slice(2);
    if (!REQUIRED_OPTIONS.includes(key)) fail(`unknown option --${key}`);
    if (Object.hasOwn(values, key)) fail(`duplicate option --${key}`);
    values[key] = value;
  }
  for (const key of REQUIRED_OPTIONS) {
    if (!Object.hasOwn(values, key)) fail(`missing option --${key}`);
  }
  return values;
}

function readLock(path, label) {
  return readRegularFile(path, label, { maxBytes: 16 * 1024 * 1024 });
}

function writeExclusiveJson(path, value) {
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail("output parent must be a regular directory");
  if (realpathSync(parent) !== resolve(parent)) fail("output parent path must be canonical");
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function createInstallerProvenance(options, { run = runFixedProgram, cwd = process.cwd() } = {}) {
  assertHeadSha(options["app-head"], "--app-head");
  assertHeadSha(options["hub-head"], "--hub-head");
  if (options.repository !== "lvis-project/lvis-app") fail("--repository must be lvis-project/lvis-app");
  if (!/^\d+$/u.test(options["workflow-run-id"]) || !/^\d+$/u.test(options["workflow-run-attempt"])) {
    fail("workflow run id and attempt must be decimal strings");
  }
  const checkoutHead = run("git", ["rev-parse", "HEAD"], { label: "checkout HEAD" }).stdout;
  if (checkoutHead !== options["app-head"]) fail(`checkout HEAD ${checkoutHead} does not equal requested app head`);

  const installer = readRegularFile(resolve(options.installer), "installer", { maxBytes: 4 * 1024 * 1024 * 1024 });
  const attestationReport = readRegularFile(resolve(options.attestation), "gh attestation report", { maxBytes: 8 * 1024 * 1024 });
  const packageJson = readLock(resolve(cwd, "package.json"), "package.json lock");
  const bunLock = readLock(resolve(cwd, "bun.lock"), "bun.lock lock");
  const signature = verifyInstallerIdentity(options.os, installer.path, run);
  const attestation = verifyAttestationReport(attestationReport, {
    installerSha256: installer.sha256,
    appHead: options["app-head"],
    repository: options.repository,
    workflowRunId: options["workflow-run-id"],
    workflowRunAttempt: options["workflow-run-attempt"],
  });
  const tools = collectFixedToolVersions(run);
  tools.signatureVerifier = signature.verifier;

  return validateProvenance({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    installer: {
      name: assertSafeString(basename(installer.path), "installer name", { max: 512 }),
      size: installer.size,
      sha256: installer.sha256,
    },
    source: {
      repository: options.repository,
      appHead: options["app-head"],
      agentHubHead: options["hub-head"],
    },
    workflow: {
      runId: options["workflow-run-id"],
      attempt: options["workflow-run-attempt"],
    },
    signature,
    attestation,
    locks: {
      packageJsonSha256: packageJson.sha256,
      bunLockSha256: bunLock.sha256,
    },
    tools,
  });
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const provenance = createInstallerProvenance(options);
  const output = resolve(options.output);
  if (!output.endsWith(".provenance.json")) fail("--output must end with .provenance.json");
  writeExclusiveJson(output, provenance);
  const bytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  process.stdout.write(`${output} sha256=${sha256Buffer(bytes)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
