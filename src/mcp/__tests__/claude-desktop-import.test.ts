/**
 * #FU262 — Claude Desktop config importer tests.
 *
 * Locks the parse + map contract: malformed input never throws, secret
 * heuristic flags the right env keys, valid entries map to the LVIS
 * stdio config shape with `auth: "none"`.
 */
import { describe, expect, it } from "vitest";
import { parseClaudeDesktopConfig } from "../claude-desktop-import.js";

describe("parseClaudeDesktopConfig — happy path", () => {
  it("maps a single stdio server with command+args+env", () => {
    const raw = JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
          env: { LOG_LEVEL: "info" },
        },
      },
    });
    const result = parseClaudeDesktopConfig(raw);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry.id).toBe("filesystem");
    expect(entry.config).toEqual({
      id: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
      env: { LOG_LEVEL: "info" },
      auth: "none",
    });
    expect(entry.suspectedSecretEnvKeys).toEqual([]);
    expect(entry.warning).toBeUndefined();
  });

  it("maps multiple servers in one config", () => {
    const raw = JSON.stringify({
      mcpServers: {
        a: { command: "node", args: ["a.js"] },
        b: { command: "node", args: ["b.js"] },
      },
    });
    const result = parseClaudeDesktopConfig(raw);
    expect(result.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("parseClaudeDesktopConfig — secret heuristic", () => {
  it("flags env keys that look like API keys", () => {
    const raw = JSON.stringify({
      mcpServers: {
        s1: {
          command: "node",
          env: {
            ANTHROPIC_API_KEY: "sk-...",
            DEBUG: "1",
            DATABASE_PASSWORD: "secret",
            LOG_LEVEL: "info",
          },
        },
      },
    });
    const result = parseClaudeDesktopConfig(raw);
    expect(result.entries[0].suspectedSecretEnvKeys.sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "DATABASE_PASSWORD",
    ]);
    expect(result.entries[0].warning).toMatch(/Detected 2 env value\(s\)/);
  });

  it("does not flag secret keys with empty value (placeholder convention)", () => {
    const raw = JSON.stringify({
      mcpServers: {
        s1: { command: "node", env: { API_KEY: "" } },
      },
    });
    const result = parseClaudeDesktopConfig(raw);
    expect(result.entries[0].suspectedSecretEnvKeys).toEqual([]);
  });
});

describe("parseClaudeDesktopConfig — error paths", () => {
  it("returns root-level error on invalid JSON", () => {
    const result = parseClaudeDesktopConfig("not json");
    expect(result.entries).toEqual([]);
    expect(result.errors[0]).toMatchObject({ id: "<root>", reason: expect.stringMatching(/JSON/) });
  });

  it("returns root-level error when mcpServers is missing", () => {
    const result = parseClaudeDesktopConfig("{}");
    expect(result.errors[0]).toMatchObject({ id: "<root>", reason: expect.stringMatching(/mcpServers/) });
  });

  it("collects per-entry errors without aborting the whole import", () => {
    const raw = JSON.stringify({
      mcpServers: {
        good: { command: "node", args: ["server.js"] },
        broken: { args: ["no-command"] },
        "  ": { command: "node" },
      },
    });
    const result = parseClaudeDesktopConfig(raw);
    expect(result.entries.map((e) => e.id)).toEqual(["good"]);
    expect(result.errors.map((e) => e.id).sort()).toEqual(["  ", "broken"]);
  });

  it("rejects entries with non-string args", () => {
    const raw = JSON.stringify({
      mcpServers: { s: { command: "node", args: ["ok", 123] } },
    });
    const result = parseClaudeDesktopConfig(raw);
    expect(result.entries).toEqual([]);
    expect(result.errors[0].reason).toMatch(/strings/);
  });

  it("rejects entries with non-string env values", () => {
    const raw = JSON.stringify({
      mcpServers: { s: { command: "node", env: { LEVEL: 5 } } },
    });
    const result = parseClaudeDesktopConfig(raw);
    expect(result.entries).toEqual([]);
    expect(result.errors[0].reason).toMatch(/env\.LEVEL/);
  });

  it("rejects mcpServers as array (must be object)", () => {
    const raw = JSON.stringify({ mcpServers: [{ command: "node" }] });
    const result = parseClaudeDesktopConfig(raw);
    expect(result.entries).toEqual([]);
    expect(result.errors[0].reason).toMatch(/object/);
  });
});

describe("parseClaudeDesktopConfig — output shape invariants", () => {
  it("always emits transport=stdio and auth=none", () => {
    const raw = JSON.stringify({ mcpServers: { s: { command: "node" } } });
    const entry = parseClaudeDesktopConfig(raw).entries[0];
    expect(entry.config.transport).toBe("stdio");
    expect((entry.config as { auth?: string }).auth).toBe("none");
  });

  it("trims whitespace from command and id", () => {
    const raw = JSON.stringify({
      mcpServers: {
        "  trimmed-id  ": { command: "  /usr/bin/node  " },
      },
    });
    const entry = parseClaudeDesktopConfig(raw).entries[0];
    expect(entry.id).toBe("trimmed-id");
    expect((entry.config as { command: string }).command).toBe("/usr/bin/node");
  });
});
