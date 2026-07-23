import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNIP_BASELINE_SCHEMA_VERSION,
  NON_BASELINE_ISSUE_TYPES,
  compareKnipBaseline,
  countKnipIssuesByType,
  formatKnipIssue,
  normalizeKnipIssues,
  writeKnipBaselineAtomicSync,
} from "./lib/knip-baseline.mjs";

const DEFAULT_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function parseOptions(argv) {
  const options = {
    root: DEFAULT_ROOT,
    config: "knip.jsonc",
    baseline: "knip-baseline.json",
    knipBinary: join(DEFAULT_ROOT, "node_modules", "knip", "bin", "knip.js"),
    updateBaseline: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--update-baseline") {
      options.updateBaseline = true;
      continue;
    }
    const value = argv[index + 1];
    if (["--root", "--config", "--baseline", "--knip-binary"].includes(argument)) {
      if (!value) throw new Error(`${argument} requires a path`);
      index += 1;
      if (argument === "--root") options.root = value;
      if (argument === "--config") options.config = value;
      if (argument === "--baseline") options.baseline = value;
      if (argument === "--knip-binary") options.knipBinary = value;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  options.root = resolve(options.root);
  const fromRoot = (path) => isAbsolute(path) ? path : resolve(options.root, path);
  options.config = fromRoot(options.config);
  options.baseline = fromRoot(options.baseline);
  options.knipBinary = fromRoot(options.knipBinary);
  return options;
}

function fail(message, details = []) {
  console.error(`[knip-gate] ${message}`);
  for (const detail of details) console.error(`  ${detail}`);
  process.exitCode = 1;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function runKnip(options) {
  const result = spawnSync(
    process.execPath,
    [options.knipBinary, "--config", options.config, "--reporter", "json"],
    {
      cwd: options.root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Knip terminated by signal ${result.signal}`);

  const stderr = result.stderr.trim();
  if (/^ERROR:/m.test(stderr)) {
    throw new Error(`Knip configuration failed:\n${stderr}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Knip did not produce a JSON report (exit ${result.status}): ${error.message}`,
    );
  }
  return { report, status: result.status, stderr };
}

try {
  const options = parseOptions(process.argv.slice(2));
  const packageJson = readJson(join(options.root, "package.json"), "package.json");
  const expectedKnipVersion = packageJson.devDependencies?.knip;
  if (typeof expectedKnipVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedKnipVersion)) {
    throw new Error("package.json must pin an exact Knip devDependency version");
  }
  const installedKnipPackage = readJson(
    resolve(dirname(options.knipBinary), "..", "package.json"),
    "installed Knip package.json",
  );
  if (installedKnipPackage.version !== expectedKnipVersion) {
    throw new Error(
      `installed Knip version ${installedKnipPackage.version} does not match ${expectedKnipVersion}`,
    );
  }

  const { report, status, stderr } = runKnip(options);
  const issues = normalizeKnipIssues(report);
  const nonBaselineIssues = issues.filter((issue) =>
    NON_BASELINE_ISSUE_TYPES.has(issue.type));
  if (nonBaselineIssues.length > 0) {
    fail(
      "unresolved, unlisted, and binary issues cannot be accepted into the baseline",
      nonBaselineIssues.map(formatKnipIssue),
    );
  } else if (status !== 0) {
    fail(`Knip exited with status ${status}`, stderr ? [stderr] : []);
  } else if (options.updateBaseline) {
    const baseline = {
      schemaVersion: KNIP_BASELINE_SCHEMA_VERSION,
      knipVersion: expectedKnipVersion,
      entries: issues,
    };
    writeKnipBaselineAtomicSync(
      options.baseline,
      `${JSON.stringify(baseline, null, 2)}\n`,
    );
    console.log(`[knip-gate] wrote ${issues.length} entries to knip-baseline.json`);
  } else {
    const baseline = readJson(options.baseline, "knip-baseline.json");
    if (baseline.schemaVersion !== KNIP_BASELINE_SCHEMA_VERSION) {
      throw new Error(`unsupported Knip baseline schema ${baseline.schemaVersion}`);
    }
    if (baseline.knipVersion !== expectedKnipVersion) {
      throw new Error(
        `Knip baseline version ${baseline.knipVersion} does not match ${expectedKnipVersion}`,
      );
    }
    if (!Array.isArray(baseline.entries)) {
      throw new Error("Knip baseline entries must be an array");
    }

    const { added, resolved } = compareKnipBaseline(issues, baseline.entries);
    if (added.length > 0) {
      fail("new issues exceed the reviewed baseline", added.map(formatKnipIssue));
    } else {
      const summary = countKnipIssuesByType(issues)
        .map(([type, count]) => `${type}=${count}`)
        .join(", ");
      console.log(`[knip-gate] baseline passed: ${summary || "no accepted debt"}`);
      if (resolved.length > 0) {
        console.log(`[knip-gate] ${resolved.length} baseline entries are now resolved; update the baseline`);
      }
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
