#!/usr/bin/env node
/**
 * check-generated-assets.mjs — #1974 guard
 *
 * `scripts/generate-lvis-icons.cjs` writes the installer and tray branding
 * assets on every `bun run build`. Some of those outputs are tracked, because
 * the signing job packages the installer from a plain checkout without running
 * repository scripts and therefore needs the icon bytes present in the tree.
 *
 * A tracked generated file is only safe while the committed bytes equal what
 * the generator produces. When they diverge, every build dirties the worktree,
 * the difference rides into whatever pull request is open at the time, and the
 * diff reads as `Bin 20331 -> 20477 bytes` — branding changing as a silent
 * passenger on an unrelated change. That is what this guard exists to stop:
 * it turns the divergence into a loud, immediate build failure at the moment
 * it is introduced, instead of a slow oscillation across pull requests.
 *
 * The generator is the authority on which paths it writes; it records them in
 * `build/generated-assets.json` and this guard reads that manifest rather than
 * keeping a second copy of the list. Of those paths, only the tracked ones are
 * checked — ignored outputs cannot diverge from a committed state because they
 * have none.
 *
 * Run standalone with `node scripts/check-generated-assets.mjs`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

const rootArgIndex = process.argv.indexOf("--root");
const ROOT = rootArgIndex >= 0
  ? resolve(process.argv[rootArgIndex + 1] ?? "")
  : process.cwd();

const MANIFEST = "build/generated-assets.json";
const LABEL = "[generated-assets]";

// Git exports these to the hooks it runs, and they outrank `-C`: a hook that
// invokes `bun run build` would otherwise have this guard report on whichever
// repository git was busy with instead of the one it was pointed at. The
// pre-push hook runs `bun run build`, so that is the normal case, not a corner.
// Dropping them makes ROOT the only thing that selects a repository.
const AMBIENT_GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
];

const GIT_ENV = { ...process.env };
for (const name of AMBIENT_GIT_VARS) delete GIT_ENV[name];

/** `git -C` rather than a child `cwd`: the repository is named explicitly, and
 *  no child ever holds the directory open as its working directory. */
function git(args) {
  return spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf-8", env: GIT_ENV });
}

/** The same call for a binary blob: text decoding would corrupt image bytes. */
function gitBytes(args) {
  return spawnSync("git", ["-C", ROOT, ...args], { env: GIT_ENV });
}

function fail(message) {
  console.error(`${LABEL} FAIL — ${message}`);
  process.exit(1);
}

/** Split NUL-delimited `git ... -z` output into non-empty entries. */
function zSplit(stdout) {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/**
 * The decoded image a PNG carries: its header plus the inflated pixel stream.
 *
 * Everything the deflate encoder is free to choose — block splitting, match
 * lengths, the trailing checksum's stream position — is dropped, so two PNGs
 * that draw the same picture normalize to the same bytes no matter which zlib
 * produced them. Returns null for anything that is not a PNG, which is how a
 * non-image asset falls back to the plain byte comparison.
 */
function normalizedPng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || signature.some((byte, i) => bytes[i] !== byte)) return null;
  const parts = [];
  const pixels = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) return null;
    if (type === "IDAT") pixels.push(body);
    else parts.push(Buffer.from(type, "ascii"), body);
    offset += 12 + length;
  }
  if (pixels.length === 0) return null;
  try {
    return Buffer.concat([...parts, inflateSync(Buffer.concat(pixels))]);
  } catch {
    return null;
  }
}

/**
 * The decoded images an ICO carries, in directory order.
 *
 * Each directory entry's byte offset and length are dropped for the same
 * reason the deflate stream is: they move when an image re-compresses to a
 * different size, without the icon depicting anything different.
 */
function normalizedIco(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  const count = bytes.readUInt16LE(4);
  if (count === 0 || bytes.length < 6 + count * 16) return null;
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    // Width/height/colours/planes/bpp describe the image; offset and size
    // describe where the encoder happened to put it.
    parts.push(bytes.subarray(entry, entry + 8));
    const size = bytes.readUInt32LE(entry + 8);
    const at = bytes.readUInt32LE(entry + 12);
    const image = bytes.subarray(at, at + size);
    if (image.length !== size) return null;
    const decoded = normalizedPng(image);
    if (decoded === null) return null;
    parts.push(decoded);
  }
  return Buffer.concat(parts);
}

/** Normalize an asset to what it depicts, or null when it is not an image. */
function normalizedImage(bytes) {
  return normalizedIco(bytes) ?? normalizedPng(bytes);
}

/**
 * Whether a byte-level divergence is only the image encoder's freedom.
 *
 * The guard's premise is that a tracked generated asset still equals what the
 * generator produces. Compressed bytes overstate that: `deflate` output depends
 * on the zlib the generator's runtime was linked against, so two checkouts on
 * the same platform running different Node versions produce different bytes for
 * pixel-identical icons. Reporting that as a divergence blocks a push over a
 * difference no consumer can observe — and the remedy the message suggests,
 * committing the regenerated bytes, only moves the failure to the next machine.
 * A real change to what the icon draws still fails, because the pixels differ.
 */
