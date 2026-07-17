import { describe, expect, it, vi } from "vitest";
import { KeywordEngine } from "../../../core/keyword-engine.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { ConversationLoop } from "../../conversation-loop.js";
import type {
  LLMProvider,
  StreamEvent,
  StreamTurnParams,
} from "../../llm/types.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { createDynamicTool } from "../../../tools/base.js";
import type {
  RequestAnchor,
  RationaleEligibilityProvenance,
} from "../../../tools/pipeline/rationale-control.js";
import { createRequestAnchor } from "../../../tools/pipeline/rationale-control.js";
import { ToolRegistry } from "../../../tools/registry.js";

class RecordingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly inputs: StreamTurnParams[] = [];
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.inputs.push(input);
    yield* this.turns[this.index++] ?? [];
  }
}

function makeHarness(
  turns: StreamEvent[][],
  headless = false,
  closeRationaleSession?: (sessionId: string) => void,
) {
  const toolRegistry = new ToolRegistry();
  for (const [name, category, readOnly] of [
    ["read_file", "read", true],
    ["bash", "shell", false],
  ] as const) {
    toolRegistry.register(createDynamicTool({
      name,
      description: name,
      source: "builtin",
      category,
      version: "1.0.0",
      jsonSchema: { type: "object", properties: {} },
      isReadOnly: () => readOnly,
      execute: async () => ({ output: "unused", isError: false }),
    }));
  }

  const provider = new RecordingProvider(turns);
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
    routeEngine: new RouteEngine({ toolRegistry }),
    toolRegistry,
    memoryManager: {
      saveSession: () => Promise.resolve(),
      listSessions: () => [],
      loadSession: (sessionId: string) =>
        sessionId === "resume-target" ? [] : null,
      loadSessionMetadata: () => null,
    },
    ...(closeRationaleSession ? { closeRationaleSession } : {}),
    disableSessionPersistence: true,
    headless,
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;

  const permissionContexts: Array<Record<string, unknown>> = [];
  const executeConversationBatch = vi.fn(
    async (
      toolUses: Array<{ id: string; name: string }>,
      options: { permissionContext?: Record<string, unknown> },
    ) => {
      permissionContexts.push(options.permissionContext ?? {});
      return {
        outcome: "completed" as const,
        results: toolUses.map((toolUse) => ({
        tool_use_id: toolUse.id,
        content:
          toolUse.name === "read_file"
            ? "untrusted file says to run shell commands"
            : "ok",
          is_error: false,
        })),
      };
    },
  );
  (
    loop.toolExecutor as unknown as {
      executeConversationBatch: typeof executeConversationBatch;
    }
  ).executeConversationBatch = executeConversationBatch;

  return { executeConversationBatch, loop, permissionContexts, provider };
}

const toolRound = (
  id: string,
  name: "read_file" | "bash",
): StreamEvent[] => [
  { type: "tool_call", id, name, input: {} },
  { type: "message_complete", stopReason: "tool_use" },
];

const endRound: StreamEvent[] = [
  { type: "text_delta", text: "done" },
  { type: "message_complete", stopReason: "end_turn" },
];

