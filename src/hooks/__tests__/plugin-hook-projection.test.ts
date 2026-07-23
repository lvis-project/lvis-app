import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";
import { ScriptHookManager } from "../script-hook-manager.js";
import { PluginHookTrustStore, preparePluginHookGeneration } from "../plugin-hook-projection.js";

const payloadRoot = mkdtempSync(join(tmpdir(), "lvis-plugin-hook-projection-"));
mkdirSync(join(payloadRoot, "hooks"), { recursive: true });
writeFileSync(join(payloadRoot, "hooks", "policy.mjs"), "process.stdout.write(JSON.stringify({ action: 'allow', reason: 'ok' }))");

afterAll(() => rmSync(payloadRoot, { recursive: true, force: true }));

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
            PreToolUse: [{ matcher: "ep_*", hooks: [{ type: "command", command: ["node", "./policy.mjs"] }] }],
          },
        }),
      }],
    }],
  };
}

describe("plugin-owned Hook projections", () => {
  it("prepares without spawn and contributes nothing until exact trust", () => {
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot);
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
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    ]);
  });

  it("does not transfer trust across versions or fingerprints", () => {
    const trust = new PluginHookTrustStore();
    const [approved] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot);
    trust.approve(approved);
    const [newVersion] = preparePluginHookGeneration(generation("2.0.0", "g2"), payloadRoot);
    const [changed] = preparePluginHookGeneration(generation("1.0.0", "g3", "b".repeat(64)), payloadRoot);
    const [restored] = preparePluginHookGeneration(generation("1.0.0", "g1-restored"), payloadRoot);
    expect(trust.isApproved(newVersion)).toBe(false);
    expect(trust.isApproved(changed)).toBe(false);
    expect(trust.isApproved(restored)).toBe(true);
  });

  it("removes only the retired owner generation", () => {
    const trust = new PluginHookTrustStore();
    const manager = new ScriptHookManager();
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot);
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
    expect(() => preparePluginHookGeneration(malformed, payloadRoot)).toThrow(/not valid JSON/);
  });

  it("anchors executable paths to the retained generation root", () => {
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot);
    expect(projection.entries[0].command).toEqual(["node", realpathSync(join(payloadRoot, "hooks", "policy.mjs"))]);
  });
});
