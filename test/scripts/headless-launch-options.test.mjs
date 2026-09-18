import assert from "node:assert/strict";
import test from "node:test";
import {
  HEADLESS_FORBIDDEN_INHERITED_ENV,
  headlessLaunchArgs,
  isPermissionAuditProofArg,
  isPermissionAuditSelfTestArg,
  permissionAuditProofFailureCode,
  prepareHeadlessLaunchEnv,
} from "../../scripts/lib/headless-launch-options.mjs";

test("scrubs inherited module-loader and process-role inputs from native launches", () => {
  const env = {
    ELECTRON_NO_ASAR: "1",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_CHANNEL_FD: "9",
    NODE_CHANNEL_SERIALIZATION_MODE: "advanced",
    NODE_OPTIONS: "--require=/untrusted/preload.cjs",
    NODE_PATH: "/untrusted/modules",
    NODE_UNIQUE_ID: "worker-role",
    LVIS_HOME: "/preserved/lvis-home",
  };

  assert.equal(prepareHeadlessLaunchEnv(env), env);
  for (const name of HEADLESS_FORBIDDEN_INHERITED_ENV) {
    assert.equal(env[name], undefined);
  }
  assert.equal(env.LVIS_HOME, "/preserved/lvis-home");
});

test("routes supported native command forms with their values intact", () => {
  for (const args of [
    ["--exec", "hello"], ["--exec=hello"],
    ["--set-secret", "llm.apiKey.openai"], ["--set-secret=llm.apiKey.openai"],
    ["--serve"], ["--runtime-check"], ["--exec=hello", "--exec-keep-alive"],
    ["--verify-permission-audit=" + "a".repeat(64)],
    ["--verify-permission-audit"],
    ["--verify-permission-audit=" + "b".repeat(64), "--user-data-dir=/tmp/lvis-proof"],
    ["--create-permission-audit-self-test=" + "c".repeat(64)],
    ["--exec=hello", "--exec-operator-attestation=/run/lvis/attestation.json"],
    ["--exec-operator-attestation=/run/lvis/attestation.json"],
    [
      "--exec=hello",
      "--exec-workload-broker=/run/lvis/workload.sock",
      "--exec-workload-capability=/run/lvis/capability.json",
    ],
  ]) {
    assert.deepEqual(headlessLaunchArgs(args), args);
    assert.deepEqual(headlessLaunchArgs(["dist/src/main/main.js", ...args]), args);
  }
});

test("reserves malformed permission audit self-test forms", () => {
  assert.equal(isPermissionAuditSelfTestArg("--create-permission-audit-self-test"), true);
  assert.equal(isPermissionAuditSelfTestArg("--create-permission-audit-self-test=BAD"), true);
  assert.deepEqual(headlessLaunchArgs(["--create-permission-audit-self-test=BAD"]), ["--create-permission-audit-self-test=BAD"]);
});

test("reserves malformed proof forms and exposes only stable failure codes", () => {
  assert.equal(isPermissionAuditProofArg("--verify-permission-audit"), true);
  assert.equal(isPermissionAuditProofArg("--verify-permission-audit=BAD"), true);
  assert.equal(isPermissionAuditProofArg("--verify-permission-auditor"), true);
  assert.deepEqual(headlessLaunchArgs(["--verify-permission-auditor"]), ["--verify-permission-auditor"]);
  assert.equal(permissionAuditProofFailureCode(false), "permission-audit-proof:invalid-arguments");
  assert.equal(permissionAuditProofFailureCode(true), "permission-audit-proof:verification-failed");
});

test("keeps ordinary desktop options and orphaned exec modifiers on the desktop route", () => {
  for (const args of [[], ["--version"], ["--exec-keep-alive"], ["--execution=hello"], ["--serve-other"]]) {
    assert.equal(headlessLaunchArgs(args), null);
  }
});
