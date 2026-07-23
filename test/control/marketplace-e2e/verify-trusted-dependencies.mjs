import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  lstat,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [descriptorPath, harnessPath, expectedControlSha] = process.argv.slice(2);
if (
  !descriptorPath
  || !harnessPath
  || !/^[0-9a-f]{40}$/.test(expectedControlSha ?? "")
) {
  throw new Error(
    "usage: verify-trusted-dependencies.mjs DESCRIPTOR HARNESS CONTROL_SHA",
  );
}

const [descriptor, harness, runnerPackage] = await Promise.all([
  readFile(descriptorPath, "utf8").then(JSON.parse),
  readFile(harnessPath, "utf8").then(JSON.parse),
  readFile("/trusted/runner/package.json", "utf8").then(JSON.parse),
]);
if (
  descriptor.schemaVersion !== 1
  || !Array.isArray(descriptor.packages)
  || harness.schemaVersion !== 1
  || harness.controlSha !== expectedControlSha
  || !Array.isArray(harness.files)
) {
  throw new Error("trusted dependency descriptor is not bound to the control SHA");
}

const boundDestinations = new Set(harness.files.map(({ destination }) => destination));
for (const destination of [
  "/trusted/control/trusted-dependencies.json",
  "/trusted/control/verify-trusted-dependencies.mjs",
  "/trusted/runner/package.json",
  "/trusted/runner/bun.lock",
]) {
  if (!boundDestinations.has(destination)) {
    throw new Error(`trusted dependency input is absent from the harness binding: ${destination}`);
  }
}

const expectedDependencies = runnerPackage.dependencies;
if (
  !expectedDependencies
  || typeof expectedDependencies !== "object"
  || Array.isArray(expectedDependencies)
) {
  throw new Error("trusted runner package has no exact dependency map");
}
const descriptorNames = descriptor.packages.map(({ name }) => name).sort();
if (
  new Set(descriptorNames).size !== descriptorNames.length
  || JSON.stringify(descriptorNames) !== JSON.stringify(Object.keys(expectedDependencies).sort())
) {
  throw new Error("trusted dependency descriptor differs from runner-package.json");
}

const candidateTest = "/candidate/app/test/e2e/ui/seeded-electron.ts";
const requireFromTrustedTest = createRequire(pathToFileURL(candidateTest));
const runnerModulesRoot = "/trusted/runner/node_modules";
for (const entry of descriptor.packages) {
  if (
    typeof entry.name !== "string"
    || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(entry.name)
    || typeof entry.version !== "string"
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.version)
    || !/^[0-9a-f]{64}$/.test(entry.packageJsonSha256 ?? "")
    || expectedDependencies[entry.name] !== entry.version
  ) {
    throw new Error("trusted dependency descriptor entry is invalid");
  }

  const candidatePackageRoot = resolve(
    "/candidate/app/node_modules",
    ...entry.name.split("/"),
  );
  const runnerPackageRoot = resolve(runnerModulesRoot, ...entry.name.split("/"));
  const linkStat = await lstat(candidatePackageRoot);
  if (!linkStat.isSymbolicLink() || await realpath(candidatePackageRoot) !== runnerPackageRoot) {
    throw new Error(`candidate test dependency is not a runner symlink: ${entry.name}`);
  }

  const manifestPath = resolve(candidatePackageRoot, "package.json");
  const resolvedManifest = await realpath(manifestPath);
  const expectedManifest = resolve(runnerPackageRoot, "package.json");
  if (resolvedManifest !== expectedManifest) {
    throw new Error(`trusted dependency manifest escaped runner root: ${entry.name}`);
  }
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  if (
    manifest.name !== entry.name
    || manifest.version !== entry.version
    || manifestHash !== entry.packageJsonSha256
  ) {
    throw new Error(`trusted dependency manifest differs: ${entry.name}`);
  }

  const resolvedEntry = await realpath(requireFromTrustedTest.resolve(entry.name));
  if (
    dirname(resolvedEntry) !== runnerPackageRoot
    && !dirname(resolvedEntry).startsWith(`${runnerPackageRoot}${sep}`)
  ) {
    throw new Error(`trusted test resolves candidate dependency bytes: ${entry.name}`);
  }
}

process.stdout.write("trusted dependency closure: ok\n");
