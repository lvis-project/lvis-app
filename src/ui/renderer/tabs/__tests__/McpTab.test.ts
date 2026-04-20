import { describe, expect, it } from "vitest";
import { parseCliWords, splitCommandLine, validateAuthApiKey } from "../McpTab.js";

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

describe("validateAuthApiKey", () => {
  it("returns null for valid none/empty-key combination", () => {
    expect(validateAuthApiKey("none", "")).toBeNull();
    expect(validateAuthApiKey("none", "   ")).toBeNull();
  });

  it("returns null for valid api-key/non-empty-key combination", () => {
    expect(validateAuthApiKey("api-key", "sk-abc123")).toBeNull();
    expect(validateAuthApiKey("api-key", "  sk-abc  ")).toBeNull();
  });

  it("returns null for sso with or without a key (sso does not use apiKey)", () => {
    expect(validateAuthApiKey("sso", "")).toBeNull();
    expect(validateAuthApiKey("sso", "some-key")).toBeNull();
  });

  it("returns an error when api-key auth is missing the key", () => {
    const err = validateAuthApiKey("api-key", "");
    expect(err).not.toBeNull();
    expect(err).toMatch(/API Key/);
  });

  it("returns an error when api-key auth has only whitespace key", () => {
    const err = validateAuthApiKey("api-key", "   ");
    expect(err).not.toBeNull();
  });

  it("returns an error when none auth is given a non-empty key", () => {
    const err = validateAuthApiKey("none", "oops-a-key");
    expect(err).not.toBeNull();
    expect(err).toMatch(/없음/);
  });
});
