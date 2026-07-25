/**
 * `mcp_resource_list` / `mcp_resource_read` — the model's path to server resources.
 *
 * What these tests pin is the trust posture, because the gates themselves live one
 * layer down in the client (deliberately, so the model path and the future user
 * path cannot drift in what they allow):
 *   - both tools are READ category and read-only, so neither can carry write
 *     authority into a turn;
 *   - a server's own error message never reaches the model — it can carry host
 *     paths, and a detailed failure is a probe channel;
 *   - what the host clipped is reported rather than silently dropped;
 *   - a resource the host refuses to fetch is still listed, and says so, so the
 *     model stops retrying instead of looping.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createMcpResourceListTool,
  createMcpResourceReadTool,
  type McpResourceToolDeps,
} from "../mcp-resource-tools.js";
import { MCP_RESOURCE_URI_MAX_CHARS } from "../../shared/mcp-resource-bounds.js";

const ctx = () => ({}) as never;

function deps(over: Partial<McpResourceToolDeps> = {}): McpResourceToolDeps {
  return {
    listResources: () => [
      {
        serverId: "hr-mcp",
        resources: [
          { uri: "file:///policy.md", name: "policy.md", mimeType: "text/markdown", size: 12 },
          { uri: "https://example.com/doc", name: "web doc", hostFetchRefused: true },
        ],
      },
      { serverId: "other-mcp", resources: [{ uri: "schema://users", name: "users" }] },
    ],
    readResource: async () => ({
      blocks: [{ uri: "file:///policy.md", mimeType: "text/markdown", text: "BODY" }],
      droppedBlocks: 0,
      truncated: false,
    }),
    ...over,
  };
}

function parse(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

describe("mcp_resource_list", () => {
  it("is a read-only read-category tool", () => {
    const tool = createMcpResourceListTool(deps());
    expect(tool.category).toBe("read");
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  it("lists every server, and narrows when serverId is given", async () => {
    const tool = createMcpResourceListTool(deps());
    const all = parse((await tool.execute({}, ctx())).output);
    expect((all.servers as unknown[]).length).toBe(2);

    const one = parse((await tool.execute({ serverId: "other-mcp" }, ctx())).output);
    expect(one.servers).toEqual([
      { serverId: "other-mcp", resources: [{ uri: "schema://users", name: "users" }] },
    ]);
  });

  it("tells the model which resources the host will not fetch", async () => {
    // Hiding them would leave the model retrying a read that can never succeed.
    const tool = createMcpResourceListTool(deps());
    const out = parse((await tool.execute({}, ctx())).output);
    const first = (out.servers as Array<{ resources: Array<Record<string, unknown>> }>)[0];
    expect(first.resources[1]).toMatchObject({ hostFetchRefused: true });
    expect(first.resources[0].hostFetchRefused).toBeUndefined();
  });
});

describe("mcp_resource_read", () => {
  it("is a read-only read-category tool", () => {
    const tool = createMcpResourceReadTool(deps());
    expect(tool.category).toBe("read");
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  it("returns the blocks the client produced", async () => {
    const readResource = vi.fn(async () => ({
      blocks: [{ text: "BODY" }, { omittedKind: "binary" }],
      droppedBlocks: 3,
      truncated: true,
    }));
    const tool = createMcpResourceReadTool(deps({ readResource }));
    const out = parse((await tool.execute({ serverId: "hr-mcp", uri: "file:///policy.md" }, ctx())).output);
    expect(readResource).toHaveBeenCalledWith("hr-mcp", "file:///policy.md");
    expect(out.blocks).toEqual([{ text: "BODY" }, { omittedKind: "binary" }]);
    // Clipping is REPORTED. A silent clip reads as "this is the whole document".
    expect(out.truncated).toBe(true);
    expect(out.droppedBlocks).toBe(3);
  });

  it("omits the clip fields when nothing was clipped", async () => {
    const tool = createMcpResourceReadTool(deps());
    const out = parse((await tool.execute({ serverId: "hr-mcp", uri: "file:///policy.md" }, ctx())).output);
    expect(out.truncated).toBeUndefined();
    expect(out.droppedBlocks).toBeUndefined();
  });

  it("rejects a malformed or over-long request before calling the client", async () => {
    const readResource = vi.fn();
    const tool = createMcpResourceReadTool(deps({ readResource: readResource as never }));
    for (const args of [
      {},
      { serverId: "hr-mcp" },
      { uri: "file:///x" },
      { serverId: "hr-mcp", uri: "" },
      { serverId: 42, uri: "file:///x" },
      { serverId: "hr-mcp", uri: `file:///${"a".repeat(MCP_RESOURCE_URI_MAX_CHARS)}` },
    ]) {
      const result = await tool.execute(args, ctx());
      expect(result.isError, JSON.stringify(args).slice(0, 40)).toBe(true);
    }
    expect(readResource).not.toHaveBeenCalled();
  });

  it("never forwards the server's own failure text to the model", async () => {
    // The client logs the real reason; a server message can carry host paths, and a
    // detailed failure would also make a refused read a probe channel.
    const tool = createMcpResourceReadTool(
      deps({
        readResource: async () => {
          throw new Error("ENOENT: C:/Users/secret/path leaked");
        },
      }),
    );
    const result = await tool.execute({ serverId: "hr-mcp", uri: "file:///x" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("secret");
    expect(result.output).not.toContain("ENOENT");
  });
});
