import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AuditLogger } from "../../../audit/audit-logger.js";
import type { RationaleAuditSink } from "../../../audit/rationale-audit-adapter.js";
import { KeywordEngine } from "../../../core/keyword-engine.js";
import { RouteEngine } from "../../../core/route-engine.js";
import {
  ApprovalGate,
  IPC_APPROVAL_REQUEST,
  type ApprovalRequest,
} from "../../../permissions/approval-gate.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { DeferredQueue } from "../../../permissions/reviewer/deferred-queue.js";
import {
  LlmRationaleScopeReviewer,
} from "../../../permissions/reviewer/rationale-scope-reviewer.js";
import { VerdictCache } from "../../../permissions/reviewer/verdict-cache.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { createDynamicTool } from "../../../tools/base.js";
import { DurableHostInvocationStartCasStore } from "../../../tools/pipeline/rationale-invocation-journal.js";
import {
  RATIONALE_RESPONSE_TOOL,
} from "../../../tools/pipeline/rationale-control.js";
import { RationaleHostService } from "../../../tools/pipeline/rationale-host-service.js";
import type { InvocationAuditRecord } from "../../../tools/pipeline/rationale-ticket-lifecycle.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ConversationLoop } from "../../conversation-loop.js";
import type {
  LLMProvider,
  StreamEvent,
  StreamTurnParams,
} from "../../llm/types.js";
import { RATIONALE_SIBLING_CANCELLED_RESULT } from "../rationale-conversation-orchestration.js";

const RAW_ANCHOR_SECRET = "alice@example.com";

interface RationaleBinding {
  readonly anchorId: string;
  readonly ticketId: string;
  readonly actionDigest: string;
}

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly requests: StreamTurnParams[] = [];
  readonly rationaleBindings: RationaleBinding[] = [];
  #round = 0;

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.requests.push(input);
    const round = this.#round++;
    if (round === 0) {
      yield {
        type: "tool_call",
        id: "write-1",
        name: "write_fixture",
        input: { payload: "bounded workspace update" },
      };
      yield {
        type: "tool_call",
        id: "plugin-1",
        name: "request_plugin",
        input: { pluginId: "local-indexer" },
      };
      yield {
        type: "message_complete",
        stopReason: "tool_use",
        usage: { inputTokens: 11, outputTokens: 2 },
      };
      return;
    }

    if (round === 1) {
      const content = input.messages[0]?.content;
      if (typeof content !== "string") {
        throw new Error("expected the fixed rationale provider envelope");
      }
      const envelope = JSON.parse(content) as RationaleBinding;
      const binding = {
        anchorId: envelope.anchorId,
        ticketId: envelope.ticketId,
        actionDigest: envelope.actionDigest,
      };
      this.rationaleBindings.push(binding);
      yield {
        type: "tool_call",
        id: "rationale-1",
        name: RATIONALE_RESPONSE_TOOL,
        input: {
          contractVersion: 1,
          ...binding,
          round: 1,
          suggestion: "Apply the exact host-sealed workspace update.",
        },
      };
      yield {
        type: "message_complete",
        stopReason: "tool_use",
        usage: { inputTokens: 7, outputTokens: 3 },
      };
      return;
    }

    yield { type: "text_delta", text: "done" };
    yield {
      type: "message_complete",
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 1 },
    };
  }
}

class AttachmentDirectModalProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly requests: StreamTurnParams[] = [];
  #round = 0;

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.requests.push(input);
    if (this.#round++ === 0) {
      yield {
        type: "tool_call",
        id: "attachment-write-1",
        name: "write_fixture",
        input: { payload: "attachment-scoped update" },
      };
      yield {
        type: "message_complete",
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 1 },
      };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield {
      type: "message_complete",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 1 },
    };
  }
}

function createPermissionManager(directory: string): PermissionManager {
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode("auto");
  manager.setInteractiveAutoApprove("low");
  manager.setReviewer({
    classifier: {
      classify: vi.fn(() => ({
        level: "medium" as const,
        reason: "bounded write requires foreground rationale",
      })),
    },
    cache: new VerdictCache(join(directory, "reviewer-cache.jsonl")),
    deferredQueue: new DeferredQueue(join(directory, "deferred-queue.jsonl")),
  });
  return manager;
}

