/**
 * Does the test-typecheck gate still detect anything?
 *
 * A ratchet whose comparison silently stops working is worse than no ratchet: it reports
 * green forever and everyone believes new test files are covered. This repo already keeps
 * a self-test beside the knip gate for the same reason; this is that pattern applied to
 * the one that would otherwise be trusted blind.
 *
 * Deliberately tests the COMPARISON in-process against synthetic inputs rather than
 * typechecking with `tsc`, so it costs milliseconds and can sit in the same CI step as the
 * gate. One documented exception at the bottom of the file spawns `tsc --showConfig` (~117 ms)
 * to read an effective compiler option — config resolution only, never a typecheck. The
 * expensive half — that `tsc --pretty false` output actually parses into per-file counts —
 * is covered by the parser cases below, using real diagnostic lines rather than invented
 * ones.
 *
 * Each case asserts a DIRECTION, not a count: a gate that fails on everything passes a
 * "does it fail" test while being useless, so every failing case is paired with a passing
 * one that must stay green.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareToBaseline,
  countErrorsByFile,
  expectedSourceFilesFromGitOutput,
  isEmptyMeasurementAgainstBaseline,
  main,
  missingExpectedSources,
  nonSourceMeasurements,
  nonTestEntries,
  programSourceFiles,
  readBaselineFilesOrEmpty,
  readExpectedSourceFiles,
  runGate,
  runTsc,
  unattributedDiagnostics,
} from "./check-test-typecheck-baseline.mjs";

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

// ── Parser cases added after a mutation sweep: these four mutations of `DIAGNOSTIC_RE`
// left the self-test GREEN, which means the pattern's constraints were unpinned. Each
// fixture below is the one that reddens for a specific constraint.
const EDGE_OUTPUT = [
  // A path containing `(`. This is the fixture that exists because the pattern once could
  // NOT parse such a path: the old file group was `[^(]*`, which cannot cross a paren, so
  // this line matched nothing and the file vanished from the measurement entirely. It reddens
  // under a `[^(]*` file group and nothing else.
  //
  // An earlier version of this comment said the file group "excludes `(`" — it no longer does,
  // that describes the defect — and named `[^\s]*` as the mutation it catches, which is the
  // mutation the SPACE fixture below catches. A reviewer measured the crossing:
  //   `[^\s].*?` (current) → both pass · `[^(]*` (old) → paren reddens · `[^\s]*` → space reddens
  `src/__tests__/odd(name).test.ts(3,1): error TS2304: Cannot find name 'Q'.`,
  // A path containing a SPACE. tsc emits these unquoted, so a file group of `[^\s]*` stops at
  // the space and misparses; this is the fixture that reddens for that one.
  `src/__tests__/two words.test.ts(4,2): error TS2304: Cannot find name 'R'.`,
  // Shapes that must NOT count: a span with no error code, and a non-error severity.
  `src/__tests__/nope.test.ts(5,3): error : missing code`,
  `src/__tests__/nope.test.ts(6,4): warning TS6133: 'x' is declared but never used.`,
].join("\n");
const edge = countErrorsByFile(EDGE_OUTPUT);
check("parses a path containing parentheses", edge.get("src/__tests__/odd(name).test.ts") === 1);
check("parses a path containing a space", edge.get("src/__tests__/two words.test.ts") === 1);
check("ignores a span with no error code", !edge.has("src/__tests__/nope.test.ts"));
check("ignores a non-error severity", edge.get("src/__tests__/nope.test.ts") === undefined);
check("counts exactly the two real diagnostics", edge.size === 2);
// The `(line,col)` SPAN is what separates a per-file diagnostic from a program-level one, and
// `unattributedDiagnostics` leans on exactly that invariant. A mutation making the span
// optional survived the sweep, so it was unpinned: with an optional span this line parses as a
// "file" named `tsconfig.json`, which is how a config error would be laundered into the
// baseline. Inert against tsc output today — that is why only a mutation found it.
check(
  "a diagnostic with no (line,col) span is not a per-file diagnostic",
  countErrorsByFile(`tsconfig.json: error TS5023: Unknown compiler option 'x'.`).size === 0,
);
// The opposite direction, and the reason the path is matched LAZILY rather than greedily: a
// message that quotes another span must not steal the attribution. Greedy `.*` backtracks to
// the LAST span, producing a "file" made of the real path plus most of the message.
check(
  "a span quoted inside a message does not steal attribution",
  countErrorsByFile(
    `src/__tests__/q.test.ts(1,2): error TS2322: see other(9,9): error TS1: x`,
  ).get("src/__tests__/q.test.ts") === 1,
);

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
// An empty result means tsc produced nothing, which is what a broken invocation looks
// like. The COMPARISON still reports it as "everything fixed" — that is correct at this
// layer, since a file with zero errors genuinely is fixed — so the refusal has to live in
// the runner, and it does: `runGate` returns a failure and `main` assigns that failure to the
// process exit code when the measurement is empty while the baseline is not.
//
// An earlier version of this comment claimed the runner's project-load check already
// covered that. It did not: a missing or moved `tsc.js` exits 1 with a node
// module-resolution error matching neither TS5xxx nor TS18003, so the gate printed
// "baseline held: 0 files, 0 errors" and exited 0. A security reviewer demonstrated it.
// The claim is corrected here and the behaviour is pinned below.
check(
  "an empty run reports every baselined file as fixed",
  compareToBaseline(new Map(), baseline).fixed.length === 2,
);
// …and the runner must REFUSE that rather than print it. Asserted against the exported
// predicate the runner uses, so this cannot drift from the guard it describes.
check(
  "an empty measurement against a non-empty baseline is refused",
  isEmptyMeasurementAgainstBaseline(new Map(), baseline) === true,
);
check(
  "an empty measurement against an EMPTY baseline is allowed",
  isEmptyMeasurementAgainstBaseline(new Map(), {}) === false,
);
check(
  "a non-empty measurement is never treated as empty",
  isEmptyMeasurementAgainstBaseline(new Map([["a.test.ts", 1]]), baseline) === false,
);
/*
 * Historical note, superseded by the injectable runner tests below. Kept only to preserve the
 * original failure analysis that motivated this follow-up.
 *
// WHAT THIS FILE CANNOT PIN, stated rather than left implicit. The predicate above guards
// BOTH the `--update-baseline` write and the compare, from a SINGLE call site hoisted above
// both branches in `main()`. It previously sat inside the compare path only, which left the
// write fail-open: with `tsc.js` unresolvable, `--update-baseline` rewrote the baseline from
// 312 entries to `files: {}` at rc=0, and the compare path's empty-baseline carve-out then
// reported green indefinitely.
//
// An earlier version of this block said the predicate is "applied at two points" and warned
// about moving "either call site". There is one. A reviewer flagged it because that wording
// tells the reader the compare path carries its own guard, which invites pushing the single
// check down into the update branch and restoring the original bug.
//
// PLACEMENT is still NOT asserted here, and "cannot" would now be false twice over: this file
// does spawn the compiler (for `--showConfig`), and pinning placement would not need a
// typecheck anyway — an injectable spawn, or the `decide()` seam agreed as a follow-up, would
// do it. It is a deferral, not an impossibility, and a reviewer was right to say the earlier
// wording claimed otherwise.
//
// Verified by hand instead, four directions: broken compiler + real baseline refuses and leaves
// the 312 entries intact; no baseline file still bootstraps; a corrupt baseline refuses; an
// intentionally emptied baseline with a working compiler writes. If the call site moves, re-run
// those four — a green self-test does not cover you.
*/

