#!/usr/bin/env node
/**
 * check-screenshot-provenance.mjs — provenance gate for the docs-site images.
 *
 * ## What problem this exists for
 *
 * The images under `web/public/` are published to a public docs site. The batch
 * that is there today was captured by hand from a live working session on a
 * managed workstation, so a number of them carry content that was never meant
 * to leave: other people's names and contact details, organisational paths,
 * conferencing credentials, internal host and share names, and mailbox
 * identifiers. `docs/development/screenshot-reshoot.md` is the per-image
 * worklist for replacing them.
 *
 * This gate is the part that stops the *next* batch from repeating it.
 *
 * ## What this gate can and cannot see — read this before trusting it
 *
 * It cannot see the pixels. There is no OCR here and no image model. It cannot
 * tell you whether a name, a phone number, a hostname, or a credential is
 * visible in a PNG, and any heuristic that claimed to would be wrong often
 * enough to be worse than nothing — a gate people learn to override is not a
 * gate. In particular it cannot detect the diagonal identity overlay that some
 * managed-workstation captures carry: that overlay is a few luminance levels
 * away from the background, it is drawn across the whole frame including over
 * content that has to stay legible, and finding it takes a deliberate
 * high-pass amplification pass (the recipe is in the worklist document).
 *
 * What it can do is refuse to let an image into the tree without a written,
 * reviewable claim about where the content came from. The claim lives in
 * `web/screenshot-provenance.json`, one entry per image, and it is what a
 * reviewer reads instead of squinting at a thumbnail. A wrong claim is a
 * person's error that the diff records; a missing claim is this gate's failure
 * and it is mechanical.
 *
 * ## Rules
 *
 * 1. Coverage — every tracked image under `web/public/` has a manifest entry.
 *    This is the rule that blocks a new screenshot dropped in without a claim.
 * 2. No stale entries — every manifest entry names a tracked file.
 * 3. Schema — `surface` non-empty, `data` and `action` from the known sets.
 * 4. `data: "third-party"` means the frame carries content about people or
 *    systems outside the publisher's own demo environment. Such an entry must
 *    carry a real `action` (`reshoot` / `redact` / `remove`); `none` is not an
 *    available answer for it.
 * 5. `data: "seeded"` must name an account from `seededAccounts` and assert
 *    `overlayChecked`. This is the shape a *replacement* image is expected to
 *    take, and the account allow-list is what makes "it was a demo account" a
 *    checkable statement rather than a claim in a commit message.
 * 6. Ratchet — the number of `third-party` entries must equal
 *    `pendingReplacementBaseline`, exactly, in both directions. Adding a new
 *    image that carries third-party content pushes the count above the
 *    baseline and fails. Replacing one and not lowering the baseline also
 *    fails, so the ledger cannot quietly stop tracking the backlog.
 * 7. Reserved domains in the capture harness — every email address written into
 *    `test/screenshots/` must sit in a domain that can never belong to anyone
 *    (RFC 2606 / RFC 6761: `example.com|net|org`, `.example`, `.invalid`,
 *    `.test`, `.localhost`). This is the one identity leak the gate CAN see
 *    mechanically: a replacement capture renders the harness's own seeded
 *    strings, so an address typed there reaches a published frame. It says
 *    nothing about the pixels of any other image — rule 4 and the worklist
 *    still own that.
 *
 * Run standalone with `node scripts/check-screenshot-provenance.mjs`.
 * `--root <dir>` points it at another checkout; the self-test uses that to
 * drive it against throwaway fixtures.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const rootArgIndex = process.argv.indexOf("--root");
const ROOT = rootArgIndex >= 0
  ? resolve(process.argv[rootArgIndex + 1] ?? "")
  : process.cwd();

const LABEL = "[screenshot-provenance]";
const MANIFEST = "web/screenshot-provenance.json";
const PUBLIC_DIR = "web/public";

/** Raster formats plus SVG. SVG is included deliberately: it is the one vector
 *  format that can carry an embedded raster payload, so leaving it out would
 *  leave a way to add a screen capture that the coverage rule never sees. */
