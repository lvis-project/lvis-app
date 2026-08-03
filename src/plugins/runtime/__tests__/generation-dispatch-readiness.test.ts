import { describe, expect, it, vi } from "vitest";
import type {
  HostPluginGenerationState,
  PluginRuntimeGenerationLifecycle,
  PluginRuntimeGenerationProjection,
} from "../../plugin-host-generation.js";
import {
  PluginGenerationCoordinator,
  type ActivePluginGeneration,
} from "../../plugin-generation-coordinator.js";
import type { PluginManifest, RuntimePlugin } from "../../types.js";
import { PluginRuntime } from "../index.js";
import { createNoopHostApiForTests } from "../sandbox.js";

const TARGET_ID = "dispatch-readiness-target";
const CALLER_ID = "dispatch-readiness-caller";
const MODEL_TOOL = "dispatch_readiness_model";
const APP_TOOL = "dispatch_readiness_app";
const CALLER_TOOL = "dispatch_readiness_caller";

function manifest(
  pluginId: string,
  version: string,
  tools: PluginManifest["tools"],
): PluginManifest {
  return {
    id: pluginId,
    name: pluginId,
    version,
    description: "dispatch readiness fixture",
    publisher: "LVIS tests",
    entry: "entry.mjs",
    tools,
  };
}

function projection(input: {
  activationId: string;
  manifest: PluginManifest;
  instance: RuntimePlugin;
  methods: PluginRuntimeGenerationProjection["methods"];
}): PluginRuntimeGenerationProjection {
  return {
    activationId: input.activationId,
    installId: null,
    manifest: input.manifest,
    pluginRoot: `/tmp/${input.manifest.id}`,
    instance: input.instance,
    methods: input.methods,
  };
}

function generation(
  runtime: PluginRuntimeGenerationProjection,
  digest: string,
): ActivePluginGeneration<HostPluginGenerationState> {
  return {
    pluginId: runtime.manifest.id,
    pluginVersion: runtime.manifest.version,
    artifactGenerationId: digest.repeat(64),
    generationId: runtime.activationId,
    manifestSha256: digest.repeat(64),
    receiptSha256: digest.repeat(64),
    contributions: [],
    state: {
      payloadRoot: runtime.pluginRoot,
      runtime,
      hooks: [],
      mcpServers: [],
    },
  };
}

async function publish(
  runtime: PluginRuntime,
  coordinator: PluginGenerationCoordinator<HostPluginGenerationState>,
  candidateRuntime: PluginRuntimeGenerationProjection,
  digest: string,
  retire?: (
    predecessor: ActivePluginGeneration<HostPluginGenerationState>,
  ) => Promise<void>,
) {
  const predecessor = coordinator.getActive(candidateRuntime.manifest.id);
  const prepared = runtime.prepareRuntimeGeneration(
    candidateRuntime,
    predecessor?.generationId,
  );
  return coordinator.commit(
    generation(candidateRuntime, digest),
    async () => undefined,
    retire,
    candidateRuntime.manifest.id,
    prepared.publish,
  );
}

function runtimeFixture() {
  const runtime = new PluginRuntime({
    hostRoot: "/tmp",
    createHostApi: createNoopHostApiForTests,
  });
  const coordinator = new PluginGenerationCoordinator<HostPluginGenerationState>();
  const lifecycle: PluginRuntimeGenerationLifecycle = {
    getActive: (pluginId) => {
      const active = coordinator.getActive(pluginId);
      return active
        ? {
            pluginId: active.pluginId,
            generationId: active.generationId,
            manifest: active.state.runtime.manifest,
          }
        : undefined;
    },
    isExactAdmitted: (pluginId, generationId) =>
      coordinator.isExactAdmitted(pluginId, generationId),
    acquire: (pluginId) => coordinator.acquire(pluginId),
    acquireExact: (pluginId, generationId) =>
      coordinator.acquireExact(pluginId, generationId),
    runWithLease: (lease, operation) => coordinator.runWithLease(lease, operation),
    runInLifecycleQueue: (_pluginId, operation) => operation(),
    replaceRuntime: async () => undefined,
    replaceRuntimeWithCommit: async (_candidate, _receiptRaw, durableCommit) => ({
      result: await durableCommit(),
      retirement: Promise.resolve(),
    }),
    deactivate: async () => undefined,
    deactivateWithCommit: async (_pluginId, durableCommit) => ({
      result: await durableCommit(),
      retirement: Promise.resolve(),
    }),
    recoverRetirements: async () => undefined,
    waitForRetirements: async () => undefined,
  };
  runtime.setGenerationAccess(lifecycle);
  return { coordinator, runtime };
}

