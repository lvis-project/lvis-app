/**
 * Producer-driven coverage for `setupWorkflowStores` wiring.
 *
 * The gate that pops the first-use skill modal must be the SAME instance the
 * tool executor uses. This exercises the real producer — `setupWorkflowStores`
 * — rather than hand-assembling `WorkflowToolDeps`, so a wiring regression in
 * the boot step (not just in the tool) is what turns it red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

// `mkdtempSync`, not `join(tmpdir(), random)`. The latter builds a path and
// then creates it non-exclusively, so anything already sitting at that path —
// including a symlink planted in the shared temp dir — is followed by the
// `mkdirSync`/`writeFileSync` below. `mkdtempSync` creates the directory
// atomically and fails if it exists.
const TEST_HOME = mkdtempSync(join(tmpdir(), "lvis-wf-gate-"));
process.env.LVIS_HOME = TEST_HOME;

// The SSRF guard resolves DNS before it fetches, which would make this test ask
// the network what it thinks of a hostname. The wiring is the claim under test,
// so the guard is replaced by a recorder for the transport it was handed.
const guardCalls: { fetchImpl: unknown }[] = [];
vi.mock("../../../core/network-guard.js", () => ({
  fetchPublicHttpResponse: async (_url: string, opts: { fetchImpl: unknown }) => {
    guardCalls.push({ fetchImpl: opts.fetchImpl });
    return new Response("<html><body>ok</body></html>", { status: 200 });
  },
}));

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
  } as unknown as BootContext;
  return { ctx, registry, probe };
}

describe("setupWorkflowStores — tool and idle-scheduler wiring", () => {
  it("registers skill_load and routes its first-use modal to ctx.approvalGate", async () => {
    const { ctx, registry, probe } = makeCtx();

    await setupWorkflowStores(ctx, []);

    const tool = registry.findByName("skill_load");
    expect(tool, "skill_load must be registered by the boot step").toBeDefined();

    const result = await tool!.execute({ skillName: "demo" }, toolCtx("sess-gate"));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).loaded).toBe(true);
    // The modal reached the very gate the BootContext carries.
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.toolName).toBe("skill_load");
    expect(probe.requests[0]?.args).toEqual({ skillName: "demo" });
    ctx.idleScheduler?.stop();
  });

  it("starts the idle scheduler with no plugin installed", async () => {
    // The shared idle consumers — preference refresh and memory consolidation —
    // each return early when the scheduler is absent, so an absent scheduler
    // disables idle work outright instead of degrading it. Nothing a plugin
    // supplies may stand between boot and this object.
    const { ctx } = makeCtx();

    await setupWorkflowStores(ctx, []);

    expect(ctx.idleScheduler).toBeDefined();
    ctx.idleScheduler?.stop();
  });

  it("blocks the skill body when the user denies at that same gate", async () => {
    const registry = new ToolRegistry();
    const ctx = {
      getMainWindow: () => null,
      approvalGate: { requestAndWait: async () => ({ choice: "deny-once" }) },
      toolRegistry: registry,
      settingsService: { get: () => undefined, getAll: () => ({}) },
    } as unknown as BootContext;

    await setupWorkflowStores(ctx, []);

    const tool = registry.findByName("skill_load");
    const result = await tool!.execute({ skillName: "demo" }, toolCtx("sess-deny"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("user denied skill load");
    expect(result.output).not.toContain("demo body");
    ctx.idleScheduler?.stop();
  });
});

/**
 * A headless turn builds a window like any other launch, so "is there a
 * surface" cannot answer "is there anyone to ask". These two run the same card
 * through the same producer and differ only in argv — without the pair, a fix
 * that silenced the card everywhere would still look green.
 */
describe("setupWorkflowStores — ask_user_question on a headless turn", () => {
  const CARD = {
    questions: [{ question: "Which way?", choices: ["left", "right"] }],
  };

  function ctxWithWindow(): {
    ctx: BootContext;
    registry: InstanceType<typeof ToolRegistry>;
    sent: string[];
  } {
    const registry = new ToolRegistry();
    const sent: string[] = [];
    const ctx = {
      getMainWindow: () => ({
        webContents: {
          send: (channel: string) => {
            sent.push(channel);
          },
        },
      }),
      approvalGate: { requestAndWait: async () => ({ choice: "allow" }) },
      toolRegistry: registry,
      settingsService: { get: () => undefined, getAll: () => ({}) },
    } as unknown as BootContext;
    return { ctx, registry, sent };
  }

  let realArgv: string[];
  beforeEach(() => {
    realArgv = process.argv;
  });
  afterEach(() => {
    process.argv = realArgv;
  });

  it("hands the card to the window on an interactive launch", async () => {
    process.argv = ["electron", "main.js"];
    const { ctx, registry, sent } = ctxWithWindow();

    await setupWorkflowStores(ctx, []);
    const tool = registry.findByName("ask_user_question");
    expect(tool, "ask_user_question must be registered by the boot step").toBeDefined();

    // The interactive call parks on the gate by design, so abort it rather
    // than leave a five-minute timer behind.
    const abort = new AbortController();
    const pending = tool!.execute(CARD, { ...toolCtx("sess-ask"), abortSignal: abort.signal });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    abort.abort();
    await pending;

    ctx.idleScheduler?.stop();
  });

  it("answers a headless turn itself instead of opening a gate no one can close", async () => {
    process.argv = ["electron", "main.js", "--exec"];
    const { ctx, registry, sent } = ctxWithWindow();

    await setupWorkflowStores(ctx, []);
    const tool = registry.findByName("ask_user_question");

    const result = await tool!.execute(CARD, toolCtx("sess-headless"));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).dismissed).toBe(true);
    expect(sent, "no card may reach a renderer nobody is watching").toHaveLength(0);

    ctx.idleScheduler?.stop();
  });
});

/**
 * `net.fetch` throws on a redirect in every mode that would let the caller see
 * it, so a tool that guards each hop has to be handed the single-hop transport
 * instead. Nothing in a Node-run test can exercise that Electron behaviour, but
 * the wiring is what broke, and the wiring is checkable here.
 */
describe("setupWorkflowStores — web_fetch transport", () => {
  beforeEach(() => {
    guardCalls.length = 0;
  });

  it("builds web_fetch on the transport that returns a redirect hop", async () => {
    const registry = new ToolRegistry();
    const plain = (async () => new Response("plain")) as unknown as typeof fetch;
    const singleHop = (async () => new Response("single-hop")) as unknown as typeof fetch;
    const ctx = {
      getMainWindow: () => null,
      approvalGate: { requestAndWait: async () => ({ choice: "allow" }) },
      networkFetch: plain,
      singleHopNetworkFetch: singleHop,
      toolRegistry: registry,
      settingsService: { get: () => undefined, getAll: () => ({}) },
    } as unknown as BootContext;

    await setupWorkflowStores(ctx, []);
    const tool = registry.findByName("web_fetch");
    expect(tool, "web_fetch must be registered by the boot step").toBeDefined();

    await tool!.execute({ url: "https://example.com/" }, toolCtx("sess-fetch"));

    expect(guardCalls).toHaveLength(1);
    expect(
      guardCalls[0]?.fetchImpl,
      "web_fetch must guard hops on the single-hop transport, not net.fetch",
    ).toBe(singleHop);
    expect(guardCalls[0]?.fetchImpl).not.toBe(plain);

    ctx.idleScheduler?.stop();
  });
});