describe("foreground rationale real-stack integration", () => {
  it("runs query, executor, host, modal, sealed resume, and audit as one ordered path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lvis-rationale-real-stack-"));
    const registry = new ToolRegistry();
    const write = vi.fn(async () => "write-complete");
    registry.register(createDynamicTool({
      name: "write_fixture",
      description: "Apply one bounded workspace write.",
      source: "builtin",
      category: "write",
      version: "1",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
        required: ["payload"],
      },
      isReadOnly: () => false,
      execute: async (input) => ({
        output: await write(input),
        isError: false,
      }),
    }));

    const modalRequests: ApprovalRequest[] = [];
    const rationaleLifecycleOrder: string[] = [];
    const projectionRecords: Array<Parameters<
      RationaleAuditSink["appendProjection"]
    >[1]> = [];
    let approvalGate!: ApprovalGate;
    const webContents = {
      isDestroyed: () => false,
      send: (channel: string, request: ApprovalRequest) => {
        expect(channel).toBe(IPC_APPROVAL_REQUEST);
        rationaleLifecycleOrder.push("modal");
        modalRequests.push(request);
        queueMicrotask(() => {
          approvalGate.resolve(request.id, {
            requestId: request.id,
            choice: "allow-once",
            nonce: request.nonce,
            hmac: request.hmac,
          });
        });
      },
    };
    const auditLogger = new AuditLogger(join(directory, "audit"));
    approvalGate = new ApprovalGate(
      webContents as never,
      undefined,
      5_000,
      auditLogger,
    );

    const ticketEvents: unknown[] = [];
    const invocationRecords: InvocationAuditRecord[] = [];
    const auditSink = {
      assertWritable: vi.fn(),
      appendTicket: vi.fn((event) => {
        rationaleLifecycleOrder.push("ticket:" + event.operation);
        ticketEvents.push(event);
        return event as never;
      }),
      appendInvocation: vi.fn((_sessionId, record) => {
        rationaleLifecycleOrder.push("invocation:" + record.state);
        invocationRecords.push(record);
        return record as never;
      }),
      appendProjection: vi.fn((_sessionId, projection) => {
        rationaleLifecycleOrder.push(
          projection.terminalReason === null
            ? "projection:user-pending"
            : "projection:" + projection.terminalReason,
        );
        projectionRecords.push(projection);
        return projection as never;
      }),
    } satisfies RationaleAuditSink;

    const scopeReviewerPrompts: string[] = [];
    const scopeReviewer = new LlmRationaleScopeReviewer({
      complete: async (input) => {
        scopeReviewerPrompts.push(input.userPrompt);
        return {
          text: JSON.stringify({
            level: "medium",
            reason: "The exact sealed write remains bounded.",
            scopeAlignment: "aligned",
            scopeReasons: ["The target and effect are unchanged."],
          }),
          tokensIn: 3,
          tokensOut: 2,
          costUsd: 0,
        };
      },
    }, "scope-review-model");
    const invocationStartCas = new DurableHostInvocationStartCasStore({
      filePath: join(directory, "invocation-journal.json"),
    });
    const hostService = new RationaleHostService({
      approvalGate,
      getRationaleScopeReviewer: () => scopeReviewer,
      getRegistryGeneration: () => registry.getGeneration(),
      getSandboxGeneration: () => "sandbox-generation-test",
      invocationStartCas,
      auditSink,
    });

    let loop!: ConversationLoop;
    const coordinatorFactory = hostService.createCoordinatorFactory({
      getRationalePolicyEpoch: () => "policy-epoch-test",
      isSessionCurrent: (sessionId) => loop.sessionId === sessionId,
    });
    const provider = new ScriptedProvider();
    loop = new ConversationLoop(({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
        setToolScope: vi.fn(),
      },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry: registry }),
      toolRegistry: registry,
      permissionManager: createPermissionManager(directory),
      approvalGate,
      auditLogger,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
      rationaleCoordinatorFactory: coordinatorFactory,
      enableDormantRationaleForTesting: true,
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    try {
      const result = await loop.runTurn(
        "perform the approved action",
        undefined,
        undefined,
        {
          inputOrigin: "user-keyboard",
          requestAnchorRawIntent:
            "perform the approved action for " + RAW_ANCHOR_SECRET,
        },
      );

      expect(write).toHaveBeenCalledTimes(1);
      expect(result.toolCalls.map((call) => call.name)).toEqual([
        "write_fixture",
        "request_plugin",
      ]);
      expect(result.toolCalls.map((call) => call.result)).toEqual([
        "write-complete",
        RATIONALE_SIBLING_CANCELLED_RESULT,
      ]);
      expect(loop.sessionPluginExpansions).toBe(0);

      expect(provider.requests).toHaveLength(3);
      expect(provider.requests[1]?.tools?.map((tool) => tool.name)).toEqual([
        RATIONALE_RESPONSE_TOOL,
      ]);
      expect(provider.rationaleBindings).toHaveLength(1);

      expect(modalRequests).toHaveLength(1);
      expect(modalRequests[0]).toMatchObject({
        kind: "rationale",
        allowedChoices: ["allow-once", "deny-once"],
        requireExplicit: true,
        toolName: "write_fixture",
        toolCategory: "write",
      });
      expect(invocationRecords.map((record) => record.state)).toEqual([
        "authorized",
        "started",
        "completed",
      ]);
      expect(projectionRecords.map((projection) => projection.terminalReason)).toEqual([
        null,
        "allowed-once",
      ]);
      expect(rationaleLifecycleOrder.indexOf("projection:user-pending")).toBeLessThan(
        rationaleLifecycleOrder.indexOf("modal"),
      );
      expect(rationaleLifecycleOrder.indexOf("projection:allowed-once")).toBeLessThan(
        rationaleLifecycleOrder.indexOf("invocation:authorized"),
      );

      const protectedSurfaces = JSON.stringify({
        providerRequests: provider.requests,
        modalRequests,
        ticketEvents,
        projectionRecords,
        invocationRecords,
        scopeReviewerPrompts,
      });
      expect(protectedSurfaces).not.toContain(RAW_ANCHOR_SECRET);
      expect(auditSink.assertWritable).toHaveBeenCalledTimes(1);
    } finally {
      hostService.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes an attachment-tainted keyboard action directly to the ordinary modal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lvis-rationale-attachment-"));
    const registry = new ToolRegistry();
    const write = vi.fn(async () => "write-complete");
    registry.register(createDynamicTool({
      name: "write_fixture",
      description: "Apply one bounded workspace write.",
      source: "builtin",
      category: "write",
      version: "1",
      jsonSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
        required: ["payload"],
      },
      isReadOnly: () => false,
      execute: async (input) => ({
        output: await write(input),
        isError: false,
      }),
    }));

    const modalRequests: ApprovalRequest[] = [];
    let approvalGate!: ApprovalGate;
    const webContents = {
      isDestroyed: () => false,
      send: (channel: string, request: ApprovalRequest) => {
        expect(channel).toBe(IPC_APPROVAL_REQUEST);
        modalRequests.push(request);
        queueMicrotask(() => {
          approvalGate.resolve(request.id, {
            requestId: request.id,
            choice: "allow-once",
            nonce: request.nonce,
            hmac: request.hmac,
          });
        });
      },
    };
    approvalGate = new ApprovalGate(
      webContents as never,
      undefined,
      5_000,
      new AuditLogger(join(directory, "audit")),
    );
    const materializeRationaleControl = vi.fn(() => null);
    const rationaleCoordinatorFactory = vi.fn((input) => ({
      requestAnchor: input.requestAnchor,
      rationaleProvenance: input.rationaleProvenance,
      materializeRationaleControl,
    }));
    const provider = new AttachmentDirectModalProvider();
    const loop = new ConversationLoop(({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
        setToolScope: vi.fn(),
      },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry: registry }),
      toolRegistry: registry,
      permissionManager: createPermissionManager(directory),
      approvalGate,
      auditLogger: new AuditLogger(join(directory, "executor-audit")),
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
      rationaleCoordinatorFactory,
      enableDormantRationaleForTesting: true,
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    try {
      const result = await loop.runTurn(
        "inspect this image and apply the bounded update",
        undefined,
        undefined,
        {
          inputOrigin: "user-keyboard",
          requestAnchorRawIntent: "inspect this image and apply the bounded update",
          attachments: [{
            type: "image",
            image: "data:image/png;base64,aW1hZ2U=",
            mimeType: "image/png",
          }],
        },
      );

      expect(write).toHaveBeenCalledTimes(1);
      expect(result.toolCalls.map((call) => call.result)).toEqual(["write-complete"]);
      expect(rationaleCoordinatorFactory).toHaveBeenCalledTimes(1);
      expect(materializeRationaleControl).not.toHaveBeenCalled();
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests.flatMap((request) =>
        request.tools?.map((tool) => tool.name) ?? [],
      )).not.toContain(RATIONALE_RESPONSE_TOOL);
      expect(modalRequests).toHaveLength(1);
      expect(modalRequests[0]?.kind ?? "tool").toBe("tool");
      expect(modalRequests[0]?.allowedChoices).toBeUndefined();
      expect(modalRequests[0]).toMatchObject({
        toolName: "write_fixture",
        toolCategory: "write",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
