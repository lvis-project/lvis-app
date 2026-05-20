import { describe, expect, it } from "vitest";

import { getToolDisplayName } from "../tool-display.js";

describe("tool display names", () => {
  it("labels read_tool_result_chunk instead of leaking raw identifier text", () => {
    expect(getToolDisplayName("read_tool_result_chunk")).toBe("도구 결과 청크 읽기");
  });
});
