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
 * The debt is real (1,613 errors across 310 files), so this is a RATCHET, not a
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
 * FAILING CLOSED IS THE HARD PART HERE, and it is why this gate carries explicit config
 * refusals plus a program-coverage check that the repo's other two baseline gates do not need.
 * `check-knip-baseline.mjs` parses JSON, so an
 * unrunnable tool yields empty stdout and `JSON.parse` throws; `check-cluster-scope.mjs` treats
 * any nonzero exit as failure. Both get fail-closed behaviour for free. This gate can use
 * NEITHER mechanism: `tsc` exits nonzero precisely when it succeeds at finding the errors being
 * measured, and the output is plain text, so there is no parse step to throw on emptiness.
 * Silence is indistinguishable from success unless something says otherwise.
 *
 * Every row below was reproduced against this gate, by me and independently by two reviewers
 * who between them corrected the config shapes, the co-occurrence claim, and the custody claim.
 *
 *   scenario                                    tsc  output shape              refused by
 *   ------------------------------------------  ---  ------------------------  ------------
 *   `tsc.js` missing or moved                     1  node module-resolution    EMPTY
 *   EXTENDING config, `files:[]`+`include:[]`     0  NOTHING AT ALL            EMPTY
 *   rootDir violation (TS6059)                    1  unattributed, column 0    EMPTY
 *   no inputs / bad lib / absent file / @types  1-2  unattributed, column 0    EMPTY
 *   STANDALONE config, `files:[]`                 2  attributed TS18002        NON-SOURCE
 *   unknown option (TS5023), bad target (TS6046)  1  attributed + REAL errors  NON-SOURCE
 *
 * Row 2 is the reason emptiness must be checked at all: a config that silently checks nothing
 * exits ZERO with no output, so neither the status nor the text can betray it. It needs an
 * EXTENDING config — a standalone `files:[]` gives the attributed row instead.
 *
 * WHY TWO REFUSALS AND NOT THREE. Config errors split into two classes, and the split is
 * mechanical rather than incidental:
 *   - UNATTRIBUTED diagnostics mean PROGRAM CONSTRUCTION failed — an unresolvable root file, a
 *     missing type root, a rootDir violation, no inputs. tsc aborts before the semantic pass,
 *     so the measurement is NECESSARILY empty and EMPTY necessarily catches it. Measured across
 *     six shapes: every unattributed one reported zero real per-file diagnostics.
 *   - ATTRIBUTED config diagnostics are option VALIDATION failures. They do not stop program
 *     construction, so checking proceeds and real per-file errors arrive alongside them —
 *     verified for TS5023 and TS6046. NON-SOURCE is what catches those, via the `tsconfig.json`
 *     path appearing in the measurement.
 *
 * So an earlier third refusal on unattributedness owned no row: it could only fire where EMPTY
 * already did. Because the classes are asymmetric, "the sibling class co-occurs, so this one
 * plausibly can" does not transfer, which left only insurance — the layered-defence argument
 * this repo rejects. `unattributedDiagnostics` survives as a MESSAGE ENRICHER inside the EMPTY
 * refusal: "the compiler did not run" is useless for a rootDir violation, and printing the
 * program-level lines was the one real benefit the third check had.
 *
 * PROGRAM COVERAGE closes the remaining narrow-config route. The same `tsc` invocation emits
 * `--listFiles` output, which is compared with an independent Git-backed inventory of the
 * intended TypeScript sources. A source that exists in `src`, `scripts`, or `test` but is absent
 * from the compiler program refuses both comparison and baseline writes. That covers both
 * baselined files and brand-new source files; checking only the baseline would leave the latter
 * invisible. Deliberate config exclusions and files actually deleted from disk are excluded from
 * the expected inventory explicitly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const PROJECT = resolve(ROOT, "tsconfig.tests.json");
const BASELINE = resolve(ROOT, "test-typecheck-baseline.json");
export const SCHEMA_VERSION = 1;

const SOURCE_FILE_RE = /\.[cm]?tsx?$/;
const INTENDED_SOURCE_RE = /^(?:src|scripts|test)\//;

function normalizeRepoRelativePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isExpectedSourcePath(path) {
  return SOURCE_FILE_RE.test(path)
    && INTENDED_SOURCE_RE.test(path)
    && path !== "src/preload.cjs.ts"
    && !(path.startsWith("src/") && path.includes("/__probes__/"));
}

