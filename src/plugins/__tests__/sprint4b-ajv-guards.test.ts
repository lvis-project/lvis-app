/**
 * Sprint 4-B unit tests — AJV wiring (B-1), uiCallable subset-of-tools[]
 * validation (B-3), capability gate (B-5 — tested via manifest field), and
 * rate-limit (B-7 — tested in sprint4b-rate-limit.test.ts).
 *
 * NOTE: The legacy suffix-based "destructive verb" gate has been removed.
 * uiCallable validation is now purely structural: every entry must be a
 * string declared in tools[]. Security relies on code review + marketplace
 * approval + signature verification — not on naming patterns.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";
import { PluginPhase } from "../lifecycle-log.js";
import { mkdtempSync } from "node:fs";

describe("Sprint 4-B — AJV + uiCallable + destructive guards", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-4b-"));
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(id: string, manifestOverrides: Record<string, unknown> = {}): Promise<void> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { "${id}_hello": async () => "hi", "${id}_delete": async () => "nope" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry: "entry.mjs",
      tools: [`${id}_hello`, `${id}_delete`],
      ...manifestOverrides,
    };
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(manifest), "utf-8");
    await mkdir(join(testDir, "plugins"), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id, manifestPath: join(pluginDir, "plugin.json") }],
      }),
      "utf-8",
    );
  }

  it("B-1: AJV rejects manifests with malformed version", async () => {
    await writePlugin("p-ajv-version", { version: "1.0" });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const ctxArgs: unknown[] = [];
    const origErr = console.error;
    console.error = (_msg: string, ctx?: unknown) => { if (ctx) ctxArgs.push(ctx); };
    try {
      await runtime.load();
    } finally {
      console.error = origErr;
    }
    expect(runtime.listPluginIds()).toHaveLength(0);
    expect(ctxArgs.some((c) => (c as Record<string, unknown>)?.phase === PluginPhase.VALIDATION_FAIL)).toBe(true);
  });

  it("B-1: AJV rejects manifests with description > 280 chars", async () => {
    await writePlugin("p-ajv-desc", { description: "x".repeat(300) });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const origErr = console.error;
    const errors: string[] = [];
    console.error = (msg: string) => errors.push(String(msg));
    try {
      await runtime.load();
    } finally {
      console.error = origErr;
    }
    expect(runtime.listPluginIds()).toHaveLength(0);
  });

  it("B-3: uiCallable not in tools[] is rejected", async () => {
    await writePlugin("p-ui-missing", { uiCallable: ["p-ui-missing_ghost"] });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const origErr = console.error;
    const ctxArgs: unknown[] = [];
    console.error = (_msg: string, ctx?: unknown) => { if (ctx) ctxArgs.push(ctx); };
    try {
      await runtime.load();
    } finally {
      console.error = origErr;
    }
    expect(runtime.listPluginIds()).toHaveLength(0);
    expect(ctxArgs.some((c) => (c as Record<string, unknown>)?.phase === PluginPhase.VALIDATION_FAIL)).toBe(true);
  });

  it("B-3: any suffix in uiCallable accepted when tool is in tools[]", async () => {
    await writePlugin("p-destructive", {
      uiCallable: ["p-destructive_delete"],
      installPolicy: "user",
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("p-destructive");
  });

  it("B-3: read-like uiCallable tool is permitted", async () => {
    await writePlugin("p-ok", { tools: ["p-ok_get", "p-ok_delete"], uiCallable: ["p-ok_get"], installPolicy: "user" });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("p-ok");
  });
});
