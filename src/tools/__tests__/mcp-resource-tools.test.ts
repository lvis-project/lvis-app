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
import { parseJsonRecord as parse } from "../../__tests__/test-helpers.js";

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
  it("drops descriptions before resources, keeping most of the catalogue", async () => {
    const one = [{
      serverId: "srv",
      resources: Array.from({ length: 200 }, (_, i) => ({
        uri: `file:///f${i}`,
        name: `f${i}`,
        description: "d".repeat(2000),
      })),
    }];
    const tool = createMcpResourceListTool(() => deps({ listResources: () => one }));
    // Narrowed, because a resume cursor is only defined for one server's catalogue.
    const rawOut = (await tool.execute({ serverId: "srv" }, ctx())).output;
    const out = parse(rawOut);
    const servers = out.servers as Array<{ serverId: string; resources: unknown[] }>;
    expect(rawOut.length).toBeLessThanOrEqual(MCP_RESOURCE_LIST_MAX_CHARS);
    // Cheapest loss first: the prose goes so the ENTRIES survive. uri + name is what a
    // read needs, so nearly the whole catalogue stays usable — 197 of 200 here, where
    // keeping the descriptions instead would have fit only a handful. The guarantee is
    // the ORDER of loss, not completeness: 200 entries of any size cannot all fit a
    // budget sized to the wire cap.
    expect(out.descriptionsOmitted).toBe(true);
    expect(servers[0].resources.length).toBeGreaterThan(150);
    // …and what did not fit is both counted and resumable.
    expect(out.omittedResources).toBe(200 - servers[0].resources.length);
    expect(out.nextOffset).toBe(servers[0].resources.length);
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

  // The bound has to hold when the OMISSION LIST is the payload. Two reviewers found
  // the same hole independently: dropped ids were pushed without being charged, and
  // the postcondition loop exits on "nothing kept" rather than on fitting — so a few
  // dozen long server ids could leave an over-budget response with no tier left.
  it("bounds the response even when almost everything is omitted", async () => {
    const many = Array.from({ length: 200 }, (_, s) => ({
      serverId: `srv-${"x".repeat(100)}-${s}`,
      resources: Array.from({ length: 20 }, (_, i) => ({
        uri: `file:///s${s}/f${i}`,
        name: `f${i}`,
        description: "d".repeat(500),
      })),
    }));
    const tool = createMcpResourceListTool(() => deps({ listResources: () => many }));
    const rawOut = (await tool.execute({}, ctx())).output;
    const out = parse(rawOut);
    expect(rawOut.length).toBeLessThanOrEqual(MCP_RESOURCE_LIST_MAX_CHARS);
    // Named ids are capped; the rest are a count, so nothing is silently lost.
    expect((out.omittedServerIds as string[]).length).toBeLessThanOrEqual(20);
    expect(out.unnamedOmittedServers).toBeGreaterThan(0);
  });

  // Trimming at the SOURCE means the tail never reaches the wire, so unlike a stubbed
  // result it cannot be paged back with `read_tool_result_chunk`. Without an offset the
  // head was a permanent ceiling on what the model could ever see.
  it("lets the model page past what the host trimmed", async () => {
    const one = [{
      serverId: "srv",
      resources: Array.from({ length: 200 }, (_, i) => ({
        uri: `file:///f${i}`,
        name: `f${i}`,
      })),
    }];
    const tool = createMcpResourceListTool(() => deps({ listResources: () => one }));
    const first = parse((await tool.execute({ serverId: "srv" }, ctx())).output);
    const firstServers = first.servers as Array<{ resources: Array<{ uri: string }> }>;
    expect(first.nextOffset).toBe(firstServers[0].resources.length);

    const second = parse(
      (await tool.execute({ serverId: "srv", offset: first.nextOffset }, ctx())).output,
    );
    const secondServers = second.servers as Array<{ resources: Array<{ uri: string }> }>;
    // The second page starts exactly where the first stopped, and reaches the tail.
    expect(secondServers[0].resources[0].uri)
      .toBe(`file:///f${firstServers[0].resources.length}`);
    const lastUri = secondServers[0].resources[secondServers[0].resources.length - 1].uri;
    expect(lastUri).toBe("file:///f199");
    // Nothing withheld on the last page ⇒ no resume marker.
    expect(second.nextOffset).toBeUndefined();
  });

  // The shape nothing pinned, and it is where a shared cursor goes wrong: `offset`
  // indexes ONE server's resources, while a total `nextOffset` would advance every
  // server by the others' shown counts — silently skipping the head of any server that
  // was omitted from the previous page. Requiring `serverId` makes the cursor mean one
  // thing; a cross-server page is refused rather than answered wrongly.
  it("refuses to page a multi-server response with one cursor", async () => {
    const two = [0, 1].map((s) => ({
      serverId: `srv-${s}`,
      resources: Array.from({ length: 60 }, (_, i) => ({
        uri: `file:///s${s}/f${i}`,
        name: `f${i}`,
        description: "d".repeat(200),
      })),
    }));
    const tool = createMcpResourceListTool(() => deps({ listResources: () => two }));
    const first = parse((await tool.execute({}, ctx())).output);
    // An un-narrowed response never advertises a cursor it cannot honor…
    expect(first.nextOffset).toBeUndefined();
    // …and following one anyway is an error, not a wrong answer.
    const paged = await tool.execute({ offset: 40 }, ctx());
    expect(paged.isError).toBe(true);
    expect(String(parse(paged.output).error)).toContain("serverId");

    // Narrowed, the same catalogue answers without a cursor at all, because dropping
    // the prose is enough to fit it — nothing withheld means nothing to resume.
    const narrowed = parse((await tool.execute({ serverId: "srv-1" }, ctx())).output);
    const shown = (narrowed.servers as Array<{ resources: unknown[] }>)[0].resources.length;
    expect(shown).toBe(60);
    expect(narrowed.nextOffset).toBeUndefined();
    expect(narrowed.descriptionsOmitted).toBe(true);
  });

  it("rejects a malformed offset instead of guessing", async () => {
    const tool = createMcpResourceListTool(() => deps());
    for (const offset of [-1, 1.5, "3", Number.NaN]) {
      const result = await tool.execute({ offset }, ctx());
      expect(result.isError, String(offset)).toBe(true);
    }
  });

  it("tells the model which argument was wrong", async () => {
    // The list tool has no `uri` parameter, so reusing the read tool's message told
    // the model to supply an argument its own schema rejects.
    const tool = createMcpResourceListTool(() => deps());
    const out = parse((await tool.execute({ serverId: 42 }, ctx())).output);
    expect(String(out.error)).toContain("serverId");
    expect(String(out.error)).not.toContain("uri");
  });

  it("declares the MCP scope dependency on both tools", () => {
    // Builtins are otherwise always eager. These two hand the model untrusted
    // server content, so they must honor the same `includeMcp` switch that keeps
    // MCP tools out of headless (routine) loops.
    expect(createMcpResourceListTool(() => deps()).requiresMcpScope).toBe(true);
    expect(createMcpResourceReadTool(() => deps()).requiresMcpScope).toBe(true);
  });
});
