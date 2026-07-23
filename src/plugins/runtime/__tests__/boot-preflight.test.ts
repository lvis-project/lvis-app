import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginRuntime } from "../../runtime.js";
import type { PluginManifest } from "../../types.js";
import { writeTestPluginRegistry } from "../../__tests__/test-helpers.js";

const PLUGIN_COUNT = 6;

describe("PluginRuntime boot preflight", () => {
  let root: string;
  let hostRoot: string;
  let pluginsRoot: string;
  let registryPath: string;
  let manifests: Map<string, PluginManifest>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lvis-plugin-boot-preflight-"));
    hostRoot = join(root, "host");
    pluginsRoot = join(root, "plugins");
    registryPath = join(root, "registry.json");
    manifests = new Map();
    await mkdir(hostRoot, { recursive: true });
    await mkdir(pluginsRoot, { recursive: true });

    const entries: Array<{ id: string; manifestPath: string }> = [];
    for (let index = 0; index < PLUGIN_COUNT; index += 1) {
      const id = `preflight-${index}`;
      const pluginRoot = join(pluginsRoot, id);
      const manifestPath = join(pluginRoot, "plugin.json");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(
        join(pluginRoot, "entry.mjs"),
        "export default async () => ({ handlers: {}, start: async () => {} });\n",
        "utf8",
      );
      await writeFile(manifestPath, "{}\n", "utf8");
      entries.push({ id, manifestPath });
      manifests.set(id, {
        id,
        name: id,
        version: "1.0.0",
        description: "boot preflight fixture",
        publisher: "test",
        entry: "entry.mjs",
        ...(index === 2 ? { capabilities: ["rejected-capability"] } : {}),
        ...(index === 3 ? { requires: { capabilities: ["rejected-capability"] } } : {}),
        tools: index === 2
          ? [{
              name: "rejected_tool",
              description: "must never seed ownership",
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { visibility: ["model"] } },
            }]
          : [],
      });
    }
    await writeTestPluginRegistry({ registryPath }, entries);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("bounds concurrent receipt checks, preserves plan order, and parses only accepted manifests once", async () => {
    const runtime = new PluginRuntime({
      hostRoot,
      pluginsRoot,
      registryPath,
      installReceiptCacheRoot: join(root, "receipts"),
    });
    const internals = runtime as unknown as {
      verifyReceiptAndDevGuard(pluginId: string, pluginRoot: string): Promise<{ ok: true } | { ok: false }>;
      readManifest(path: string): Promise<PluginManifest>;
    };
    let activeReceiptChecks = 0;
    let maxReceiptChecks = 0;
    const verified: string[] = [];
    const parseCounts = new Map<string, number>();

    internals.verifyReceiptAndDevGuard = async (pluginId) => {
      activeReceiptChecks += 1;
      maxReceiptChecks = Math.max(maxReceiptChecks, activeReceiptChecks);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeReceiptChecks -= 1;
      verified.push(pluginId);
      return pluginId === "preflight-2" ? { ok: false } : { ok: true };
    };
    internals.readManifest = async (path) => {
      const id = path.split(/[\\/]/).at(-2)!;
      parseCounts.set(id, (parseCounts.get(id) ?? 0) + 1);
      return manifests.get(id)!;
    };

    await runtime.load();

    expect(maxReceiptChecks).toBe(4);
    expect(verified).toHaveLength(PLUGIN_COUNT);
    expect(runtime.listPluginIds()).toEqual([
      "preflight-0",
      "preflight-1",
      "preflight-4",
      "preflight-5",
    ]);
    expect(parseCounts.get("preflight-2")).toBeUndefined();
    for (const id of ["preflight-0", "preflight-1", "preflight-3", "preflight-4", "preflight-5"]) {
      expect(parseCounts.get(id)).toBe(1);
    }
    expect(runtime.resolveToolOwner("rejected_tool")).toBeUndefined();
    expect(runtime.listPluginCards().find((card) => card.id === "preflight-3")?.loadStatus).toBe("failed");
  });
});
