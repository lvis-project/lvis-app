import test from "node:test";
import assert from "node:assert/strict";
import {
  compareKnipBaseline,
  normalizeKnipIssues,
} from "../../scripts/lib/knip-baseline.mjs";

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
