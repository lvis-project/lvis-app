import { mkdtemp } from "node:fs/promises";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginRuntime } from "../runtime/index.js";
import { hashReceiptFiles, writeInstallReceipt } from "../plugin-install-receipt.js";
import type {
  HostPluginGenerationState,
  PluginRuntimeGenerationProjection,
} from "../plugin-host-generation.js";
import { makeTestTreeWritable } from "./test-helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTestTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("PluginRuntime immutable generation root", () => {
  it("keeps a booted g1 lease on g1 bytes after the canonical install root changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-runtime-generation-root-"));
    roots.push(root);
    const pluginsRoot = join(root, "plugins");
    const cacheRoot = join(root, "cache");
    const pluginId = "immutable-root";
    const pluginRoot = join(pluginsRoot, pluginId);
    const registryPath = join(pluginsRoot, "registry.json");
    await mkdir(pluginRoot, { recursive: true });
    const manifest = {
      id: pluginId,
      name: "Immutable root",
      version: "1.0.0",
      entry: "entry.mjs",
      description: "Reads one receipt-covered fixture byte.",
      publisher: "LVIS",
      tools: [{
        name: "immutable_root_read",
        description: "Read the immutable generation fixture.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        _meta: { ui: { visibility: ["model"] } },
      }],
    };
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(pluginRoot, "value.txt"), "g1", "utf8");
    await writeFile(
      join(pluginRoot, "entry.mjs"),
      `import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export default async function createPlugin(ctx) {
  return { handlers: { immutable_root_read: async () => readFile(resolve(ctx.pluginRoot, "value.txt"), "utf8") } };
}`,
      "utf8",
    );
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{ id: pluginId, manifestPath: join(pluginRoot, "plugin.json"), enabled: true }],
    }), "utf8");
    const receiptFiles = ["entry.mjs", "plugin.json", "value.txt"];
    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 2,
      pluginId,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "test-v1",
      installedAt: new Date(0).toISOString(),
      files: await hashReceiptFiles(pluginRoot, receiptFiles),
    });

    let runtime!: PluginRuntime;
    let active: {
      pluginId: string;
      generationId: string;
      state: HostPluginGenerationState;
    } | undefined;
    const generationId = "b".repeat(64);
    const access = {
      getActive: vi.fn(() => active),
      acquire: vi.fn(async () => ({ generation: active!, release: vi.fn() })),
      acquireExact: vi.fn(async () => ({ generation: active!, release: vi.fn() })),
      runWithLease: vi.fn(async (_lease, operation) => operation()),
      replaceRuntime: vi.fn(async (projection: PluginRuntimeGenerationProjection) => {
        projection.hostEffects?.bindGeneration(access as never, generationId);
        runtime.prepareRuntimeGeneration(projection).publish();
        active = {
          pluginId,
          generationId,
          state: {
            payloadRoot: projection.pluginRoot,
            runtime: projection,
            hooks: [],
            mcpServers: [],
          },
        };
      }),
      waitForRetirements: vi.fn(async () => undefined),
    };
    runtime = new PluginRuntime({
      hostRoot: root,
      registryPath,
      pluginsRoot,
      installReceiptCacheRoot: cacheRoot,
    });
    runtime.setGenerationAccess(access as never);
    await runtime.startAll();

    const bootProjection = runtime.getRuntimeGenerationProjection(pluginId);
    expect(bootProjection?.pluginRoot).toContain(`${join(cacheRoot, pluginId, "generations")}`);
    expect(await runtime.call("immutable_root_read")).toBe("g1");

    await writeFile(join(pluginRoot, "value.txt"), "g2", "utf8");
    expect(await readFile(join(pluginRoot, "value.txt"), "utf8")).toBe("g2");
    expect(await runtime.call("immutable_root_read")).toBe("g1");
    expect(access.acquire).toHaveBeenCalled();

    const generationsRoot = join(cacheRoot, pluginId, "generations");
    const generationIdsBeforeFailedRestart = await readdir(generationsRoot);
    await writeFile(join(pluginRoot, "entry.mjs"), "export default {", "utf8");
    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 2,
      pluginId,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "c".repeat(64),
      signerKeyId: "test-v1",
      installedAt: new Date(1).toISOString(),
      files: await hashReceiptFiles(pluginRoot, receiptFiles),
    });
    await expect(runtime.restartPlugin(pluginId)).resolves.toBe("failed");
    expect(await readdir(generationsRoot)).toEqual(generationIdsBeforeFailedRestart);
    expect(await runtime.call("immutable_root_read")).toBe("g1");
  });
});
