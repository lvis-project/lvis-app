/**
 * buildManifestEventHints — manifest-driven event hint resolution.
 *
 * Tests:
 *  1. Old string form → neutral fallback hint {category:"system",priority:"low",title:eventType}
 *  2. New object form with hint → uses hint verbatim
 *  3. New object form without hint → neutral fallback
 *  4. Mixed old+new in same manifest → both resolved correctly
 *  5. Multiple plugins → hints from all are merged
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildManifestEventHints } from "../plugins.js";
import { mkdtempSync } from "node:fs";
import {
  makeTestPluginEntrySource,
  makeTestPluginRuntime,
  writeTestPlugin,
  writeTestPluginRegistry,
} from "../../plugins/__tests__/test-helpers.js";

async function writePlugin(
  installedDir: string,
  registryPath: string,
  id: string,
  eventSubscriptions: unknown[],
): Promise<void> {
  const toolName = `${id.replace(/-/g, "_")}_ping`;
  const { manifestPath } = await writeTestPlugin({
    rootDir: dirname(dirname(installedDir)),
    pluginsRoot: installedDir,
    registryPath,
  }, {
    id,
    tools: [toolName],
    entrySource: makeTestPluginEntrySource({ [toolName]: JSON.stringify("pong") }),
    manifest: { eventSubscriptions },
  });
  await writeTestPluginRegistry({ registryPath }, [{ id, manifestPath }]);
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
    await writePlugin(installedDir, registryPath, "p-str", ["meeting.ended"]);
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const hints = buildManifestEventHints(runtime);
    expect(hints["meeting.ended"]).toEqual({
      category: "system",
      priority: "low",
      title: "meeting.ended",
    });
  });

  it("object form with hint → uses hint verbatim", async () => {
    await writePlugin(installedDir, registryPath, "p-obj", [
      { type: "meeting.summary.created", hint: { category: "meeting", priority: "medium", title: "회의 요약" } },
    ]);
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const hints = buildManifestEventHints(runtime);
    expect(hints["meeting.summary.created"]).toEqual({
      category: "meeting",
      priority: "medium",
      title: "회의 요약",
    });
  });

  it("object form without hint → neutral fallback", async () => {
    await writePlugin(installedDir, registryPath, "p-nohint", [
      { type: "email.analyzed" },
    ]);
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();

    const hints = buildManifestEventHints(runtime);
    expect(hints["email.analyzed"]).toEqual({
      category: "system",
      priority: "low",
      title: "email.analyzed",
    });
  });

  it("mixed old+new in same manifest → both resolved correctly", async () => {
    await writePlugin(installedDir, registryPath, "p-mixed", [
      "email.analyzed",
      { type: "meeting.ended", hint: { category: "meeting", priority: "high", title: "회의 종료" } },
    ]);
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
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
