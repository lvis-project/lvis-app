import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COVERAGE_SUMMARY_PATH = "coverage/vitest/coverage-summary.json";
const METRICS = ["lines", "statements", "functions", "branches"];

export const COVERAGE_GATES = [
  {
    name: "total",
    source: "total",
    thresholds: { lines: 70, statements: 68, functions: 64, branches: 62 },
  },
  {
    name: "engine",
    prefix: "src/engine/",
    thresholds: { lines: 81, statements: 79, functions: 73, branches: 70 },
  },
  {
    name: "permissions",
    prefix: "src/permissions/",
    thresholds: { lines: 91, statements: 89, functions: 90, branches: 82 },
  },
  {
    name: "plugins",
    prefix: "src/plugins/",
    thresholds: { lines: 79, statements: 77, functions: 79, branches: 68 },
  },
  {
    name: "ipc",
    prefix: "src/ipc/",
    thresholds: { lines: 55, statements: 52, functions: 56, branches: 41 },
  },
  {
    name: "renderer",
    prefix: "src/ui/renderer/",
    thresholds: { lines: 68, statements: 65, functions: 63, branches: 60 },
  },
  {
    name: "main",
    prefix: "src/main/",
    thresholds: { lines: 72, statements: 69, functions: 68, branches: 65 },
  },
  {
    name: "boot",
    prefix: "src/boot/",
    thresholds: { lines: 47, statements: 46, functions: 45, branches: 45 },
  },
  {
    name: "tools",
    prefix: "src/tools/",
    thresholds: { lines: 74, statements: 72, functions: 75, branches: 62 },
  },
  {
    name: "mcp",
    prefix: "src/mcp/",
    thresholds: { lines: 79, statements: 77, functions: 75, branches: 66 },
  },
];

function emptyTotals() {
  return Object.fromEntries(
    METRICS.map((metric) => [metric, { total: 0, covered: 0, skipped: 0 }]),
  );
}

function normalizeCoveragePath(filePath, cwd) {
  const relative = path.isAbsolute(filePath)
    ? path.relative(cwd, filePath)
    : filePath;
  return relative.split(path.sep).join("/");
}

function addMetrics(target, source) {
  for (const metric of METRICS) {
    target[metric].total += source[metric]?.total ?? 0;
    target[metric].covered += source[metric]?.covered ?? 0;
    target[metric].skipped += source[metric]?.skipped ?? 0;
  }
}

function summarizeTotals(totals) {
  return Object.fromEntries(
    METRICS.map((metric) => {
      const { total, covered, skipped } = totals[metric];
      const pct = total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
      return [metric, { total, covered, skipped, pct }];
    }),
  );
}

function summarizeGate(summary, gate, cwd) {
  if (gate.source === "total") {
    return {
      name: gate.name,
      fileCount: Object.keys(summary).filter((key) => key !== "total").length,
      metrics: summary.total,
      thresholds: gate.thresholds,
    };
  }

  const totals = emptyTotals();
  let fileCount = 0;
  for (const [filePath, metrics] of Object.entries(summary)) {
    if (filePath === "total") continue;
    const relativePath = normalizeCoveragePath(filePath, cwd);
    if (!relativePath.startsWith(gate.prefix)) continue;
    fileCount += 1;
    addMetrics(totals, metrics);
  }

  return {
    name: gate.name,
    fileCount,
    metrics: summarizeTotals(totals),
    thresholds: gate.thresholds,
  };
}

function compareGate(gateSummary) {
  const failures = [];
  if (gateSummary.fileCount === 0) {
    failures.push(`${gateSummary.name}: no files matched coverage gate`);
    return failures;
  }

  for (const metric of METRICS) {
    const actual = gateSummary.metrics[metric]?.pct;
    const expected = gateSummary.thresholds[metric];
    if (actual === undefined) {
      failures.push(`${gateSummary.name}.${metric}: missing coverage metric`);
      continue;
    }
    if (actual + Number.EPSILON < expected) {
      failures.push(
        `${gateSummary.name}.${metric}: ${actual.toFixed(2)} < ${expected.toFixed(2)}`,
      );
    }
  }
  return failures;
}

export function evaluateCoverageSummary(summary, options = {}) {
  if (!summary || typeof summary !== "object" || !summary.total) {
    throw new Error("coverage summary must include a total entry");
  }

  const cwd = options.cwd ?? process.cwd();
  const gates = options.gates ?? COVERAGE_GATES;
  const gateSummaries = gates.map((gate) => summarizeGate(summary, gate, cwd));
  const failures = gateSummaries.flatMap(compareGate);
  return { passed: failures.length === 0, failures, gateSummaries };
}

export function topUncoveredFiles(summary, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const limit = options.limit ?? 10;
  return Object.entries(summary)
    .filter(([filePath]) => filePath !== "total")
    .map(([filePath, metrics]) => {
      const lines = metrics.lines ?? { total: 0, covered: 0, pct: 100 };
      return {
        file: normalizeCoveragePath(filePath, cwd),
        uncoveredLines: Math.max(0, lines.total - lines.covered),
        linePct: lines.pct,
      };
    })
    .sort((a, b) => b.uncoveredLines - a.uncoveredLines)
    .slice(0, limit);
}

function formatGateSummary(gateSummary) {
  const metrics = METRICS.map((metric) => {
    const actual = gateSummary.metrics[metric]?.pct ?? 0;
    const expected = gateSummary.thresholds[metric];
    return `${metric} ${actual.toFixed(2)}>=${expected.toFixed(2)}`;
  }).join(", ");
  return `${gateSummary.name.padEnd(11)} files=${String(gateSummary.fileCount).padStart(3)} ${metrics}`;
}

export function runCoverageCli(args = process.argv.slice(2), options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const summaryPath = path.resolve(cwd, args[0] ?? COVERAGE_SUMMARY_PATH);
  if (!fs.existsSync(summaryPath)) {
    stderr(`coverage summary not found: ${path.relative(cwd, summaryPath)}`);
    stderr("run `bun run test:coverage` before `node scripts/check-test-coverage.mjs`");
    return 1;
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const result = evaluateCoverageSummary(summary, { cwd });
  stdout("coverage gates:");
  for (const gateSummary of result.gateSummaries) {
    stdout(`  ${formatGateSummary(gateSummary)}`);
  }

  if (!result.passed) {
    stderr("\ncoverage gate failed:");
    for (const failure of result.failures) {
      stderr(`  - ${failure}`);
    }
    stderr("\ntop uncovered files:");
    for (const file of topUncoveredFiles(summary, { cwd })) {
      stderr(
        `  - ${file.file}: ${file.uncoveredLines} uncovered lines (${file.linePct.toFixed(2)}%)`,
      );
    }
    return 1;
  }

  stdout("coverage gates passed");
  return 0;
}

function main() {
  process.exitCode = runCoverageCli(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
