import { describe, expect, it } from "vitest";
import { parseCliWords, splitCommandLine } from "../McpTab.js";

describe("McpTab command parsing", () => {
  it("preserves Windows-style backslashes in argv values", () => {
    expect(parseCliWords(String.raw`--config C:\Users\ken\AppData\Local\lvis\mcp.json`)).toEqual([
      "--config",
      String.raw`C:\Users\ken\AppData\Local\lvis\mcp.json`,
    ]);
  });

  it("parses unquoted Windows executable paths with spaces as a single command", () => {
    expect(splitCommandLine(String.raw`C:\Program Files\tool\mcp.exe --port 3000 --mode json`)).toEqual([
      String.raw`C:\Program Files\tool\mcp.exe`,
      "--port",
      "3000",
      "--mode",
      "json",
    ]);
  });
});
