import { describe, expect, it, vi } from "vitest";
import { RouteEngine } from "../route-engine.js";
import type { InputClassification } from "../keyword-engine.js";
import type { ToolRegistry } from "../../tools/registry.js";

function engine() {
  return new RouteEngine({
    toolRegistry: { findByName: vi.fn(() => undefined) } as unknown as ToolRegistry,
  });
}

describe("RouteEngine", () => {
  it("routes mentions through the generic agent-message route", () => {
    const result = engine().route({
      type: "mention",
      target: "worker-a",
      message: "상태 알려줘",
    } as InputClassification);

    expect(result).toEqual({
      route: "agent-message",
      target: "worker-a",
      message: "상태 알려줘",
    });
  });
});
