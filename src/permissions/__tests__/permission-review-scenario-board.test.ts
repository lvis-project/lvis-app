/**
 * Permission review scenario board coverage.
 *
 * Pins the 16 user-visible scenarios in
 * docs/design/permission-review-scenario-board-v2.html against the current
 * permission policy path. The board is a PR artifact, but these tests keep it
 * tied to executable behavior instead of letting it drift into a static mockup.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PermissionManager } from "../permission-manager.js";
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import {
  RuleBasedRiskClassifier,
  type RiskClassifier,
  type RiskVerdict,
} from "../reviewer/risk-classifier.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool, type Tool } from "../../tools/base.js";
import type { ToolCategory, ToolSource } from "../../tools/types.js";
import { buildPluginToolsForTest } from "../../plugins/__tests__/plugin-tool-test-fixture.js";
import type { PluginManifest } from "../../plugins/types.js";
import type { PluginRuntime } from "../../plugins/runtime.js";

const BOARD_PATH = resolve(process.cwd(), "docs/design/permission-review-scenario-board-v2.html");

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-permission-scenarios-"));
  return join(dir, name);
}

function makeManager(
  mode: "default" | "strict" | "auto" | "allow" = "default",
  classifier: RiskClassifier = new RuleBasedRiskClassifier(),
): { pm: PermissionManager; queue: DeferredQueue; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lvis-permission-scenarios-"));
  const pm = new PermissionManager(join(dir, "permissions.json"));
  const queue = new DeferredQueue(join(dir, "deferred-queue.jsonl"));
  pm.setMode(mode);
  // Round-1 critic MAJOR-2 — `interactive.autoApprove` is now the SOT
  // for foreground-auto reviewer dispatch. When the scenario asserts
  // `mode="auto"` behaviour the test must opt in explicitly.
  if (mode === "auto") {
    pm.setInteractiveAutoApprove("low");
  }
  pm.setReviewer({
    classifier,
    cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
    deferredQueue: queue,
  });
  return { pm, queue, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fixedClassifier(verdict: RiskVerdict): RiskClassifier {
  return { classify: vi.fn(() => verdict) };
}

function makeTool(args: {
  name: string;
  category: ToolCategory;
  source?: ToolSource;
  pathFields?: readonly string[];
  pluginId?: string;
  mcpServerId?: string;
  decisionOverride?: Tool["decisionOverride"];
}): { tool: Tool; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => ({ output: `${args.name} ok`, isError: false }));
  const tool = createDynamicTool({
    name: args.name,
    description: `${args.name} scenario probe`,
    source: args.source ?? "builtin",
    category: args.category,
    pluginId: args.pluginId,
    mcpServerId: args.mcpServerId,
    decisionOverride: args.decisionOverride,
    pathFields: args.pathFields,
    jsonSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        endpoint: { type: "string" },
        method: { type: "string" },
        command: { type: "string" },
        payload: { type: "string" },
      },
    },
    execute,
    isReadOnly: () => args.category === "read",
  });
  return { tool, execute };
}

function makeGate(choice: "allow-once" | "deny-once" = "allow-once") {
  return {
    requestAndWait: vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice,
    })),
  };
}

async function runProbe(args: {
  tool: Tool;
  input: Record<string, unknown>;
  pm?: PermissionManager;
  gate?: ReturnType<typeof makeGate>;
  headless?: boolean;
  trustOrigin?: "user-keyboard" | "llm-tool-arg" | "plugin-emitted";
  auditLogger?: ConstructorParameters<typeof ToolExecutor>[6];
  overlayTriggerOrigin?: string;
}) {
  const registry = new ToolRegistry();
  registry.register(args.tool);
  const executor = new ToolExecutor(
    registry,
    undefined,
    args.pm,
    undefined,
    args.gate as never,
    undefined,
    args.auditLogger,
  );
  return executor.executeAll(
    [{ id: `tu-${args.tool.name}`, name: args.tool.name, input: args.input }],
    {
      sessionId: `sess-${args.tool.name}`,
      ...(args.overlayTriggerOrigin ? { overlayTriggerOrigin: args.overlayTriggerOrigin } : {}),
      permissionContext: {
        trustOrigin: args.trustOrigin ?? "user-keyboard",
        ...(args.headless ? { headless: true } : {}),
      },
    },
  );
}

describe("permission-review-scenario-board-v2.html contract", () => {
  it("contains exactly S1-S16 as the PR scenario set", () => {
    const html = readFileSync(BOARD_PATH, "utf8");
    const ids = Array.from(html.matchAll(/<span class="tag [^"]+">S(\d+)<\/span>/g))
      .map((match) => Number(match[1]));
    expect(ids).toEqual(Array.from({ length: 16 }, (_, idx) => idx + 1));
  });

  it("S1 default read inside workspace allows without approval", async () => {
    const { pm, cleanup } = makeManager("default");
    try {
      const { tool, execute } = makeTool({ name: "read_file", category: "read", pathFields: ["path"] });
      const gate = makeGate();
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { path: resolve(process.cwd(), "package.json") },
      });
      expect(result[0].is_error).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("S2 strict read asks instead of using the reviewer", async () => {
    const classifier = fixedClassifier({ level: "low", reason: "would allow" });
    const { pm, cleanup } = makeManager("strict", classifier);
    try {
      const { tool } = makeTool({ name: "read_file", category: "read", pathFields: ["path"] });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { path: resolve(process.cwd(), "package.json") },
      });
      expect(result[0].is_error).toBe(true);
      expect(gate.requestAndWait).toHaveBeenCalledOnce();
      expect(classifier.classify).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("S3 out-of-dir read switches to directory-scope approval", async () => {
    const { pm, cleanup } = makeManager("default");
    try {
      const { tool, execute } = makeTool({ name: "grep_files", category: "read", pathFields: ["path"] });
      const gate = makeGate("allow-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { path: "/var/tmp/lvis-scenario-outside" },
      });
      expect(result[0].is_error).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        kind: "out-of-allowed-dir",
      }));
    } finally {
      cleanup();
    }
  });

  it("S4 auto-review LOW foreground mutation runs inline", async () => {
    const { pm, cleanup } = makeManager("auto", fixedClassifier({ level: "low", reason: "small local write" }));
    try {
      const { tool, execute } = makeTool({ name: "write_file", category: "write", pathFields: ["path"] });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { path: resolve(process.cwd(), "tmp-scenario-note.md") },
      });
      expect(result[0].is_error).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("S5 auto-review MED foreground mutation routes to the approval modal (user authority)", async () => {
    // Phase 0: a non-LOW foreground verdict ASKS the user instead of silently
    // hard-denying. Here the user allows → the mutation runs.
    const { pm, cleanup } = makeManager("auto", fixedClassifier({ level: "medium", reason: "external summary send" }));
    try {
      const { tool, execute } = makeTool({
        name: "teams_send",
        category: "network",
        source: "plugin",
        pluginId: "ms-graph",
      });
      const gate = makeGate("allow-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { endpoint: "https://teams.microsoft.com/webhook", payload: "meeting summary" },
      });
      expect(result[0].is_error).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reviewerVerdict: expect.objectContaining({ level: "medium" }),
      }));
    } finally {
      cleanup();
    }
  });

  it("S6 auto-review HIGH foreground shell routes to the approval modal; deny-once blocks execution", async () => {
    const { pm, cleanup } = makeManager("auto", fixedClassifier({ level: "high", reason: "destructive shell" }));
    try {
      const { tool, execute } = makeTool({ name: "bash", category: "shell" });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { command: "rm -rf ./build" },
        trustOrigin: "llm-tool-arg",
      });
      // deny-by-default preserved: user denies → blocked, no execution.
      expect(result[0].is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(gate.requestAndWait).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reviewerVerdict: expect.objectContaining({ level: "high" }),
      }));
    } finally {
      cleanup();
    }
  });

  it("S7 reviewer-disabled modes ask without classifier reasons", async () => {
    const classifier = fixedClassifier({ level: "low", reason: "should not run" });
    const { pm, cleanup } = makeManager("default", classifier);
    try {
      const { tool, execute } = makeTool({ name: "write_file", category: "write", pathFields: ["path"] });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { path: resolve(process.cwd(), "tmp-scenario-note.md") },
      });
      expect(result[0].is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.not.stringContaining("reviewer"),
      }));
    } finally {
      cleanup();
    }
  });

  it("S8 auto-review with missing reviewer asks foreground and does not silently allow", async () => {
    const pm = new PermissionManager(tmpFile("permissions.json"));
    pm.setMode("auto");
    // Round-1 critic MAJOR-2 — interactive opt-in is required for the
    // foreground-auto reviewer lane to fire. With it set + reviewer
    // missing, the scenario tests fail-closed behaviour.
    pm.setInteractiveAutoApprove("low");
    const { tool, execute } = makeTool({ name: "write_file", category: "write", pathFields: ["path"] });
    const gate = makeGate("deny-once");
    const result = await runProbe({
      tool,
      pm,
      gate,
      input: { path: resolve(process.cwd(), "tmp-scenario-note.md") },
    });
    expect(result[0].is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining("reviewer unavailable"),
    }));
  });

  it.each([
    {
      category: "write",
      name: "write_file",
      input: { path: resolve(process.cwd(), "tmp-medium.txt") },
    },
    { category: "shell", name: "bash", input: { command: "git status" } },
    {
      category: "network",
      name: "http_probe",
      input: { endpoint: "https://example.com" },
    },
    {
      category: "meta",
      name: "agent_spawn",
      input: { instructions: "inspect tests" },
    },
  ] as const)(
    "auto-review medium threshold auto-approves the common $category reviewer route",
    async ({ category, name, input }) => {
      const classifier = fixedClassifier({
        level: "medium",
        reason: "medium reviewer verdict",
      });
      const { pm, cleanup } = makeManager("auto", classifier);
      pm.setInteractiveAutoApprove("medium");
      try {
        const { tool, execute } = makeTool({
          name,
          category,
          ...(category === "meta" ? { decisionOverride: "ask" as const } : {}),
        });
        const gate = makeGate("deny-once");
        const appendPermissionAuditEntry = vi.fn(
          async (entry: Record<string, unknown>) => ({
            ...entry,
            prevHash: "h",
          }),
        );
        const auditLogger = {
          log: vi.fn(),
          isPermissionAuditChainReady: vi.fn(() => true),
          assertPermissionAuditWritable: vi.fn(),
          appendPermissionAuditEntry,
          isShadowChannelWritable: vi.fn(() => true),
        };
        const result = await runProbe({
          tool,
          pm,
          gate,
          input,
          auditLogger: auditLogger as never,
        });
        expect(result[0].is_error).toBeUndefined();
        expect(execute).toHaveBeenCalledOnce();
        expect(gate.requestAndWait).not.toHaveBeenCalled();
        expect(appendPermissionAuditEntry).toHaveBeenCalledOnce();
        expect(appendPermissionAuditEntry).toHaveBeenCalledWith(
          expect.objectContaining({
            decision: "allow",
            tool: name,
            source: "builtin",
            category,
            layer: 5,
            reviewer: expect.objectContaining({
              level: "medium",
              reason: "medium reviewer verdict",
            }),
          }),
        );
      } finally {
        cleanup();
      }
    },
  );

  it("default mode ignores the medium threshold and uses the normal approval path", async () => {
    const classifier = fixedClassifier({
      level: "medium",
      reason: "default-mode medium verdict",
    });
    const { pm, cleanup } = makeManager("default", classifier);
    pm.setInteractiveAutoApprove("medium");
    try {
      const { tool, execute } = makeTool({
        name: "default_write",
        category: "write",
      });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { path: resolve(process.cwd(), "tmp-default-medium.txt") },
      });

      expect(result[0].is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(gate.requestAndWait).toHaveBeenCalledOnce();
      const request = gate.requestAndWait.mock.calls[0]?.[0] as {
        reviewerVerdict?: unknown;
      };
      expect(request.reviewerVerdict).toBeUndefined();
    } finally {
      cleanup();
    }
  });
  it("overlay ask-meta bypasses MEDIUM auto-review and opens the common modal", async () => {
    const classifier = fixedClassifier({
      level: "medium",
      reason: "must not run for overlay hard gate",
    });
    const { pm, cleanup } = makeManager("auto", classifier);
    pm.setInteractiveAutoApprove("medium");
    try {
      const { tool, execute } = makeTool({
        name: "authority_probe",
        category: "meta",
        decisionOverride: "ask",
      });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        overlayTriggerOrigin: "overlay:meeting-detection",
        input: { instructions: "delegate from staged overlay" },
      });

      expect(result[0].is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(gate.requestAndWait).toHaveBeenCalledOnce();
      const request = gate.requestAndWait.mock.calls[0]?.[0] as {
        reviewerVerdict?: unknown;
      };
      expect(request.reviewerVerdict).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("auto-review HIGH agent_spawn uses the common approval path", async () => {
    const classifier = fixedClassifier({
      level: "high",
      reason: "unsafe delegated authority",
    });
    const { pm, cleanup } = makeManager("auto", classifier);
    pm.setInteractiveAutoApprove("medium");
    try {
      const { tool, execute } = makeTool({
        name: "agent_spawn",
        category: "meta",
        decisionOverride: "ask",
      });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { instructions: "perform a high-risk operation" },
      });
      expect(result[0].is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(classifier.classify).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewerVerdict: expect.objectContaining({ level: "high" }),
        }),
      );
    } finally {
      cleanup();
    }
  });

  it("S9 reviewer timeout/error fails closed to HIGH and routes to the approval modal; deny-once blocks", async () => {
    const classifier: RiskClassifier = {
      classify: vi.fn(() => {
        throw new Error("provider timeout");
      }),
    };
    const { pm, cleanup } = makeManager("auto", classifier);
    try {
      const { tool, execute } = makeTool({
        name: "teams_send",
        category: "network",
        source: "plugin",
        pluginId: "ms-graph",
      });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { endpoint: "https://teams.microsoft.com/webhook", payload: "summary" },
      });
      // Fail-closed HIGH still asks the user (not a silent deny); deny → blocked.
      expect(result[0].is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(gate.requestAndWait).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reviewerVerdict: expect.objectContaining({ level: "high" }),
      }));
    } finally {
      cleanup();
    }
  });

  it("S10 a category-less plugin tool loads at the host default-strict baseline (write-equivalent)", () => {
    // host-classifies-risk: the host no longer trusts (or requires) the plugin
    // to declare its own danger. A category-less tool registers as
    // write-equivalent — the safe default — instead of failing the load.
    const manifest = {
      id: "bad-plugin",
      name: "bad-plugin",
      version: "1.0.0",
      main: "index.js",
      tools: [
        {
          name: "bad_write",
          description: "no category declared",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    } as unknown as PluginManifest;
    const runtime = { call: vi.fn() } as unknown as PluginRuntime;
    const tools = buildPluginToolsForTest(runtime, "bad-plugin", manifest);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("bad_write");
    expect(tools[0].category).toBe("write");
  });

  it("S11 overlay prompt import remains separate from the tool permission path", () => {
    const html = readFileSync(BOARD_PATH, "utf8");
    expect(html).toContain("overlay:...");
    expect(html).toContain("prompt import approval, then normal tool permission");
  });

  it("S12 MCP remote tools use the same category policy with MCP source", async () => {
    const classify = vi.fn((): RiskVerdict => ({ level: "low", reason: "reviewer would allow" }));
    const { pm, cleanup } = makeManager("auto", { classify });
    try {
      const { tool, execute } = makeTool({
        name: "mcp.repo_create_issue",
        category: "network",
        source: "mcp",
        mcpServerId: "github",
      });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { endpoint: "https://github.com/repos/lvis-project/lvis-app/issues" },
      });
      expect(result[0].is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        source: "mcp",
        reason: expect.stringContaining("MCP 도구 strict 강제"),
      }));
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.not.stringContaining("reviewer"),
      }));
    } finally {
      cleanup();
    }
  });

  it("S13 trusted metadata network lookup can pass LOW in auto-review", async () => {
    const { pm, cleanup } = makeManager("auto");
    try {
      const { tool, execute } = makeTool({
        name: "graph_profile_get",
        category: "network",
        source: "plugin",
        pluginId: "ms-graph",
      });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { endpoint: "https://graph.microsoft.com/v1.0/me" },
      });
      expect(result[0].is_error).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("S14 network data egress routes its reviewer impact to the approval modal; deny-once blocks", async () => {
    const { pm, cleanup } = makeManager("auto");
    try {
      const { tool, execute } = makeTool({
        name: "teams_send",
        category: "network",
        source: "plugin",
        pluginId: "ms-graph",
      });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: {
          endpoint: "https://graph.microsoft.com/v1.0/teams/team/channels/channel/messages",
          method: "POST",
          payload: "2.4KB meeting summary",
        },
      });
      expect(result[0].is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(gate.requestAndWait).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reviewerVerdict: expect.objectContaining({
          level: "medium",
          reason: "network graph data operation",
        }),
      }));
    } finally {
      cleanup();
    }
  });

  it("S15 unknown or sensitive network target is HIGH and routes to the approval modal; deny-once blocks", async () => {
    const { pm, cleanup } = makeManager("auto");
    try {
      const { tool, execute } = makeTool({
        name: "upload_archive",
        category: "network",
        source: "plugin",
        pluginId: "archive-plugin",
      });
      const gate = makeGate("deny-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        input: { endpoint: "http://example-upload.local/ingest", payload: "workspace archive" },
      });
      expect(result[0].is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(gate.requestAndWait).toHaveBeenCalledOnce();
      expect(gate.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
        reviewerVerdict: expect.objectContaining({ level: "high" }),
      }));
    } finally {
      cleanup();
    }
  });

  it("S16 headless network MED/HIGH goes to the manual queue without execution", async () => {
    const { pm, queue, cleanup } = makeManager("auto", fixedClassifier({ level: "medium", reason: "headless data egress" }));
    try {
      const { tool, execute } = makeTool({
        name: "teams_send",
        category: "network",
        source: "plugin",
        pluginId: "ms-graph",
      });
      const gate = makeGate("allow-once");
      const result = await runProbe({
        tool,
        pm,
        gate,
        headless: true,
        trustOrigin: "llm-tool-arg",
        input: { endpoint: "https://teams.microsoft.com/webhook", payload: "meeting summary" },
      });
      expect(result[0].is_error).toBe(true);
      expect(result[0].content).toContain("권한 보류");
      expect(execute).not.toHaveBeenCalled();
      expect(gate.requestAndWait).not.toHaveBeenCalled();
      expect(queue.listPending()).toHaveLength(1);
      expect(queue.listPending()[0].verdict.level).toBe("medium");
    } finally {
      cleanup();
    }
  });
});
