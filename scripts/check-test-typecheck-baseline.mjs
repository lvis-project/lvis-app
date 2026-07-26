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
 * Each row below was reproduced against this gate, not reasoned about. The first was found
 * by a security reviewer; the rest came from asking what else could produce a measurement
 * that looks like mass improvement.
 *
 *   scenario                            tsc  output shape                which check fires
 *   ----------------------------------  ---  --------------------------  -----------------
 *   `tsc.js` missing or moved             1  node module-resolution err  empty measurement
 *   `include`/`files` both empty          0  NOTHING AT ALL              empty measurement
 *   rootDir violation (TS6059)            1  unattributed, column zero   unattributed
 *   unknown compiler option (TS5023)      1  attributed to tsconfig      non-source path
 *
 * Note the second row: a config that silently checks nothing exits ZERO with no output, so
 * neither the status nor the text can betray it. And note that a config error makes tsc
 * report the config INSTEAD of the program — none of the genuine type errors appear — which
 * is what turns any of these into "every file fully fixed" rather than a visible failure.
 *
 * So none of the three is redundant with the others, and none is redundant with the exit
 * status. Removing one silently re-opens exactly one row.
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
 * not exclude — `[^(]+` from position 0 happily swallows the leading spaces. Found by
 * mutating the pattern and watching the self-test stay green, which is the same fixture
 * failure this gate exists to catch, one level up.
 */
const DIAGNOSTIC_RE = /^(?<file>[^\s(][^(]*)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+):/;

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
 * emitted TS6059 unattributed AND TS5023 attributed to the tsconfig, and reported none of
 * the program's genuine type errors — so a config error yields a measurement that looks
 * like mass improvement. Every baselined path is `.ts` or `.tsx` (268 + 44).
 */
export function nonSourceMeasurements(counts) {
  return [...counts.keys()].filter((f) => !/\.tsx?$/.test(f));
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
  // FAIL CLOSED on an empty measurement. A run that parsed no diagnostics at all, while
  // the baseline expects some, means the compiler did not run — not that every file was
  // fixed at once. The project-load check in `runTsc` does NOT cover every such case: a
  // missing or moved `tsc.js` exits 1 with a node module-resolution error that matches
  // neither TS5xxx nor TS18003, which a security reviewer demonstrated. Without this the
  // gate printed "baseline held: 0 files, 0 errors" and exited 0 — a gate that reports
  // green forever, which is worse than no gate.
  //
  // An earlier comment in the self-test claimed the runner's own check covered this. It
  // did not. `check-knip-baseline.mjs` is the fail-closed precedent in this repo.
  const baselineFiles = parsed.files ?? {};
  if (isEmptyMeasurementAgainstBaseline(counts, baselineFiles)) {
    throw new Error(
      "tsc produced no diagnostics while the baseline expects them — the compiler did not"
      + " run. Refusing to report this as an improvement.",
    );
  }
  const { regressed, improved, fixed } = compareToBaseline(counts, baselineFiles);

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
