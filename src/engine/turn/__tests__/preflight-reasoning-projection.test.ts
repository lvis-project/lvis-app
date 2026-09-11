import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationTracer, TraceStepName } from "../../../observability/conversation-trace.js";
import { getModelPreflightThreshold } from "../../auto-compact.js";
import { ConversationLoop } from "../../conversation-loop.js";
import {
  makeConversationLoopDeps,
  makeConversationLoopMemoryManager,
  makeConversationLoopMemoryReviewer,
  makeConversationLoopSettings,
  makeConversationTurnProvider,
  makeSyntheticCompactResult,
} from "../../__tests__/conversation-loop-test-helpers.js";
import type { GenericMessage } from "../../llm/types.js";

vi.mock("../../structured-compact.js", () => ({
  DEFAULT_PRESERVE_RECENT_TURNS: 5,
  compactWithBoundary: vi.fn(),
  renderBoundaryAsPreamble: vi.fn(() => "## Compact preamble"),
}));

import { compactWithBoundary } from "../../structured-compact.js";

beforeEach(() => {
  vi.mocked(compactWithBoundary).mockReset();
});

describe("preflight reasoning projection", () => {
  it.each([
    { vendor: "claude", kind: "display-only", shouldCompact: false },
    { vendor: "claude", kind: "unsigned", shouldCompact: false },
    { vendor: "claude", kind: "signed", shouldCompact: true },
    { vendor: "claude", kind: "visible", shouldCompact: true },
    { vendor: "openai-compatible", kind: "signed", shouldCompact: false },
    { vendor: "openai-compatible", kind: "visible", shouldCompact: true },
  ] as const)(
    "compacts only request-bearing history at the unchanged threshold: $vendor $kind",
    async ({ vendor, kind, shouldCompact }) => {
      const model = vendor === "claude" ? "claude-sonnet-4-5" : "unlisted-model";
      const threshold = getModelPreflightThreshold(vendor, model);
      const largeText = "a".repeat(threshold * 5);
      const assistant: Extract<GenericMessage, { role: "assistant" }> = {
        role: "assistant",
        content: kind === "visible" ? largeText : "I inspected the file.",
        thought: largeText,
        ...(kind === "signed" || kind === "unsigned"
          ? { thinkingBlocks: [{ thinking: largeText, signature: kind === "signed" ? "signature" : "" }] }
          : {}),
      };
      const history: GenericMessage[] = [{ role: "user", content: "Inspect the file." }, assistant];
      const sessionId = randomUUID();
      const loop = new ConversationLoop(makeConversationLoopDeps({
        settingsService: makeConversationLoopSettings(true, model, vendor),
        memoryManager: makeConversationLoopMemoryManager(history, sessionId),
        memoryReviewer: makeConversationLoopMemoryReviewer(),
      }));
      loop.resetAndResume(sessionId);
      const steps: Array<{ name: TraceStepName; meta?: Record<string, unknown> }> = [];
      const tracer: ConversationTracer = {
        enabled: true,
        filePath: undefined,
        step: (name, meta) => { steps.push({ name, meta }); },
      };
      loop.setTracer(tracer);
      const provider = { ...makeConversationTurnProvider(), vendor };
      (loop as unknown as { provider: typeof provider }).provider = provider;
      vi.mocked(compactWithBoundary).mockResolvedValue(makeSyntheticCompactResult(history));

      await loop.runTurn("Continue.", undefined, undefined, { inputOrigin: "user-keyboard" });

      expect(steps.find((step) => step.name === "PREFLIGHT_GUARD")?.meta).toMatchObject({
        outcome: shouldCompact ? "fired" : "not-reached",
        threshold,
        thresholdSource: "context-window",
      });
      if (shouldCompact) expect(compactWithBoundary).toHaveBeenCalled();
      else expect(compactWithBoundary).not.toHaveBeenCalled();
      expect(assistant.thought).toBe(largeText);
    },
  );
});
