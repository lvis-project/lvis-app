import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { getFileMatchers } = require("app-builder-lib/out/fileMatcher.js");
const config = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).build;

test("Windows resources include the job launcher and every shared runtime asset", () => {
  const root = resolve("packaging-fixture");
  const destination = resolve("packaging-output/resources");
  const matchers = getFileMatchers(config, "extraResources", destination, {
    defaultSrc: root,
    globalOutDir: resolve("packaging-output"),
    macroExpander: value => value.replaceAll("${arch}", "x64"),
    customBuildOptions: config.win,
  });
  for (const asset of [...config.extraResources, ...config.win.extraResources]) {
    assert.ok(matchers.some(matcher => matcher.from === resolve(root, asset.from.replaceAll("${arch}", "x64")) &&
      matcher.to === resolve(destination, asset.to.replaceAll("${arch}", "x64"))), asset.from);
  }
  assert.equal(matchers.length, config.extraResources.length + 1);
  assert.equal(config.beforePack, "scripts/electron-before-pack.cjs");
});