// ── Program coverage and runner placement. The parser sees diagnostics and listFiles output
// from the SAME compiler invocation; the expected inventory deliberately comes from Git rather
// than TypeScript's effective config, because a narrowed config cannot reveal its own omission.
const EXPECTED_SOURCE_INVENTORY = expectedSourceFilesFromGitOutput(
  [
    "src/a.test.ts",
    "scripts/check.mts",
    "test/runner.cts",
    "src/__probes__/excluded.ts",
    "src/preload.cjs.ts",
    "README.md",
    "",
  ].join("\0"),
  () => true,
);
check(
  "the independent source inventory includes intended TypeScript files only",
  [...EXPECTED_SOURCE_INVENTORY].sort().join(",")
    === "scripts/check.mts,src/a.test.ts,test/runner.cts",
);
check(
  "a source deleted from disk is not required by the inventory",
  !expectedSourceFilesFromGitOutput(
    "src/present.test.ts\0src/deleted.test.ts\0",
    (path) => !path.endsWith("deleted.test.ts"),
  ).has("src/deleted.test.ts"),
);
const LISTED_PROGRAM_SOURCES = programSourceFiles(
  [
    "src/a.test.ts",
    "scripts/check.mts",
    "test/runner.cts",
    "src/__probes__/excluded.ts",
    "node_modules/typescript/lib/lib.es2023.d.ts",
  ].join("\n"),
);
check("listFiles parsing keeps intended program sources", LISTED_PROGRAM_SOURCES.has("src/a.test.ts"));
check("listFiles parsing ignores dependency declarations", !LISTED_PROGRAM_SOURCES.has("node_modules/typescript/lib/lib.es2023.d.ts"));
const SELF_TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
check(
  "listFiles parsing normalizes an absolute source path",
  programSourceFiles(resolve(SELF_TEST_ROOT, "src", "a.test.ts")).has("src/a.test.ts"),
);
check(
  "coverage reports an expected source omitted from the compiler program",
  missingExpectedSources(EXPECTED_SOURCE_INVENTORY, new Set(["src/a.test.ts", "scripts/check.mts"]))
    .join(",") === "test/runner.cts",
);
let measuredCompilerArgs = [];
const measuredListFiles = runTsc((_command, args) => {
  measuredCompilerArgs = args;
  return {
    status: 1,
    signal: null,
    stdout: "src/a.test.ts\nscripts/check.mts\n",
    stderr: "",
  };
});
check(
  "the diagnostic measurement asks its same compiler invocation for listFiles",
  measuredCompilerArgs.includes("--listFiles")
    && measuredListFiles.programFiles.has("src/a.test.ts")
    && measuredListFiles.programFiles.has("scripts/check.mts"),
);
let inventoryCommand;
let inventoryArgs;
const measuredInventory = readExpectedSourceFiles(
  (command, args) => {
    inventoryCommand = command;
    inventoryArgs = args;
    return {
      status: 0,
      signal: null,
      stdout: "src/tracked.test.ts\0src/untracked.test.ts\0",
      stderr: "",
    };
  },
  () => true,
);
check(
  "the independent inventory asks Git for tracked and untracked intended sources",
  inventoryCommand === "git"
    && inventoryArgs.join(",")
      === "ls-files,-z,--cached,--others,--exclude-standard,--,src,scripts,test"
    && measuredInventory.has("src/tracked.test.ts")
    && measuredInventory.has("src/untracked.test.ts"),
);

