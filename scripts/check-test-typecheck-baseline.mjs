/**
 * Typecheck gate for the files `tsconfig.json` leaves out.
 *
 * The root config excludes `src/**\/__tests__/**`, `src/**\/__probes__/**`, the preload
 * tree and `renderer.tsx`; `tsconfig.build.json` re-declares the same exclusions rather
 * than relaxing them, and `typecheck` is the only script that runs `tsc`. So no
 * configuration in this repo typechecked a test file: one could reference an unimported
 * symbol, pass `bun run typecheck`, and reach CI green — failing only if a test happened
 * to execute that line.
 *
 * The debt is real (1,626 errors across 312 files), so this is a RATCHET, not a
 * pass/fail: a per-file error count is committed as a baseline, and the gate fails when
 * any file gains errors or when a file with no baseline entry has any. New test files are
 * therefore fully typechecked from the day they are written, and existing ones can only
 * get better.
 *
 * Per-FILE counts rather than per-error identity, deliberately: line numbers move
 * whenever anything above them is edited, so an identity keyed on position would fail on
 * unrelated edits and train everyone to re-baseline. A count is stable under moves and
 * still catches the case that matters — a file that gains an error.
 *
 * `--pretty false` is not cosmetic. `tsc`'s default output is ANSI-coloured, and this repo
 * has already been bitten by `grep "error TS"` silently matching nothing because of the
 * escape codes. The flag gives one plain `file(line,col): error TSxxxx: msg` per line.
 *
 * FAILING CLOSED IS THE HARD PART HERE, and it is why this gate carries three checks that
 * the repo's other two baseline gates do not need. `check-knip-baseline.mjs` parses JSON, so
 * an unrunnable tool yields empty stdout and `JSON.parse` throws; `check-cluster-scope.mjs`
 * treats any nonzero exit as failure. Both get fail-closed behaviour for free. This gate can
 * use NEITHER mechanism: `tsc` exits nonzero precisely when it succeeds at finding the errors
 * being measured, and the output is plain text, so there is no parse step to throw on
 * emptiness. Silence is indistinguishable from success unless something says otherwise.
 *
 * Every row below was reproduced against this gate. The first was found by a security
 * reviewer, who then independently re-derived the whole table and corrected three of my
 * claims about it — the corrections are folded in, including the config shapes, because a
 * scenario described too loosely for someone else to reproduce is not evidence.
 *
 *   scenario                                    tsc  output shape              fires
 *   ------------------------------------------  ---  ------------------------  --------------
 *   `tsc.js` missing or moved                     1  node module-resolution    EMPTY (sole)
 *   EXTENDING config, `files:[]`+`include:[]`     0  NOTHING AT ALL            EMPTY (sole)
 *   STANDALONE config, `files:[]`                 2  attributed TS18002        NON-SOURCE (sole)
 *   unknown compiler option (TS5023)              1  attributed + REAL errors  NON-SOURCE (sole)
 *   rootDir violation (TS6059)                    1  unattributed, column 0    UNATTRIBUTED+EMPTY
 *   no inputs / missing -p / missing @types     1-2  unattributed, column 0    UNATTRIBUTED+EMPTY
 *
 * Row 2 is the reason emptiness must be checked at all: a config that silently checks
 * nothing exits ZERO with no output, so neither the status nor the text can betray it. Note
 * it needs an EXTENDING config — a standalone `files:[]` gives row 3 instead, exit 2 with an
 * attributed TS18002. Both are real; naming only "files and include are empty" left the
 * reviewer unable to reproduce row 2 and reasonably concluding I had mis-derived it.
 *
 * Config errors split into two classes, and the split matters:
 *   - UNATTRIBUTED (TS6059, TS18003, TS5058, TS2688) SUPPRESSES the program. tsc aborts
 *     before semantic checking, so none of the genuine type errors are reported and the
 *     measurement is empty.
 *   - ATTRIBUTED (TS5023, TS18002) does NOT suppress it. TS5023 arrives ALONGSIDE the real
 *     per-file diagnostics — verified. So "a config error makes tsc report the config
 *     instead of the program" is true only of the first class. An earlier version of this
 *     comment stated it absolutely, which contradicted `nonSourceMeasurements`' own
 *     (correct) account of the same row.
 *
 * Consequently, and contrary to what this comment used to claim, the three checks do NOT
 * each own exactly one row. EMPTY and NON-SOURCE each have sole custody of two rows. But
 * UNATTRIBUTED has sole custody of NOTHING: because its whole class suppresses the program,
 * EMPTY fires on every row it fires on. Neither the reviewer nor I could construct an
 * unattributed diagnostic co-occurring with real ones.
 *
 * It is kept anyway, for two reasons that are not coverage: it produces a far better
 * diagnosis (it prints the program-level diagnostics, where EMPTY can only say "the compiler
 * did not run" — useless for a rootDir violation), and the attributed class proves
 * co-occurrence is real in the sibling class, so an unattributed shape that co-occurs is
 * plausible rather than impossible. That is insurance against an unobserved shape, and this
 * comment says so rather than implying custody it does not have.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const PROJECT = resolve(ROOT, "tsconfig.tests.json");
const BASELINE = resolve(ROOT, "test-typecheck-baseline.json");
export const SCHEMA_VERSION = 1;

/**
 * One `tsc --pretty false` diagnostic line.
 *
 * The file must start at column 0 with a NON-SPACE character. That is what separates a
 * real diagnostic from a continuation line: tsc indents those, and a 'related' one can
 * itself carry a full `file(line,col): error TSxxxx:` span, which an anchor alone does
 * not exclude — a leading `.*` from position 0 happily swallows the leading spaces. Found by
 * mutating the pattern and watching the self-test stay green, which is the same fixture
 * failure this gate exists to catch, one level up.
 *
 * The path is `.*?` — LAZY, and deliberately not `[^(]*`. The earlier `[^(]*` could not
 * cross a `(`, so a path containing one (`odd(name).test.ts`) matched nothing at all and the
 * file vanished from the measurement entirely: a new test file with type errors would have
 * reached CI green, which is the exact hole this gate exists to close. Found by a mutation
 * sweep — weakening that character class left the self-test green, and writing the fixture
 * to prove the fix revealed the pattern had never handled it.
 *
 * Lazy rather than greedy matters for the opposite case. Greedy `.*` would backtrack to the
 * LAST span on the line, so a diagnostic whose MESSAGE quotes another span
 * (`a.ts(1,2): error TS2322: see other(9,9): error TS1: x`) would be attributed to a file
 * name containing most of the message. Lazy takes the first span, which is the real one.
 * Both directions are pinned in the self-test; the ten shapes were checked against the old
 * and new patterns side by side before this changed.
 */
