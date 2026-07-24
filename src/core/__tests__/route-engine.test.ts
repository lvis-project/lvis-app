import { describe, expect, it } from "vitest";
import { RouteEngine } from "../route-engine.js";

describe("RouteEngine", () => {
  it("routes general input through the llm route", () => {
    expect(
      new RouteEngine().route({
        type: "general",
        input: "상태 알려줘",
      }),
    ).toEqual({
      route: "llm",
      input: "상태 알려줘",
    });
});

  it("routes host commands without consulting Tool state", () => {
    expect(
      new RouteEngine().route({
      type: "command",
        command: "compact",
        args: "now",
      }),
    ).toEqual({
      route: "command",
      command: "compact",
      args: "now",
    });
  });
});