const IMAGE_PATTERN = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|svg)$/i;

const DATA_KINDS = new Set(["third-party", "owner", "seeded", "synthetic"]);
const ACTIONS = new Set(["reshoot", "redact", "remove", "none"]);
const REQUIRES_ACTION = "third-party";

/** Where the replacement captures are authored. Rule 7 scans this tree. */
const CAPTURE_HARNESS_DIR = "test/screenshots";
const CAPTURE_HARNESS_EXTENSIONS = [".ts", ".tsx", ".mjs", ".md"];
/**
 * Local part is deliberately loose and the domain deliberately strict: the point
 * is to catch anything that READS as an address in a rendered frame, not to
 * validate mail routing.
 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
/**
 * Domains reserved by RFC 2606 and RFC 6761. Nothing here can ever be
 * registered, so an address in one of them cannot identify a real mailbox.
 */
const RESERVED_DOMAIN_SUFFIXES = [
  "example.com",
  "example.net",
  "example.org",
  ".example",
  ".invalid",
  ".test",
  ".localhost",
];

function isReservedDomain(domain) {
  const lower = domain.toLowerCase();
  return RESERVED_DOMAIN_SUFFIXES.some(
    (suffix) => lower === suffix || lower.endsWith(suffix),
  );
}

function listHarnessSources(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // `out/` holds the captured PNGs (gitignored); nothing to read there.
      if (entry.name === "node_modules" || entry.name === "out") continue;
      listHarnessSources(full, out);
    } else if (CAPTURE_HARNESS_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// Git exports these to the hooks it runs and they outrank `-C`, so a gate
// invoked from a hook would otherwise report on whichever repository git was
// busy with rather than the one it was pointed at. Dropping them leaves ROOT as
// the only thing that selects a repository.
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

function git(args) {
  return spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf-8", env: GIT_ENV });
}

const failures = [];
function fail(message) {
  failures.push(message);
}

function readManifest() {
  const path = resolve(ROOT, MANIFEST);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`${LABEL} FAIL: ${MANIFEST} is missing. Every image under ${PUBLIC_DIR}/ needs a provenance entry; the manifest is where they live.`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`${LABEL} FAIL: ${MANIFEST} is not valid JSON — ${error.message}`);
    process.exit(1);
  }
}

function listTrackedImages() {
  const result = git(["ls-files", "-z", "--", PUBLIC_DIR]);
  if (result.status !== 0) {
    console.error(`${LABEL} FAIL: could not list tracked files under ${PUBLIC_DIR} — ${(result.stderr || "").trim()}`);
    process.exit(1);
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => IMAGE_PATTERN.test(file))
    .map((file) => file.slice(`${PUBLIC_DIR}/`.length))
    .sort();
}

const manifest = readManifest();

if (manifest.schemaVersion !== 1) {
  console.error(`${LABEL} FAIL: unsupported schemaVersion ${JSON.stringify(manifest.schemaVersion)} (this gate understands 1).`);
  process.exit(1);
}

const images = manifest.images;
if (images === null || typeof images !== "object" || Array.isArray(images)) {
  console.error(`${LABEL} FAIL: ${MANIFEST} "images" must be an object keyed by path relative to ${PUBLIC_DIR}/.`);
  process.exit(1);
}

const seededAccounts = new Set(
  Array.isArray(manifest.seededAccounts) ? manifest.seededAccounts : [],
);

const tracked = listTrackedImages();
const trackedSet = new Set(tracked);
const declaredSet = new Set(Object.keys(images));

// Rule 1 — coverage.
for (const file of tracked) {
  if (!declaredSet.has(file)) {
    fail(`undeclared image: ${PUBLIC_DIR}/${file} has no entry in ${MANIFEST}. Add one recording what is on screen and which account captured it.`);
  }
}

