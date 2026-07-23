import { describe, expect, it, vi } from "vitest";
import { PluginRuntime } from "../index.js";
import type { PluginManifest } from "../../types.js";

const pluginId = "session-bound-auth";
const generationId = "generation-1";
const manifest: PluginManifest = {
  id: pluginId,
  name: "Session-bound auth",
  version: "1.0.0",
  entry: "index.js",
  description: "test",
  tools: [],
  auth: {
    statusTool: "auth_status",
    loginTool: "auth_login",
    logoutTool: "auth_logout",
  },
};

function runtime(): PluginRuntime {
  const instance = new PluginRuntime({ hostRoot: "/tmp", manifestPaths: [] });
  instance.setGenerationAccess({
    getActive: vi.fn(() => ({
      pluginId,
      generationId,
      state: { runtime: { manifest } },
    })),
    replaceRuntime: vi.fn(),
  } as never);
  return instance;
}

function observe(
  instance: PluginRuntime,
  toolName: string,
  result: unknown,
) {
  const epoch = instance.beginPluginAuthInvocation(
    pluginId,
    generationId,
    toolName,
  );
  return instance.observePluginAuthResult(
    pluginId,
    generationId,
    toolName,
    result,
    epoch,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function observeDeferred(
  instance: PluginRuntime,
  toolName: string,
  result: Promise<unknown>,
) {
  const epoch = instance.beginPluginAuthInvocation(
    pluginId,
    generationId,
    toolName,
  );
  return instance.observePluginAuthResult(
    pluginId,
    generationId,
    toolName,
    await result,
    epoch,
  );
}

describe("PluginRuntime operation account sessions", () => {
  it("keeps repeated authenticated status stable but rotates after unauthentication", () => {
    const instance = runtime();

    expect(observe(
      instance,
      "auth_status",
      { authenticated: true, account: "Person@Example.com" },
    )).toEqual({});
    const first = instance.getPluginOperationAccountHash(pluginId, generationId);
    expect(first).toMatch(/^[a-f0-9]{64}$/);

    expect(observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    )).toEqual({});
    expect(instance.getPluginOperationAccountHash(pluginId, generationId)).toBe(first);

    expect(observe(
      instance,
      "auth_status",
      { authenticated: false },
    )).toEqual({ invalidatedAccountHash: first });
    expect(instance.getPluginOperationAccountHash(pluginId, generationId)).toBeUndefined();

    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const second = instance.getPluginOperationAccountHash(pluginId, generationId);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it("invalidates the current account binding on explicit logout", () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { data: { authenticated: true, account: "person@example.com" } },
    );
    const current = instance.getPluginOperationAccountHash(pluginId, generationId);

    expect(observe(
      instance,
      "auth_logout",
      { success: true },
    )).toEqual({ invalidatedAccountHash: current });
    expect(instance.getPluginOperationAccountHash(pluginId, generationId)).toBeUndefined();

    observe(
      instance,
      "auth_status",
      { data: { authenticated: true, account: "person@example.com" } },
    );
    expect(instance.getPluginOperationAccountHash(pluginId, generationId))
      .not.toBe(current);
  });

  it("ignores an older authenticated status that completes after a newer principal", async () => {
    const instance = runtime();
    const older = deferred<unknown>();
    const olderCompletion = observeDeferred(instance, "auth_status", older.promise);
    const newer = observeDeferred(
      instance,
      "auth_status",
      Promise.resolve({ authenticated: true, account: "newer@example.com" }),
    );

    await newer;
    const newerPrincipal = instance.getPluginOperationAccountHash(pluginId, generationId);
    older.resolve({ authenticated: true, account: "older@example.com" });
    await olderCompletion;

    expect(instance.getPluginOperationAccountHash(pluginId, generationId))
      .toBe(newerPrincipal);
  });

  it("ignores stale unauthenticated status and logout completions after a newer principal", async () => {
    const instance = runtime();
    for (const [toolName, result] of [
      ["auth_status", { authenticated: false }],
      ["auth_logout", { success: true }],
    ] as const) {
      const stale = deferred<unknown>();
      const staleCompletion = observeDeferred(instance, toolName, stale.promise);
      await observeDeferred(
        instance,
        "auth_status",
        Promise.resolve({
          authenticated: true,
          account: `${toolName}@example.com`,
        }),
      );
      const newerPrincipal = instance.getPluginOperationAccountHash(pluginId, generationId);

      stale.resolve(result);
      await staleCompletion;

      expect(instance.getPluginOperationAccountHash(pluginId, generationId))
        .toBe(newerPrincipal);
    }
  });

  it("ignores an older unauthenticated status that completes after a newer login starts", async () => {
    const instance = runtime();
    observe(
      instance,
      "auth_status",
      { authenticated: true, account: "current@example.com" },
    );
    const currentPrincipal = instance.getPluginOperationAccountHash(pluginId, generationId);
    const staleStatus = deferred<unknown>();
    const staleCompletion = observeDeferred(
      instance,
      "auth_status",
      staleStatus.promise,
    );

    await observeDeferred(
      instance,
      "auth_login",
      Promise.resolve({ success: true }),
    );
    staleStatus.resolve({ authenticated: false });
    await staleCompletion;

    expect(instance.getPluginOperationAccountHash(pluginId, generationId))
      .toBe(currentPrincipal);
  });
});
