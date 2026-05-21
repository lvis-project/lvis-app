import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadRepoDemoEnv } from "../demo-env-loader.mjs";

test("loadRepoDemoEnv loads .env.demo lines without overriding shell env", () => {
  const dir = mkdtempSync(join(tmpdir(), "lvis-demo-env-"));
  try {
    writeFileSync(
      join(dir, ".env.demo"),
      [
        "# comment",
        "LVIS_DEMO_VENDOR=azure-foundry",
        "export LVIS_DEMO_KEY_AZURE_FOUNDRY=from-file",
        "LVIS_DEMO_HOST_MAP='host.example.com=10.182.192.10'",
        "MALFORMED",
        "",
      ].join("\n"),
      "utf8",
    );

    const env = { LVIS_DEMO_KEY_AZURE_FOUNDRY: "from-shell" };
    const result = loadRepoDemoEnv(env, dir);

    assert.equal(result.loaded, true);
    assert.equal(result.applied, 2);
    assert.equal(env.LVIS_DEMO_VENDOR, "azure-foundry");
    assert.equal(env.LVIS_DEMO_KEY_AZURE_FOUNDRY, "from-shell");
    assert.equal(env.LVIS_DEMO_HOST_MAP, "host.example.com=10.182.192.10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRepoDemoEnv is a no-op when .env.demo is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "lvis-demo-env-"));
  try {
    const env = {};
    const result = loadRepoDemoEnv(env, dir);

    assert.equal(result.loaded, false);
    assert.equal(result.applied, 0);
    assert.deepEqual(env, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