// Rule 2 — no stale entries.
for (const file of declaredSet) {
  if (!trackedSet.has(file)) {
    fail(`stale entry: ${MANIFEST} declares ${file}, which is not a tracked image under ${PUBLIC_DIR}/.`);
  }
}

// Rules 3-5 — per-entry shape.
let thirdPartyCount = 0;
for (const [file, entry] of Object.entries(images)) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`${file}: entry must be an object.`);
    continue;
  }
  if (typeof entry.surface !== "string" || entry.surface.trim() === "") {
    fail(`${file}: "surface" must be a non-empty string naming the screen this shows.`);
  }
  if (!DATA_KINDS.has(entry.data)) {
    fail(`${file}: "data" must be one of ${[...DATA_KINDS].join(", ")} (got ${JSON.stringify(entry.data)}).`);
    continue;
  }
  if (!ACTIONS.has(entry.action)) {
    fail(`${file}: "action" must be one of ${[...ACTIONS].join(", ")} (got ${JSON.stringify(entry.action)}).`);
    continue;
  }
  if (entry.data === REQUIRES_ACTION) {
    thirdPartyCount += 1;
    if (entry.action === "none") {
      fail(`${file}: data "${REQUIRES_ACTION}" carries content about people or systems outside the demo environment, so it needs an action (reshoot, redact, or remove) — "none" is not available for it.`);
    }
  }
  if (entry.data === "seeded") {
    if (!seededAccounts.has(entry.account)) {
      fail(`${file}: data "seeded" must name an account from seededAccounts (got ${JSON.stringify(entry.account)}). That allow-list is what makes the demo-account claim checkable.`);
    }
    if (entry.overlayChecked !== true) {
      fail(`${file}: data "seeded" must assert "overlayChecked": true — the capture has to be amplification-checked for an identity overlay before it is treated as clean.`);
    }
  }
}

// Rule 6 — ratchet, both directions.
const baseline = manifest.pendingReplacementBaseline;
if (!Number.isInteger(baseline) || baseline < 0) {
  fail(`"pendingReplacementBaseline" must be a non-negative integer (got ${JSON.stringify(baseline)}).`);
} else if (thirdPartyCount > baseline) {
  fail(`ratchet: ${thirdPartyCount} entries carry third-party content but the baseline is ${baseline}. A new image carrying third-party content is exactly what this gate refuses. If you are adding one, do not raise the baseline — capture it against a seeded account instead.`);
} else if (thirdPartyCount < baseline) {
  fail(`ratchet: ${thirdPartyCount} entries carry third-party content but the baseline still says ${baseline}. Lower "pendingReplacementBaseline" to ${thirdPartyCount} so the backlog stays tracked.`);
}

// Rule 7 — no addressable domain in the capture harness's own seeded strings.
for (const file of listHarnessSources(resolve(ROOT, CAPTURE_HARNESS_DIR))) {
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const relativePath = file.slice(resolve(ROOT).length + 1).split("\\").join("/");
  for (const match of contents.matchAll(EMAIL_PATTERN)) {
    if (isReservedDomain(match[1])) continue;
    fail(
      `${relativePath}: seeded text contains an address at "${match[1]}", which is a domain someone could own. A capture renders these strings into a published frame — use a reserved domain (${RESERVED_DOMAIN_SUFFIXES.join(", ")}).`,
    );
  }
}

if (failures.length > 0) {
  console.error(`${LABEL} FAIL (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  console.error(`${LABEL} This gate reads declarations, not pixels. It cannot tell you whether a name or a credential is visible in an image — see the header of this script and docs/development/screenshot-reshoot.md.`);
  process.exit(1);
}

console.log(`${LABEL} OK — ${tracked.length} tracked images, all declared; ${thirdPartyCount} awaiting replacement (baseline ${baseline}).`);
