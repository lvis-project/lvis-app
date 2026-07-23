import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  readdir,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const [manifestPath, expectedControlSha] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.schemaVersion !== 1
  || manifest.controlSha !== expectedControlSha
  || !/^[0-9a-f]{40}$/.test(expectedControlSha ?? "")
  || !Array.isArray(manifest.files)
) {
  throw new Error("trusted harness manifest binding is invalid");
}

const expected = new Map();
for (const file of manifest.files) {
  if (
    typeof file.destination !== "string"
    || (!file.destination.startsWith("/candidate/app/test/e2e/")
      && !file.destination.startsWith("/candidate/app/src/shared/")
      && !file.destination.startsWith("/trusted/control/")
      && !file.destination.startsWith("/trusted/runner/"))
    || !/^[0-9a-f]{64}$/.test(file.sha256 ?? "")
    || !Number.isSafeInteger(file.size)
    || file.size < 0
    || expected.has(file.destination)
  ) {
    throw new Error("trusted harness manifest contains an invalid entry");
  }
  expected.set(file.destination, file);
}

async function walk(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`trusted harness has a special or symlink entry: ${path}`);
    }
    if (stat.isDirectory()) found.push(...await walk(path));
    else found.push(path);
  }
  return found;
}

const actual = [
  ...await walk("/candidate/app/test/e2e"),
  ...await walk("/trusted/control"),
  ...[...expected.keys()].filter((path) => path.startsWith("/candidate/app/src/shared/")),
  ...[...expected.keys()].filter((path) => path.startsWith("/trusted/runner/")),
].filter((path) => path !== manifestPath);
if (actual.length !== expected.size) {
  throw new Error(`trusted harness file count differs: actual=${actual.length} expected=${expected.size}`);
}
for (const path of actual) {
  const record = expected.get(path);
  if (!record) throw new Error(`unexpected trusted harness file ${path}`);
  const stat = await lstat(path);
  const resolved = await realpath(path);
  const allowedRoot = path.startsWith("/candidate/app/test/e2e/")
    ? "/candidate/app/test/e2e"
    : path.startsWith("/candidate/app/src/shared/")
      ? "/candidate/app/src/shared"
    : path.startsWith("/trusted/runner/")
      ? "/trusted/runner"
      : "/trusted/control";
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || resolved !== path
    || (dirname(resolved) !== allowedRoot && !dirname(resolved).startsWith(`${allowedRoot}${sep}`))
    || stat.size !== record.size
  ) {
    throw new Error(`trusted harness file metadata differs: ${path}`);
  }
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (digest !== record.sha256) throw new Error(`trusted harness digest differs: ${path}`);
}

for (const shadow of [
  "/candidate/app/src/shared/llm-vendor-defaults.js",
  "/candidate/app/src/shared/theme-bundles.js",
]) {
  try {
    await lstat(shadow);
    throw new Error(`candidate JavaScript shadows trusted shared source: ${shadow}`);
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("candidate JavaScript shadows")
    ) {
      throw error;
    }
    if (error?.code !== "ENOENT") throw error;
  }
}
