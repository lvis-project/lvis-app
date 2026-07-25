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
 * Bound on ONE list response, counted over the serialized payload across BOTH axes
 * per-server count. The per-server cap is already spent at discovery, so counting
 * again there would be an unreachable branch; what is genuinely unbounded here is
 * server_count x catalogue_size, and this is the axis that reaches the model's
 * context window. A clip is REPORTED, never silent.
 */
const MCP_RESOURCE_LIST_MAX_CHARS = 24 * 1024;

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
    // headless loops (routines) run with MCP withheld on purpose.
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
      // Spend the budget across BOTH axes, because either alone is unbounded:
      // discovery caps resources per server at 200 but never their bytes, so one
      // approved server can be ~600 KB, and a narrowed call always yields exactly one
      // server — a whole-servers-only bound would never fire for it. Resources are
      // trimmed from the tail of the last server that fits, and BOTH kinds of
      // omission are reported: a silent clip reads as "that is all there is".
      //
      // Each server's serialized length is measured once. Re-serializing the whole
      // payload per iteration is O(n^2) string work in the main process.
      const budget = MCP_RESOURCE_LIST_MAX_CHARS;
      const kept: typeof servers = [];
      let used = 0;
      let omittedServers = 0;
      let omittedResources = 0;
      for (const server of servers) {
        const whole = JSON.stringify(server).length;
        if (used + whole <= budget) {
          kept.push(server);
          used += whole;
          continue;
        }
        // Does not fit whole. Take as many of its resources as the remaining budget
        // allows, so a single over-large server still returns something usable
        // instead of nothing.
        const partial = { serverId: server.serverId, resources: [] as typeof server.resources };
        let partialLen = JSON.stringify(partial).length;
        for (const resource of server.resources) {
          const entryLen = JSON.stringify(resource).length + 1;
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
          omittedServers += 1;
        }
      }
      omittedServers += servers.length - kept.length - omittedServers;
      return {
        output: JSON.stringify({
          servers: kept,
          ...(omittedServers > 0 ? { omittedServers } : {}),
          ...(omittedResources > 0 ? { omittedResources } : {}),
        }),
        isError: false,
      };
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