/**
 * TypeScript source paths reported by `tsc --listFiles` that belong to the intended program.
 *
 * The compiler reports absolute paths on some platforms and relative paths on others. Normalize
 * both to the repo-relative POSIX spelling used by the baseline and Git inventory.
 */
export function programSourceFiles(tscOutput) {
  const files = new Set();
  for (const raw of tscOutput.split(/\r?\n/)) {
    const candidate = raw.trim();
    if (!SOURCE_FILE_RE.test(candidate)) continue;
    const repoRelative = normalizeRepoRelativePath(relative(ROOT, resolve(ROOT, candidate)));
    if (INTENDED_SOURCE_RE.test(repoRelative)) files.add(repoRelative);
  }
  return files;
}

/**
 * Convert the null-delimited output of `git ls-files` into the intended current source inventory.
 *
 * Git's cached view retains a path that a developer has deleted but not staged. That path is
 * intentionally omitted when it no longer exists on disk: deletion is a legitimate "fixed"
 * result, while a still-present file omitted by the compiler is not.
 */
export function expectedSourceFilesFromGitOutput(gitOutput, exists = existsSync) {
  const files = new Set();
  for (const raw of gitOutput.split("\0")) {
    const path = normalizeRepoRelativePath(raw);
    if (!isExpectedSourcePath(path) || !exists(resolve(ROOT, path))) continue;
    files.add(path);
  }
  return files;
}

export function missingExpectedSources(expectedInventory, programFiles) {
  return [...expectedInventory].filter((file) => !programFiles.has(file)).sort();
}

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
 * This remains a BOUNDARY check, deliberately separate from coverage. It detects a compiler
 * that produced no file diagnostics while the baseline expects some; `decide` immediately
 * follows it with the independent inventory comparison that detects a non-empty but narrowed
 * program. Keep the predicates narrow so the self-test can pin each failure shape directly.
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
  return [...counts.keys()].filter((f) => !SOURCE_FILE_RE.test(f));
}

/**
 * Diagnostics tsc attributed to no file at all.
 *
 * NOT a refusal — a MESSAGE ENRICHER for the empty-measurement refusal in `decide`. It was a
 * third refusal until an architect reviewer showed it owned no failure shape: unattributedness
 * means program construction failed, tsc aborts before the semantic pass, and the measurement
 * is therefore always empty, so EMPTY always fires too. Measured across six config shapes.
 *
 * ASK THE SHAPE, DO NOT LIST THE CODES. This replaced a `TS5\d{3}|TS18003` test after a
 * reviewer asked what happens to codes outside that set. A diagnostic with no
 * `file(line,col)` span is not about a file, it is about the program — verified: `error
 * TS6059: File '…' is not under 'rootDir'` begins at column zero with no span, while genuine
 * per-file diagnostics always carry one. Covers present and future config codes without
 * naming any.
 *
 * Pure and exported so the self-test pins the same function the runner calls; it previously
 * lived inline in `runTsc`, where the self-test could not reach it.
 */
export function unattributedDiagnostics(tscStdout) {
  return tscStdout.split(/\r?\n/).filter((line) => /^error TS\d+:/.test(line));
}