const RUNNER_BASELINE = {
  exists: true,
  files: { "src/a.test.ts": 2, "src/b.test.ts": 1 },
};
const RUNNER_EXPECTED = new Set(["src/a.test.ts", "src/b.test.ts"]);
function gateMeasurement(counts, programFiles = RUNNER_EXPECTED, tscStdout = "") {
  return { counts, programFiles: new Set(programFiles), tscStdout };
}
const RUNNER_HELD = gateMeasurement(
  new Map([["src/a.test.ts", 2], ["src/b.test.ts", 1]]),
);
function gateDeps(overrides = {}) {
  return {
    argv: [],
    loadBaseline: () => RUNNER_BASELINE,
    measure: () => RUNNER_HELD,
    loadExpectedInventory: () => RUNNER_EXPECTED,
    ...overrides,
  };
}
function runGateCase(overrides = {}) {
  const writes = [];
  const stdout = [];
  const stderr = [];
  const exitCode = runGate(gateDeps({
    saveBaseline: (payload) => writes.push(payload),
    writeStdout: (message) => stdout.push(message),
    writeStderr: (message) => stderr.push(message),
    ...overrides,
  }));
  return { exitCode, writes, stdout, stderr };
}

const emptyUpdate = runGateCase({
  argv: ["--update-baseline"],
  measure: () => gateMeasurement(new Map(), new Set()),
});
check(
  "runner refuses an empty update before it writes",
  emptyUpdate.exitCode === 1
    && emptyUpdate.writes.length === 0
    && emptyUpdate.stderr.join("").includes("produced no diagnostics"),
);
const emptyCompare = runGateCase({
  measure: () => gateMeasurement(new Map(), new Set()),
});
check(
  "runner refuses an empty measurement before it compares",
  emptyCompare.exitCode === 1
    && emptyCompare.writes.length === 0
    && emptyCompare.stdout.length === 0
    && emptyCompare.stderr.join("").includes("produced no diagnostics"),
);
const nonSourceUpdate = runGateCase({
  argv: ["--update-baseline"],
  measure: () => gateMeasurement(new Map([["tsconfig.json", 1]]), new Set()),
});
check(
  "runner refuses a non-source update before it writes",
  nonSourceUpdate.exitCode === 1
    && nonSourceUpdate.writes.length === 0
    && nonSourceUpdate.stderr.join("").includes("non-source files"),
);
const narrowedProgramUpdate = runGateCase({
  argv: ["--update-baseline"],
  measure: () => gateMeasurement(
    new Map([["src/a.test.ts", 2]]),
    new Set(["src/a.test.ts"]),
  ),
});
check(
  "runner refuses a non-empty but narrowed program before it writes",
  narrowedProgramUpdate.exitCode === 1
    && narrowedProgramUpdate.writes.length === 0
    && narrowedProgramUpdate.stderr.join("").includes("omitted 1 expected"),
);
const narrowedProgramCompare = runGateCase({
  measure: () => gateMeasurement(
    new Map([["src/a.test.ts", 2]]),
    new Set(["src/a.test.ts"]),
  ),
});
check(
  "runner refuses a non-empty but narrowed program before it compares",
  narrowedProgramCompare.exitCode === 1
    && narrowedProgramCompare.writes.length === 0
    && narrowedProgramCompare.stdout.length === 0
    && narrowedProgramCompare.stderr.join("").includes("omitted 1 expected"),
);
const emptyInventoryUpdate = runGateCase({
  argv: ["--update-baseline"],
  loadExpectedInventory: () => new Set(),
});
check(
  "runner refuses an empty independent inventory before it writes",
  emptyInventoryUpdate.exitCode === 1
    && emptyInventoryUpdate.writes.length === 0
    && emptyInventoryUpdate.stderr.join("").includes("inventory was empty"),
);
const emptyInventoryCompare = runGateCase({
  loadExpectedInventory: () => new Set(),
});
check(
  "runner refuses an empty independent inventory before it compares",
  emptyInventoryCompare.exitCode === 1
    && emptyInventoryCompare.writes.length === 0
    && emptyInventoryCompare.stdout.length === 0
    && emptyInventoryCompare.stderr.join("").includes("inventory was empty"),
);
const bootstrapWrite = runGateCase({
  argv: ["--update-baseline"],
  loadBaseline: () => ({ exists: false, files: {} }),
  loadExpectedInventory: () => new Set(["src/bootstrap.test.ts"]),
  measure: () => gateMeasurement(
    new Map([["src/bootstrap.test.ts", 1]]),
    new Set(["src/bootstrap.test.ts"]),
  ),
});
check(
  "a complete first program bootstraps a baseline",
  bootstrapWrite.exitCode === 0
    && bootstrapWrite.writes.length === 1
    && bootstrapWrite.writes[0].files["src/bootstrap.test.ts"] === 1,
);
const heldRunner = runGateCase();
check(
  "a complete unchanged program holds",
  heldRunner.exitCode === 0
    && heldRunner.writes.length === 0
    && heldRunner.stdout.join("").includes("baseline held"),
);
const originalExitCode = process.exitCode;
process.exitCode = 0;
const regressionExitCode = main(gateDeps({
  measure: () => gateMeasurement(
    new Map([["src/a.test.ts", 3], ["src/b.test.ts", 1]]),
  ),
  writeStdout: () => {},
  writeStderr: () => {},
}));
const assignedExitCode = process.exitCode;
process.exitCode = originalExitCode ?? 0;
check(
  "a regression reaches the CLI exit code",
  regressionExitCode === 1 && assignedExitCode === 1,
);
const signalFailure = runGateCase({
  measure: () => runTsc(() => ({
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
  })),
});
check(
  "a compiler signal becomes a failing runner exit",
  signalFailure.exitCode === 1 && signalFailure.stderr.join("").includes("terminated by signal"),
);
const unexpectedStatus = runGateCase({
  measure: () => runTsc(() => ({
    status: 3,
    signal: null,
    stdout: "",
    stderr: "",
  })),
});
check(
  "an unaccepted compiler status becomes a failing runner exit",
  unexpectedStatus.exitCode === 1 && unexpectedStatus.stderr.join("").includes("tsc exited 3"),
);

