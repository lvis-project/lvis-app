#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

import { assertArtifactStable, readEvidenceDescriptor, fail, verifySignedManifest } from "./evidence-lib.mjs";
import {
  CANARIES,
  PACKAGED_LIVE_CASE_IDS,
  STABLE_TEST_IDS,
  UI_CASE_EXPECTATIONS,
  validatePackagedLiveManifest,
} from "./packaged-live-contract.mjs";

const CORE_TEST_IDS = Object.freeze([
  "remote-a2a-trigger",
  "remote-a2a-panel",
  "remote-a2a-target",
  "remote-a2a-intent",
  "remote-a2a-status",
  "remote-a2a-send",
]);
const ACTION_TEST_ID = Object.freeze({
  get: "remote-a2a-get",
  resume: "remote-a2a-resume",
  cancel: "remote-a2a-cancel",
  replay: "remote-a2a-replay",
});

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--manifest" || !args[1] || args[1].startsWith("--")) {
    fail("UI driver accepts exactly --manifest <signed-manifest-path>");
  }
  return args[1];
}

async function launchInstalledApp(executablePath) {
  return electron.launch({ executablePath, args: [], env: { ...process.env }, timeout: 60_000 });
}

async function getEvidenceWindow(app, target) {
  const window = await app.firstWindow({ timeout: 60_000 });
  await window.waitForLoadState("domcontentloaded");
  const trigger = window.getByTestId("remote-a2a-trigger");
  await trigger.waitFor({ state: "visible", timeout: 60_000 });
  if (await trigger.count() !== 1) fail("packaged UI: remote-a2a-trigger must exist exactly once");
  await trigger.click();
  for (const testId of CORE_TEST_IDS) {
    const locator = window.getByTestId(testId);
    await locator.waitFor({ state: "attached", timeout: 30_000 });
    if (await locator.count() !== 1) fail(`packaged UI: ${testId} must exist exactly once`);
  }
  const select = window.getByTestId("remote-a2a-target");
  const option = select.locator(`option[value="${target.targetAgentId}"]`);
  if (await option.count() !== 1 || (await option.textContent())?.trim() !== target.label) {
    fail("packaged UI: signed targetAgentId/label pair is absent or ambiguous");
  }
  await select.selectOption(String(target.targetAgentId));
  if (await select.inputValue() !== String(target.targetAgentId)) fail("packaged UI: exact targetAgentId was not selected");
  return window;
}

function caseIntent(caseId, suffix = "initial") {
  return [
    `[LVIS-P4-5:${caseId}]`,
    `[phase:${suffix}]`,
    CANARIES[0],
    CANARIES[1],
    CANARIES[2],
  ].join(" ");
}

async function readRendererIpcStatus(window) {
  const result = await window.evaluate(async () => {
    const api = window.lvisApi?.remoteA2a;
    if (!api) return { ok: false, error: "remote-a2a-api-unavailable" };
    return api.status();
  });
  if (!result || result.ok !== true || !result.status) fail("packaged UI: renderer-to-IPC status query failed");
  return result.status;
}

function matchesExpected(actual, expected, target) {
  return actual.state === expected.state
    && actual.outcome === expected.outcome
    && (actual.taskState ?? null) === expected.taskState
    && actual.targetAgentId === target.targetAgentId
    && actual.targetLabel === target.label;
}

function expectedStatusCopy(status, target) {
  if (status.taskState === "TASK_STATE_AUTH_REQUIRED") return "Authentication required remotely · complete it out of band";
  if (status.state === "sent") return `Sent to ${target.label}`;
  if (status.state === "failed") return `Not sent · ${status.outcome}`;
  fail(`packaged UI: unsupported final renderer state ${status.state}`);
}

