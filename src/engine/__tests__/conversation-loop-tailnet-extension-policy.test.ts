/**
 * ConversationLoop must establish the remote-controller extension boundary
 * before any asynchronous lifecycle dispatch reaches the hook manager.
 */
import { describe, expect, it, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { areExternalTurnHooksAllowed } from "../../shared/turn-extension-policy.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";

class SingleTurnProvider implements LLMProvider {
  readonly vendor = "openai" as const;

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "ok" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

function buildLoop(scriptHookManager: ScriptHookManager): ConversationLoop {
  return new ConversationLoop({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn() },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: {
      saveSession: () => Promise.resolve(),
      listSessions: () => [],
      loadSessionMetadata: () => null,
    },
    disableSessionPersistence: true,
    scriptHookManager,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
}

describe("ConversationLoop Tailnet extension policy", () => {
  it("propagates disabled external hooks through an asynchronous lifecycle dispatch", async () => {
    const provider = new SingleTurnProvider();
    const manager = new ScriptHookManager();
    const lifecycleDispatch = vi.spyOn(manager, "runLifecycleEvent").mockImplementation(async () => {
      expect(areExternalTurnHooksAllowed()).toBe(false);
      return { decision: "allow", reason: "suppressed", results: [] };
    });
    const promptDispatch = vi.spyOn(manager, "runUserPromptSubmit");
    const loop = buildLoop(manager);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("tailnet request", undefined, undefined, {
      inputOrigin: "tailnet-surface",
      remoteControllerAuthority: {
        kind: "tailnet-controller",
        actorId: "tailnet:conversation-loop-policy-test",
      },
    });

    expect(result.text).toBe("ok");
    expect(promptDispatch).not.toHaveBeenCalled();
    expect(lifecycleDispatch.mock.calls.some((call) => call[0] === "Stop")).toBe(true);
  });
});