// ── Config errors. A reviewer asked what happens to config codes outside the TS5xxx set
// the runner used to look for, e.g. TS6059. Running tsc against a deliberately broken
// config answered it, and the answer was worse than the question: a config error makes tsc
// report the CONFIG and none of the program's genuine type errors, so the measurement looks
// like every baselined file was fixed at once. Both real shapes are pinned below, taken
// verbatim from that run rather than invented.
//
// Shape 1: unattributed — no `file(line,col)` span at all, so the parser drops it silently.
const CONFIG_UNATTRIBUTED = [
  `error TS6059: File 'C:/x/outside.ts' is not under 'rootDir' 'C:/x/src'. 'rootDir' is expected to contain all source files.`,
  `  The file is in the program because:`,
  `    Matched by include pattern '../outside.ts' in 'C:/x/tsconfig.json'`,
].join("\n");
check(
  "an unattributed config diagnostic yields no per-file counts",
  countErrorsByFile(CONFIG_UNATTRIBUTED).size === 0,
);
// …so something other than the parser has to see it. This is that something, and it is the
// same function the runner calls — the rule used to be inline in `runTsc`, unreachable from
// here without spawning a compiler, and therefore verified only by hand.
check(
  "an unattributed diagnostic is detected as program-level",
  unattributedDiagnostics(CONFIG_UNATTRIBUTED).length === 1,
);
// The negative direction, which is the one that matters: a per-file diagnostic carries a
// `file(line,col)` span and must NOT be mistaken for a program-level one, or the gate would
// refuse to run every time a test file has an error — i.e. always.
check(
  "a real per-file diagnostic is not program-level",
  unattributedDiagnostics(TSC_OUTPUT).length === 0,
);
// …which is why the runner refuses on emptiness. Asserted here so the two halves are
// visibly connected: the parser CANNOT see this, therefore something else must.
check(
  "and is therefore caught by the empty-measurement refusal",
  isEmptyMeasurementAgainstBaseline(countErrorsByFile(CONFIG_UNATTRIBUTED), baseline) === true,
);

