import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeTestPluginRuntime,
  makeTestTreeWritable,
} from "../../__tests__/test-helpers.js";
import {
  buildInstallReceipt,
} from "../../plugin-install-receipt.js";
import {
  createNoopHostApiForTests,
  type PluginRuntimeOptions,
} from "../../runtime.js";
import type { PluginManifest } from "../../types.js";
import { canonicalJSON } from "../../whitelist/canonical-json.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTestTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

async function writePreparedPlugin(
  root: string,
  manifestId: string,
  installId: string,
): Promise<{
  pluginRoot: string;
  manifest: PluginManifest;
  receiptRaw: string;
  registryEntry: {
    installSource: "user";
    manifestSha256: string;
  };
}> {
  const pluginRoot = join(root, `staging-${manifestId}`);
  await mkdir(pluginRoot, { recursive: true });
  const toolName = `${manifestId.replaceAll("-", "_")}_ping`;
  const manifest: PluginManifest = {
    id: manifestId,
    name: manifestId,
    version: "1.0.0",
    entry: "entry.mjs",
    description: "Prepared identity fixture.",
    publisher: "LVIS",
    tools: [{
      name: toolName,
      description: "ping",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model"] } },
    }],
  };
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(manifest), "utf8");
  await writeFile(
    join(pluginRoot, "entry.mjs"),
    `export default async function createPlugin() {
  return { handlers: { ${toolName}: async () => "pong" } };
}
`,
    "utf8",
  );
  const { receipt } = await buildInstallReceipt(pluginRoot, {
    pluginId: installId,
    version: manifest.version,
    installSource: "marketplace",
    artifactSha256: "a".repeat(64),
    signerKeyId: "test-v1",
    files: ["entry.mjs", "plugin.json"],
    installedAt: new Date(0).toISOString(),
  });
  return {
    pluginRoot,
    manifest,
    receiptRaw: JSON.stringify(receipt),
    registryEntry: {
      installSource: "user",
      manifestSha256: createHash("sha256")
        .update(canonicalJSON(manifest))
        .digest("hex"),
    },
  };
}

describe("prepared artifact install identity", () => {
  it("passes fresh provenance into production-shaped HostApi creation and publishes it after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-prepared-identity-"));
    roots.push(root);
    const installId = "catalog-fresh";
    const canonicalId = "manifest-fresh";
    const prepared = await writePreparedPlugin(root, canonicalId, installId);
    const observedInstallIds: Array<string | null> = [];
    const observedRegistryEntries: unknown[] = [];
    const createHostApi: PluginRuntimeOptions["createHostApi"] = (
      pluginId,
      manifest,
      dataDir,
      _incarnation,
      candidateInstallId,
      candidateRegistryEntry,
    ) => {
      observedInstallIds.push(candidateInstallId);
      observedRegistryEntries.push(candidateRegistryEntry);
      return createNoopHostApiForTests(pluginId, manifest, dataDir);
    };
    const runtime = makeTestPluginRuntime(
      {
        rootDir: root,
        registryPath: join(root, "plugins", "registry.json"),
        pluginsRoot: join(root, "plugins"),
      },
      {
        installReceiptCacheRoot: join(root, "cache"),
        createHostApi,
      },
    );
    const durableCommit = vi.fn(async () => "committed");

    const activated = await runtime.activatePreparedArtifact({
      installId,
      ...prepared,
      durableCommit,
    });
    await activated.retirement;

    expect(activated.result).toBe("committed");
    expect(durableCommit).toHaveBeenCalledOnce();
    expect(observedInstallIds).toEqual([installId]);
    expect(observedRegistryEntries).toEqual([prepared.registryEntry]);
    expect(runtime.resolvePluginInstallId(canonicalId)).toBe(installId);
    await expect(runtime.call("manifest_fresh_ping")).resolves.toBe("pong");
  });

  it("rejects a prepared manifest id already owned as another plugin's install alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-prepared-collision-"));
    roots.push(root);
    const runtime = makeTestPluginRuntime(
      {
        rootDir: root,
        registryPath: join(root, "plugins", "registry.json"),
        pluginsRoot: join(root, "plugins"),
      },
      { installReceiptCacheRoot: join(root, "cache") },
    );
    const owner = await writePreparedPlugin(root, "canonical-owner", "claimed-alias");
    await runtime.activatePreparedArtifact({
      installId: "claimed-alias",
      ...owner,
      durableCommit: async () => "owner-committed",
    });
    const collision = await writePreparedPlugin(
      root,
      "claimed-alias",
      "claimed-alias",
    );
    const durableCommit = vi.fn(async () => "must-not-commit");

    await expect(runtime.activatePreparedArtifact({
      installId: "claimed-alias",
      ...collision,
      durableCommit,
    })).rejects.toMatchObject({ code: "plugin-identity-collision" });
    expect(durableCommit).not.toHaveBeenCalled();
    expect(runtime.resolvePluginId("claimed-alias")).toBe("canonical-owner");
  });

  it("atomically reserves canonical and install identities until durable publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-prepared-concurrent-collision-"));
    roots.push(root);
    const runtime = makeTestPluginRuntime(
      {
        rootDir: root,
        registryPath: join(root, "plugins", "registry.json"),
        pluginsRoot: join(root, "plugins"),
      },
      { installReceiptCacheRoot: join(root, "cache") },
    );
    const owner = await writePreparedPlugin(
      root,
      "concurrent-owner",
      "shared-identity",
    );
    const collision = await writePreparedPlugin(
      root,
      "shared-identity",
      "second-install",
    );
    let releaseCommit!: () => void;
    const holdCommit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let signalCommitEntered!: () => void;
    const commitEntered = new Promise<void>((resolve) => {
      signalCommitEntered = resolve;
    });
    const ownerCommit = vi.fn(async () => {
      signalCommitEntered();
      await holdCommit;
      return "owner-committed";
    });
    const collisionCommit = vi.fn(async () => "must-not-commit");

    const ownerActivation = runtime.activatePreparedArtifact({
      installId: "shared-identity",
      ...owner,
      durableCommit: ownerCommit,
    });
    await commitEntered;
    await expect(runtime.activatePreparedArtifact({
      installId: "second-install",
      ...collision,
      durableCommit: collisionCommit,
    })).rejects.toMatchObject({ code: "plugin-identity-collision" });
    expect(ownerCommit).toHaveBeenCalledOnce();
    expect(collisionCommit).not.toHaveBeenCalled();
    releaseCommit();
    const activated = await ownerActivation;
    await activated.retirement;
    expect(runtime.resolvePluginInstallId("concurrent-owner"))
      .toBe("shared-identity");
  });
});
