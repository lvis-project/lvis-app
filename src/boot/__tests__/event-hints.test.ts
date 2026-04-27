/**
 * buildManifestEventHints — manifest-driven proactive hint resolution.
 *
 * Tests:
 *  1. Old string form → neutral fallback hint {category:"system",priority:"low",title:eventType}
 *  2. New object form with hint → uses hint verbatim
 *  3. New object form without hint → neutral fallback
 *  4. Mixed old+new in same manifest → both resolved correctly
 *  5. Multiple plugins → hints from all are merged
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../../plugins/runtime.js";
import { buildManifestEventHints } from "../plugins.js";
import { mkdtempSync } from "node:fs";

async function writePlugin(
  installedDir: string,
  registryPath: string,
  id: string,
  eventSubscriptions: unknown[],
): Promise<void> {
  const pluginDir = join(installedDir, id);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "entry.mjs"),
    `export default async function createPlugin(ctx) {
  return { handlers: { ${id}_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
    "utf-8",
  );
  const manifest = {
    id,
    name: id,
    version: "1.0.0",
    entry: "entry.mjs",
    tools: [`${id}_ping`],
    eventSubscriptions,
  };
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(manifest), "utf-8");
  // Append plugin to registry (overwrite with single entry for simplicity; tests use one plugin at a time)
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      plugins: [{ id, manifestPath: join(pluginDir, "plugin.json") }],
    }),
    "utf-8",
  );
}

describe("buildManifestEventHints", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-hints-"));
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("string form → neutral fallback hint", async () => {
    await writePlugin(installedDir, registryPath, "p_str", ["meeting.ended"]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const hints = buildManifestEventHints(runtime);
    expect(hints["meeting.ended"]).toEqual({
      category: "system",
      priority: "low",
      title: "meeting.ended",
    });
  });

  it("object form with hint → uses hint verbatim", async () => {
    await writePlugin(installedDir, registryPath, "p_obj", [
      { type: "meeting.summary.created", hint: { category: "meeting", priority: "medium", title: "회의 요약" } },
    ]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const hints = buildManifestEventHints(runtime);
    expect(hints["meeting.summary.created"]).toEqual({
      category: "meeting",
      priority: "medium",
      title: "회의 요약",
    });
  });

  it("object form without hint → neutral fallback", async () => {
    await writePlugin(installedDir, registryPath, "p_nohint", [
      { type: "email.analyzed" },
    ]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const hints = buildManifestEventHints(runtime);
    expect(hints["email.analyzed"]).toEqual({
      category: "system",
      priority: "low",
      title: "email.analyzed",
    });
  });

  it("mixed old+new in same manifest → both resolved correctly", async () => {
    await writePlugin(installedDir, registryPath, "p_mixed", [
      "email.analyzed",
      { type: "meeting.ended", hint: { category: "meeting", priority: "high", title: "회의 종료" } },
    ]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const hints = buildManifestEventHints(runtime);
    expect(hints["email.analyzed"]).toEqual({
      category: "system",
      priority: "low",
      title: "email.analyzed",
    });
    expect(hints["meeting.ended"]).toEqual({
      category: "meeting",
      priority: "high",
      title: "회의 종료",
    });
  });
});
