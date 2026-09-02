import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareSotShapes,
  formatSotShapesBaseline,
  runSotShapesGate,
  scanSotShapes,
} from "../../scripts/check-sot-shapes.mjs";

function fixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "sot-shapes-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function gate(root, baseline, updateBaseline = false) {
  const baselinePath = join(root, "sot-shapes-baseline.json");
  if (baseline) writeFileSync(baselinePath, formatSotShapesBaseline(baseline));
  const out = [];
  const err = [];
  const code = runSotShapesGate({
    root,
    baselinePath,
    updateBaseline,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), baselinePath };
}

const RENAME_COPY = 'import { renameSync } from "node:fs";\nexport function swap(a, b) {\n  renameSync(a, b);\n}\n';

test("counts shape hits per file, skips homes, comments and tests", () => {
  const root = fixtureRoot({
    "src/plugins/mover.ts": RENAME_COPY,
    "src/lib/atomic-file.ts": RENAME_COPY,
    "src/plugins/__tests__/mover.test.ts": RENAME_COPY,
    "src/plugins/mover.spec.ts": RENAME_COPY,
    "src/notes.ts": "// renameSync(a, b) is what the helper does\n/* rename(x) */\n * rename(y)\n",
    "src/tools/tilde.ts": 'import { homedir } from "node:os";\nconst h = homedir();\nif (p.startsWith("~")) {}\n',
    "src/tools/no-home.ts": 'if (p.startsWith("~/")) {}\n',
    "src/errors.ts": "const m = e instanceof Error ? e.message : String(e);\nconst n = err instanceof Error ? err.message : String(err);\n",
  });
  try {
    assert.deepEqual(scanSotShapes(root), {
      "fs-rename": { "src/plugins/mover.ts": 1 },
      "home-tilde": { "src/tools/tilde.ts": 1 },
      "error-message": { "src/errors.ts": 2 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compare reports growth and shrinkage separately", () => {
  const current = { "fs-rename": { "a.ts": 2, "b.ts": 1 }, "home-tilde": {}, "error-message": {} };
  const baseline = { "fs-rename": { "a.ts": 1, "c.ts": 3 }, "home-tilde": {} };
  assert.deepEqual(compareSotShapes(current, baseline), {
    grown: ["fs-rename a.ts: 1 -> 2", "fs-rename b.ts: 0 -> 1"],
    shrunk: ["fs-rename c.ts: 3 -> 0"],
  });
});

test("gate fails on a new copy, fails on a stale ledger, and only shrinks on update", () => {
  const root = fixtureRoot({ "src/plugins/mover.ts": RENAME_COPY });
  try {
    const held = gate(root, { "fs-rename": { "src/plugins/mover.ts": 1 } });
    assert.equal(held.code, 0);
    assert.match(held.out, /baseline held/u);

    const grown = gate(root, { "fs-rename": {} });
    assert.equal(grown.code, 1);
    assert.match(grown.err, /new copies/u);
    assert.match(grown.err, /src\/plugins\/mover\.ts: 0 -> 1/u);
    assert.match(grown.err, /atomic-file\.ts/u);

    const growUpdate = gate(root, { "fs-rename": {} }, true);
    assert.equal(growUpdate.code, 1, "an update must not record growth");

    const stale = gate(root, { "fs-rename": { "src/plugins/mover.ts": 1, "src/gone.ts": 2 } });
    assert.equal(stale.code, 1);
    assert.match(stale.err, /copies that are gone/u);

    const shrunk = gate(root, { "fs-rename": { "src/plugins/mover.ts": 1, "src/gone.ts": 2 } }, true);
    assert.equal(shrunk.code, 0);
    assert.deepEqual(JSON.parse(readFileSync(shrunk.baselinePath, "utf8")), {
      schemaVersion: 1,
      shapes: { "error-message": {}, "fs-rename": { "src/plugins/mover.ts": 1 }, "home-tilde": {} },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing ledger is an error unless the run is an update, which grandfathers once", () => {
  const root = fixtureRoot({ "src/plugins/mover.ts": RENAME_COPY });
  try {
    assert.throws(() => gate(root, null), /not readable JSON/u);
    const written = gate(root, null, true);
    assert.equal(written.code, 0);
    assert.match(written.out, /baseline written: .*fs-rename=1 hits\/1 files/u);
    assert.deepEqual(
      JSON.parse(readFileSync(written.baselinePath, "utf8")).shapes["fs-rename"],
      { "src/plugins/mover.ts": 1 },
    );
    assert.equal(gate(root, null).code, 0, "the written ledger holds on the next run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
