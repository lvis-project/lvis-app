/**
 * Does the test-typecheck gate still detect anything?
 *
 * A ratchet whose comparison silently stops working is worse than no ratchet: it reports
 * green forever and everyone believes new test files are covered. This repo already keeps
 * a self-test beside the knip gate for the same reason; this is that pattern applied to
 * the one that would otherwise be trusted blind.
 *
 * Deliberately tests the COMPARISON in-process against synthetic inputs rather than
 * running `tsc`, so it costs milliseconds and can sit in the same CI step as the gate. The
 * expensive half — that `tsc --pretty false` output actually parses into per-file counts —
 * is covered by the parser cases below, using real diagnostic lines rather than invented
 * ones.
 *
 * Each case asserts a DIRECTION, not a count: a gate that fails on everything passes a
 * "does it fail" test while being useless, so every failing case is paired with a passing
 * one that must stay green.
 */
import { compareToBaseline, countErrorsByFile } from "./check-test-typecheck-baseline.mjs";

const failures = [];
function check(name, condition) {
  if (!condition) failures.push(name);
}

// ── The parser. Real `tsc --pretty false` lines, including the shapes that have
// historically broken naive parsing: a Windows path, a message body containing the
// literal text "error TS" inside a quoted type, and a multi-line diagnostic whose
// continuation lines must NOT be counted as separate errors.
const TSC_OUTPUT = [
  `src/a/__tests__/x.test.ts(12,5): error TS2345: Argument of type 'A' is not assignable.`,
  `src/a/__tests__/x.test.ts(40,1): error TS2304: Cannot find name 'Foo'.`,
  `src\\b\\__tests__\\y.test.tsx(3,9): error TS2551: Property 'z' does not exist.`,
  `  Type '{ msg: "error TS9999: fake" }' is not assignable to type 'never'.`,
  // An INDENTED continuation carrying a complete diagnostic span. tsc emits these for
  // 'related' locations, and it is the case an anchor alone does NOT exclude — the file
  // group would simply swallow the leading spaces. Counting it would inflate both the
  // file count and one file's total.
  `    related.test.ts(7,3): error TS2322: Type 'string' is not assignable.`,
  `test/scripts/z.test.ts(1,1): error TS2307: Cannot find module 'q'.`,
  ``,
  `Found 4 errors in 3 files.`,
].join("\n");

const counts = countErrorsByFile(TSC_OUTPUT);
check("parses one entry per diagnostic line", counts.size === 3);
check("counts repeated errors in one file", counts.get("src/a/__tests__/x.test.ts") === 2);
check("normalizes Windows separators", counts.get("src/b/__tests__/y.test.tsx") === 1);
check("counts files under test/", counts.get("test/scripts/z.test.ts") === 1);
// The two continuation shapes. The quoted-type one is inert either way; the INDENTED
// full-span one is the case that actually discriminates, and it is the reason the pattern
// requires a non-space first character rather than merely anchoring.
check("ignores an indented continuation line", !counts.has("related.test.ts"));
check("never captures a file name with leading space", ![...counts.keys()].some((f) => /^\s/.test(f)));
check("ignores the trailing summary line", !counts.has("Found 4 errors in 3 files."));

// ── The comparison. Both directions, because a gate that fails on everything is not a
// gate — the `holds` and `improved` cases are what stop that.
const baseline = { "a.test.ts": 2, "b.test.ts": 1 };

check(
  "unchanged counts hold",
  compareToBaseline(new Map([["a.test.ts", 2], ["b.test.ts", 1]]), baseline).regressed.length === 0,
);
check(
  "a file gaining an error regresses",
  compareToBaseline(new Map([["a.test.ts", 3], ["b.test.ts", 1]]), baseline).regressed.length === 1,
);
// THE case this gate exists for: a file with no baseline entry is implicitly 0, so any
// error in a NEW test file is a regression. Before this gate, that file reached CI green.
check(
  "a NEW file with any error regresses",
  compareToBaseline(new Map([["brand-new.test.ts", 1]]), baseline).regressed.length === 1,
);
check(
  "a file losing an error is an improvement, not a failure",
  (() => {
    const r = compareToBaseline(new Map([["a.test.ts", 1], ["b.test.ts", 1]]), baseline);
    return r.regressed.length === 0 && r.improved.length === 1;
  })(),
);
check(
  "a file dropping to zero is reported as fixed",
  (() => {
    const r = compareToBaseline(new Map([["a.test.ts", 2]]), baseline);
    return r.regressed.length === 0 && r.fixed.includes("b.test.ts");
  })(),
);
// An empty result means tsc produced nothing — which is what a broken invocation looks
// like. It must not read as "everything was fixed" and pass silently; the runner's own
// project-load check covers the cause, this pins that the comparison reports it as fixed
// rather than as regressed, so the runner is the only thing that can be wrong.
check(
  "an empty run reports every baselined file as fixed",
  compareToBaseline(new Map(), baseline).fixed.length === 2,
);

if (failures.length > 0) {
  process.stderr.write(
    `[test-typecheck-self-test] the gate is not detecting what it claims:\n  ${failures.join("\n  ")}\n`,
  );
  process.exit(1);
}
process.stdout.write("[test-typecheck-self-test] OK\n");
