#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REGULAR_MODES = new Set(["100644", "100755"]);
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const ROOT_DOCKERIGNORE = ".dockerignore";
const GIT_METADATA_SEGMENT = ".git";
const MARKETPLACE_SDK_GITLINK = "vendor/lvis-plugin-sdk";
const TAR_BLOCK_SIZE = 512;

function fail(message) {
  throw new Error(`candidate tree sealing failed: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runGit(repo, args, options = {}) {
  const result = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "-C", repo, ...args],
    {
      encoding: options.encoding === undefined ? "utf8" : options.encoding,
      input: options.input,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr ?? "");
    fail(`git ${args.join(" ")} failed: ${detail.trim()}`);
  }
  return result.stdout;
}

function assertSafeRelativePath(candidate) {
  if (
    candidate.length === 0
    || isAbsolute(candidate)
    || candidate.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    fail(`unsafe tree path ${JSON.stringify(candidate)}`);
  }
  const segments = candidate.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0
        || segment === "."
        || segment === ".."
        || segment === GIT_METADATA_SEGMENT,
    )
  ) {
    fail(`unsafe tree path ${JSON.stringify(candidate)}`);
  }
}

export function parseTreeEntries(output) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
  const entries = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) fail("git ls-tree output is not NUL terminated");
    const record = bytes.subarray(offset, end);
    const tab = record.indexOf(9);
    if (tab < 0) fail("git ls-tree record has no path separator");
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^([0-9]{6}) (blob|commit|tree) ([0-9a-f]{40,64})$/u.exec(header);
    if (!match) fail(`invalid git ls-tree header ${JSON.stringify(header)}`);
    const path = record.subarray(tab + 1).toString("utf8");
    if (!Buffer.from(path, "utf8").equals(record.subarray(tab + 1))) {
      fail("git tree path is not valid UTF-8");
    }
    assertSafeRelativePath(path);
    entries.push({ mode: match[1], type: match[2], oid: match[3], path });
    offset = end + 1;
  }
  const sorted = [...entries].sort((a, b) =>
    Buffer.from(a.path).compare(Buffer.from(b.path)));
  if (sorted.some((entry, index) => index > 0 && entry.path === sorted[index - 1].path)) {
    fail("git ls-tree returned a duplicate path");
  }
  return sorted;
}

function readBlobs(repo, entries) {
  if (entries.length === 0) return [];
  const request = `${entries.map(({ oid }) => oid).join("\n")}\n`;
  const output = runGit(repo, ["cat-file", "--batch"], {
    encoding: null,
    input: request,
  });
  const blobs = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) fail(`missing cat-file header for ${entry.path}`);
    const header = output.subarray(offset, headerEnd).toString("ascii");
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/u.exec(header);
    if (!match || match[1] !== entry.oid) {
      fail(`unexpected cat-file header for ${entry.path}: ${header}`);
    }
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0) {
      fail(`invalid blob size for ${entry.path}`);
    }
    const start = headerEnd + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 10) {
      fail(`truncated cat-file blob for ${entry.path}`);
    }
    blobs.push(output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) fail("cat-file returned trailing output");
  return blobs;
}

function assertContained(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`path escapes sealed root: ${candidate}`);
  }
}

function ensureDirectory(root, relativePath) {
  const segments = relativePath === "" ? [] : relativePath.split("/");
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    assertContained(root, current);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`materialized parent is not a real directory: ${relativePath}`);
    }
    assertContained(root, realpathSync(current));
  }
}

function writeExclusiveRegularFile(root, entry, bytes) {
  ensureDirectory(root, dirname(entry.path) === "." ? "" : dirname(entry.path));
  const destination = resolve(root, entry.path);
  assertContained(root, destination);
  const mode = entry.mode === "100755" ? 0o755 : 0o644;
  const flags =
    constants.O_CREAT
    | constants.O_EXCL
    | constants.O_WRONLY
    | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(destination, flags, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
  } finally {
    closeSync(fd);
  }
  chmodSync(destination, mode);
  const stat = lstatSync(destination);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (stat.mode & 0o777) !== mode
    || stat.size !== bytes.length
  ) {
    fail(`materialized file invariant failed: ${entry.path}`);
  }
  assertContained(root, realpathSync(destination));
}

function writeTarOctal(header, offset, length, value) {
  const octal = value.toString(8);
  if (octal.length > length - 1) fail(`tar numeric field overflow: ${value}`);
  header.fill(0x30, offset, offset + length - 1);
  header.write(octal, offset + length - 1 - octal.length, "ascii");
  header[offset + length - 1] = 0;
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  let slash = path.lastIndexOf("/");
  while (slash > 0) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
    slash = path.lastIndexOf("/", slash - 1);
  }
  fail(`tree path is too long for deterministic ustar evidence: ${JSON.stringify(path)}`);
}

function tarHeader(path, mode, size) {
  const { name, prefix } = splitUstarPath(path);
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(name, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function createDeterministicTar(entries, blobs) {
  const chunks = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const bytes = blobs[index];
    chunks.push(tarHeader(entry.path, entry.mode === "100755" ? 0o755 : 0o644, bytes.length));
    chunks.push(bytes);
    const remainder = bytes.length % TAR_BLOCK_SIZE;
    if (remainder !== 0) chunks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function archiveFromMaterializedEntries(root, entries) {
  const blobs = entries.map((entry) => readFileSync(resolve(root, entry.path)));
  return createDeterministicTar(entries, blobs);
}

function writeExclusive(path, bytes, mode = 0o600) {
  ensureDirectory(dirname(path), "");
  const flags =
    constants.O_CREAT
    | constants.O_EXCL
    | constants.O_WRONLY
    | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(`output is not a single-link regular file: ${path}`);
  }
}

function listContextFiles(root, relativeRoot = "") {
  const directory = resolve(root, relativeRoot);
  const files = [];
  for (const dirent of readdirSync(directory, { withFileTypes: true })) {
    const path = relativeRoot === "" ? dirent.name : `${relativeRoot}/${dirent.name}`;
    assertSafeRelativePath(path);
    if (dirent.isSymbolicLink()) fail(`materialized context contains symlink: ${path}`);
    if (dirent.isDirectory()) {
      files.push(...listContextFiles(root, path));
    } else if (dirent.isFile()) {
      files.push(path);
    } else {
      fail(`materialized context contains special entry: ${path}`);
    }
  }
  return files.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

export function verifyMaterializedTree(contextPath, manifest) {
  const root = realpathSync(contextPath);
  const expected = manifest.entries.filter(({ mode }) => REGULAR_MODES.has(mode));
  const actualPaths = listContextFiles(root);
  const expectedPaths = expected.map(({ path }) => path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail("materialized context path set differs from sealed tree");
  }
  for (const entry of expected) {
    const file = resolve(root, entry.path);
    assertContained(root, file);
    const stat = lstatSync(file);
    const expectedMode = entry.mode === "100755" ? 0o755 : 0o644;
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || (stat.mode & 0o777) !== expectedMode
    ) {
      fail(`materialized file mode/link mismatch: ${entry.path}`);
    }
    assertContained(root, realpathSync(file));
    const bytes = readFileSync(file);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
      fail(`materialized file byte mismatch: ${entry.path}`);
    }
  }
}

export function materializeCandidateTree({
  name,
  repo,
  expectedCommit,
  contextPath,
  archivePath,
  manifestPath,
  evidencePath,
  allowedGitlinks = [],
}) {
  if (!/^[a-z][a-z0-9_-]*$/u.test(name)) fail(`invalid candidate name ${name}`);
  if (!SHA_PATTERN.test(expectedCommit)) fail("expected commit is not a full object ID");
  for (const binding of allowedGitlinks) {
    if (
      !binding
      || typeof binding !== "object"
      || typeof binding.path !== "string"
      || typeof binding.oid !== "string"
      || !SHA_PATTERN.test(binding.oid)
    ) {
      fail("allowed gitlink binding requires an exact path and full object ID");
    }
    assertSafeRelativePath(binding.path);
  }
  if (
    allowedGitlinks.length > 0
    && (
      name !== "marketplace"
      || allowedGitlinks.length !== 1
      || allowedGitlinks[0].path !== MARKETPLACE_SDK_GITLINK
    )
  ) {
    fail("only the Marketplace SDK gitlink may be allowed");
  }
  const allowed = new Map(allowedGitlinks.map((binding) => [binding.path, binding.oid]));
  const commit = String(runGit(repo, ["rev-parse", "HEAD"])).trim();
  const tree = String(runGit(repo, ["rev-parse", "HEAD^{tree}"])).trim();
  if (commit !== expectedCommit) fail(`${name} checkout is not expected commit`);
  if (!SHA_PATTERN.test(tree)) fail(`${name} tree ID is invalid`);

  const rawEntries = parseTreeEntries(
    runGit(repo, ["ls-tree", "-rz", "--full-tree", "-t", "HEAD"], { encoding: null }),
  );
  if (rawEntries.some(({ path }) => path === ROOT_DOCKERIGNORE)) {
    fail(`${name} root .dockerignore may filter the sealed BuildKit context`);
  }
  const regularEntries = [];
  const treePaths = new Set();
  for (const entry of rawEntries) {
    if (entry.mode === "040000" && entry.type === "tree") {
      treePaths.add(entry.path);
      continue;
    }
    if (REGULAR_MODES.has(entry.mode) && entry.type === "blob") {
      regularEntries.push(entry);
      continue;
    }
    if (entry.mode === "120000") {
      fail(`${name} symlink is forbidden: ${entry.path}`);
    }
    if (entry.mode === "160000" && entry.type === "commit" && allowed.has(entry.path)) {
      const expectedOid = allowed.get(entry.path);
      if (entry.oid !== expectedOid) {
        fail(
          `${name} gitlink ${entry.path} resolves ${entry.oid}, expected ${expectedOid}`,
        );
      }
      allowed.delete(entry.path);
      continue;
    }
    fail(`${name} unsupported tree mode ${entry.mode} at ${entry.path}`);
  }
  for (const entry of rawEntries) {
    if (entry.mode === "040000") continue;
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (!treePaths.has(ancestor)) {
        fail(`${name} tree ancestor is not an exact Git tree: ${ancestor}`);
      }
    }
  }
  if (allowed.size > 0) {
    fail(`${name} allowed gitlink is absent: ${[...allowed.keys()].join(", ")}`);
  }

  mkdirSync(contextPath, { mode: 0o700 });
  const contextRoot = realpathSync(contextPath);
  const blobs = readBlobs(repo, regularEntries);
  const manifestEntries = regularEntries.map((entry, index) => {
    const bytes = blobs[index];
    writeExclusiveRegularFile(contextRoot, entry, bytes);
    return { ...entry, size: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = {
    schemaVersion: 1,
    name,
    commit,
    tree,
    gitlinks: allowedGitlinks.map(({ path, oid }) => ({ path, oid })),
    entries: manifestEntries,
  };
  verifyMaterializedTree(contextRoot, manifest);

  const archive = createDeterministicTar(regularEntries, blobs);
  writeExclusive(archivePath, archive);
  const gitmodules = manifestEntries.find(({ path }) => path === ".gitmodules");
  const evidence = {
    key: name,
    value: {
      commit,
      tree,
      archiveSha256: sha256(archive),
      gitmodulesSha256: gitmodules?.sha256 ?? null,
    },
  };
  writeExclusive(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  writeExclusive(evidencePath, Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`));
  return { manifest, evidence };
}

