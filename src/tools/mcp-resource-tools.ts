/**
 * `mcp_resource_list` / `mcp_resource_read` — the MODEL's path to server resources.
 *
 * The user's path (a composer mention that attaches a resource to the turn) is a
 * separate surface; see `docs/development/mcp-resources-policy.md` §6. Both exist
 * because they answer different questions: the mention is how a person says
 * "consider this", these tools are how the model follows a reference it found
 * mid-task — a schema URI in an error message, a doc URI in an issue body.
 * Reference hosts expose both, and either one alone leaves a real gap.
 *
 * Trust model. Resource content is UNTRUSTED, server-authored data. It arrives as
 * a `tool_result` — the same channel as any file read — so it is data the model
 * reads, never instruction the host obeyed, and it never enters the trusted
 * system-prompt overlay. What these tools do NOT do is change the turn's
 * provenance: a resource is attached data, not a staged origin (policy §2), so the
 * permission decision for later tool calls still belongs to whoever authored the
 * turn.
 *
 * NAMING HAZARD, recorded deliberately: MCP tools are namespaced
 * `mcp_<prefix>_<tool>`, so a server approved with `toolNamePrefix: "resource"`
 * publishing a tool named `list` would namespace to `mcp_resource_list` and collide
 * with the builtin — the registry refuses the name and rolls back that server's
 * whole tool set. The names are kept because they are the ones a model guesses,
 * and the collision needs both halves to line up exactly; the durable fix is a
 * reserved-name check in the registry, which is its own change.
 *
 * Every gate lives one layer down, in the client, and that is deliberate: the
 * capability check (advertised AND approved), the listed-URI requirement that stops
 * `resources/read` becoming a general fetch primitive, the refusal to fetch
 * `https:` on the server's behalf, and the size bounds are all enforced there, so
 * the model path and the user path cannot drift apart in what they allow.
 */
import { createDynamicTool, type Tool } from "./base.js";
import { createLogger } from "../lib/logger.js";
import { scrubSecrets } from "../mcp/mcp-client.js";
import { t } from "../i18n/index.js";
import { MCP_RESOURCE_URI_MAX_CHARS } from "../shared/mcp-resource-bounds.js";
import type { McpResourceSummary } from "../mcp/types.js";

const log = createLogger("lvis");

/**
 * Bound on ONE list response, over the serialized payload.
 *
 * Sized to the host's own tool-result wire cap (`MAX_TOOL_RESULT_TOKENS` ≈ 2,000
 * tokens ≈ 8 KB — see `shared/tool-result-trim.ts`), not to something larger: a
 * result over that cap is stubbed before the provider send and the model has to
 * page it back with `read_tool_result_chunk`. A list the model cannot read inline
 * is a list that costs two round trips to learn what exists, so a budget above the
 * wire cap would be a bound that satisfies itself and nobody else.
 *
 * Spent across BOTH axes, because either alone is unbounded: discovery caps
 * resources per server at 200 but never their bytes, and a `serverId`-narrowed
 * call always yields exactly one server. Every clip is REPORTED — a silent one
 * reads as "that is all there is".
 */
export const MCP_RESOURCE_LIST_MAX_CHARS = 8 * 1024;

/**
 * The slice of the MCP manager these tools need. Narrow on purpose: a tool that
 * takes the whole manager can reach `callTool`, and this surface must not.
 */
export interface McpResourceToolDeps {
  listResources(): Array<{ serverId: string; resources: readonly McpResourceSummary[] }>;
  /**
   * Named for the CORE-capability read (`readDeclaredResource`), never the
   * MCP-Apps `ui://` read that shares the JSON-RPC method but skips the
   * listed-URI gate and is exempt from the `resources` capability. The client
   * keeps those two apart by name; this surface must not put them back.
   */
  readDeclaredResource(serverId: string, uri: string): Promise<{
    blocks: Array<{ uri?: string; mimeType?: string; text?: string; omittedKind?: string }>;
    droppedBlocks: number;
    truncated: boolean;
  }>;
}