async function assertRendererProjection(window, actual, expected, target) {
  if (!matchesExpected(actual, expected, target)) {
    fail(`packaged UI: status mismatch (expected ${JSON.stringify(expected)}, got ${JSON.stringify({ state: actual.state, outcome: actual.outcome ?? null, taskState: actual.taskState ?? null })})`);
  }
  const locator = window.getByTestId("remote-a2a-status");
  if ((await locator.getAttribute("data-state")) !== actual.state) fail("packaged UI: DOM state does not match renderer IPC status");
  if ((await locator.textContent())?.trim() !== expectedStatusCopy(actual, target)) fail("packaged UI: visible status copy does not match actual outcome/task state");
  if (expected.taskState === "TASK_STATE_INPUT_REQUIRED") {
    if (!(await window.getByTestId("remote-a2a-resume").isEnabled())) fail("packaged UI: INPUT_REQUIRED did not enable Resume");
  }
  if (["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"].includes(expected.taskState)) {
    const cancel = window.getByTestId("remote-a2a-cancel");
    if (await cancel.count() === 1 && await cancel.isEnabled()) fail("packaged UI: terminal Task left Cancel enabled");
  }
}

async function waitForExpectedStatus(window, expected, target) {
  const deadline = Date.now() + 60_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await readRendererIpcStatus(window);
    if (matchesExpected(latest, expected, target)) {
      await assertRendererProjection(window, latest, expected, target);
      return latest;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  fail(`packaged UI: timed out waiting for fixed status; last=${JSON.stringify(latest)}`);
}

async function clickFixedAction(window, action, caseId) {
  const testId = ACTION_TEST_ID[action];
  if (!testId) fail(`packaged UI: unsupported fixed action ${action}`);
  const taskActions = window.getByTestId("remote-a2a-task-actions");
  if (await taskActions.count() !== 1) fail(`packaged UI: ${caseId} did not expose task actions`);
  const button = window.getByTestId(testId);
  if (await button.count() !== 1 || !(await button.isEnabled())) fail(`packaged UI: ${testId} is absent or disabled`);
  if (action === "resume") await window.getByTestId("remote-a2a-intent").fill(caseIntent(caseId, "continuation"));
  await button.click();
}

async function startCase(window, caseId, target) {
  await window.getByTestId("remote-a2a-target").selectOption(String(target.targetAgentId));
  await window.getByTestId("remote-a2a-intent").fill(caseIntent(caseId));
  await window.getByTestId("remote-a2a-send").click();
}

export async function runFixedUiMatrix({ executablePath, target }) {
  let app = await launchInstalledApp(executablePath);
  let window = await getEvidenceWindow(app, target);
  const caseResults = [];
  try {
    for (const caseId of PACKAGED_LIVE_CASE_IDS) {
      const contract = UI_CASE_EXPECTATIONS[caseId];
      await startCase(window, caseId, target);
      if (contract.preAction) await waitForExpectedStatus(window, contract.preAction, target);
      if (contract.action === "replay-restart") {
        await app.close();
        app = await launchInstalledApp(executablePath);
        window = await getEvidenceWindow(app, target);
        await clickFixedAction(window, "replay", caseId);
      } else if (contract.action) {
        await clickFixedAction(window, contract.action, caseId);
      }
      const actual = await waitForExpectedStatus(window, contract.final, target);
      caseResults.push({
        id: caseId,
        status: "passed",
        skipped: false,
        rendererState: actual.state,
        outcome: actual.outcome,
        taskState: actual.taskState ?? null,
      });
    }
  } finally {
    await app.close().catch(() => {});
  }
  return { schemaVersion: 1, stableTestIds: [...STABLE_TEST_IDS], caseResults };
}

async function main() {
  const manifestPath = parseArguments(process.argv.slice(2));
  const signed = verifySignedManifest(manifestPath);
  const manifest = validatePackagedLiveManifest(signed.manifest);
  const executable = readEvidenceDescriptor(manifestPath, manifest.installedExecutable, "installed packaged executable", { maxBytes: 1024 * 1024 * 1024, loadBytes: false });
  const result = await runFixedUiMatrix({ executablePath: executable.path, target: manifest.target });
  assertArtifactStable(executable, "installed packaged executable", { maxBytes: 1024 * 1024 * 1024 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
