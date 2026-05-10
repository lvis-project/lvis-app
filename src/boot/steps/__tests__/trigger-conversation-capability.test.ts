import { describe, expect, it, vi } from "vitest";
import {
  evaluateTriggerSpec,
  TriggerConversationDedupe,
  TriggerConversationRateLimiter,
} from "../plugin-runtime.js";

const spec = {
  source: "overlay:test",
  prompt: "검토가 필요한 항목이 있습니다.",
};

function run(capabilities: string[]) {
  return evaluateTriggerSpec({
    spec,
    pluginId: "plugin-a",
    capabilities,
    dedupe: new TriggerConversationDedupe(),
    rateLimiter: new TriggerConversationRateLimiter(),
    loopBound: true,
    auditLogger: { log: vi.fn() },
    now: () => Date.parse("2026-05-10T00:00:00.000Z"),
  });
}

describe("triggerConversation overlay capability gate", () => {
  it("accepts host:overlay as the canonical capability", () => {
    expect(run(["host:overlay"]).kind).toBe("allow");
  });

  it("rejects non-overlay capability labels", () => {
    const outcome = run(["mail-source"]);
    expect(outcome.kind).toBe("deny");
    expect(outcome.result.reason).toBe("capability_denied");
  });
});
