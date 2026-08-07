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
  entrySource?: (toolName: string) => string,
  manifestOverrides: Partial<PluginManifest> = {},
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
    ...manifestOverrides,
  };
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(manifest), "utf8");
  await writeFile(
    join(pluginRoot, "entry.mjs"),
    entrySource?.(toolName) ?? `export default async function createPlugin() {
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
  it("prepares host-managed runtime config before starting a marketplace candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-prepared-python-runtime-"));
    roots.push(root);
    const pluginId = "python-candidate";
    const installId = "catalog-python-candidate";
    const pythonExecutable = join(root, "managed-python");
    const prepared = await writePreparedPlugin(
      root,
      pluginId,
      installId,
      (toolName) => `export default async function createPlugin(context) {
  if (context.config.pythonExecutable !== ${JSON.stringify(pythonExecutable)}) {
    throw new Error("python runtime was not prepared before candidate factory");
  }
  return { handlers: { ${toolName}: async () => "pong" } };
}
`,
      { python: { managedBy: "lvis-app" } },
    );
    const preparePluginStart: NonNullable<PluginRuntimeOptions["preparePluginStart"]> =
      vi.fn(async ({ pluginId: preparedPluginId, manifestPath, pluginRoot }) => {
        expect(preparedPluginId).toBe(pluginId);
        expect(manifestPath).toBe(join(prepared.pluginRoot, "plugin.json"));
        expect(pluginRoot).toBe(prepared.pluginRoot);
        return { configOverride: { pythonExecutable } };
      });
    const runtime = makeTestPluginRuntime(
      {
        rootDir: root,
        registryPath: join(root, "plugins", "registry.json"),
        pluginsRoot: join(root, "plugins"),
      },
      {
        installReceiptCacheRoot: join(root, "cache"),
        preparePluginStart,
      },
    );
    runtime.setConfigOverride(pluginId, {
      pythonExecutable: join(root, "incumbent-python"),
      retained: "incumbent",
    });

    const activated = await runtime.activatePreparedArtifact({
      installId,
      ...prepared,
      durableCommit: async () => "committed",
    });
    await activated.retirement;

    expect(preparePluginStart).toHaveBeenCalledOnce();
    expect(runtime.getConfigOverride(pluginId)).toEqual({
      pythonExecutable,
      retained: "incumbent",
    });
    await expect(runtime.call("python_candidate_ping")).resolves.toBe("pong");
  });

  it("passes fresh provenance into production-shaped HostApi creation and publishes it after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "lvis-prepared-identity-"));
    roots.push(root);
    const installId = "catalog-fresh";
    const canonicalId = "manifest-fresh";
    const prepared = await writePreparedPlugin(root, canonicalId, installId);
    const observedInstallIds: Array<string | null> = [];
    const observedRegistryEntries: unknown[] = [];
    const observedAccessGrants: unknown[] = [];
    const approvedPluginAccess = {
      plugins: [{
        pluginId: "work-assistant",
        events: ["work_assistant.snapshot.requested"],
      }],
    };
    const createHostApi: PluginRuntimeOptions["createHostApi"] = (
      pluginId,
      manifest,
      dataDir,
      _incarnation,
      candidateInstallId,
      candidateRegistryEntry,
      candidateApprovedPluginAccess,
    ) => {
      observedInstallIds.push(candidateInstallId);
      observedRegistryEntries.push(candidateRegistryEntry);
      observedAccessGrants.push(candidateApprovedPluginAccess);
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
      approvedPluginAccess,
      durableCommit,
    });
    await activated.retirement;

    expect(activated.result).toBe("committed");
    expect(durableCommit).toHaveBeenCalledOnce();
    expect(observedInstallIds).toEqual([installId]);
    expect(observedRegistryEntries).toEqual([prepared.registryEntry]);
    expect(observedAccessGrants).toEqual([approvedPluginAccess]);
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

  // Every throw site spanned by the prepared identity reservation belongs in
  // this table: the reservation is released by one outer `finally`, so a phase
  // that is absent here has its release asserted by structure alone. Adding a
  // pre-publication throw site to `activatePreparedArtifact` without adding a
  // row leaves that phase's release unproven.
  const failurePhases: ReadonlyArray<{
    label: string;
    entrySource?: (toolName: string) => string;
    /** Corrupt the registry provenance the activation input carries. */
    failsRegistryProvenance?: boolean;
    failsPreparePluginStart?: boolean;
    /** Delete a receipt-declared payload file so materialization cannot copy it. */
    failsGenerationMaterialization?: boolean;
    failsHostApiIncarnation?: boolean;
    failsDurableCommit?: boolean;
    failsPublication?: boolean;
    /** Message of the first activation's rejection; defaults to the injected error. */
    expectedMessage?: string;
    /** Phases reached only after the durable commit callback has run. */
    reachesDurableCommit?: boolean;
  }> = [
    {
      label: "registry provenance",
      failsRegistryProvenance: true,
      expectedMessage: "registry manifest provenance changed",
    },
    { label: "runtime preparation hook", failsPreparePluginStart: true },
    {
      label: "generation materialization",
      failsGenerationMaterialization: true,
      expectedMessage: "ENOENT",
    },
    { label: "host api incarnation", failsHostApiIncarnation: true },
    {
      label: "module import",
      entrySource: () => 'throw new Error("module import failure");\n',
    },
    {
      label: "plugin factory",
      entrySource: () => `export default async function createPlugin() {
  throw new Error("plugin factory failure");
}
`,
    },
    {
      label: "plugin start",
      entrySource: (toolName) => `export default async function createPlugin() {
  return {
    handlers: { ${toolName}: async () => "pong" },
    start: async () => { throw new Error("plugin start failure"); },
  };
}
`,
    },
    {
      label: "durable commit",
      failsDurableCommit: true,
      reachesDurableCommit: true,
    },
    {
      label: "prepared publication",
      failsPublication: true,
      reachesDurableCommit: true,
    },
  ];

  for (const phase of failurePhases) {
    it(`releases both reserved identities after ${phase.label} failure`, async () => {
      const root = await mkdtemp(join(tmpdir(), "lvis-prepared-retry-"));
      roots.push(root);
      const pluginId = `retry-${phase.label.replaceAll(" ", "-")}`;
      const installId = `catalog-${phase.label.replaceAll(" ", "-")}`;
      const incumbentConfig = {
        pythonExecutable: join(root, "incumbent-python"),
        retained: "incumbent",
      };
      const candidatePythonExecutable = join(root, "candidate-python");
      const failure = new Error(`${phase.label} failure`);
      // Injections that live on the runtime rather than on the activation input
      // must fail the first activation only, so the retry exercises the same
      // runtime instance that still holds the reservation map.
      let injectRuntimeFailure = true;
      const failingCreateHostApi: PluginRuntimeOptions["createHostApi"] = (
        hostApiPluginId,
        hostApiManifest,
        dataDir,
      ) => {
        if (injectRuntimeFailure) throw failure;
        return createNoopHostApiForTests(hostApiPluginId, hostApiManifest, dataDir);
      };
      const runtime = makeTestPluginRuntime(
        {
          rootDir: root,
          registryPath: join(root, "plugins", "registry.json"),
          pluginsRoot: join(root, "plugins"),
        },
        {
          installReceiptCacheRoot: join(root, "cache"),
          preparePluginStart: async () => {
            if (phase.failsPreparePluginStart && injectRuntimeFailure) throw failure;
            return { configOverride: { pythonExecutable: candidatePythonExecutable } };
          },
          ...(phase.failsHostApiIncarnation ? { createHostApi: failingCreateHostApi } : {}),
        },
      );
      runtime.setConfigOverride(pluginId, incumbentConfig);
      const publicationSpy = phase.failsPublication
        ? vi.spyOn(runtime, "prepareRuntimeGeneration").mockImplementation(
          () => ({ publish: () => { throw failure; } }) as never,
        )
        : undefined;
      const failedPrepared = await writePreparedPlugin(
        root,
        pluginId,
        installId,
        phase.entrySource,
      );
      if (phase.failsGenerationMaterialization) {
        // The receipt still declares `entry.mjs`, so materializing the retained
        // generation cannot copy the payload out of the staging tree.
        await rm(join(failedPrepared.pluginRoot, "entry.mjs"));
      }
      const failedRegistryEntry = phase.failsRegistryProvenance
        ? { ...failedPrepared.registryEntry, manifestSha256: "b".repeat(64) }
        : failedPrepared.registryEntry;
      const failedCommit = vi.fn(async () => {
        if (phase.failsDurableCommit) throw failure;
        return "first-commit";
      });

      await expect(runtime.activatePreparedArtifact({
        installId,
        ...failedPrepared,
        registryEntry: failedRegistryEntry,
        durableCommit: failedCommit,
      })).rejects.toThrow(phase.expectedMessage ?? failure.message);
      publicationSpy?.mockRestore();
      injectRuntimeFailure = false;

      expect(runtime.listPluginIds()).not.toContain(pluginId);
      expect(runtime.getConfigOverride(pluginId)).toEqual(incumbentConfig);
      if (phase.reachesDurableCommit) expect(failedCommit).toHaveBeenCalledOnce();
      else expect(failedCommit).not.toHaveBeenCalled();

      const retryPrepared = await writePreparedPlugin(root, pluginId, installId);
      const retryCommit = vi.fn(async () => "retry-commit");
      const activated = await runtime.activatePreparedArtifact({
        installId,
        ...retryPrepared,
        durableCommit: retryCommit,
      });
      await activated.retirement;

      expect(activated.result).toBe("retry-commit");
      expect(retryCommit).toHaveBeenCalledOnce();
      expect(runtime.resolvePluginInstallId(pluginId)).toBe(installId);
      expect(runtime.getConfigOverride(pluginId)).toEqual({
        pythonExecutable: candidatePythonExecutable,
        retained: "incumbent",
      });
      await expect(runtime.call(`${pluginId.replaceAll("-", "_")}_ping`)).resolves.toBe("pong");
    });
  }
});