function errorResult(message: string): { output: string; isError: true } {
  return { output: JSON.stringify({ error: message }), isError: true };
}

/**
 * Resource access is resolved per call, not captured: the MCP manager is built in
 * a later boot step than the builtin tools, so a captured value would be the
 * `undefined` from registration time forever. Resolving here also gives the
 * not-ready case its own visible outcome instead of a generic failure.
 */
export type McpResourceAccessResolver = () => McpResourceToolDeps | undefined;

export function createMcpResourceListTool(getAccess: McpResourceAccessResolver): Tool {
  return createDynamicTool({
    name: "mcp_resource_list",
    description: t("be_mcpResourceTools.listDescription"),
    source: "builtin",
    // Surfaces MCP-server data, so the turn scope's `includeMcp` switch applies:
    // headless loops (routines) run with MCP withheld on purpose. Like that switch,
    // this is an EXPOSURE control — the tool is not listed to the model — not an
    // execution gate; a name that reaches the executor anyway is gated by
    // permissions, exactly as for `source: "mcp"` tools.
    requiresMcpScope: true,
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        serverId: {
          type: "string",
          description: t("be_mcpResourceTools.serverIdDescription"),
        },
      },
    },
    execute: async (rawInput) => {
      const access = getAccess();
      if (!access) return errorResult(t("be_mcpResourceTools.notReady"));
      const a = (rawInput ?? {}) as Record<string, unknown>;
      // A serverId that is PRESENT but unusable is a request error, not a request
      // for everything: silently widening the scope of a narrowed call is how a
      // model ends up reading a catalogue it did not ask for.
      if (a.serverId !== undefined && typeof a.serverId !== "string") {
        return errorResult(t("be_mcpResourceTools.invalidRequest"));
      }
      const wanted = typeof a.serverId === "string" ? a.serverId : undefined;
      const servers = access
        .listResources()
        .filter((entry) => (wanted ? entry.serverId === wanted : true))
        .map((entry) => ({
          serverId: entry.serverId,
          resources: entry.resources.map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            ...(resource.title ? { title: resource.title } : {}),
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
            ...(resource.size !== undefined ? { size: resource.size } : {}),
            // Surfaced rather than hidden: a resource the host will not fetch is
            // still worth knowing about, and saying so stops the model retrying.
            ...(resource.hostFetchRefused ? { hostFetchRefused: true } : {}),
          })),
        }));
      // Three tiers, cheapest loss first. Dropping a description keeps the resource
      // discoverable (uri + name is what a read needs); dropping the resource does
      // not; dropping the server hides even its id. Each server is measured once —
      // re-serializing the whole payload per iteration is O(n^2) in the main process.
      const budget = MCP_RESOURCE_LIST_MAX_CHARS;
      const serialize = (value: unknown): number => JSON.stringify(value).length;
      let descriptionsOmitted = false;
      if (serialize({ servers }) > budget) {
        descriptionsOmitted = servers.some((server) =>
          server.resources.some((resource) => "description" in resource));
        for (const server of servers) {
          server.resources = server.resources.map((resource) => {
            const { description: _dropped, ...rest } = resource as typeof resource
              & { description?: string };
            return rest as typeof resource;
          });
        }
      }
      const kept: typeof servers = [];
      const omittedServerIds: string[] = [];
      let omittedResources = 0;
      let used = 0;
      for (const server of servers) {
        const whole = serialize(server);
        if (used + whole <= budget) {
          kept.push(server);
          used += whole;
          continue;
        }
        // Does not fit whole: take as many of its resources as the remaining budget
        // allows, so an over-large server still returns something usable.
        const partial = { serverId: server.serverId, resources: [] as typeof server.resources };
        let partialLen = serialize(partial);
        for (const resource of server.resources) {
          const entryLen = serialize(resource) + 1;
          if (used + partialLen + entryLen > budget) {
            omittedResources += 1;
            continue;
          }
          partial.resources.push(resource);
          partialLen += entryLen;
        }
        if (partial.resources.length > 0) {
          kept.push(partial);
          used += partialLen;
        } else {
          // Named, not counted: `serverId` is the model's only narrowing lever, and it
          // cannot narrow to a server it was never told about.
          omittedServerIds.push(server.serverId);
        }
      }
      // Final guarantee, on the REAL payload. The per-server accounting above sums
      // server objects; the envelope adds its own keys, the commas between them, and
      // the omission lists — which grow as servers are dropped. Asserting the
      // postcondition ("the output is within budget") here rather than inferring it
      // from the parts is what makes the bound a bound; a test measuring the output
      // caught this being 8,564 against an 8,192 budget.
      const payload = () => ({
        servers: kept,
        ...(omittedServerIds.length > 0 ? { omittedServerIds } : {}),
        ...(omittedResources > 0 ? { omittedResources } : {}),
        ...(descriptionsOmitted ? { descriptionsOmitted: true } : {}),
      });
      // Terminates: each step removes one kept server, and the empty case is small.
      while (kept.length > 0 && serialize(payload()) > budget) {
        const dropped = kept.pop()!;
        omittedResources += dropped.resources.length;
        omittedServerIds.push(dropped.serverId);
      }
      return { output: JSON.stringify(payload()), isError: false };
    },
  });
}

