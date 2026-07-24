/** AJV wiring and pure Tool visibility validation. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginPhase } from "../lifecycle-log.js";
import { mkdtempSync } from "node:fs";
import {
  pureTool,
  TestPluginRuntime as PluginRuntime,
} from "./test-helpers.js";

describe("manifest AJV and Tool visibility guards", () => {
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
    const overrideTools = Array.isArray(manifestOverrides.tools)
      ? manifestOverrides.tools
      : [`${id}_hello`, `${id}_delete`];
    const manifest: Record<string, unknown> = {
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry: "entry.mjs",
      ...manifestOverrides,
      tools: overrideTools.map((tool) =>
        typeof tool === "string" ? pureTool(tool) : tool),
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
    await writePlugin("p-ajv-version", { tools: ["pav_hello", "pav_delete"], version: "1.0" });
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
    await writePlugin("p-ajv-desc", { tools: ["pad_hello", "pad_delete"], description: "x".repeat(300) });
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

  it("accepts an app-only Tool that is not model-visible", async () => {
    await writePlugin("p-ui-missing", {
      tools: [
        pureTool("pum_hello"),
        pureTool("pum_delete"),
        pureTool("p_ui_missing_ghost", ["app"]),
      ],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
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

  it("accepts any suffix for a model-and-app-visible Tool", async () => {
    await writePlugin("p-destructive", {
      tools: [pureTool("pd_hello"), pureTool("pd_delete")],
      installPolicy: "user",
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("p-destructive");
  });

  it("accepts a read-like app-visible Tool", async () => {
    await writePlugin("p-ok", {
      tools: [pureTool("pok_get"), pureTool("pok_delete", ["model"])],
      installPolicy: "user",
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("p-ok");
  });
});