// Shape 2: attributed, but to the tsconfig rather than a source file. This one DOES parse,
// so emptiness cannot catch it — hence the separate non-source rule.
const CONFIG_ATTRIBUTED = countErrorsByFile(
  `../../tmp/cfg/tsconfig.json(1,76): error TS5023: Unknown compiler option 'typo'.`,
);
check("a config diagnostic attributed to tsconfig does parse", CONFIG_ATTRIBUTED.size === 1);
check(
  "a measurement naming a non-source file is refused",
  nonSourceMeasurements(CONFIG_ATTRIBUTED).length === 1,
);
// The direction that stops the rule from rejecting everything: real sources must pass, both
// extensions, and a path containing a dot in a directory name must not be mistaken for one.
check(
  "real TypeScript sources are never flagged as non-source",
  nonSourceMeasurements(
    new Map([
      ["src/a.test.ts", 1],
      ["src/b.test.tsx", 1],
      // A dot in a DIRECTORY name must not be read as an extension.
      ["src/v1.2/c.test.ts", 1],
      // `.mts`/`.cts` are real sources here, not config. A reviewer found that `/\.tsx?$/`
      // rejected them while `scripts/electron-flags.d.mts` and `scripts/uv-targets.d.mts`
      // are committed inside this project's `scripts` include — so a diagnostic in either
      // would have been refused as "tsc was diagnosing the configuration", the exact
      // misdiagnosis the non-source rule exists to prevent. Nothing was masked only
      // because neither file currently has diagnostics.
      ["scripts/electron-flags.d.mts", 1],
      ["scripts/uv-targets.d.mts", 1],
      ["scripts/legacy.cts", 1],
    ]),
  ).length === 0,
);
// ── `nonTestEntries` drives the generated `_note`'s production-file list. A mutation sweep
// found it completely unpinned in BOTH directions: matching nothing silently drops the
// sentence, matching everything wrongly reports test files as production code. It is
// documentation rather than enforcement, which is exactly why nobody would notice.
const ENTRIES = {
  "src/a/__tests__/x.test.ts": 1,
  "src/__probes__/p.ts": 1,
  "test/renderer/helpers.ts": 1,
  "src/preload/internal-surface.ts": 4,
  "src/main/window-manager.ts": 1,
};
check(
  "reports production files as non-test",
  nonTestEntries(ENTRIES).join(",")
    === "src/preload/internal-surface.ts,src/main/window-manager.ts",
);
check("never reports a __tests__ file", !nonTestEntries(ENTRIES).some((f) => f.includes("__tests__")));
check("never reports a __probes__ file", !nonTestEntries(ENTRIES).some((f) => f.includes("__probes__")));
check("never reports a test/ file", !nonTestEntries(ENTRIES).some((f) => f.startsWith("test/")));