export function createMcpResourceReadTool(getAccess: McpResourceAccessResolver): Tool {
  return createDynamicTool({
    name: "mcp_resource_read",
    description: t("be_mcpResourceTools.readDescription"),
    source: "builtin",
    // Surfaces MCP-server data, so the turn scope's `includeMcp` switch applies:
    // headless loops (routines) run with MCP withheld on purpose.
    requiresMcpScope: true,
    // Pure read: no filesystem mutation, no system-prompt mutation. The content
    // lands in a tool_result, so it needs no approval modal of its own — the gates
    // that matter (capability approved, URI previously listed) are structural.
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["serverId", "uri"],
      properties: {
        serverId: {
          type: "string",
          description: t("be_mcpResourceTools.serverIdDescription"),
        },
        uri: {
          type: "string",
          description: t("be_mcpResourceTools.uriDescription"),
        },
      },
    },
    execute: async (rawInput) => {
      const access = getAccess();
      if (!access) return errorResult(t("be_mcpResourceTools.notReady"));
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const serverId = typeof a.serverId === "string" ? a.serverId.trim() : "";
      const uri = typeof a.uri === "string" ? a.uri.trim() : "";
      if (serverId.length === 0 || uri.length === 0 || uri.length > MCP_RESOURCE_URI_MAX_CHARS) {
        return errorResult(t("be_mcpResourceTools.invalidRequest"));
      }
      try {
        const read = await access.readDeclaredResource(serverId, uri);
        return {
          output: JSON.stringify({
            uri,
            serverId,
            blocks: read.blocks,
            ...(read.truncated ? { truncated: true } : {}),
            ...(read.droppedBlocks > 0 ? { droppedBlocks: read.droppedBlocks } : {}),
          }),
          isError: false,
        };
      } catch (err) {
        // The model gets a stable reason — a server message can carry host paths,
        // and a detailed failure turns a refused read into a probe channel. The
        // operator still needs the real cause, so it is logged HERE: nothing on the
        // client read path logs, so discarding it left the failure observable to
        // no one.
        // The reason is SCRUBBED and BOUNDED before it reaches the log. Both inputs
        // are attacker-influenced: a server's JSON-RPC error message is unbounded and
        // may echo a credential it was handed, and `serverId` comes from the model.
        // Unbounded here would let a hostile server flush the log ring and destroy
        // the forensic record this line exists to create, and persist cleartext
        // secrets to disk (field redaction does not touch free text in a message).
        // `scrubSecrets` is the host's existing short-error SoT.
        log.warn(
          `mcp_resource_read failed server=${serverId.slice(0, 64)} `
            + `uri=${uri.slice(0, 256)}: `
            + scrubSecrets(err instanceof Error ? err.message : String(err)),
        );
        return errorResult(t("be_mcpResourceTools.readFailed"));
      }
    },
  });
}
