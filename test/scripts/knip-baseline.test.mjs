import test from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareKnipBaseline,
  normalizeKnipIssues,
  writeKnipBaselineAtomicSync,
} from "../../scripts/lib/knip-baseline.mjs";

function atomicWriteRuntime(overrides = {}) {
  return {
    platform: process.platform,
    open: openSync,
    write: (fd, content) => writeFileSync(fd, content, { encoding: "utf8" }),
    flush: fsyncSync,
    close: closeSync,
    replace: renameSync,
    remove: (path) => rmSync(path, { force: true }),
    wait: () => {},
    ...overrides,
  };
}

test("normalizes issue positions away while retaining type, file, and name", () => {
  const issues = normalizeKnipIssues({
    issues: [{
      file: "src/example.ts",
      files: [],
      exports: [{ name: "unused", line: 99, col: 2, pos: 1200 }],
      duplicates: [[{ name: "second" }, { name: "first" }]],
    }],
  });

  assert.deepEqual(issues, [
    { type: "duplicates", file: "src/example.ts", name: "first,second" },
    { type: "exports", file: "src/example.ts", name: "unused" },
  ]);
});

test("reports only additions as gate failures and keeps resolved debt separate", () => {
  const accepted = [
    { type: "files", file: "src/old.ts", name: "src/old.ts" },
  ];
  const current = [
    { type: "files", file: "src/new.ts", name: "src/new.ts" },
  ];

  assert.deepEqual(compareKnipBaseline(current, accepted), {
    added: current,
    resolved: accepted,
  });
});

test("atomically replaces a baseline after flushing the staged bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "lvis-knip-baseline-write-"));
  const baselinePath = join(directory, "knip-baseline.json");
  try {
    writeFileSync(baselinePath, "before\n", "utf8");
    writeKnipBaselineAtomicSync(baselinePath, "after\n");
    assert.equal(readFileSync(baselinePath, "utf8"), "after\n");
    assert.deepEqual(readdirSync(directory), ["knip-baseline.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves the reviewed baseline and removes staging after replace failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "lvis-knip-baseline-failure-"));
  const baselinePath = join(directory, "knip-baseline.json");
  try {
    writeFileSync(baselinePath, "reviewed\n", "utf8");
    assert.throws(
      () => writeKnipBaselineAtomicSync(
        baselinePath,
        "partial candidate\n",
        atomicWriteRuntime({
          platform: "linux",
          replace: () => {
            throw Object.assign(new Error("injected replace failure"), { code: "EIO" });
          },
        }),
      ),
      /injected replace failure/,
    );
    assert.equal(readFileSync(baselinePath, "utf8"), "reviewed\n");
    assert.deepEqual(readdirSync(directory), ["knip-baseline.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