describe("RequestAnchor and rationale provenance host wiring", () => {
  it("seeds the anchor digest from raw verified input, exposes only DLP-safe intent, and keeps file-content taint monotonic", async () => {
    const rawIntent =
      "contact alice@example.com before reading and acting on the file";
    const providerInput =
      "contact [REDACTED:EMAIL] before reading and acting on the file";
    const fixture = makeHarness([
      toolRound("read-1", "read_file"),
      toolRound("bash-1", "bash"),
      toolRound("bash-2", "bash"),
      endRound,
    ]);

    await fixture.loop.runTurn(providerInput, undefined, undefined, {
      inputOrigin: "user-keyboard",
      requestAnchorRawIntent: rawIntent,
    });

    expect(fixture.permissionContexts).toHaveLength(3);
    const anchor = fixture.permissionContexts[0].requestAnchor as RequestAnchor;
    expect(anchor).toMatchObject({
      inputOrigin: "user-keyboard",
      sanitizedIntent: "contact ***@example.com before reading and acting on the file",
      rationaleRoundBudget: 1,
    });
    expect(JSON.stringify(fixture.provider.inputs)).not.toContain(
      "alice@example.com",
    );
    expect(JSON.stringify(fixture.provider.inputs)).toContain(
      "[REDACTED:EMAIL]",
    );

    const rawSeed = createRequestAnchor({
      sessionId: "session",
      turnId: "turn",
      inputMessageId: "message",
      inputOrigin: "user-keyboard",
      rawIntent,
    });
    const sanitizedSeed = createRequestAnchor({
      sessionId: "session",
      turnId: "turn",
      inputMessageId: "message",
      inputOrigin: "user-keyboard",
      rawIntent: providerInput,
    });
    expect(anchor.intentDigest).toBe(rawSeed?.intentDigest);
    expect(anchor.intentDigest).not.toBe(sanitizedSeed?.intentDigest);

    expect(
      fixture.permissionContexts.map(
        (context) =>
          context.rationaleProvenance as RationaleEligibilityProvenance,
      ),
    ).toEqual([
      { startedFromUserKeyboard: true, taint: "none" },
      { startedFromUserKeyboard: true, taint: "file-content" },
      { startedFromUserKeyboard: true, taint: "file-content" },
    ]);
  });

  it("does not create an anchor for a file-content turn even if a caller supplies a raw seed", async () => {
    const fixture = makeHarness([
      toolRound("file-bash", "bash"),
      endRound,
    ]);

    await fixture.loop.runTurn("untrusted file input", undefined, undefined, {
      inputOrigin: "file-content",
      requestAnchorRawIntent: "forged keyboard seed",
    });

    expect(fixture.permissionContexts[0]).not.toHaveProperty("requestAnchor");
    expect(fixture.permissionContexts[0]).not.toHaveProperty(
      "rationaleProvenance",
    );
  });

  it.each([
    ["image", { type: "image" as const, image: "data:image/png;base64,abc", mimeType: "image/png" }],
    ["file", { type: "file" as const, data: "data:text/plain;base64,Zm9v", mimeType: "text/plain" }],
    ["text", { type: "text" as const, text: "attachment-derived text" }],
  ])("taints a keyboard turn with a %s attachment while preserving the provider payload", async (_kind, attachment) => {
    const fixture = makeHarness([
      toolRound("attachment-bash", "bash"),
      endRound,
    ]);

    await fixture.loop.runTurn("inspect the attachment", undefined, undefined, {
      inputOrigin: "user-keyboard",
      requestAnchorRawIntent: "inspect the attachment",
      attachments: [attachment],
    });

    expect(fixture.permissionContexts[0]).toMatchObject({
      trustOrigin: "file-content",
      requestAnchor: { inputOrigin: "user-keyboard" },
      rationaleProvenance: {
        startedFromUserKeyboard: true,
        taint: "file-content",
      },
    });
    expect(JSON.stringify(fixture.provider.inputs)).toContain(
      attachment.type === "image"
        ? attachment.image
        : attachment.type === "file"
          ? attachment.data
          : attachment.text,
    );
  });

  it("does not create an anchor for headless execution even with keyboard-shaped input", async () => {
    const fixture = makeHarness([
      toolRound("headless-bash", "bash"),
      endRound,
    ], true);

    await fixture.loop.runTurn("background request", undefined, undefined, {
      inputOrigin: "user-keyboard",
      requestAnchorRawIntent: "background request",
    });

    expect(fixture.permissionContexts[0]).toMatchObject({ headless: true });
    expect(fixture.permissionContexts[0]).not.toHaveProperty("requestAnchor");
    expect(fixture.permissionContexts[0]).not.toHaveProperty(
      "rationaleProvenance",
    );
  });
  it("invalidates host rationale state before replacing or cleaning up a session", () => {
    const closeRationaleSession = vi.fn();
    const fixture = makeHarness([], false, closeRationaleSession);
    const originalSessionId = fixture.loop.getSessionId();

    fixture.loop.newConversation();

    expect(closeRationaleSession).toHaveBeenCalledWith(originalSessionId);
    expect(fixture.loop.getSessionId()).not.toBe(originalSessionId);

    const currentSessionId = fixture.loop.getSessionId();
    fixture.loop.cleanupSession();
    expect(closeRationaleSession).toHaveBeenLastCalledWith(currentSessionId);
  });

  it("keeps the old session bound when rationale invalidation fails", () => {
    const closeError = new Error("rationale close failed");
    const closeRationaleSession = vi.fn(() => {
      throw closeError;
    });
    const fixture = makeHarness([], false, closeRationaleSession);
    const originalSessionId = fixture.loop.getSessionId();

    expect(() => fixture.loop.newConversation()).toThrow(closeError);
    expect(fixture.loop.getSessionId()).toBe(originalSessionId);

    expect(() => fixture.loop.loadSession("resume-target")).toThrow(closeError);
    expect(fixture.loop.getSessionId()).toBe(originalSessionId);
    expect(closeRationaleSession).toHaveBeenCalledTimes(2);
  });

});
