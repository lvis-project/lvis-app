import { describe, expect, it, vi } from "vitest";
import { A2ATaskState } from "../../shared/a2a.js";
import { A2AAgentMessageBus } from "../../engine/a2a-agent-message-bus.js";
import { A2A_PARENT_RECIPIENT } from "../../engine/a2a-agent-message-envelope.js";
import { A2AAgentMessageMailbox } from "../../engine/a2a-agent-message-mailbox.js";
import { createAgentSpawnTool } from "../agent-spawn.js";
import { createAgentSendTool } from "../agent-send.js";

function parentContext() {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    metadata: {
      sessionId: "parent-session",
      spawnDepth: 0,
      supportsA2AParentDelivery: true,
    },
  };
}

function childContext() {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    metadata: {
      sessionId: "sub-question",
      spawnDepth: 1,
    },
  };
}

function createInMemoryNamespace() {
  let stored: unknown;
  return {
    handle: {
      dir: "memory",
      readJson: async (_name: string, fallback: unknown) =>
        structuredClone(stored === undefined ? fallback : stored),
      writeJson: async (_name: string, value: unknown) => {
        stored = structuredClone(value);
      },
      childDir: async (name: string) => name,
    } as never,
    getStored: () => structuredClone(stored),
  };
}

describe("agent_spawn background routing", () => {
  it("passes the host background mode to both fresh spawn and resume", async () => {
    const spawnPending = new Promise<never>(() => undefined);
    const resumePending = new Promise<never>(() => undefined);
    const spawn = vi.fn(() => spawnPending);
    const resume = vi.fn(() => resumePending);
    const tool = createAgentSpawnTool({
      getRunner: () => ({ spawn, resume }) as never,
      emit: () => undefined,
    });

    const fresh = await tool.execute({
      title: "background child",
      instructions: "do work",
      background: true,
    }, parentContext());
    expect(fresh.isError).toBe(false);
    expect(JSON.parse(fresh.output)).toMatchObject({ background: true });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      background: true,
      originSessionId: "parent-session",
    }), expect.any(Object));

    const resumed = await tool.execute({
      resumeId: "sub-resume",
      instructions: "continue",
      background: true,
    }, parentContext());
    expect(resumed.isError).toBe(false);
    expect(JSON.parse(resumed.output)).toMatchObject({
      background: true,
      resumeId: "sub-resume",
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[6]).toBe(true);
  });
  it("keeps a background question waiting event without projecting a duplicate parent message", async () => {
    const deliverToParent = vi.fn();
    const emit = vi.fn();
    const spawn = vi.fn(async (
      _input: unknown,
      callbacks: { onLinked?: (input: { childSessionId: string }) => void },
    ) => {
      callbacks.onLinked?.({ childSessionId: "sub-question" });
      return {
        summary: "Need input",
        toolCallCount: 1,
        turnCount: 1,
        childSessionId: "sub-question",
        entries: [],
        ok: true,
        stopReason: "input-required" as const,
        suspension: {
          reason: "question" as const,
          prompt: "Which option?",
          resumeId: "sub-question",
        },
      };
    });
    const tool = createAgentSpawnTool({
      getRunner: () => ({ spawn, deliverToParent }) as never,
      emit,
    });

    const handle = await tool.execute({
      title: "question child",
      instructions: "ask",
      background: true,
    }, parentContext());
    expect(handle.isError).toBe(false);
    for (let attempt = 0; attempt < 20 && !emit.mock.calls.some(
      ([event]) => event.type === "done",
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "done",
      status: "waiting",
      taskState: "TASK_STATE_INPUT_REQUIRED",
      suspension: expect.objectContaining({ reason: "question" }),
    }));
    expect(deliverToParent).not.toHaveBeenCalled();
  });
  it("delivers a background question once across agent_send and result projection", async () => {
    const namespace = createInMemoryNamespace();
    const mailbox = new A2AAgentMessageMailbox(namespace.handle);
    let metadataCommitted = false;
    const parentDeliver = vi.fn(async (input: {
      message: { messageId: string; metadata?: unknown };
    }) => {
      expect(metadataCommitted).toBe(true);
      expect(input.message.metadata).toMatchObject({
        taskState: A2ATaskState.INPUT_REQUIRED,
        suspension: { reason: "question", resumeId: "sub-question" },
      });
      return {
      ok: true as const,
      disposition: "mailbox" as const,
      messageId: input.message.messageId,
      };
    });
    const audit = vi.fn();
    const bus = new A2AAgentMessageBus({
      parentBus: { deliverToParent: parentDeliver } as never,
      mailbox,
      auditLogger: { log: audit } as never,
      resolveSender: vi.fn(async () => ({
        originSessionId: "parent-session",
        childSessionId: "sub-question",
        title: "question child",
        background: true,
        taskState: A2ATaskState.WORKING,
      })),
      resolvePeer: vi.fn() as never,
    });
    let stagedQuestion: Parameters<typeof bus.commitStagedQuestion>[0] | undefined;
    const agentSend = createAgentSendTool({
      getRuntime: () => ({
        sendAgentMessage: async (input) => {
          const staged = await bus.stageQuestion(input);
          if (!staged.ok) return staged.result;
          stagedQuestion = staged.stage;
          return staged.result;
        },
        auditAgentSendDrop: (input) => bus.auditToolDrop(input),
        reserveQuestionWait: async () => ({
          ok: true as const,
          token: Symbol("question"),
        }),
        cancelQuestionWait: async () => undefined,
      }),
    });
    const resultProjector = vi.fn();
    const emit = vi.fn();
    const spawn = vi.fn(async (
      _input: unknown,
      callbacks: { onLinked?: (input: { childSessionId: string }) => void },
    ) => {
      callbacks.onLinked?.({ childSessionId: "sub-question" });
      const sent = await agentSend.execute({
        to: A2A_PARENT_RECIPIENT,
        parts: [{ text: "Which option?" }],
        waitForReply: true,
      }, childContext());
      expect(JSON.parse(sent.output)).toMatchObject({
        disposition: "question-staged",
      });
      expect(sent).toMatchObject({
        isError: false,
        metadata: {
          rawResult: {
            kind: "a2a-input-required",
            version: 1,
            reason: "question",
            prompt: "Which option?",
          },
        },
      });
      if (!stagedQuestion) throw new Error("question was not staged");
      metadataCommitted = true;
      await expect(bus.commitStagedQuestion(stagedQuestion)).resolves.toMatchObject({
        ok: true,
        disposition: "parent",
      });
      return {
        summary: "Need input",
        toolCallCount: 1,
        turnCount: 1,
        childSessionId: "sub-question",
        entries: [],
        ok: true,
        stopReason: "input-required" as const,
        suspension: {
          reason: "question" as const,
          prompt: "Which option?",
          resumeId: "sub-question",
        },
      };
    });
    const tool = createAgentSpawnTool({
      getRunner: () => ({
        spawn,
        deliverToParent: resultProjector,
      }) as never,
      emit,
    });

    await expect(tool.execute({
      title: "question child",
      instructions: "ask",
      background: true,
    }, parentContext())).resolves.toMatchObject({ isError: false });
    for (let attempt = 0; attempt < 20 && !emit.mock.calls.some(
      ([event]) => event.type === "done",
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(parentDeliver).toHaveBeenCalledTimes(1);
    expect(resultProjector).not.toHaveBeenCalled();
    const stored = namespace.getStored() as {
      trees: Array<{ originSessionId: string; messageCount: number }>;
    };
    expect(stored.trees).toEqual([{
      originSessionId: "parent-session",
      messageCount: 1,
    }]);
    const deliveredEdges = audit.mock.calls.filter(([entry]) =>
      String(entry.input).includes("delivered:parent"));
    expect(deliveredEdges).toHaveLength(1);
  });
});