export function runTsc(spawn = spawnSync) {
  const result = spawn(
    process.execPath,
    [resolve(ROOT, "node_modules", "typescript", "lib", "tsc.js"),
      "-p", PROJECT, "--noEmit", "--pretty", "false", "--listFiles"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`tsc terminated by signal ${result.signal}`);
  // Statuses are NOT the failure signal here, which is the whole difficulty: `tsc` exits 1
  // exactly when it succeeds at finding the errors this gate measures. 0/1/2 are all
  // legitimate; anything else is a broken invocation. The real signals are the ordered policy
  // checks in `decide`.
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
  // NO refusal here. `unattributedDiagnostics` is still used — but to ENRICH the
  // empty-measurement refusal's message in `decide`, not as a gate of its own. An architect
  // reviewer showed why, with six config shapes measured against real tsc and reproduced
  // here: unattributedness IS program-construction failure (an unresolvable root file, a
  // missing type root, a rootDir violation, no inputs), so tsc aborts before the semantic
  // pass and the measurement is NECESSARILY empty — EMPTY always co-fires. Attributed config
  // diagnostics are option-VALIDATION failures, which do not stop program construction, so
  // checking proceeds and NON-SOURCE catches them. The classes are asymmetric, so "the
  // sibling class co-occurs, therefore this one plausibly can" does not transfer, and the
  // only remaining argument for a third refusal was insurance — which is the layered-defence
  // argument this repo rejects.
  return {
    tscStdout: stdout,
    counts: countErrorsByFile(stdout),
    programFiles: programSourceFiles(stdout),
  };
}

/**
 * Source inventory independent from TypeScript configuration resolution.
 *
 * The compiler's effective config cannot prove that it includes every source we intend to
 * check: a narrowed config faithfully reports its own omission. Git gives this check its
 * separate authority while also including local, untracked files that a developer may be
 * adding to a PR.
 */
export function readExpectedSourceFiles(spawn = spawnSync, exists = existsSync) {
  const result = spawn(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src", "scripts", "test"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`git ls-files terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    throw new Error(`git ls-files exited ${result.status}\n${result.stderr ?? ""}`);
  }
  return expectedSourceFilesFromGitOutput(result.stdout ?? "", exists);
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
 * bootstrapping. Anything else (including unparseable or structurally invalid JSON) throws:
 * if the file exists but cannot be trusted, we cannot tell whether a real baseline is about
 * to be destroyed, and guessing is what fail-open looks like. Delete the file deliberately to
 * bootstrap.
 *
 * Exported for the same reason as the gate's refusal paths: a mutation sweep showed that replacing
 * the ENOENT check with an unconditional `return {}` left the self-test GREEN, and that
 * mutation re-opens the write-path fail-open (unreadable baseline + broken compiler → `{}` →
 * the guard passes → a real baseline is overwritten with an empty measurement). This was the
 * only guard-adjacent function in the file that was not exported, i.e. the only one the
 * self-test could not pin.
 */
function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateBaselineFiles(baseline, path) {
  if (!isPlainObject(baseline)) {
    throw new Error(`baseline ${path} must be a JSON object`);
  }
  if (baseline.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `baseline schemaVersion ${baseline.schemaVersion} != ${SCHEMA_VERSION}; repair or remove it deliberately before updating`,
    );
  }
  if (!isPlainObject(baseline.files)) {
    throw new Error(`baseline ${path} must contain a non-array files object`);
  }
  for (const [file, count] of Object.entries(baseline.files)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`baseline ${path} has an invalid error count for ${file}`);
    }
  }
  return baseline.files;
}

function readBaseline(path = BASELINE) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, files: {} };
    throw error;
  }
  return { exists: true, files: validateBaselineFiles(JSON.parse(raw), path) };
}

export function readBaselineFilesOrEmpty(path = BASELINE) {
  return readBaseline(path).files;
}

