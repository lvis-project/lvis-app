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

function main() {
  const update = process.argv.includes("--update-baseline");
  const counts = countErrorsByFile(runTsc());

  if (update) {
    const sorted = Object.fromEntries(
      [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, "en")),
    );
    writeFileSync(
      BASELINE,
      `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, files: sorted }, null, 2)}\n`,
      "utf8",
    );
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
