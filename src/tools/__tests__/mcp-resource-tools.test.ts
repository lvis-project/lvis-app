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
import { MCP_RESOURCE_LIST_MAX_CHARS } from "../mcp-resource-tools.js";

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
      {
        serverId: "other-mcp",
        // Fully populated on purpose: the exact-shape assertion below is the only
        // thing pinning the optional-field projection, so it has to see every
        // optional field rather than a two-field resource.
        resources: [{
          uri: "schema://users",
          name: "users",
          title: "Users table",
          description: "columns and types",
          mimeType: "application/json",
          size: 99,
        }],
      },
    ],
    readDeclaredResource: async () => ({
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
    const tool = createMcpResourceListTool(() => deps());
    expect(tool.category).toBe("read");
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  it("lists every server, and narrows when serverId is given", async () => {
    const tool = createMcpResourceListTool(() => deps());
    const all = parse((await tool.execute({}, ctx())).output);
    expect((all.servers as unknown[]).length).toBe(2);

    const one = parse((await tool.execute({ serverId: "other-mcp" }, ctx())).output);
    expect(one.servers).toEqual([
      {
        serverId: "other-mcp",
        resources: [{
          uri: "schema://users",
          name: "users",
          title: "Users table",
          description: "columns and types",
          mimeType: "application/json",
          size: 99,
        }],
      },
    ]);
  });

  it("tells the model which resources the host will not fetch", async () => {
    // Hiding them would leave the model retrying a read that can never succeed.
    const tool = createMcpResourceListTool(() => deps());
    const out = parse((await tool.execute({}, ctx())).output);
    const first = (out.servers as Array<{ resources: Array<Record<string, unknown>> }>)[0];
    expect(first.resources[1]).toMatchObject({ hostFetchRefused: true });
    expect(first.resources[0].hostFetchRefused).toBeUndefined();
  });
});