function targetManifest(version: string): PluginManifest {
  return manifest(TARGET_ID, version, [
    {
      name: MODEL_TOOL,
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model"] } },
    },
    {
      name: APP_TOOL,
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["app"] } },
    },
  ]);
}

describe("replacement generation dispatch readiness", () => {
  it("holds model, app-only, and plugin-to-plugin dispatch until predecessor retirement", async () => {
    const { coordinator, runtime } = runtimeFixture();
    const predecessor = projection({
      activationId: "1".repeat(64),
      manifest: targetManifest("1.0.0"),
      instance: { handlers: {} },
      methods: new Map([
        [MODEL_TOOL, async () => "predecessor:model"],
        [APP_TOOL, async () => "predecessor:app"],
      ]),
    });
    await publish(runtime, coordinator, predecessor, "1");

    const caller = projection({
      activationId: "2".repeat(64),
      manifest: manifest(CALLER_ID, "1.0.0", [{
        name: CALLER_TOOL,
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model"] } },
      }]),
      instance: { handlers: {} },
      methods: new Map([[CALLER_TOOL, async () => runtime.call(MODEL_TOOL)]]),
    });
    await publish(runtime, coordinator, caller, "2");

    const start = vi.fn(async () => undefined);
    let startPromise: Promise<void> | undefined;
    const ensureStarted = vi.fn(() => {
      startPromise ??= start();
      return startPromise;
    });
    const candidate = projection({
      activationId: "3".repeat(64),
      manifest: targetManifest("2.0.0"),
      instance: { handlers: {}, start },
      methods: new Map([
        [MODEL_TOOL, async () => {
          await ensureStarted();
          return "candidate:model";
        }],
        [APP_TOOL, async () => {
          await ensureStarted();
          return "candidate:app";
        }],
      ]),
    });
    let retirementStarted!: () => void;
    const retirementEntered = new Promise<void>((resolve) => {
      retirementStarted = resolve;
    });
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    const published = await publish(runtime, coordinator, candidate, "3", async () => {
      retirementStarted();
      await retirementGate;
    });
    await retirementEntered;

    const modelDispatch = runtime.call(MODEL_TOOL);
    const appDispatch = runtime.callDeclaredAppOnlyTool(APP_TOOL);
    const pluginDispatch = runtime.call(CALLER_TOOL);
    await Promise.resolve();
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();

    releaseRetirement();
    await published.retired;
    published.markDispatchReady();
    await expect(Promise.all([modelDispatch, appDispatch, pluginDispatch])).resolves.toEqual([
      "candidate:model",
      "candidate:app",
      "candidate:model",
    ]);
    expect(start).toHaveBeenCalledOnce();
  });

  it("keeps every candidate dispatch route unavailable after retirement failure", async () => {
    const { coordinator, runtime } = runtimeFixture();
    const predecessor = projection({
      activationId: "4".repeat(64),
      manifest: targetManifest("1.0.0"),
      instance: { handlers: {} },
      methods: new Map([
        [MODEL_TOOL, async () => "predecessor:model"],
        [APP_TOOL, async () => "predecessor:app"],
      ]),
    });
    await publish(runtime, coordinator, predecessor, "4");
    const caller = projection({
      activationId: "5".repeat(64),
      manifest: manifest(CALLER_ID, "1.0.0", [{
        name: CALLER_TOOL,
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model"] } },
      }]),
      instance: { handlers: {} },
      methods: new Map([[CALLER_TOOL, async () => runtime.call(MODEL_TOOL)]]),
    });
    await publish(runtime, coordinator, caller, "5");

    const start = vi.fn(async () => undefined);
    const ensureStarted = vi.fn(async () => start());
    const candidate = projection({
      activationId: "6".repeat(64),
      manifest: targetManifest("2.0.0"),
      instance: { handlers: {}, start },
      methods: new Map([
        [MODEL_TOOL, async () => ensureStarted()],
        [APP_TOOL, async () => ensureStarted()],
      ]),
    });
    const published = await publish(runtime, coordinator, candidate, "6", async () => {
      throw new Error("predecessor retirement retries exhausted");
    });
    await expect(published.retired).rejects.toThrow("retries exhausted");
    published.markDispatchUnavailable(new Error("predecessor retirement retries exhausted"));

    await expect(runtime.call(MODEL_TOOL)).rejects.toThrow(/dispatch blocked/);
    await expect(runtime.callDeclaredAppOnlyTool(APP_TOOL)).rejects.toThrow(/dispatch blocked/);
    await expect(runtime.call(CALLER_TOOL)).rejects.toThrow(/dispatch blocked/);
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
