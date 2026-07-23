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

describe("PluginRuntime operation account sessions", () => {
  it("keeps repeated authenticated status stable but rotates after unauthentication", () => {
    const instance = runtime();

    expect(instance.observePluginAuthResult(
      pluginId,
      generationId,
      "auth_status",
      { authenticated: true, account: "Person@Example.com" },
    )).toEqual({});
    const first = instance.getPluginOperationAccountHash(pluginId, generationId);
    expect(first).toMatch(/^[a-f0-9]{64}$/);

    expect(instance.observePluginAuthResult(
      pluginId,
      generationId,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    )).toEqual({});
    expect(instance.getPluginOperationAccountHash(pluginId, generationId)).toBe(first);

    expect(instance.observePluginAuthResult(
      pluginId,
      generationId,
      "auth_status",
      { authenticated: false },
    )).toEqual({ invalidatedAccountHash: first });
    expect(instance.getPluginOperationAccountHash(pluginId, generationId)).toBeUndefined();

    instance.observePluginAuthResult(
      pluginId,
      generationId,
      "auth_status",
      { authenticated: true, account: "person@example.com" },
    );
    const second = instance.getPluginOperationAccountHash(pluginId, generationId);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it("invalidates the current account binding on explicit logout", () => {
    const instance = runtime();
    instance.observePluginAuthResult(
      pluginId,
      generationId,
      "auth_status",
      { data: { authenticated: true, account: "person@example.com" } },
    );
    const current = instance.getPluginOperationAccountHash(pluginId, generationId);

    expect(instance.observePluginAuthResult(
      pluginId,
      generationId,
      "auth_logout",
      { success: true },
    )).toEqual({ invalidatedAccountHash: current });
    expect(instance.getPluginOperationAccountHash(pluginId, generationId)).toBeUndefined();

    instance.observePluginAuthResult(
      pluginId,
      generationId,
      "auth_status",
      { data: { authenticated: true, account: "person@example.com" } },
    );
    expect(instance.getPluginOperationAccountHash(pluginId, generationId))
      .not.toBe(current);
  });
});