// ── The gate must not use an incremental compiler.
//
// `tsconfig.tests.json` inherits from `tsconfig.json`, which sets `incremental: true`. That
// made this gate's error count depend on compiler cache state rather than on the source. The
// precondition is specific and worth stating, since a reviewer could not reproduce the loose
// version: warm runs with the SAME options are stable, but a buildinfo written by a run with
// DIFFERENT options and then read by the gate gives 1,625 instead of 1,626 —
// `internal-api-surface.ts` reporting 2 rather than 3. `incremental: false` removes the class
// by construction rather than patching an instance; see `tsconfig.tests.json` for the numbers.
//
// Asserted on the EFFECTIVE option after `extends` resolution, not on the literal text of the
// config. Three earlier attempts got this wrong in instructive ways:
//   1. Giving the tests config its own `tsBuildInfoFile` and asserting the two paths differ.
//      True, but the property was irrelevant — separating the cache files fixed only the
//      shared-file case, so the assertion would have kept passing while the bug remained.
//   2. Asserting the literal `compilerOptions.incremental` in each file via a hand-rolled
//      `//`-comment stripper. That pins the MECHANISM, not the property: it would have
//      reddened on a legitimate alternative fix (dropping `incremental` from the root config),
//      and the stripper had its own failure class — a legal trailing comment or trailing comma
//      raised a `JSON.parse` SyntaxError instead of a named check failure.
//   3. `ts.getParsedCommandLineOfConfigFile`, suggested by a reviewer. Not available: this
//      repo is on the NATIVE typescript package (7.0.2), whose JS API surface is gone —
//      `readConfigFile`, `parseJsonConfigFileContent` and `ts.sys` are all undefined. The same
//      removal is why `webpack.config.cjs` moved off ts-loader.
//
// So ask the binary. `tsc --showConfig` resolves `extends` and reports the options the PROGRAM
// runs with — and it is the very binary the gate spawns, so it cannot disagree with the gate.
// Measured at ~117 ms, which is why this file's "does not run tsc" rule has one documented
// exception: config resolution, never typechecking.
//
// It lives in the self-test rather than the gate because it protects the gate's own
// correctness, not its failure taxonomy, and it exists at all because the override sits among
// comments arguing this config should diverge from the root as little as possible — so
// "finish the cleanup" is the natural next edit. A comment cannot fail; this can.
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function effectiveIncremental(configName) {
  const result = spawnSync(
    process.execPath,
    [
      resolve(ROOT_DIR, "node_modules", "typescript", "lib", "tsc.js"),
      "-p", resolve(ROOT_DIR, configName), "--showConfig",
    ],
    { cwd: ROOT_DIR, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tsc --showConfig failed: ${result.stderr}`);
  return JSON.parse(result.stdout)?.compilerOptions?.incremental;
}
// Only the property that matters. Deliberately NOT paired with an assertion about the root
// config: whether the root is incremental is its own business, and asserting it would turn a
// legitimate change there into a failure here.
//
// `!== true`, not `=== false`. A reviewer measured that `--showConfig` reports `undefined`
// when nothing sets `incremental` anywhere — off is the default — so `=== false` asserts
// "explicitly set to false" rather than "not incremental", and would redden on a state that
// satisfies the property (drop `incremental: true` from the root, then drop the now-redundant
// override here). That is the same pin-the-mechanism mistake this assertion has already been
// rewritten twice to avoid.
check("the gate's program is not incremental", effectiveIncremental("tsconfig.tests.json") !== true);

// ── `readBaselineFilesOrEmpty`: ONLY a missing file may be tolerated.
//
// These cases were written once, verified, and then DELETED by a later splice of mine
// that replaced everything between two anchors — after which I reported them as landed. A
// critic reviewer caught it: the symbol appeared only in the import list, 35 `check()` calls
// referenced none of it, and three mutations survived, including the one that re-opens the
// write-path fail-open (unreadable or corrupt baseline + broken compiler → `{}` → the
// empty-measurement guard passes → a real baseline is overwritten with an empty measurement).
// The three unused imports left behind were the fingerprint, and nothing caught them because
// `.mjs` is outside what `tsc` checks here.
const scratch = mkdtempSync(join(tmpdir(), "typecheck-gate-selftest-"));
const goodPath = join(scratch, "good.json");
writeFileSync(goodPath, JSON.stringify({ schemaVersion: 1, files: { "a.test.ts": 2 } }), "utf8");
const badPath = join(scratch, "bad.json");
writeFileSync(badPath, "not json at all", "utf8");
check(
  "a MISSING baseline reads as empty, so bootstrapping is possible",
  Object.keys(readBaselineFilesOrEmpty(join(scratch, "absent.json"))).length === 0,
);
check("a valid baseline returns its files", readBaselineFilesOrEmpty(goodPath)["a.test.ts"] === 2);
check(
  "a MALFORMED baseline throws rather than reading as empty",
  (() => {
    try { readBaselineFilesOrEmpty(badPath); return false; } catch { return true; }
  })(),
);
// A non-ENOENT read error must also throw. A directory is the portable way to produce one
// (EISDIR on Linux, EPERM/EISDIR on Windows); an unreadable-permissions fixture is not
// portable, and the point is that the carve-out is ENOENT-ONLY, not the specific errno.
check(
  "a non-ENOENT read error throws rather than reading as empty",
  (() => {
    try { readBaselineFilesOrEmpty(scratch); return false; } catch { return true; }
  })(),
);
const invalidBaselines = [
  ["a non-object baseline", []],
  ["a baseline with a stale schema", { schemaVersion: 0, files: {} }],
  ["a baseline missing files", { schemaVersion: 1 }],
  ["a baseline with null files", { schemaVersion: 1, files: null }],
  ["a baseline with array files", { schemaVersion: 1, files: [] }],
  ["a baseline with a negative count", { schemaVersion: 1, files: { "a.test.ts": -1 } }],
  ["a baseline with a fractional count", { schemaVersion: 1, files: { "a.test.ts": 1.5 } }],
  ["a baseline with a string count", { schemaVersion: 1, files: { "a.test.ts": "1" } }],
];
for (const [name, payload] of invalidBaselines) {
  const invalidPath = join(scratch, `${name.replaceAll(" ", "-")}.json`);
  writeFileSync(invalidPath, JSON.stringify(payload), "utf8");
  check(
    `${name} throws rather than reading as empty`,
    (() => {
      try { readBaselineFilesOrEmpty(invalidPath); return false; } catch { return true; }
    })(),
  );
}

if (failures.length > 0) {
  process.stderr.write(
    `[test-typecheck-self-test] the gate is not detecting what it claims:\n  ${failures.join("\n  ")}\n`,
  );
  process.exit(1);
}
process.stdout.write("[test-typecheck-self-test] OK\n");
