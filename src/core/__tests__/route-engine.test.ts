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
  it("routes general input through the llm route", () => {
    const result = engine().route({
      type: "general",
      input: "상태 알려줘",
    } as InputClassification);

    expect(result).toEqual({
      route: "llm",
      input: "상태 알려줘",
    });
  });
});
