#!/usr/bin/env node
/**
 * check-screenshot-provenance-self-test.mjs
 *
 * A gate nobody exercises is a gate that reports green after it stops
 * comparing. This drives `check-screenshot-provenance.mjs` against throwaway
 * git repositories built for the purpose and asserts the outcomes that matter:
 *
 *   blocks  — an image added with no provenance entry at all
 *   blocks  — an image added declaring third-party content, pushing the
 *             backlog above its baseline
 *   blocks  — a "seeded" claim naming an account outside the allow-list
 *   blocks  — a "seeded" claim that has not been overlay-checked
 *   blocks  — a manifest entry left behind after its image is gone
 *   blocks  — a backlog that shrank without the baseline following it down
 *   blocks  — a capture-harness source seeding an address at a domain someone
 *             could own
 *   passes  — an image added the way a replacement is supposed to look:
 *             seeded data, an allow-listed account, overlay-checked, and a
 *             harness that seeds only reserved-domain addresses
 *
 * Run standalone with `node scripts/check-screenshot-provenance-self-test.mjs`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const GATE = join(ROOT, "scripts", "check-screenshot-provenance.mjs");

// A one-pixel PNG. The gate never decodes it — the bytes only need to be a
// plausible tracked image so `git ls-files` reports it.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let failures = 0;
const results = [];

function run(cwd, command, args) {
  return spawnSync(command, args, { cwd, encoding: "utf-8" });
}

/**
 * Build a throwaway repository holding `images` (relative to web/public), the
 * given manifest and any `harnessFiles` (relative to test/screenshots), then
 * run the gate against it.
 */