describe("mcp_resource_read", () => {
  it("is a read-only read-category tool", () => {
    const tool = createMcpResourceReadTool(() => deps());
    expect(tool.category).toBe("read");
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  it("returns the blocks the client produced", async () => {
    const readDeclaredResource = vi.fn(async () => ({
      blocks: [{ text: "BODY" }, { omittedKind: "binary" }],
      droppedBlocks: 3,
      truncated: true,
    }));
    const tool = createMcpResourceReadTool(() => deps({ readDeclaredResource }));
    const out = parse((await tool.execute({ serverId: "hr-mcp", uri: "file:///policy.md" }, ctx())).output);
    expect(readDeclaredResource).toHaveBeenCalledWith("hr-mcp", "file:///policy.md");
    expect(out.blocks).toEqual([{ text: "BODY" }, { omittedKind: "binary" }]);
    // Clipping is REPORTED. A silent clip reads as "this is the whole document".
    expect(out.truncated).toBe(true);
    expect(out.droppedBlocks).toBe(3);
  });

  it("omits the clip fields when nothing was clipped", async () => {
    const tool = createMcpResourceReadTool(() => deps());
    const out = parse((await tool.execute({ serverId: "hr-mcp", uri: "file:///policy.md" }, ctx())).output);
    expect(out.truncated).toBeUndefined();
    expect(out.droppedBlocks).toBeUndefined();
  });

  it("rejects a malformed or over-long request before calling the client", async () => {
    const readDeclaredResource = vi.fn();
    const tool = createMcpResourceReadTool(() => deps({ readDeclaredResource: readDeclaredResource as never }));
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
    expect(readDeclaredResource).not.toHaveBeenCalled();
  });

  it("never forwards the server's own failure text to the model", async () => {
    // The tool logs the real reason host-side; a server message can carry host paths,
    // and a detailed failure would also make a refused read a probe channel.
    const tool = createMcpResourceReadTool(() =>
      deps({
        readDeclaredResource: async () => {
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

describe("resource tools — wiring and bounds", () => {
  // The MCP manager is built in a LATER boot step than the builtin tools, so the
  // window exists in every real launch. It gets its own outcome rather than a
  // generic failure, or an operator sees "could not be read" for a host that was
  // simply still starting.
  it("says so when resource access is not wired yet", async () => {
    const list = createMcpResourceListTool(() => undefined);
    const read = createMcpResourceReadTool(() => undefined);
    const listed = await list.execute({}, ctx());
    const readOut = await read.execute({ serverId: "hr-mcp", uri: "file:///x" }, ctx());
    expect(listed.isError).toBe(true);
    expect(readOut.isError).toBe(true);
    // Both tools report the SAME not-ready reason…
    expect(parse(listed.output).error).toBe(parse(readOut.output).error);
    // …and it is distinguishable from a real read failure, which is the point: an
    // operator must not see "could not be read" for a host that was still starting.
    const failing = createMcpResourceReadTool(() =>
      deps({ readDeclaredResource: async () => { throw new Error("boom"); } }),
    );
    const failed = await failing.execute({ serverId: "hr-mcp", uri: "file:///x" }, ctx());
    expect(parse(failed.output).error).not.toBe(parse(readOut.output).error);
  });

  it("resolves access per call, so a late-arriving manager is picked up", async () => {
    // Capturing the value at construction would freeze the registration-time
    // `undefined` forever — the bug the resolver exists to prevent.
    let access: McpResourceToolDeps | undefined;
    const tool = createMcpResourceListTool(() => access);
    expect((await tool.execute({}, ctx())).isError).toBe(true);
    access = deps();
    const after = await tool.execute({}, ctx());
    expect(after.isError).toBe(false);
    expect((parse(after.output).servers as unknown[]).length).toBe(2);
  });

  it("bounds one list response and reports what it dropped", async () => {
    // The unbounded axis is server_count x catalogue_size, and it lands in the
    // model's context window. Dropping servers silently would read as "that is all
    // there is".
    const many = Array.from({ length: 40 }, (_, s) => ({
      serverId: `srv-${s}`,
      resources: Array.from({ length: 50 }, (_, i) => ({
        uri: `file:///s${s}/f${i}`,
        name: `f${i}`,
        description: "d".repeat(200),
      })),
    }));
    const tool = createMcpResourceListTool(() => deps({ listResources: () => many }));
    const rawOut = (await tool.execute({}, ctx())).output;
    const out = parse(rawOut);
    expect((out.servers as unknown[]).length).toBeLessThan(many.length);
    // The BOUND, not just "something was dropped": a loose ceiling passes for any
    // constant and would not have caught the single-server exemption this fixed.
    expect(rawOut.length).toBeLessThanOrEqual(MCP_RESOURCE_LIST_MAX_CHARS);
    // Dropped servers are NAMED — `serverId` is the model's only narrowing lever,
    // and it cannot narrow to a server it was never told about.
    expect(Array.isArray(out.omittedServerIds)).toBe(true);
  });

  // The dominant axis is ONE server's catalogue: discovery caps resources at 200 but
  // never their bytes, and a narrowed call always yields exactly one server — so a
  // whole-servers-only bound would never fire for the biggest realistic payload.
  it("drops descriptions before resources, keeping the catalogue complete", async () => {
    const one = [{
      serverId: "srv",
      resources: Array.from({ length: 200 }, (_, i) => ({
        uri: `file:///f${i}`,
        name: `f${i}`,
        description: "d".repeat(2000),
      })),
    }];
    const tool = createMcpResourceListTool(() => deps({ listResources: () => one }));
    const rawOut = (await tool.execute({}, ctx())).output;
    const out = parse(rawOut);
    const servers = out.servers as Array<{ serverId: string; resources: unknown[] }>;
    expect(rawOut.length).toBeLessThanOrEqual(MCP_RESOURCE_LIST_MAX_CHARS);
    // Cheapest loss first: the prose goes, every resource stays. uri + name is what a
    // read needs, so the catalogue is still fully usable.
    expect(out.descriptionsOmitted).toBe(true);
    expect(servers[0].resources).toHaveLength(200);
    expect(out.omittedResources).toBeUndefined();
  });

  it("trims resources from a server too large even without descriptions", async () => {
    const one = [{
      serverId: "srv",
      // Long URIs, no prose to drop — the only remaining lever is the resource list.
      resources: Array.from({ length: 200 }, (_, i) => ({
        uri: `file:///${"deep/".repeat(30)}f${i}`,
        name: `f${i}`,
      })),
    }];
    const tool = createMcpResourceListTool(() => deps({ listResources: () => one }));
    const rawOut = (await tool.execute({}, ctx())).output;
    const out = parse(rawOut);
    const servers = out.servers as Array<{ serverId: string; resources: unknown[] }>;
    expect(rawOut.length).toBeLessThanOrEqual(MCP_RESOURCE_LIST_MAX_CHARS);
    // Still returns something usable for that server rather than nothing…
    expect(servers).toHaveLength(1);
    expect(servers[0].resources.length).toBeGreaterThan(0);
    expect(servers[0].resources.length).toBeLessThan(200);
    // …and says how much it withheld.
    expect(out.omittedResources).toBe(200 - servers[0].resources.length);
  });

  it("declares the MCP scope dependency on both tools", () => {
    // Builtins are otherwise always eager. These two hand the model untrusted
    // server content, so they must honor the same `includeMcp` switch that keeps
    // MCP tools out of headless (routine) loops.
    expect(createMcpResourceListTool(() => deps()).requiresMcpScope).toBe(true);
    expect(createMcpResourceReadTool(() => deps()).requiresMcpScope).toBe(true);
  });
});
