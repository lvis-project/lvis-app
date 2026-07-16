import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DETERMINISTIC_TEST_FILES,
  P4_5_CONSTANTS,
  assertCleanPinnedRepository,
  fileSha256,
  git,
  parseVitestReport,
  runCaptured,
  sha256,
  writeImmutable,
} from "./a2a-p4-5-harness-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = resolve(root, "artifacts/a2a-p4-5/deterministic-local.json");
const temporary = mkdtempSync(resolve(tmpdir(), "lvis-a2a-p4-5-deterministic-"));

function runVitest(name, files, reportPath, env = process.env) {
  const command = runCaptured(
    name,
    "bun",
    [
      "run", "test:vitest", "--", "run", ...files,
      "--reporter=json", `--outputFile=${reportPath}`,
    ],
    { cwd: root, env },
  );
  return { command: command.summary, report: parseVitestReport(reportPath, files) };
}

try {
  const head = git(root, "rev-parse", "HEAD");
  assertCleanPinnedRepository(root, head, "lvis-app");
  for (const file of DETERMINISTIC_TEST_FILES) {
    if (!readFileSync(resolve(root, file), "utf8")) throw new Error(`empty deterministic test file: ${file}`);
  }

  const checker = runCaptured(
    "check:a2a-p4-5-contract",
    "node",
    ["scripts/check-a2a-p4-5-contract.mjs"],
    { cwd: root },
  );
  const regression = runVitest(
    "p4-5-deterministic-regression",
    DETERMINISTIC_TEST_FILES,
    resolve(temporary, "regression.json"),
  );
  const gateOff = runVitest(
    "p4-5-gate-off",
    ["src/main/__tests__/a2a-p4-5-gate.test.ts"],
    resolve(temporary, "gate-off.json"),
    { ...process.env, A2A_P4_5_GATE_EXPECTED: "off" },
  );
  const gateOn = runVitest(
    "p4-5-gate-on",
    ["src/main/__tests__/a2a-p4-5-gate.test.ts"],
    resolve(temporary, "gate-on.json"),
    { ...process.env, A2A_P4_5_GATE_EXPECTED: "on" },
  );

  const totalCases = regression.report.total + gateOff.report.total + gateOn.report.total;
  const artifact = {
    schema_version: "lvis-a2a-p4-5-deterministic-local/v1",
    lvis_app_head_sha: head,
    blueprint_contract_sha256: fileSha256(resolve(root, "docs/blueprints/a2a-subagent-messaging.md")),
    exact_replay_spec_sha256: fileSha256(resolve(root, "docs/protocols/lvis-a2a-exact-send-replay.md")),
    contract_checker_sha256: fileSha256(resolve(root, "scripts/check-a2a-p4-5-contract.mjs")),
    contract_checker_result: checker.summary,
    constants: P4_5_CONSTANTS,
    deterministic_test_files: DETERMINISTIC_TEST_FILES,
    case_counts: {
      total: totalCases,
      passed: totalCases,
      failed: 0,
      skipped: 0,
      regression: regression.report,
    },
    gate_results: {
      off: gateOff.report,
      on: gateOn.report,
    },
    command_results: [regression.command, gateOff.command, gateOn.command],
    zero_skips: true,
    verification_state: "passed",
  };
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  writeImmutable(artifactPath, bytes);
  process.stdout.write(`${artifactPath} sha256=${sha256(bytes)} cases=${totalCases}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
