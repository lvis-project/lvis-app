import assert from "node:assert/strict";
import test from "node:test";
import { headlessLaunchArgs } from "../../scripts/lib/headless-launch-options.mjs";

test("routes supported native command forms with their values intact", () => {
  for (const args of [
    ["--exec", "hello"], ["--exec=hello"],
    ["--set-secret", "llm.apiKey.openai"], ["--set-secret=llm.apiKey.openai"],
    ["--serve"], ["--runtime-check"], ["--exec=hello", "--exec-keep-alive"],
  ]) {
    assert.deepEqual(headlessLaunchArgs(args), args);
    assert.deepEqual(headlessLaunchArgs(["dist/src/main/main.js", ...args]), args);
  }
});

test("keeps ordinary desktop options and orphaned exec modifiers on the desktop route", () => {
  for (const args of [[], ["--version"], ["--exec-keep-alive"], ["--execution=hello"], ["--serve-other"]]) {
    assert.equal(headlessLaunchArgs(args), null);
  }
});
