import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  readdir,
  writeFile,
} from "node:fs/promises";
import { resolve, sep } from "node:path";
import process from "node:process";

const [rootArg, exportRootArg] = process.argv.slice(2);
if (!rootArg || !exportRootArg) throw new Error("evidence and export roots are required");
const root = resolve(rootArg);
const exportRoot = resolve(exportRootArg);
if (await realpath(root) !== root) throw new Error("evidence root must not traverse a symlink");
const rootStat = await lstat(root);
if (
  !rootStat.isDirectory()
  || rootStat.isSymbolicLink()
  || rootStat.uid !== process.getuid?.()
  || (rootStat.mode & 0o777) !== 0o700
) {
  throw new Error("evidence root must be runner-owned mode-0700");
}

const exactSha = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const imageId = /^sha256:[0-9a-f]{64}$/;
const semver = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const required = new Set([
  "input-bindings.json",
  "control-harness-manifest.json",
  "image-digests.json",
  "input-contract.json",
  "host-attestation.json",
  "hostile-containment.json",
  "container-exits.json",
]);
const perFileLimit = 2 * 1024 * 1024;
const totalLimit = 5 * 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (
    !isObject(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

async function validateFiles() {
  const names = await readdir(root);
  if (names.length !== required.size || names.some((name) => !required.has(name))) {
    throw new Error(`evidence directory contains missing or unknown files: ${names.join(",")}`);
  }
  let total = 0;
  for (const name of names) {
    const path = resolve(root, name);
    if (!path.startsWith(`${root}${sep}`)) throw new Error("evidence path escaped its root");
    const stat = await lstat(path);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o600
      || stat.size <= 0
      || stat.size > perFileLimit
      || await realpath(path) !== path
    ) {
      throw new Error(`unsafe evidence file metadata: ${name}`);
    }
    total += stat.size;
  }
  if (total > totalLimit) throw new Error("evidence directory exceeds its size budget");
}
await validateFiles();

const readJson = async (name) => JSON.parse(await readFile(resolve(root, name), "utf8"));
const [
  bindings,
  harness,
  images,
  inputContract,
  hostAttestation,
  hostile,
  exits,
] = await Promise.all([
  readJson("input-bindings.json"),
  readJson("control-harness-manifest.json"),
  readJson("image-digests.json"),
  readJson("input-contract.json"),
  readJson("host-attestation.json"),
  readJson("hostile-containment.json"),
  readJson("container-exits.json"),
]);

exactKeys(bindings, [
  "schemaVersion",
  "repository",
  "runId",
  "runAttempt",
  "controlSha",
  "workflowRef",
  "sdkVersion",
  "sdkSchemaSha256",
  "inputs",
], "sealed input binding");
if (
  bindings.schemaVersion !== 1
  || bindings.repository !== "lvis-project/lvis-app"
  || bindings.runId !== process.env.GITHUB_RUN_ID
  || bindings.runAttempt !== process.env.GITHUB_RUN_ATTEMPT
  || !/^[1-9][0-9]*$/.test(bindings.runId ?? "")
  || !/^[1-9][0-9]*$/.test(bindings.runAttempt ?? "")
  || bindings.controlSha !== process.env.CONTROL_SHA
  || bindings.workflowRef !== process.env.GITHUB_WORKFLOW_REF
  || !exactSha.test(bindings.controlSha ?? "")
  || !semver.test(bindings.sdkVersion ?? "")
) {
  throw new Error("sealed input replay binding is invalid");
}
exactKeys(bindings.inputs, ["host", "marketplace", "sdk", "ep"], "sealed inputs");
for (const name of ["host", "marketplace", "sdk", "ep"]) {
  const input = bindings.inputs[name];
  exactKeys(
    input,
    ["commit", "tree", "archiveSha256", "gitmodulesSha256"],
    `sealed ${name} input`,
  );
  if (
    !exactSha.test(input.commit ?? "")
    || !exactSha.test(input.tree ?? "")
    || !sha256.test(input.archiveSha256 ?? "")
    || (input.gitmodulesSha256 !== null && !sha256.test(input.gitmodulesSha256 ?? ""))
  ) {
    throw new Error(`invalid sealed input binding for ${name}`);
  }
}
if (!sha256.test(bindings.sdkSchemaSha256 ?? "")) {
  throw new Error("sealed SDK schema binding is invalid");
}

exactKeys(harness, ["schemaVersion", "controlSha", "files"], "trusted harness manifest");
if (
  harness.schemaVersion !== 1
  || harness.controlSha !== bindings.controlSha
  || !Array.isArray(harness.files)
  || harness.files.length < 8
) {
  throw new Error("trusted harness binding is invalid");
}
for (const file of harness.files) {
  exactKeys(file, ["source", "destination", "gitMode", "size", "sha256"], "harness file");
  if (
    typeof file.source !== "string"
    || !/^[a-zA-Z0-9._/-]+$/.test(file.source)
    || typeof file.destination !== "string"
    || (!file.destination.startsWith("/candidate/app/test/e2e/")
      && !file.destination.startsWith("/candidate/app/src/shared/")
      && !file.destination.startsWith("/trusted/control/")
      && !file.destination.startsWith("/trusted/runner/"))
    || !["100644", "100755"].includes(file.gitMode)
    || !sha256.test(file.sha256 ?? "")
    || !Number.isSafeInteger(file.size)
    || file.size < 0
  ) {
    throw new Error("trusted harness manifest entry is invalid");
  }
}

exactKeys(images, ["marketplace", "ep", "host"], "image digests");
for (const name of ["marketplace", "ep", "host"]) {
  if (!imageId.test(images[name] ?? "")) throw new Error(`invalid ${name} image digest`);
}

exactKeys(
  inputContract,
  ["refs", "sdkDependency", "sdkLockPrefix", "schemaSha256"],
  "input contract",
);
exactKeys(inputContract.refs, ["host", "marketplace", "sdk", "epApi"], "input refs");
if (
  inputContract.refs.host !== bindings.inputs.host.commit
  || inputContract.refs.marketplace !== bindings.inputs.marketplace.commit
  || inputContract.refs.sdk !== bindings.inputs.sdk.commit
  || inputContract.refs.epApi !== bindings.inputs.ep.commit
  || inputContract.schemaSha256 !== bindings.sdkSchemaSha256
  || inputContract.sdkDependency
    !== `github:lvis-project/lvis-plugin-sdk#${bindings.inputs.sdk.commit}`
  || !/^[0-9a-f]{7,40}$/.test(inputContract.sdkLockPrefix ?? "")
  || !bindings.inputs.sdk.commit.startsWith(inputContract.sdkLockPrefix)
) {
  throw new Error("input contract does not match the sealed inputs");
}

exactKeys(
  hostAttestation,
  ["schemaVersion", "refs", "images", "hostExit", "phases"],
  "Host attestation",
);
exactKeys(
  hostAttestation.refs,
  ["host", "marketplace", "sdk", "epApi", "control"],
  "Host attestation refs",
);
exactKeys(hostAttestation.images, ["host", "marketplace"], "Host attestation images");
exactKeys(
  hostAttestation.phases,
  [
    "harnessIntegrity",
    "trustedDependencyClosure",
    "marketplaceTransport",
    "marketplaceLifecycle",
    "attendanceReadWriteReadback",
    "reverseContainment",
  ],
  "Host attestation phases",
);
if (
  hostAttestation.schemaVersion !== 1
  || hostAttestation.refs.host !== bindings.inputs.host.commit
  || hostAttestation.refs.marketplace !== bindings.inputs.marketplace.commit
  || hostAttestation.refs.sdk !== bindings.inputs.sdk.commit
  || hostAttestation.refs.epApi !== bindings.inputs.ep.commit
  || hostAttestation.refs.control !== bindings.controlSha
  || hostAttestation.images.host !== images.host
  || hostAttestation.images.marketplace !== images.marketplace
  || hostAttestation.hostExit !== 0
  || Object.values(hostAttestation.phases).some((value) => value !== true)
) {
  throw new Error("Host attestation does not match trusted exit facts");
}

exactKeys(
  hostile,
  [
    "uid",
    "effectiveCapabilities",
    "rootReadOnly",
    "dockerSocketVisible",
    "siblingSourcesVisible",
    "sensitiveEnvironmentAbsent",
    "passwordlessSudoDenied",
    "trustedControlWriteBlocked",
    "siblingWriteBlocked",
    "hostMarkerWriteBlocked",
    "sealedInputMutationBlocked",
    "internalMarketplaceReachable",
    "externalDnsBlocked",
    "externalEgressBlocked",
  ],
  "hostile containment",
);
if (
  hostile.uid !== 10002
  || hostile.effectiveCapabilities !== "0"
  || hostile.rootReadOnly !== true
  || hostile.dockerSocketVisible !== false
  || hostile.siblingSourcesVisible !== false
  || hostile.sensitiveEnvironmentAbsent !== true
  || hostile.passwordlessSudoDenied !== true
  || hostile.trustedControlWriteBlocked !== true
  || hostile.siblingWriteBlocked !== true
  || hostile.hostMarkerWriteBlocked !== true
  || hostile.sealedInputMutationBlocked !== true
  || hostile.internalMarketplaceReachable !== true
  || hostile.externalDnsBlocked !== true
  || hostile.externalEgressBlocked !== true
) {
  throw new Error("hostile containment rehearsal did not prove isolation");
}

exactKeys(
  exits,
  ["host", "marketplace", "hostile", "hostImage", "marketplaceImage"],
  "container exits",
);
if (
  exits.host !== 0
  || exits.marketplace !== 0
  || exits.hostile !== 0
  || exits.hostImage !== images.host
  || exits.marketplaceImage !== images.marketplace
) {
  throw new Error("container exit or image replay binding is invalid");
}

if (await realpath(exportRoot) !== exportRoot) {
  throw new Error("export root must not traverse a symlink");
}
const exportStat = await lstat(exportRoot);
if (
  !exportStat.isDirectory()
  || exportStat.isSymbolicLink()
  || exportStat.uid !== process.getuid?.()
  || (exportStat.mode & 0o777) !== 0o700
  || (await readdir(exportRoot)).length !== 0
) {
  throw new Error("export root must be an empty runner-owned mode-0700 directory");
}

const digest = async (name) =>
  createHash("sha256").update(await readFile(resolve(root, name))).digest("hex");
const summary = {
  schemaVersion: 1,
  ok: true,
  runId: bindings.runId,
  runAttempt: bindings.runAttempt,
  controlSha: bindings.controlSha,
  refs: {
    host: bindings.inputs.host.commit,
    marketplace: bindings.inputs.marketplace.commit,
    sdk: bindings.inputs.sdk.commit,
    epApi: bindings.inputs.ep.commit,
  },
  checks: {
    harnessIntegrityVerified: true,
    trustedDependencyClosureVerified: true,
    marketplaceTransportVerified: true,
    marketplaceLifecycleVerified: true,
    attendanceReadWriteReadbackVerified: true,
    reverseContainmentVerified: true,
    hostileIsolationVerified: true,
    externalDnsBlocked: true,
    containerExitsVerified: true,
  },
  digests: {
    inputBindings: await digest("input-bindings.json"),
    harnessManifest: await digest("control-harness-manifest.json"),
    imageDigests: await digest("image-digests.json"),
    inputContract: await digest("input-contract.json"),
    hostAttestation: await digest("host-attestation.json"),
    hostileContainment: await digest("hostile-containment.json"),
    containerExits: await digest("container-exits.json"),
  },
};
const summaryPath = resolve(exportRoot, "validated-summary.json");
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
const exportedNames = await readdir(exportRoot);
const summaryStat = await lstat(summaryPath);
if (
  exportedNames.length !== 1
  || exportedNames[0] !== "validated-summary.json"
  || !summaryStat.isFile()
  || summaryStat.isSymbolicLink()
  || summaryStat.nlink !== 1
  || summaryStat.uid !== process.getuid?.()
  || (summaryStat.mode & 0o777) !== 0o600
  || await realpath(summaryPath) !== summaryPath
) {
  throw new Error("sanitized summary export is unsafe");
}
process.stdout.write("trusted evidence validation: ok\n");
