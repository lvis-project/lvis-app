/**
 * Producer-driven coverage for the skill_load approval wiring.
 *
 * The gate that pops the first-use skill modal must be the SAME instance the
 * tool executor uses. This exercises the real producer — `setupWorkflowStores`
 * — rather than hand-assembling `WorkflowToolDeps`, so a wiring regression in
 * the boot step (not just in the tool) is what turns it red.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { cleanupTmpDir } from "../../../testing/tmp-dir-teardown.js";

// `mkdtempSync`, not `join(tmpdir(), random)`. The latter builds a path and
// then creates it non-exclusively, so anything already sitting at that path —
// including a symlink planted in the shared temp dir — is followed by the
// `mkdirSync`/`writeFileSync` below. `mkdtempSync` creates the directory
// atomically and fails if it exists.
const TEST_HOME = mkdtempSync(join(tmpdir(), "lvis-wf-gate-"));
process.env.LVIS_HOME = TEST_HOME;

const { setupWorkflowStores } = await import("../workflow-stores.js");
const { ToolRegistry } = await import("../../../tools/registry.js");
import type { BootContext } from "../../context.js";
import type { ToolExecutionContext } from "../../../tools/types.js";

function toolCtx(sessionId: string): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    metadata: { sessionId },
  };
}

beforeEach(() => {
  mkdirSync(join(TEST_HOME, "skills", "demo"), { recursive: true });
  writeFileSync(
    join(TEST_HOME, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: A user-authored skill\n---\ndemo body",
    "utf-8",
  );
});

afterEach(async () => {
  await cleanupTmpDir(TEST_HOME);
});

interface GateProbe {
  requests: { toolName?: string; args?: unknown }[];
}

function makeCtx(): { ctx: BootContext; registry: InstanceType<typeof ToolRegistry>; probe: GateProbe } {
  const registry = new ToolRegistry();
  const probe: GateProbe = { requests: [] };
  const approvalGate = {
    requestAndWait: async (req: { toolName?: string; args?: unknown }) => {
      probe.requests.push({ toolName: req.toolName, args: req.args });
      return { choice: "allow" };
    },
  };
  const ctx = {
    routinesStore: undefined,
    getMainWindow: () => null,
    notificationService: undefined,
    approvalGate,
    networkFetch: undefined,
    toolRegistry: registry,
    settingsService: { get: () => undefined, getAll: () => ({}) },
    pluginRuntime: { findPluginIdByCapability: () => undefined },
    auditService: { log: () => {} },
  } as unknown as BootContext;
  return { ctx, registry, probe };
}

describe("setupWorkflowStores — skill_load approval gate wiring", () => {
  it("registers skill_load and routes its first-use modal to ctx.approvalGate", async () => {
    const { ctx, registry, probe } = makeCtx();

    await setupWorkflowStores(ctx);

    const tool = registry.findByName("skill_load");
    expect(tool, "skill_load must be registered by the boot step").toBeDefined();

    const result = await tool!.execute({ skillName: "demo" }, toolCtx("sess-gate"));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).loaded).toBe(true);
    // The modal reached the very gate the BootContext carries.
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.toolName).toBe("skill_load");
    expect(probe.requests[0]?.args).toEqual({ skillName: "demo" });
  });

  it("blocks the skill body when the user denies at that same gate", async () => {
    const registry = new ToolRegistry();
    const ctx = {
      getMainWindow: () => null,
      approvalGate: { requestAndWait: async () => ({ choice: "deny-once" }) },
      toolRegistry: registry,
      settingsService: { get: () => undefined, getAll: () => ({}) },
      pluginRuntime: { findPluginIdByCapability: () => undefined },
      auditService: { log: () => {} },
    } as unknown as BootContext;

    await setupWorkflowStores(ctx);

    const tool = registry.findByName("skill_load");
    const result = await tool!.execute({ skillName: "demo" }, toolCtx("sess-deny"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("user denied skill load");
    expect(result.output).not.toContain("demo body");
  });
});
