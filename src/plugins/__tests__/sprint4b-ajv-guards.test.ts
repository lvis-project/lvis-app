/**
 * Sprint 4-B unit tests — AJV wiring (B-1), uiActions structural
 * validation (B-3), capability gate (B-5 — tested via manifest field), and
 * rate-limit (B-7 — tested in sprint4b-rate-limit.test.ts).
 *
 * NOTE: The legacy suffix-based "destructive verb" gate has been removed.
 * uiActions validation is now structural: every entry must be a valid
 * runtime method name. UI-only methods may stay out of tools[] so they are
 * not registered as LLM tools. Security relies on code review + marketplace
 * approval + signature verification — not on naming patterns.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNoopHostApiForTests, PluginRuntime } from "../runtime.js";
import { PluginPhase } from "../lifecycle-log.js";
import { mkdtempSync } from "node:fs";
import { compileLegacyToolSurface } from "./test-helpers.js";

describe("Sprint 4-B — AJV + uiActions + destructive guards", () => {
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
    const manifest: Record<string, unknown> = {
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry: "entry.mjs",
      tools: [`${id}_hello`, `${id}_delete`],
      ...manifestOverrides,
    };
    // Pure v6: compile any legacy tools[]/uiActions/toolSchemas surface into Tool[].
    const toolNames = Array.isArray(manifest.tools)
      ? (manifest.tools as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    manifest.tools = compileLegacyToolSurface({
      tools: toolNames,
      uiActions: manifest.uiActions as Record<string, { description?: string }> | undefined,
      toolSchemas: manifest.toolSchemas as Record<string, Record<string, unknown>> | undefined,
    });
    delete manifest.uiActions;
    delete manifest.toolSchemas;
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
    await writePlugin("p-ajv-version", { tools: ["pav_hello", "pav_delete"], version: "1.0" });
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests, hostRoot: testDir, registryPath, pluginsRoot: installedDir });
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
    await writePlugin("p-ajv-desc", { tools: ["pad_hello", "pad_delete"], description: "x".repeat(300) });
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests, hostRoot: testDir, registryPath, pluginsRoot: installedDir });
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

  it("B-3: uiActions not in tools[] is accepted as UI-only runtime method", async () => {
    await writePlugin("p-ui-missing", { tools: ["pum_hello", "pum_delete"], uiActions: { p_ui_missing_ghost: {} } });
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests, hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const origErr = console.error;
    const ctxArgs: unknown[] = [];
    console.error = (_msg: string, ctx?: unknown) => { if (ctx) ctxArgs.push(ctx); };
    try {
      await runtime.load();
    } finally {
      console.error = origErr;
    }
    expect(runtime.listPluginIds()).toContain("p-ui-missing");
    expect(ctxArgs.some((c) => (c as Record<string, unknown>)?.phase === PluginPhase.VALIDATION_FAIL)).toBe(false);
  });

  it("B-3: any suffix in uiActions accepted when tool is in tools[]", async () => {
    await writePlugin("p-destructive", {
      tools: ["pd_hello", "pd_delete"],
      uiActions: { pd_delete: {} },
      installPolicy: "user",
    });
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests, hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("p-destructive");
  });

  it("B-3: read-like uiActions tool is permitted", async () => {
    await writePlugin("p-ok", { tools: ["pok_get", "pok_delete"], uiActions: { pok_get: {} }, installPolicy: "user" });
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests, hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("p-ok");
  });
});