function encodingOnlyDivergence(path) {
  const committed = gitBytes(["cat-file", "blob", `HEAD:${path}`]);
  if (committed.status !== 0) return false;
  let worktree;
  try {
    worktree = readFileSync(join(ROOT, path));
  } catch {
    return false;
  }
  const before = normalizedImage(committed.stdout);
  const after = normalizedImage(worktree);
  return before !== null && after !== null && before.equals(after);
}

// The icon encoder does not produce identical bytes on every platform, so the
// committed blobs can only ever match the one they were generated on. Checking
// elsewhere asks a question the committed state cannot answer: it reports a
// divergence that is real but not a defect, and it blocked a release build on
// macOS the first time a tag ran through it.
//
// `encodingOnlyDivergence` below now answers that question for images by
// comparing what they depict instead of how they compressed, which is what the
// encoder difference was always about — and the difference turned out not to be
// a platform boundary at all: two Windows checkouts on different Node versions
// deflate the same pixels into different bytes. The platform skip stays anyway,
// because the committed blobs have only ever been validated against a win32
// generator run, and widening where the guard reports is not this guard's call.
//
// Windows is the canonical platform because that is where the installer icons
// are consumed — `installerIcon`/`installerHeaderIcon` are NSIS inputs. A
// divergence introduced anywhere still fails there, which is the platform that
// matters, and the pre-push hook on a Windows checkout catches it before it
// can reach a tag.
// `LVIS_GENERATED_ASSETS_FORCE` exists so the guard's own tests exercise the
// comparison on any platform — they build throwaway repositories whose bytes
// they control, so the encoder difference does not apply to them. It is not a
// production escape hatch: nothing in `build` or the hooks sets it.
const CANONICAL_PLATFORM = "win32";
const forced = process.env.LVIS_GENERATED_ASSETS_FORCE === "1";
if (!forced && process.platform !== CANONICAL_PLATFORM) {
  console.log(
    `${LABEL} SKIP — committed bytes are ${CANONICAL_PLATFORM}-generated; ` +
      `${process.platform} output differs by encoder, not by defect`,
  );
  process.exit(0);
}

const insideWorkTree = git(["rev-parse", "--is-inside-work-tree"]);
if (insideWorkTree.status !== 0 || insideWorkTree.stdout.trim() !== "true") {
  // Not a checkout — an unpacked source archive, or git is unavailable. There
  // is no committed state here for the generated bytes to disagree with, so
  // the question this guard asks does not exist rather than being answered
  // permissively. Every path that can commit bytes runs inside a checkout.
  console.log(`${LABEL} SKIP — not a git work tree`);
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf-8"));
} catch (err) {
  fail(
    `cannot read ${MANIFEST} (${err.message}); run \`bun run build:icons\` before this check`,
  );
}
if (!Array.isArray(manifest) || manifest.some((entry) => typeof entry !== "string")) {
  fail(`${MANIFEST} is not a list of paths`);
}
if (manifest.length === 0) fail(`${MANIFEST} lists no generated assets`);

// `git ls-files --` with explicit paths returns the tracked subset. Untracked
// and ignored outputs simply do not come back.
const listed = git(["ls-files", "-z", "--", ...manifest]);
if (listed.status !== 0) {
  fail(`git ls-files failed: ${listed.stderr.trim()}`);
}
const tracked = zSplit(listed.stdout);
if (tracked.length === 0) {
  console.log(`${LABEL} OK — no generated asset is tracked`);
  process.exit(0);
}

// Worktree against HEAD, not against the index: staging a divergent blob is
// how it reaches a commit, so `git add` must not be able to quiet the guard.
const diff = git(["diff", "--name-only", "-z", "HEAD", "--", ...tracked]);
if (diff.status !== 0) {
  fail(`git diff failed: ${diff.stderr.trim()}`);
}
const changed = zSplit(diff.stdout);
const reEncoded = changed.filter((path) => encodingOnlyDivergence(path));
const divergent = changed.filter((path) => !reEncoded.includes(path));

for (const path of reEncoded) {
  console.log(
    `${LABEL} ${path} — same decoded image, different deflate encoding; not a divergence`,
  );
}

if (divergent.length > 0) {
  for (const path of divergent) {
    console.error(`${LABEL} ${path} — committed bytes differ from generator output`);
  }
  console.error(
    `${LABEL} FAIL — ${divergent.length} tracked generated asset(s) diverge from \`bun run build:icons\`.`,
  );
  console.error(
    `${LABEL} If the change is intended, commit the regenerated bytes. If it is not, the`,
  );
  console.error(
    `${LABEL} generator's output moved under you — investigate before committing anything.`,
  );
  process.exit(1);
}

console.log(`${LABEL} OK — ${tracked.length} tracked generated asset(s) match`);