function gateOn({ images, manifest, harnessFiles = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "lvis-shot-provenance-selftest-"));
  try {
    run(dir, "git", ["init", "-q"]);
    run(dir, "git", ["config", "user.email", "self-test@example.invalid"]);
    run(dir, "git", ["config", "user.name", "self test"]);
    for (const relative of images) {
      const target = join(dir, "web", "public", relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, PNG_BYTES);
    }
    for (const [relative, contents] of Object.entries(harnessFiles)) {
      const target = join(dir, "test", "screenshots", relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf-8");
    }
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(
      join(dir, "web", "screenshot-provenance.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    run(dir, "git", ["add", "-A"]);
    const gate = run(dir, "node", [GATE, "--root", dir]);
    return { status: gate.status, out: `${gate.stdout ?? ""}${gate.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expect(name, { expected, actual, needle, out }) {
  const statusOk = actual === expected;
  const textOk = needle === undefined || out.includes(needle);
  const ok = statusOk && textOk;
  if (!ok) failures += 1;
  results.push({ ok, name, expected, actual, needle, out });
}

const SEEDED_ACCOUNTS = ["work-board-seed"];

/** The shape a replacement image is supposed to declare. */
const CLEAN_ENTRY = {
  surface: "host chat surface",
  data: "seeded",
  action: "none",
  account: "work-board-seed",
  overlayChecked: true,
};

// --- must block: image present, nothing declared about it ------------------
{
  const { status, out } = gateOn({
    images: ["screenshots/newly-added.png"],
    manifest: {
      schemaVersion: 1,
      pendingReplacementBaseline: 0,
      seededAccounts: SEEDED_ACCOUNTS,
      images: {},
    },
  });
  expect("blocks an undeclared image", {
    expected: 1, actual: status, needle: "undeclared image", out,
  });
}

// --- must block: new image declaring third-party content over the baseline --
{
  const { status, out } = gateOn({
    images: ["screenshots/kept.png", "screenshots/newly-added.png"],
    manifest: {
      schemaVersion: 1,
      pendingReplacementBaseline: 1,
      seededAccounts: SEEDED_ACCOUNTS,
      images: {
        "screenshots/kept.png": { surface: "host chat surface", data: "third-party", action: "reshoot" },
        "screenshots/newly-added.png": { surface: "host chat surface", data: "third-party", action: "reshoot" },
      },
    },
  });
  expect("blocks a new third-party image over the baseline", {
    expected: 1, actual: status, needle: "ratchet", out,
  });
}

// --- must block: seeded claim naming an account outside the allow-list ------
{
  const { status, out } = gateOn({
    images: ["screenshots/newly-added.png"],
    manifest: {
      schemaVersion: 1,
      pendingReplacementBaseline: 0,
      seededAccounts: SEEDED_ACCOUNTS,
      images: {
        "screenshots/newly-added.png": { ...CLEAN_ENTRY, account: "someone-personal-account" },
      },
    },
  });
  expect("blocks a seeded claim with an account outside the allow-list", {
    expected: 1, actual: status, needle: "seededAccounts", out,
  });
}

// --- must block: seeded claim that was never overlay-checked ----------------
{
  const { status, out } = gateOn({
    images: ["screenshots/newly-added.png"],
    manifest: {
      schemaVersion: 1,
      pendingReplacementBaseline: 0,
      seededAccounts: SEEDED_ACCOUNTS,
      images: {
        "screenshots/newly-added.png": { ...CLEAN_ENTRY, overlayChecked: false },
      },
    },
  });
  expect("blocks a seeded claim that is not overlay-checked", {
    expected: 1, actual: status, needle: "overlayChecked", out,
  });
}

// --- must block: entry left behind after its image is gone ------------------
{
  const { status, out } = gateOn({
    images: [],
    manifest: {
      schemaVersion: 1,
      pendingReplacementBaseline: 0,
      seededAccounts: SEEDED_ACCOUNTS,
      images: { "screenshots/removed.png": CLEAN_ENTRY },
    },
  });
  expect("blocks a stale entry", {
    expected: 1, actual: status, needle: "stale entry", out,
  });
}

// --- must block: backlog shrank, baseline did not follow -------------------
{
  const { status, out } = gateOn({
    images: ["screenshots/replaced.png"],
    manifest: {
      schemaVersion: 1,
      pendingReplacementBaseline: 1,
      seededAccounts: SEEDED_ACCOUNTS,
      images: { "screenshots/replaced.png": CLEAN_ENTRY },
    },
  });
  expect("blocks a baseline left above the real backlog", {
    expected: 1, actual: status, needle: "Lower", out,
  });
}

// --- must block: harness seeding an address at a domain someone could own ---
{
  const { status, out } = gateOn({
    images: ["screenshots/newly-added.png"],
    manifest: {
      schemaVersion: 1,
      pendingReplacementBaseline: 0,
      seededAccounts: SEEDED_ACCOUNTS,
      images: { "screenshots/newly-added.png": CLEAN_ENTRY },
    },
    harnessFiles: {
      // A plausible slip: a real organiser copied out of the image being replaced.
      "matrix.ts": "const ORGANISER = 'somebody@a-real-company.com';\n",
    },
  });
  expect("blocks a harness address at an ownable domain", {
    expected: 1, actual: status, needle: "a-real-company.com", out,
  });
}

// --- must pass: a replacement declared the way the process expects ---------
{
  const { status, out } = gateOn({
    images: ["screenshots/kept.png", "screenshots/newly-added.png"],
    manifest: {
      schemaVersion: 1,
      pendingReplacementBaseline: 1,
      seededAccounts: SEEDED_ACCOUNTS,
      images: {
        "screenshots/kept.png": { surface: "host chat surface", data: "third-party", action: "reshoot" },
        "screenshots/newly-added.png": CLEAN_ENTRY,
      },
    },
    harnessFiles: {
      // Reserved by RFC 2606 — it can never resolve to a real mailbox.
      "matrix.ts": "const ORGANISER = 'demo-host@example.invalid';\n",
    },
  });
  expect("passes a properly declared seeded capture", {
    expected: 0, actual: status, needle: "OK", out,
  });
}

for (const r of results) {
  const verdict = r.ok ? "PASS" : "FAIL";
  console.log(`[screenshot-provenance:self-test] ${verdict} ${r.name} (exit ${r.actual}, expected ${r.expected})`);
  if (!r.ok) console.log(r.out.trim().split("\n").map((line) => `      ${line}`).join("\n"));
}

if (failures > 0) {
  console.error(`[screenshot-provenance:self-test] ${failures} of ${results.length} expectations failed.`);
  process.exit(1);
}
console.log(`[screenshot-provenance:self-test] OK — ${results.length}/${results.length} expectations held.`);
