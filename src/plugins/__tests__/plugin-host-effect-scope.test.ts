import { describe, expect, it, vi } from "vitest";
import { HostApiGenerationScope } from "../plugin-host-effect-scope.js";
import type { PluginRuntimeGenerationAccess } from "../plugin-host-generation.js";

function generationAccess(activeGenerationId: { current: string }): PluginRuntimeGenerationAccess {
  return {
    getActive: vi.fn(() => undefined),
    isExactAdmitted: vi.fn((_pluginId, generationId) =>
      generationId === activeGenerationId.current),
    acquire: vi.fn(async () => { throw new Error("not used"); }),
    acquireExact: vi.fn(async (_pluginId, generationId) => {
      if (generationId !== activeGenerationId.current) throw new Error("not active");
      return {
        generation: { generationId } as never,
        release: vi.fn(),
      };
    }),
    runWithLease: vi.fn(async (_lease, operation) => operation()),
  };
}

describe("HostApiGenerationScope", () => {
  it("queues reversible signals, rejects writes, and opens only after exact publish", async () => {
    const active = { current: "g1" };
    const scope = new HostApiGenerationScope("ep-api");
    const emitEvent = vi.fn();
    const set = vi.fn(async () => undefined);
    const api = scope.wrapHostApi({
      emitEvent,
      logEvent: vi.fn(),
      config: { get: vi.fn(), set, onChange: vi.fn() },
    } as never);

    api.emitEvent("ep.ready", { ok: true });
    expect(emitEvent).not.toHaveBeenCalled();
    expect(() => api.config.set("mode", "remote")).toThrow(/replacement generation is preparing/);
    expect(set).not.toHaveBeenCalled();

    scope.bindGeneration(generationAccess(active), "g1");
    scope.publish();
    expect(emitEvent).not.toHaveBeenCalled();
    expect(scope.postPublish()).toEqual([]);
    expect(emitEvent).toHaveBeenCalledWith("ep.ready", { ok: true });
  });

  it("admits callbacks only for the exact active generation and disposes exact resources", async () => {
    const active = { current: "g1" };
    const scope = new HostApiGenerationScope("ep-api");
    const access = generationAccess(active);
    const callback = vi.fn();
    const dispose = vi.fn();
    scope.registerDisposer(dispose);
    scope.bindGeneration(access, "g1");
    scope.publish();

    await scope.wrapCallback(callback)("first");
    expect(callback).toHaveBeenCalledWith("first");
    expect(access.runWithLease).toHaveBeenCalledTimes(1);
    active.current = "g2";
    await scope.wrapCallback(callback)("stale");
    expect(callback).toHaveBeenCalledTimes(1);

    scope.supersede();
    scope.retire();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects detached HostApi calls after supersede without a live exact admission", () => {
    const active = { current: "g1" };
    const access = generationAccess(active);
    const admitted = vi.mocked(access.isExactAdmitted);
    admitted.mockReturnValue(false);
    const scope = new HostApiGenerationScope("ep-api");
    const getInstalledPluginIds = vi.fn(() => ["ep-api"]);
    const api = scope.wrapHostApi({ getInstalledPluginIds } as never);
    scope.bindGeneration(access, "g1");
    scope.publish();
    scope.supersede();

    expect(() => api.getInstalledPluginIds()).toThrow(/retired generation/);
    expect(getInstalledPluginIds).not.toHaveBeenCalled();
  });

  it("discards a failed candidate and rejects its late work", () => {
    const scope = new HostApiGenerationScope("ep-api");
    const dispose = vi.fn();
    const api = scope.wrapHostApi({ getInstalledPluginIds: vi.fn(() => []) } as never);
    scope.registerDisposer(dispose);
    scope.discard();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => api.getInstalledPluginIds()).toThrow(/retired generation/);
  });

  it("removes and restores generation-owned published effects", () => {
    const active = { current: "g1" };
    const scope = new HostApiGenerationScope("ep-api");
    const publish = vi.fn();
    const remove = vi.fn();
    scope.stagePublish(publish);
    scope.onSupersede(remove);
    scope.bindGeneration(generationAccess(active), "g1");

    scope.publish();
    scope.supersede();
    scope.resume();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("refuses a path the effect SOT does not list, which is what covers callTool", () => {
    // The refusal used to be written twice — once as `path === "callTool"` and
    // once as "no entry in HOSTAPI_EFFECT_BY_PATH". Nothing pinned the
    // behaviour, so removing the redundant clause broke no test, which is
    // exactly why it needed one.
    //
    // `callTool` left the effect SOT when the hostApi surface was frozen: the
    // surviving `callTool` is the plugin UI webview bridge, not a hostApi
    // member. If it is ever put back into that map, this test turns red and
    // says so, rather than the plugin silently gaining a preparation-time call.
    const scope = new HostApiGenerationScope("ep-api");
    const callTool = vi.fn();
    const api = scope.wrapHostApi({ callTool, logEvent: vi.fn() } as never);

    expect(() => (api as unknown as { callTool: () => void }).callTool()).toThrow(
      /replacement generation is preparing/,
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it("refuses any other unlisted path the same way", () => {
    // The rule is "not in the SOT", not "is callTool" — an unknown member must
    // be refused for the same reason and by the same clause.
    const scope = new HostApiGenerationScope("ep-api");
    const invented = vi.fn();
    const api = scope.wrapHostApi({ someFutureMember: invented, logEvent: vi.fn() } as never);

    expect(() => (api as unknown as { someFutureMember: () => void }).someFutureMember()).toThrow(
      /replacement generation is preparing/,
    );
    expect(invented).not.toHaveBeenCalled();
  });
});
