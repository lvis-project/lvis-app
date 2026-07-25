/**
 * Self-test for the source-text-safety gate.
 *
 * The gate exists because a raw control byte in a source file makes git treat the
 * file as binary, which silently exempts it from `git diff`, review, ripgrep, and
 * the naming gate — and that happened twice in one review cycle to a file defining
 * shared validation. A gate nobody has watched fail is a gate nobody can trust, so
 * this pins all three outcomes against fixtures.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanSourceTextSafety } from "../../scripts/check-source-text-safe.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "lvis-text-safe-"));
  mkdirSync(join(root, "src"));
  return root;
}

test("flags a raw control byte and reports where it is", () => {
  const root = fixtureRoot();
  try {
    // The exact shape that caused this: a control character written into a regex
    // character class as a raw byte instead of the escape text.
    writeFileSync(join(root, "src", "bad.ts"), Buffer.from("const RE = /[\u0000-\u001f]/;\n", "latin1"));
    const { offenders, stale } = scanSourceTextSafety(root, ["src"], []);
    assert.equal(offenders.length, 1);
    assert.match(offenders[0], /^src\/bad\.ts: offset \d+ = 0x00/);
    assert.deepEqual(stale, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts the escaped spelling, plus tab, LF, and CR", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(
      join(root, "src", "good.ts"),
      "const RE = /[\\u0000-\\u001f\\u007f]/;\r\n\tconst indented = RE;\n",
    );
    assert.deepEqual(scanSourceTextSafety(root, ["src"], []), { offenders: [], stale: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exempts a grandfathered file but reports it once it is clean", () => {
  const root = fixtureRoot();
  try {
    const rel = "src/legacy.ts";
    writeFileSync(join(root, "src", "legacy.ts"), Buffer.from("const x = \"\u0000\";\n", "latin1"));
    assert.deepEqual(scanSourceTextSafety(root, ["src"], [rel]), { offenders: [], stale: [] });

    // Cleaned up ⇒ the entry must go, so the list can only ever shrink.
    writeFileSync(join(root, "src", "legacy.ts"), "const x = \"\\u0000\";\n");
    assert.deepEqual(scanSourceTextSafety(root, ["src"], [rel]), { offenders: [], stale: [rel] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores files that are not source", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(join(root, "src", "fixture.bin"), Buffer.from([0x00, 0x01, 0x02]));
    assert.deepEqual(scanSourceTextSafety(root, ["src"], []), { offenders: [], stale: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