export function overlayMaterializedTree({
  sourceContext,
  sourceManifest,
  destinationRoot,
  destinationManifest,
  destinationPath,
}) {
  assertSafeRelativePath(destinationPath);
  verifyMaterializedTree(sourceContext, sourceManifest);
  verifyMaterializedTree(destinationRoot, destinationManifest);
  const gitlink = destinationManifest.gitlinks?.find(
    ({ path }) => path === destinationPath,
  );
  if (
    !gitlink
    || gitlink.oid !== sourceManifest.commit
    || destinationManifest.gitlinks.length !== 1
  ) {
    fail("SDK overlay is not bound to the exact Marketplace gitlink commit");
  }
  const sourceRoot = realpathSync(sourceContext);
  const destinationRootReal = realpathSync(destinationRoot);
  const parentRelative = dirname(destinationPath) === "." ? "" : dirname(destinationPath);
  ensureDirectory(destinationRootReal, parentRelative);
  const parent = resolve(destinationRootReal, parentRelative);
  assertContained(destinationRootReal, realpathSync(parent));
  const destination = resolve(destinationRootReal, destinationPath);
  assertContained(destinationRootReal, destination);
  if (existsSync(destination)) fail(`overlay destination already exists: ${destinationPath}`);
  mkdirSync(destination, { mode: 0o700 });
  assertContained(destinationRootReal, realpathSync(destination));

  for (const entry of sourceManifest.entries) {
    const source = resolve(sourceRoot, entry.path);
    const target = resolve(destination, entry.path);
    assertContained(sourceRoot, source);
    assertContained(destinationRootReal, target);
    const sourceStat = lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
      fail(`overlay source is not a single-link regular file: ${entry.path}`);
    }
    ensureDirectory(destination, dirname(entry.path) === "." ? "" : dirname(entry.path));
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    chmodSync(target, entry.mode === "100755" ? 0o755 : 0o644);
  }
  verifyMaterializedTree(destination, sourceManifest);
  const compositeEntries = [
    ...destinationManifest.entries,
    ...sourceManifest.entries.map((entry) => ({
      ...entry,
      path: `${destinationPath}/${entry.path}`,
    })),
  ].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const compositeManifest = {
    schemaVersion: 1,
    name: "marketplace-image-input",
    entries: compositeEntries,
  };
  verifyMaterializedTree(destinationRootReal, compositeManifest);
  return {
    schemaVersion: 1,
    targetPath: destinationPath,
    gitlinkOid: gitlink.oid,
    sdkTree: sourceManifest.tree,
    sdkArchiveSha256: sha256(
      archiveFromMaterializedEntries(sourceRoot, sourceManifest.entries),
    ),
    imageInputArchiveSha256: sha256(
      archiveFromMaterializedEntries(destinationRootReal, compositeEntries),
    ),
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("invalid CLI arguments");
    const normalized = key.slice(2);
    const existing = values.get(normalized);
    values.set(normalized, existing ? [...existing, value] : [value]);
  }
  const one = (key) => {
    const found = values.get(key);
    if (!found || found.length !== 1) fail(`expected exactly one --${key}`);
    return found[0];
  };
  return { command, values, one };
}

