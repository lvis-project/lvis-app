import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COVERAGE_GATES,
  evaluateCoverageSummary,
  topUncoveredFiles,
} from "../../scripts/check-test-coverage.mjs";

const scriptPath = fileURLToPath(new URL("../../scripts/check-test-coverage.mjs", import.meta.url));

type CoverageMetric = {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
};

type CoverageEntry = {
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
};

function metric(covered: number, total = 100): CoverageMetric {
  return {
    total,
    covered,
    skipped: 0,
    pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)),
  };
}

function entry(coverage: number): CoverageEntry {
  return {
    lines: metric(coverage),
    statements: metric(coverage),
    functions: metric(coverage),
    branches: metric(coverage),
  };
}

describe("check-test-coverage", () => {
  it("passes when every configured gate is above its floor", () => {
    const summary = {
      total: entry(90),
      "/repo/src/engine/conversation-loop.ts": entry(90),
      "/repo/src/engine/conversation-history.ts": entry(90),
    };

    const result = evaluateCoverageSummary(summary, {
      cwd: "/repo",
      gates: [
        {
          name: "total",
          source: "total",
          thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
        },
        {
          name: "engine",
          prefix: "src/engine/",
          thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
        },
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails on metric regressions instead of relying on total test pass count", () => {
    const summary = {
      total: entry(90),
      "/repo/src/engine/conversation-loop.ts": entry(75),
    };

    const result = evaluateCoverageSummary(summary, {
      cwd: "/repo",
      gates: [
        {
          name: "engine",
          prefix: "src/engine/",
          thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      "engine.lines: 75.00 < 80.00",
      "engine.statements: 75.00 < 80.00",
      "engine.functions: 75.00 < 80.00",
      "engine.branches: 75.00 < 80.00",
    ]);
  });

  it("fails the CLI when the coverage summary is missing", () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "lvis-coverage-missing-"));
    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("coverage summary not found");
      expect(result.stderr).toContain("run `bun run test:coverage`");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the CLI when a configured coverage gate regresses", () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "lvis-coverage-threshold-"));
    const summaryPath = path.join(root, "coverage-summary.json");
    try {
      fs.writeFileSync(
        summaryPath,
        JSON.stringify({
          total: entry(90),
          "src/engine/conversation-loop.ts": entry(75),
          "src/permissions/permission-manager.ts": entry(95),
          "src/plugins/runtime.ts": entry(95),
          "src/ipc/bridge.ts": entry(95),
          "src/ui/renderer/App.tsx": entry(95),
          "src/main/main.ts": entry(95),
          "src/boot/boot.ts": entry(95),
          "src/tools/web.ts": entry(95),
          "src/mcp/manager.ts": entry(95),
        }),
      );

      const result = spawnSync(process.execPath, [scriptPath, summaryPath], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("coverage gates:");
      expect(result.stderr).toContain("coverage gate failed");
      expect(result.stderr).toContain("engine.lines: 75.00 < 81.00");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when a required source area disappears from the report", () => {
    const result = evaluateCoverageSummary(
      {
        total: entry(90),
        "/repo/src/plugins/runtime/index.ts": entry(90),
      },
      {
        cwd: "/repo",
        gates: [
          {
            name: "engine",
            prefix: "src/engine/",
            thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
          },
        ],
      },
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["engine: no files matched coverage gate"]);
  });

  it("keeps the quality scripts and v8 provider wired as a regression guard", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    const vitestConfig = fs.readFileSync(path.resolve("vitest.config.ts"), "utf8");
    const coverageGateScript = fs.readFileSync(path.resolve("scripts/run-test-coverage-gate.mjs"), "utf8");
    const vitestVersion = packageJson.devDependencies.vitest.replace(/^[^\d]*/, "");
    const coverageVersion = packageJson.devDependencies["@vitest/coverage-v8"].replace(/^[^\d]*/, "");

    expect(packageJson.scripts["test:coverage"]).toBe("vitest run --coverage");
    expect(packageJson.scripts["check:test-coverage"]).toContain("scripts/run-test-coverage-gate.mjs");
    expect(packageJson.scripts["check:test-quality"]).toContain("check:test-duplicates");
    expect(coverageVersion).toBe(vitestVersion);
    expect(vitestConfig).toContain('provider: "v8"');
    expect(vitestConfig).toContain('reportsDirectory: "coverage/vitest"');
    expect(vitestConfig).toContain('"json-summary"');
    expect(coverageGateScript).toContain('process.platform === "win32" ? "bun.exe" : "bun"');
    expect(coverageGateScript).not.toContain("shell: true");
    expect(coverageGateScript).toContain("rmSync(reportsDir");
  });

  it("surfaces the highest uncovered files for actionable failures", () => {
    const summary = {
      total: entry(90),
      "/repo/src/engine/small.ts": {
        lines: metric(9, 10),
        statements: metric(9, 10),
        functions: metric(9, 10),
        branches: metric(9, 10),
      },
      "/repo/src/ipc/large-gap.ts": {
        lines: metric(10, 100),
        statements: metric(10, 100),
        functions: metric(10, 100),
        branches: metric(10, 100),
      },
    };

    expect(topUncoveredFiles(summary, { cwd: "/repo", limit: 1 })).toEqual([
      {
        file: "src/ipc/large-gap.ts",
        uncoveredLines: 90,
        linePct: 10,
      },
    ]);
  });

  it("defines directory-level gates so weak areas cannot hide behind global coverage", () => {
    expect(COVERAGE_GATES.map((gate) => gate.name)).toEqual([
      "total",
      "engine",
      "permissions",
      "plugins",
      "ipc",
      "renderer",
      "main",
      "boot",
      "tools",
      "mcp",
    ]);
  });
});
