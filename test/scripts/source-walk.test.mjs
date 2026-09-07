import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { walkSourceFiles } from "../../scripts/lib/source-walk.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "source-walk-"));
  for (const rel of files) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
  return root;
}

// The race this guards: a repo-wide walk runs while another suite clears its
// own scratch directory. The parent listing named that directory a moment
// before it disappeared. Reproduced for real rather than by mocking the
// filesystem — `accept` deletes the sibling while the walk is in flight.
test("a directory removed mid-walk is skipped, not fatal", () => {
  const root = fixture(["a/one.ts", "doomed/two.ts", "z/three.ts"]);
  const doomed = join(root, "doomed");
  const seen = walkSourceFiles(root, {
    extensions: [".ts"],
    accept: (path) => {
      if (path.endsWith("one.ts")) rmSync(doomed, { recursive: true, force: true });
      return true;
    },
  });
  assert.deepEqual(
    seen.map((p) => p.slice(root.length + 1)).sort(),
    ["a/one.ts", "z/three.ts"],
  );
  rmSync(root, { recursive: true, force: true });
});

// The root is the caller's own argument, so a missing one is their mistake and
// stays an error — otherwise a gate pointed at a renamed directory would report
// a clean scan of nothing.
test("a root that does not exist still throws", () => {
  assert.throws(
    () => walkSourceFiles(join(tmpdir(), "source-walk-absent-root")),
    /ENOENT/,
  );
});

test("a caller can still opt out for the root", () => {
  assert.deepEqual(
    walkSourceFiles(join(tmpdir(), "source-walk-absent-root"), {
      tolerateUnreadableDirs: true,
    }),
    [],
  );
});

test("separate calls do not share an accumulator", () => {
  const root = fixture(["only.ts"]);
  assert.equal(walkSourceFiles(root, { extensions: [".ts"] }).length, 1);
  assert.equal(walkSourceFiles(root, { extensions: [".ts"] }).length, 1);
  rmSync(root, { recursive: true, force: true });
});
