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
import { HostApiGenerationScope } from "../../plugin-host-effect-scope.js";

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
  hostEffects?: HostApiGenerationScope;
}): PluginRuntimeGenerationProjection {
  return {
    activationId: input.activationId,
    installId: null,
    manifest: input.manifest,
    pluginRoot: `/tmp/${input.manifest.id}`,
    instance: input.instance,
    methods: input.methods,
    hostEffects: input.hostEffects,
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
  const transition = await coordinator.commit(
    generation(candidateRuntime, digest),
    async () => undefined,
    retire,
    candidateRuntime.manifest.id,
    prepared.publish,
  );
  if (!predecessor) await transition.markDispatchReady();
  return transition;
}

function runtimeFixture(
  auditEntries?: Array<{ level: string; message: string; data?: unknown }>,
) {
  const runtime = new PluginRuntime({
    hostRoot: "/tmp",
    createHostApi: createNoopHostApiForTests,
    ...(auditEntries
      ? {
          auditLog: (level: string, message: string, data?: unknown) => {
            auditEntries.push({ level, message, data });
          },
        }
      : {}),
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
    replaceRuntimeWithCommit: async (_candidate, _receiptRaw, durableCommit) => {
      const completion = Promise.resolve();
      return {
        result: await durableCommit(),
        retirement: completion,
        completion,
        retirementDeferred: false,
      };
    },
    deactivate: async () => undefined,
    deactivateWithCommit: async (_pluginId, durableCommit) => {
      const completion = Promise.resolve();
      return {
        result: await durableCommit(),
        retirement: completion,
        completion,
        retirementDeferred: false,
      };
    },
    recoverRetirements: async () => undefined,
    waitForRetirements: async () => undefined,
  };
  runtime.setGenerationAccess(lifecycle);
  return { coordinator, runtime, lifecycle };
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

describe("generation dispatch readiness", () => {
  it("holds every initial dispatch route until post-publication readiness succeeds", async () => {
    const { coordinator, runtime } = runtimeFixture();
    const caller = projection({
      activationId: "7".repeat(64),
      manifest: manifest(CALLER_ID, "1.0.0", [{
        name: CALLER_TOOL,
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model"] } },
      }]),
      instance: { handlers: {} },
      methods: new Map([[CALLER_TOOL, async () => runtime.call(MODEL_TOOL)]]),
    });
    await publish(runtime, coordinator, caller, "7");

    const start = vi.fn(async () => undefined);
    const ensureStarted = vi.fn(async () => start());
    const candidate = projection({
      activationId: "8".repeat(64),
      manifest: targetManifest("1.0.0"),
      instance: { handlers: {}, start },
      methods: new Map([
        [MODEL_TOOL, async () => ensureStarted().then(() => "initial:model")],
        [APP_TOOL, async () => ensureStarted().then(() => "initial:app")],
      ]),
    });
    const prepared = runtime.prepareRuntimeGeneration(candidate, undefined);
    const transition = await coordinator.commit(
      generation(candidate, "8"),
      async () => undefined,
      undefined,
      TARGET_ID,
      prepared.publish,
    );

    const dispatches = [
      runtime.call(MODEL_TOOL),
      runtime.callDeclaredAppOnlyTool(APP_TOOL),
      runtime.call(CALLER_TOOL),
    ];
    await Promise.resolve();
    expect(ensureStarted).not.toHaveBeenCalled();
    await transition.markDispatchReady();
    await expect(Promise.all(dispatches)).resolves.toEqual([
      "initial:model",
      "initial:app",
      "initial:model",
    ]);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("keeps every initial dispatch route unavailable after readiness failure", async () => {
    const { coordinator, runtime } = runtimeFixture();
    const caller = projection({
      activationId: "9".repeat(64),
      manifest: manifest(CALLER_ID, "1.0.0", [{
        name: CALLER_TOOL,
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model"] } },
      }]),
      instance: { handlers: {} },
      methods: new Map([[CALLER_TOOL, async () => runtime.call(MODEL_TOOL)]]),
    });
    await publish(runtime, coordinator, caller, "9");
    const candidate = projection({
      activationId: "a".repeat(64),
      manifest: targetManifest("1.0.0"),
      instance: { handlers: {} },
      methods: new Map([
        [MODEL_TOOL, async () => "must-not-run"],
        [APP_TOOL, async () => "must-not-run"],
      ]),
    });
    const prepared = runtime.prepareRuntimeGeneration(candidate, undefined);
    const transition = await coordinator.commit(
      generation(candidate, "a"),
      async () => undefined,
      undefined,
      TARGET_ID,
      prepared.publish,
    );
    transition.markDispatchUnavailable(new Error("initial readiness failed"));

    await expect(runtime.call(MODEL_TOOL)).rejects.toThrow(/dispatch blocked/);
    await expect(runtime.callDeclaredAppOnlyTool(APP_TOOL)).rejects.toThrow(/dispatch blocked/);
    await expect(runtime.call(CALLER_TOOL)).rejects.toThrow(/dispatch blocked/);
  });

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
    await published.markDispatchReady();
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

describe("post-publish fault ownership", () => {
  function throwingHostEffect(pluginId: string, lifecycle: PluginRuntimeGenerationLifecycle) {
    // A real scope, not a stub: `emitEvent` is queued while the scope is
    // preparing and replayed by postPublish(), which is where it throws. A
    // stub returning a canned array would pass even if the host stopped
    // replaying queued signals at all.
    const scope = new HostApiGenerationScope(pluginId);
    const api = scope.wrapHostApi({
      emitEvent: () => { throw new Error("generation fence signal failed"); },
      logEvent: vi.fn(),
      config: { get: vi.fn(), set: vi.fn(), onChange: vi.fn() },
    } as never);
    api.emitEvent("ready", {});
    return { scope, bind: (generationId: string) => { scope.bindGeneration(lifecycle, generationId); } };
  }

  async function commitCandidate(
    runtime: PluginRuntime,
    coordinator: PluginGenerationCoordinator<HostPluginGenerationState>,
    candidate: PluginRuntimeGenerationProjection,
    digest: string,
  ) {
    const prepared = runtime.prepareRuntimeGeneration(candidate, undefined);
    return coordinator.commit(
      generation(candidate, digest),
      async () => undefined,
      undefined,
      candidate.manifest.id,
      prepared.publish,
    );
  }

  it("keeps dispatch open when the plugin's own onPublished fails, and records it as degraded", async () => {
    const audit: Array<{ level: string; message: string; data?: unknown }> = [];
    const { coordinator, runtime } = runtimeFixture(audit);
    const candidate = projection({
      activationId: "a".repeat(64),
      manifest: targetManifest("1.0.0"),
      instance: {
        handlers: {},
        onPublished: async () => { throw new Error("worker failed health check within 30000ms"); },
      },
      methods: new Map([
        [MODEL_TOOL, async () => "reached the plugin"],
        [APP_TOOL, async () => "reached the plugin"],
      ]),
    });
    const transition = await commitCandidate(runtime, coordinator, candidate, "a");

    await expect(runtime.postPublishRuntimeGeneration(candidate)).resolves.toBeUndefined();
    await transition.markDispatchReady();

    // The whole point: a startup failure must not spend the rest of the
    // session refusing every tool with a host message.
    await expect(runtime.call(MODEL_TOOL)).resolves.toBe("reached the plugin");
    await expect(runtime.callDeclaredAppOnlyTool(APP_TOOL)).resolves.toBe("reached the plugin");
    expect(audit).toContainEqual(expect.objectContaining({
      level: "warn",
      message: "plugin_post_publish_startup_degraded",
      data: expect.objectContaining({
        pluginId: TARGET_ID,
        error: expect.stringContaining("failed health check"),
      }),
    }));
  });

  it("still refuses dispatch when the host's own generation fence fails", async () => {
    const { coordinator, runtime, lifecycle } = runtimeFixture();
    const effect = throwingHostEffect(TARGET_ID, lifecycle);
    const candidate = projection({
      activationId: "b".repeat(64),
      manifest: targetManifest("1.0.0"),
      instance: { handlers: {} },
      methods: new Map([[MODEL_TOOL, async () => "reached the plugin"]]),
      hostEffects: effect.scope,
    });
    effect.bind(candidate.activationId);
    const transition = await commitCandidate(runtime, coordinator, candidate, "b");

    await expect(runtime.postPublishRuntimeGeneration(candidate))
      .rejects.toThrow(/host generation effects failed to publish/);

    // The caller closes dispatch on that throw, exactly as before the split.
    transition.markDispatchUnavailable(new Error("host generation effects failed to publish"));
    await expect(runtime.call(MODEL_TOOL)).rejects.toThrow(/dispatch blocked/);
  });

  it("does not fold a plugin startup failure back into the host fence faults", async () => {
    // The control for the split. If both classes are merged into one
    // AggregateError again, this AggregateError carries two errors and the
    // plugin's message leaks into a host-owned fault.
    const audit: Array<{ level: string; message: string; data?: unknown }> = [];
    const { coordinator, runtime, lifecycle } = runtimeFixture(audit);
    const effect = throwingHostEffect(TARGET_ID, lifecycle);
    const candidate = projection({
      activationId: "c".repeat(64),
      manifest: targetManifest("1.0.0"),
      instance: {
        handlers: {},
        onPublished: async () => { throw new Error("plugin startup blew up"); },
      },
      methods: new Map([[MODEL_TOOL, async () => "reached the plugin"]]),
      hostEffects: effect.scope,
    });
    effect.bind(candidate.activationId);
    await commitCandidate(runtime, coordinator, candidate, "c");

    const failure = await runtime.postPublishRuntimeGeneration(candidate).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("generation fence signal failed");
    // The plugin fault is still recorded — on its own channel, not this one.
    expect(audit).toContainEqual(expect.objectContaining({
      message: "plugin_post_publish_startup_degraded",
    }));
  });
});