export function decide({ update, measurement, baseline, expectedInventory }) {
  const { counts, programFiles, tscStdout } = measurement;

  // Before comparing OR writing: a measurement attributed to something that is not a
  // TypeScript source means the compiler was diagnosing the configuration, not the code.
  const nonSource = nonSourceMeasurements(counts);
  if (nonSource.length > 0) {
    return {
      kind: "refuse",
      exitCode: 1,
      message:
        `tsc attributed errors to non-source files (${nonSource.join(", ")}), which means it`
        + " was diagnosing the configuration. Refusing to compare or write a baseline.",
    };
  }

  // THE empty-measurement refusal — ONE call site, hoisted above both branches, guarding
  // the write and the compare together. Do not push it into `if (update)`.
  //
  // It used to sit inside the compare path only, which left `--update-baseline` fail-open: a
  // security reviewer reproduced it end-to-end with `tsc.js` unresolvable — the baseline was
  // rewritten from the then-current 312 entries to `files: {}` at rc=0, after which the
  // compare path's own empty-baseline carve-out reported "baseline held" green indefinitely.
  // Reachable by
  // running the update script mid-dependency-bump with typescript half-installed.
  //
  // Hoisting it here is what fixed that, and it is why there is exactly one call site rather
  // than two. An earlier version of this comment said "same predicate as the compare path,
  // asked twice" — describing the two-call-site shape this replaced. A reviewer flagged the
  // wording precisely because it licenses moving the check back down into the update branch,
  // which would restore the original bug.
  const onDiskFiles = baseline.files;
  if (isEmptyMeasurementAgainstBaseline(counts, onDiskFiles)) {
    // Wording covers both callers: `update` is about to overwrite, `compare` is about to
    // report. Saying only "refusing to overwrite" misdescribes half the runs.
    //
    // Program-level diagnostics are appended rather than checked separately. "The compiler did
    // not run" is useless for a rootDir violation, and these lines say exactly what went wrong
    // — which was the one real argument for having a third refusal. Folding it into the
    // message keeps the diagnosis and drops the speculative layer.
    const programLevel = unattributedDiagnostics(tscStdout);
    return {
      kind: "refuse",
      exitCode: 1,
      message:
        "tsc produced no diagnostics while the committed baseline expects them — the compiler"
        + " did not run. Refusing to treat that as an improvement or to write it to the"
        + " baseline."
        + (programLevel.length > 0
          ? `\n\ntsc reported these program-level errors:\n${programLevel.join("\n")}`
          : `\n\ntsc produced no program-level errors either. Full output:\n${tscStdout}`),
    };
  }

  // This must stay above both update and compare. A non-empty diagnostic measurement says only
  // that TypeScript checked *some* file; it does not prove a narrowed config included every
  // intended source. The independent inventory covers existing baselined files and new files
  // that have no baseline entry yet.
  if (expectedInventory.size === 0) {
    return {
      kind: "refuse",
      exitCode: 1,
      message:
        "the independent TypeScript source inventory was empty. Refusing to compare or write a"
        + " baseline because program coverage cannot be established.",
    };
  }
  const missingSources = missingExpectedSources(expectedInventory, programFiles);
  if (missingSources.length > 0) {
    const preview = missingSources.slice(0, 20);
    return {
      kind: "refuse",
      exitCode: 1,
      message:
        `tsc omitted ${missingSources.length} expected TypeScript source file(s) from its`
        + " program. Refusing to compare or write a baseline.\n"
        + preview.map((file) => `  ${file}\n`).join("")
        + (missingSources.length > preview.length
          ? `  … and ${missingSources.length - preview.length} more\n`
          : ""),
    };
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
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    return {
      kind: "write",
      exitCode: 0,
      payload,
      message: `[test-typecheck] baseline written: ${counts.size} files, ${total} errors\n`,
    };
  }

  if (!baseline.exists) {
    return {
      kind: "refuse",
      exitCode: 1,
      message: `baseline ${BASELINE} does not exist; run check:typecheck-tests:update to create it`,
    };
  }
  const { regressed, improved, fixed } = compareToBaseline(counts, onDiskFiles);

  if (regressed.length > 0) {
    return {
      kind: "regressed",
      exitCode: 1,
      message:
        "[test-typecheck] new type errors in files the baseline covers\n"
        + regressed.map((row) => `  ${row.file}: ${row.before} -> ${row.after}\n`).join("")
        + "\nThese files are typechecked by tsconfig.tests.json. Fix the errors — do NOT\n"
        + "re-baseline to make this pass. `bun run check:typecheck-tests:update` exists for\n"
        + "recording IMPROVEMENTS after you have cleaned a file.\n",
    };
  }

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const changeSummary = improved.length > 0 || fixed.length > 0
    ? ` (${improved.length} file(s) improved, ${fixed.length} fully fixed — run`
      + " check:typecheck-tests:update to lock it in)"
    : "";
  return {
    kind: "hold",
    exitCode: 0,
    message: `[test-typecheck] baseline held: ${counts.size} files, ${total} errors${changeSummary}\n`,
  };
}

function writeBaseline(payload) {
  writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Execute the gate through a narrow, injectable seam.
 *
 * `decide` owns the ordered policy; this function owns I/O. Keeping that boundary explicit lets
 * the self-test prove that every refusal is evaluated before a baseline write and that a
 * regression reaches the process exit code, without spawning a real compiler.
 */
export function runGate({
  argv = process.argv.slice(2),
  loadBaseline = readBaseline,
  measure = runTsc,
  loadExpectedInventory = readExpectedSourceFiles,
  saveBaseline = writeBaseline,
  writeStdout = (message) => process.stdout.write(message),
  writeStderr = (message) => process.stderr.write(message),
} = {}) {
  try {
    const decision = decide({
      update: argv.includes("--update-baseline"),
      baseline: loadBaseline(),
      measurement: measure(),
      expectedInventory: loadExpectedInventory(),
    });
    if (decision.kind === "write") saveBaseline(decision.payload);
    if (decision.exitCode === 0) writeStdout(decision.message);
    else writeStderr(decision.message);
    return decision.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`[test-typecheck] ${message}\n`);
    return 1;
  }
}

export function main(deps) {
  const exitCode = runGate(deps);
  process.exitCode = exitCode;
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