const DIAGNOSTIC_RE = /^(?<file>[^\s].*?)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+):/;

/** Per-file error counts, keyed by repo-relative POSIX path. */
export function countErrorsByFile(tscStdout) {
  const counts = new Map();
  for (const raw of tscStdout.split(/\r?\n/)) {
    const match = DIAGNOSTIC_RE.exec(raw);
    if (!match?.groups) continue;
    const file = match.groups.file.replaceAll("\\", "/");
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/**
 * What changed against the baseline.
 *
 * `regressed` is the failure. `improved` and `fixed` are reported so the message tells
 * someone who cleaned a file that they should re-baseline, rather than leaving them to
 * wonder why the number moved.
 */
export function compareToBaseline(counts, baseline) {
  const regressed = [];
  const improved = [];
  const fixed = [];
  for (const [file, count] of counts) {
    const before = baseline[file] ?? 0;
    if (count > before) regressed.push({ file, before, after: count });
    else if (count < before) improved.push({ file, before, after: count });
  }
  for (const file of Object.keys(baseline)) {
    if (!counts.has(file)) fixed.push(file);
  }
  regressed.sort((a, b) => a.file.localeCompare(b.file, "en"));
  improved.sort((a, b) => a.file.localeCompare(b.file, "en"));
  return { regressed, improved, fixed: fixed.sort() };
}

/**
 * Did the measurement come back empty while the baseline expects errors?
 *
 * Exported so the self-test pins THIS function rather than a restatement of it — a
 * re-spelled condition in the test is how a guard and its test drift apart.
 *
 * KNOWN LIMIT, stated because both reviewers reached for it independently and neither could
 * make it reachable: this is a BOUNDARY check, not a coverage check. A PARTIAL measurement —
 * one file parsed, the other 311 silently absent — passes it, and the comparison then reports
 * 311 files "fixed" at exit 0. Nobody has produced a tsc invocation that truncates that way:
 * config errors suppress the program entirely (empty, caught here), and the one realistic
 * truncation route, output exceeding `maxBuffer`, sets `result.error`, which `runTsc` throws
 * on. So it is theoretical rather than a defect — but it is a real hole in what this function
 * can promise, and the next person should not read `counts.size === 0` as "the measurement is
 * complete".
 */
export function isEmptyMeasurementAgainstBaseline(counts, baselineFiles) {
  return counts.size === 0 && Object.keys(baselineFiles).length > 0;
}

/**
 * Measured paths that are not TypeScript sources.
 *
 * The other half of the unattributed-diagnostic check, and the case a reviewer's TS6059
 * question uncovered: some config errors ARE attributed, just not to a source file.
 * `error TS5023: Unknown compiler option` arrives as `…/tsconfig.json(1,76): error TS5023:`,
 * which the per-file parser happily counts as a file named `tsconfig.json`.
 *
 * That alone would still fail the gate — an unbaselined path with errors is a regression —
 * but it would fail as "tsconfig.json gained 1 error", sending the reader after a source
 * bug that does not exist. Worse, under `--update-baseline` it would be written INTO the
 * baseline. Refusing outright keeps the diagnosis honest and the baseline clean.
 *
 * Verified against real output rather than assumed: with a deliberately broken config, tsc
 * emitted TS6059 unattributed AND TS5023 attributed to the tsconfig.
 *
 * The extension set is `.ts`/`.tsx`/`.mts`/`.cts`, NOT just `.ts`/`.tsx`. A reviewer caught
 * that `/\.tsx?$/` rejects `.mts`, and `scripts/electron-flags.d.mts` and
 * `scripts/uv-targets.d.mts` are committed and inside this project's `scripts` include
 * (confirmed with `tsc --listFilesOnly`). A diagnostic in either would have failed the gate
 * with the exact misleading message this function exists to avoid — "was diagnosing the
 * configuration" — about a real source file. Nothing was masked, because neither file
 * currently has diagnostics, which is precisely why only a reviewer would find it.
 */
export function nonSourceMeasurements(counts) {
  return [...counts.keys()].filter((f) => !/\.[cm]?tsx?$/.test(f));
}

/**
 * Diagnostics tsc attributed to no file at all.
 *
 * ASK THE SHAPE, DO NOT LIST THE CODES. This replaced a `TS5\d{3}|TS18003` test after a
 * reviewer asked what happens to config codes outside that set. A diagnostic with no
 * `file(line,col)` span is not about a file, it is about the program — and the per-file
 * parser drops it silently, so without this the gate measures nothing and says so in the
 * language of success. Verified against real output: `error TS6059: File '…' is not under
 * 'rootDir'` begins at column zero with no span, while genuine per-file diagnostics always
 * carry one.
 *
 * Pure and exported for one reason: the rule previously lived inline in `runTsc`, where the
 * self-test could not reach it without spawning a compiler, so it was verified only by hand
 * with throwaway configs. An unpinned rule is an untested rule. Here it is the same function
 * the runner calls, pinned against real tsc text.
 */
export function unattributedDiagnostics(tscStdout) {
  return tscStdout.split(/\r?\n/).filter((line) => /^error TS\d+:/.test(line));
}

function runTsc() {
  const result = spawnSync(
    process.execPath,
    [resolve(ROOT, "node_modules", "typescript", "lib", "tsc.js"),
      "-p", PROJECT, "--noEmit", "--pretty", "false"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`tsc terminated by signal ${result.signal}`);
  // Statuses are NOT the failure signal here, which is the whole difficulty: `tsc` exits 1
  // exactly when it succeeds at finding the errors this gate measures. 0/1/2 are all
  // legitimate; anything else is a broken invocation. The real signals are the two content
  // checks below plus the empty-measurement refusal in `main()`.
  //
  // Measured across the docstring's scenarios, so this is not an assumption: the HEALTHY
  // control exits 1, four broken configs also exit 1, two exit 2, and the silent-no-op
  // config exits 0. Status cannot discriminate in either direction — a reviewer proposed
  // tightening the accepted set and then withdrew it on the same evidence. Do NOT tighten;
  // rejecting 2 would not catch the dangerous row (exit 0) and would add false failures.
  if (result.status !== 0 && result.status !== 1 && result.status !== 2) {
    throw new Error(`tsc exited ${result.status}\n${result.stdout}${result.stderr}`);
  }
  const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // Catches config errors that are EMITTED AND UNATTRIBUTED — not "every config code",
  // which is what an earlier draft of this comment claimed. The other shapes are covered by
  // the other two checks; see the matrix in the module docstring for which catches what.
  const unattributed = unattributedDiagnostics(stdout);
  if (unattributed.length > 0) {
    throw new Error(
      "tsc reported program-level errors, so the per-file measurement is not trustworthy:\n"
      + `${unattributed.join("\n")}\n\nFull output:\n${stdout}`,
    );
  }
  return stdout;
}

/**
 * Baseline entries that are NOT test files.
 *
 * `tsconfig.tests.json` pulls in whatever the tests import, so a few production files land
 * in the baseline too. For the `src/preload` ones that is genuine coverage rather than
 * duplication — the root `tsconfig.json` excludes `src/preload`, and webpack compiles it
 * with esbuild-loader transpile-only, so nothing else typechecks it at all.
 *
 * Do NOT generalise that to every production entry. The root config excludes `src/preload`
 * and the probe/test dirs, and nothing else — `src/main`, for instance, is fully covered by
 * `check:typecheck`. A note claiming exclusivity for all of them was false for exactly one
 * file, which is why the generated text names the directory rather than asserting the rule.
 *
 * Emitted INTO the written baseline rather than hand-written into it — a static header note
 * would be silently dropped by `--update-baseline`, and a note that vanishes on
 * regeneration is worse than none.
 */
const TEST_FILE_RE = /(^|\/)(__tests__|__probes__|test)\//;
export function nonTestEntries(files) {
  return Object.keys(files).filter((f) => !TEST_FILE_RE.test(f));
}

/**
 * The committed baseline's `files`, or `{}` when there is no baseline yet.
 *
 * ENOENT is the first-ever run — there is nothing to protect, so the guard must not block
 * bootstrapping. Anything else (including unparseable JSON) throws: if the file exists but
 * cannot be read, we cannot tell whether a real baseline is about to be destroyed, and
 * guessing is what fail-open looks like. Delete the file deliberately to bootstrap.
 *
 * Exported for the same reason as the three refusals: a mutation sweep showed that replacing
 * the ENOENT check with an unconditional `return {}` left the self-test GREEN, and that
 * mutation re-opens the write-path fail-open (unreadable baseline + broken compiler → `{}` →
 * the guard passes → a real baseline is overwritten with an empty measurement). This was the
 * only guard-adjacent function in the file that was not exported, i.e. the only one the
 * self-test could not pin.
 */
export function readBaselineFilesOrEmpty(path = BASELINE) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  return JSON.parse(raw)?.files ?? {};
}

function main() {
  const update = process.argv.includes("--update-baseline");
  const counts = countErrorsByFile(runTsc());

  // Before comparing OR writing: a measurement attributed to something that is not a
  // TypeScript source means the compiler was diagnosing the configuration, not the code.
  const nonSource = nonSourceMeasurements(counts);
  if (nonSource.length > 0) {
    throw new Error(
      `tsc attributed errors to non-source files (${nonSource.join(", ")}), which means it`
      + " was diagnosing the configuration. Refusing to compare or write a baseline.",
    );
  }

  // THE empty-measurement refusal — ONE call site, hoisted above both branches, guarding
  // the write and the compare together. Do not push it into `if (update)`.
  //
  // It used to sit inside the compare path only, which left `--update-baseline` fail-open: a
  // security reviewer reproduced it end-to-end with `tsc.js` unresolvable — the baseline was
  // rewritten from 312 entries to `files: {}` at rc=0, after which the compare path's own
  // empty-baseline carve-out reported "baseline held" green indefinitely. Reachable by
  // running the update script mid-dependency-bump with typescript half-installed.
  //
  // Hoisting it here is what fixed that, and it is why there is exactly one call site rather
  // than two. An earlier version of this comment said "same predicate as the compare path,
  // asked twice" — describing the two-call-site shape this replaced. A reviewer flagged the
  // wording precisely because it licenses moving the check back down into the update branch,
  // which would restore the original bug.
  const onDiskFiles = readBaselineFilesOrEmpty();
  if (isEmptyMeasurementAgainstBaseline(counts, onDiskFiles)) {
    // Wording covers both callers: `update` is about to overwrite, `compare` is about to
    // report. Saying only "refusing to overwrite" misdescribes half the runs.
    throw new Error(
      "tsc produced no diagnostics while the committed baseline expects them — the compiler"
      + " did not run. Refusing to treat that as an improvement or to write it to the"
      + " baseline.",
    );
  }

  if (update) {
    const sorted = Object.fromEntries(
      [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, "en")),
    );
    const nonTest = nonTestEntries(sorted);
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      _note:
        "Generated by scripts/check-test-typecheck-baseline.mjs --update-baseline."
        + " Per-file error counts under tsconfig.tests.json; a file absent from `files`"
        + " must have zero errors."
        + (nonTest.length > 0
          ? ` Not every entry is a test file: ${nonTest.length} production file(s) are`
            + ` reached through test imports (${nonTest.join(", ")}). Those under`
            + " src/preload are excluded by the root tsconfig, so for them this gate is the"
            + " only typecheck rather than a duplicate of check:typecheck."
          : ""),
      files: sorted,
    };
    writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    process.stdout.write(
      `[test-typecheck] baseline written: ${counts.size} files, ${total} errors\n`,
    );
    return;
  }

  const parsed = JSON.parse(readFileSync(BASELINE, "utf8"));
  if (parsed?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `baseline schemaVersion ${parsed?.schemaVersion} != ${SCHEMA_VERSION}; re-run with --update-baseline`,
    );
  }
  const { regressed, improved, fixed } = compareToBaseline(counts, parsed.files ?? {});

  if (regressed.length > 0) {
    process.stderr.write("[test-typecheck] new type errors in files the baseline covers\n");
    for (const row of regressed) {
      process.stderr.write(`  ${row.file}: ${row.before} -> ${row.after}\n`);
    }
    process.stderr.write(
      "\nThese files are typechecked by tsconfig.tests.json. Fix the errors — do NOT\n"
      + "re-baseline to make this pass. `bun run check:typecheck-tests:update` exists for\n"
      + "recording IMPROVEMENTS after you have cleaned a file.\n",
    );
    process.exit(1);
  }

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  process.stdout.write(
    `[test-typecheck] baseline held: ${counts.size} files, ${total} errors`
    + `${improved.length > 0 || fixed.length > 0
      ? ` (${improved.length} file(s) improved, ${fixed.length} fully fixed —`
        + " run check:typecheck-tests:update to lock it in)"
      : ""}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
