import { describe, expect, it } from "vitest";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";
import { ScriptHookManager } from "../script-hook-manager.js";
import { PluginHookTrustStore, preparePluginHookGeneration } from "../plugin-hook-projection.js";

function generation(version: string, generationId: string, fingerprint = "a".repeat(64)): ActivePluginGeneration {
  return {
    pluginId: "bundle-hooks",
    pluginVersion: version,
    generationId,
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [{
      ownerPluginId: "bundle-hooks",
      ownerVersion: version,
      kind: "hook",
      localId: "policy",
      path: "hooks/policy.json",
      fingerprint,
      files: [{
        path: "hooks/policy.json",
        sha256: fingerprint,
        content: JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "ep_*", hooks: [{ type: "command", command: ["node", "./hooks/policy.mjs"] }] }],
          },
        }),
      }],
    }],
  };
}

describe("plugin-owned Hook projections", () => {
  it("prepares without spawn and contributes nothing until exact trust", () => {
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"));
    const trust = new PluginHookTrustStore();
    const manager = new ScriptHookManager();
    manager.publishPluginGeneration([projection], trust);
    expect(manager.size()).toBe(0);
    trust.approve(projection);
    manager.publishPluginGeneration([projection], trust);
    expect(manager.hooksOfType("pre")).toEqual([
      expect.objectContaining({
        id: "plugin:bundle-hooks:policy:PreToolUse#0.0",
        owner: expect.objectContaining({
          pluginId: "bundle-hooks",
          pluginVersion: "1.0.0",
          generationId: "g1",
          localId: "policy",
          fingerprint: "a".repeat(64),
        }),
      }),
    ]);
  });

  it("does not transfer trust across versions or fingerprints", () => {
    const trust = new PluginHookTrustStore();
    const [approved] = preparePluginHookGeneration(generation("1.0.0", "g1"));
    trust.approve(approved);
    const [newVersion] = preparePluginHookGeneration(generation("2.0.0", "g2"));
    const [changed] = preparePluginHookGeneration(generation("1.0.0", "g3", "b".repeat(64)));
    const [restored] = preparePluginHookGeneration(generation("1.0.0", "g1-restored"));
    expect(trust.isApproved(newVersion)).toBe(false);
    expect(trust.isApproved(changed)).toBe(false);
    expect(trust.isApproved(restored)).toBe(true);
  });

  it("removes only the retired owner generation", () => {
    const trust = new PluginHookTrustStore();
    const manager = new ScriptHookManager();
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"));
    trust.approve(projection);
    manager.publishPluginGeneration([projection], trust);
    manager.removePluginGeneration("bundle-hooks", "g1");
    expect(manager.size()).toBe(0);
  });

  it("rejects malformed configuration before publication", () => {
    const broken = generation("1.0.0", "g1");
    const contribution = broken.contributions[0];
    const malformed: ActivePluginGeneration = {
      ...broken,
      contributions: [{ ...contribution, files: [{ ...contribution.files[0], content: "{" }] }],
    };
    expect(() => preparePluginHookGeneration(malformed)).toThrow(/not valid JSON/);
  });
});
