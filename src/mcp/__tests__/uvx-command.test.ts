import { describe, expect, it, vi } from "vitest";

vi.mock("../../main/uv-runtime.js", () => ({
  resolveBundledUvBinaryPath: vi.fn(() => "/resources/uv/darwin-arm64/uv"),
}));

import { resolveStdioSpawnCommand } from "../uvx-command.js";

describe("resolveStdioSpawnCommand", () => {
  it("routes bare uvx through the bundled uv tool runner", () => {
    expect(resolveStdioSpawnCommand("uvx", ["browser-use", "--mcp"])).toEqual({
      command: "/resources/uv/darwin-arm64/uv",
      args: ["tool", "run", "browser-use", "--mcp"],
    });
  });

  it("preserves inline uvx command arguments before configured args", () => {
    expect(resolveStdioSpawnCommand("uvx browser-use", ["--mcp"])).toEqual({
      command: "/resources/uv/darwin-arm64/uv",
      args: ["tool", "run", "browser-use", "--mcp"],
    });
  });

  it("routes inline uvx.exe commands on Windows configs", () => {
    expect(resolveStdioSpawnCommand("uvx.exe browser-use", ["--mcp"])).toEqual({
      command: "/resources/uv/darwin-arm64/uv",
      args: ["tool", "run", "browser-use", "--mcp"],
    });
  });

  it("leaves non-uvx stdio commands unchanged", () => {
    expect(resolveStdioSpawnCommand("npx browser-use", ["--mcp"])).toEqual({
      command: "npx browser-use",
      args: ["--mcp"],
    });
  });
});
