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
 * The debt is real (1600+ errors across 320 files), so this is a RATCHET, not a
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

function runTsc() {
  const result = spawnSync(
    process.execPath,
    [resolve(ROOT, "node_modules", "typescript", "lib", "tsc.js"),
      "-p", PROJECT, "--noEmit", "--pretty", "false"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  // tsc exits 1 when it emits diagnostics and 2 on a config/crash failure. Only the
  // former is expected here; anything else means the gate itself is broken and must not
  // be read as "no errors".
  if (result.status !== 0 && result.status !== 1 && result.status !== 2) {
    throw new Error(`tsc exited ${result.status}\n${result.stdout}${result.stderr}`);
  }
  const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (/error TS(5\d{3}|18003)/.test(stdout)) {
    throw new Error(`tsc could not load the project — the gate is not measuring anything:\n${stdout}`);
  }
  return stdout;
}

/**
 * Baseline entries that are NOT test files.
 *
 * `tsconfig.tests.json` pulls in whatever the tests import, so a few production files land
 * in the baseline too. They are legitimately covered rather than duplicated: the root
 * `tsconfig.json` excludes `src/preload*` and the probe dirs, so for those files this gate
 * is the only typecheck they get.
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
            + ` reached through test imports (${nonTest.join(", ")}). The root tsconfig`
            + " excludes those, so this gate is the only typecheck they get — not a"
            + " duplicate of check:typecheck."
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
  // the baseline expects some, means the compiler did not run — not that 290 files were
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