function main(argv) {
  const { command, values, one } = parseArgs(argv);
  if (command === "materialize") {
    materializeCandidateTree({
      name: one("name"),
      repo: one("repo"),
      expectedCommit: one("expected"),
      contextPath: one("context"),
      archivePath: one("archive"),
      manifestPath: one("manifest"),
      evidencePath: one("evidence"),
      allowedGitlinks: (values.get("allow-gitlink") ?? []).map((binding) => {
        const separator = binding.lastIndexOf("=");
        if (separator <= 0 || separator === binding.length - 1) {
          fail("--allow-gitlink must be PATH=FULL_OBJECT_ID");
        }
        return {
          path: binding.slice(0, separator),
          oid: binding.slice(separator + 1),
        };
      }),
    });
    return;
  }
  if (command === "overlay") {
    const evidence = overlayMaterializedTree({
      sourceContext: one("source-context"),
      sourceManifest: JSON.parse(readFileSync(one("source-manifest"), "utf8")),
      destinationRoot: one("destination-root"),
      destinationManifest: JSON.parse(
        readFileSync(one("destination-manifest"), "utf8"),
      ),
      destinationPath: one("destination"),
    });
    writeExclusive(
      one("evidence"),
      Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
    );
    return;
  }
  fail(`unsupported command ${JSON.stringify(command)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
