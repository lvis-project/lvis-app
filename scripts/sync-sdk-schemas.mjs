#!/usr/bin/env node
/**
 * Keep `schemas/sdk/` byte-identical to the SDK files it snapshots.
 *
 * WHAT IS SNAPSHOTTED AND WHY
 *   `lvis-plugin-sdk:schemas/skill-package.schema.json` carries
 *   `$defs/skillComponent` — the definition of SKILL.md front matter for both
 *   delivery paths. The host implements that definition
 *   (`src/main/skill-store.ts`) but does not load the file at runtime; the
 *   snapshot exists so the contract test can read the rule out of the
 *   definition instead of restating it, and so a reader can see what the host
 *   is implementing without cloning another repository.
 *
 *   The SDK owns it. This copy has no authority: a rule that belongs in the
 *   contract belongs in the SDK, and this script must never "improve" one on
 *   the way through. Contrast `schemas/plugin-manifest.schema.json`, which is
 *   the opposite arrangement — the host owns the manifest shape and the SDK
 *   mirrors it.
 *
 * WHY A GATE AND NOT A CONVENTION
 *   A snapshot with no gate is a copy that is correct on the day it is written
 *   and silently wrong afterwards. Two different things can go wrong, and they
 *   need different checks:
 *
 *     --check   Local, hermetic, no network. The bytes on disk still hash to
 *               what `sources.json` recorded. Catches a hand edit to the
 *               snapshot — someone "fixing" the rule in the copy.
 *
 *     --verify  Fetches from the SDK. Two comparisons, and they answer
 *               different questions:
 *                 · at the pinned ref  — is this snapshot really what that tag
 *                   published? (provenance: the recorded sha is not merely
 *                   self-consistent)
 *                 · at the default branch — has the SDK moved since? (drift:
 *                   the reason to re-sync)
 *
 * USAGE
 *   node scripts/sync-sdk-schemas.mjs --ref v13.2.0   # fetch, write, record
 *   node scripts/sync-sdk-schemas.mjs --check         # offline hash check
 *   node scripts/sync-sdk-schemas.mjs --verify        # + fetch and compare
 *
 * The fetch uses `gh api`, so it needs a `gh` on PATH that is authenticated —
 * in CI, the token the workflow already has. The SDK repository is public, so
 * no secret is involved.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_DIR = join(ROOT, "schemas/sdk");
const SOURCES = join(SNAPSHOT_DIR, "sources.json");
const LABEL = "[sdk-schemas]";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readSources() {
  return JSON.parse(readFileSync(SOURCES, "utf8"));
}

/** One file from the SDK at `ref`, as text. Throws with the gh error on failure. */
function fetchFromSdk(repository, ref, path) {
  const result = spawnSync(
    "gh",
    [
      "api",
      "-H", "Accept: application/vnd.github.raw",
      `repos/${repository}/contents/${path}?ref=${ref}`,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${LABEL} could not fetch ${path} from ${repository}@${ref}: ` +
        `${(result.stderr || "").trim() || `gh exited ${result.status}`}`,
    );
  }
  return result.stdout;
}

function fail(message) {
  console.error(`${LABEL} ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const refIndex = argv.indexOf("--ref");
const requestedRef = refIndex >= 0 ? argv[refIndex + 1] : undefined;
const check = argv.includes("--check");
const verify = argv.includes("--verify");

const sources = readSources();
const { repository, defaultBranch } = sources;
const ref = requestedRef ?? sources.ref;

if (!check && !verify) {
  // Sync mode: the SDK at `ref` becomes the snapshot, verbatim.
  const next = { ...sources, ref, files: {} };
  for (const name of Object.keys(sources.files)) {
    const content = fetchFromSdk(repository, ref, `schemas/${name}`);
    writeFileSync(join(SNAPSHOT_DIR, name), content);
    next.files[name] = { sha256: sha256(content) };
    console.log(`${LABEL} wrote schemas/sdk/${name} from ${repository}@${ref}`);
  }
  writeFileSync(SOURCES, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${LABEL} recorded ref ${ref} in schemas/sdk/sources.json`);
  process.exit(0);
}

let failed = false;

for (const [name, recorded] of Object.entries(sources.files)) {
  const local = readFileSync(join(SNAPSHOT_DIR, name), "utf8");
  const localSha = sha256(local);

  // Local: the committed bytes are the bytes that were recorded.
  if (localSha !== recorded.sha256) {
    console.error(
      `${LABEL} schemas/sdk/${name} does not match its recorded hash.\n` +
        `  recorded ${recorded.sha256}\n  on disk  ${localSha}\n` +
        `  The snapshot is a verbatim copy of an SDK file — it is not edited here.\n` +
        `  Change the rule in ${repository}, then re-sync:\n` +
        `    node scripts/sync-sdk-schemas.mjs --ref <sdk-tag>`,
    );
    failed = true;
    continue;
  }

  if (!verify) {
    console.log(`${LABEL} schemas/sdk/${name} matches its recorded hash.`);
    continue;
  }

  // Provenance: the tag this claims to come from really published these bytes.
  const atRef = fetchFromSdk(repository, ref, `schemas/${name}`);
  if (atRef !== local) {
    console.error(
      `${LABEL} schemas/sdk/${name} is NOT what ${repository}@${ref} publishes.\n` +
        `  The recorded ref and the recorded bytes disagree, so the snapshot's\n` +
        `  provenance claim is false. Re-sync from the tag it should carry:\n` +
        `    node scripts/sync-sdk-schemas.mjs --ref ${ref}`,
    );
    failed = true;
    continue;
  }

  // Drift: the SDK has moved on and this snapshot is behind.
  const atHead = fetchFromSdk(repository, defaultBranch, `schemas/${name}`);
  if (atHead !== local) {
    console.error(
      `${LABEL} SDK schema moved — re-sync snapshot and bump the recorded ref.\n` +
        `  schemas/sdk/${name} matches ${repository}@${ref} but not ` +
        `${repository}@${defaultBranch}.\n` +
        `  The host is implementing an older definition than the SDK now publishes.\n` +
        `    node scripts/sync-sdk-schemas.mjs --ref <new-sdk-tag>\n` +
        `  then run the front-matter contract test, which reads the rule out of\n` +
        `  the snapshot and will name whatever the host has to change with it.`,
    );
    failed = true;
    continue;
  }

  console.log(
    `${LABEL} schemas/sdk/${name}: hash recorded, byte-identical at ` +
      `${ref} and ${defaultBranch}.`,
  );
}

if (failed) fail("snapshot check failed.");
console.log(`${LABEL} OK`);
