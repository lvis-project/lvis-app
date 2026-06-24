import { describe, expect, it, vi } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnInput } from "../llm/types.js";

class UnusedProvider implements LLMProvider {
  readonly vendor = "openai" as const;

  async *streamTurn(_input: StreamTurnInput): AsyncIterable<StreamEvent> {
    throw new Error("slash command should not stream LLM turns");
  }
}

function makeLoop() {
  const toolRegistry = new ToolRegistry();
  const keywordEngine = new KeywordEngine();
  const routeEngine = new RouteEngine({ toolRegistry });
  let mode: "default" | "strict" | "auto" | "allow" = "default";
  const permissionManager = {
    getMode: vi.fn(() => mode),
    setMode: vi.fn((next: typeof mode) => {
      mode = next;
    }),
    setModePersist: vi.fn(async (next: typeof mode) => {
      mode = next;
    }),
  };
  const approvalGate = {
    requestAndWait: vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    })),
  };
  const auditLogger = {
    isPermissionAuditChainReady: vi.fn(() => true),
    appendPermissionAuditEntry: vi.fn(async () => undefined),
  };
  const loop = new ConversationLoop(({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: () => {},
    },
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager: {
      saveSession: () => {},
      listSessions: () => [],
    },
    permissionManager,
    approvalGate,
    auditLogger,
    disableSessionPersistence: true,
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as unknown as { provider: LLMProvider | null }).provider = new UnusedProvider();
  return { loop, permissionManager, approvalGate, auditLogger };
}

describe("ConversationLoop permission mode slash events", () => {
  it("notifies callbacks after /permission mode allow changes the policy", async () => {
    const { loop, permissionManager } = makeLoop();
    const onPermissionModeChanged = vi.fn();

    const result = await loop.runTurn(
      "/permission mode allow",
      { onPermissionModeChanged },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(result.text).toContain("권한 모드 변경됨: default -> allow");
    expect(permissionManager.setMode).toHaveBeenCalledWith("allow");
    expect(onPermissionModeChanged).toHaveBeenCalledWith("allow");
  });

  it("applies durable built-in /permission mode changes without approval popup", async () => {
    const { loop, permissionManager, approvalGate, auditLogger } = makeLoop();
    const onPermissionModeChanged = vi.fn();

    const result = await loop.runTurn(
      "/permission mode auto --durable",
      { onPermissionModeChanged },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(result.text).toContain("권한 모드 변경됨: default -> auto");
    expect(permissionManager.setModePersist).toHaveBeenCalledWith("auto");
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "mode_change",
        fromMode: "default",
        toMode: "auto",
        durable: true,
      }),
    );
    expect(onPermissionModeChanged).toHaveBeenCalledWith("auto");
  });
});
