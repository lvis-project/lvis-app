import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNIP_BASELINE_SCHEMA_VERSION,
  NON_BASELINE_ISSUE_TYPES,
  compareKnipBaseline,
  countKnipIssuesByType,
  formatKnipIssue,
  normalizeKnipIssues,
} from "./lib/knip-baseline.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const BASELINE_PATH = join(ROOT, "knip-baseline.json");
const PACKAGE_PATH = join(ROOT, "package.json");
const KNIP_BINARY = join(ROOT, "node_modules", "knip", "bin", "knip.js");
const UPDATE_BASELINE = process.argv.includes("--update-baseline");

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

function runKnip() {
  const result = spawnSync(
    process.execPath,
    [KNIP_BINARY, "--config", "knip.jsonc", "--reporter", "json"],
    {
      cwd: ROOT,
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
  const packageJson = readJson(PACKAGE_PATH, "package.json");
  const expectedKnipVersion = packageJson.devDependencies?.knip;
  if (typeof expectedKnipVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedKnipVersion)) {
    throw new Error("package.json must pin an exact Knip devDependency version");
  }

  const { report, status, stderr } = runKnip();
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
  } else if (UPDATE_BASELINE) {
    const baseline = {
      schemaVersion: KNIP_BASELINE_SCHEMA_VERSION,
      knipVersion: expectedKnipVersion,
      entries: issues,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    console.log(`[knip-gate] wrote ${issues.length} entries to knip-baseline.json`);
  } else {
    const baseline = readJson(BASELINE_PATH, "knip-baseline.json");
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
