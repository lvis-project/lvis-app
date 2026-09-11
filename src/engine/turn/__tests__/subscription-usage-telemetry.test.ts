import { describe, expect, it } from "vitest";
import { createSubscriptionUsageCollector } from "../subscription-usage-telemetry.js";
import type { StreamCollectResult } from "../stream-collector.js";

describe("local subscription output accounting", () => {
  it("counts generated reasoning even when it is not replayed in later inputs", () => {
    const collector = createSubscriptionUsageCollector();
    const runtime = { kind: "subscription", provider: "codex", model: "fixture-model" } as const;
    const completed: Extract<StreamCollectResult, { kind: "ok" }> = {
      kind: "ok", text: "Done.", thought: "", thinkingBlocks: [], toolCalls: [], stopReason: "end_turn",
    };
    const visibleOnly = collector.record(runtime, completed, 100);
    const withReasoning = collector.record(runtime, {
      ...completed, thought: "Inspect the dependency graph before changing the implementation. ".repeat(100),
    }, 100);

    expect(visibleOnly).toBeDefined();
    expect(withReasoning).toMatchObject({
      source: "local-estimate", billable: false, inputTokens: 100,
    });
    expect(withReasoning!.outputTokens).toBeGreaterThan(visibleOnly!.outputTokens + 100);
    expect(withReasoning!.totalTokens).toBe(withReasoning!.inputTokens + withReasoning!.outputTokens);
  });
});
