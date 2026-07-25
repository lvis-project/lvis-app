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
import { t } from "../i18n/index.js";
import { MCP_RESOURCE_URI_MAX_CHARS } from "../shared/mcp-resource-bounds.js";
import type { McpResourceSummary } from "../mcp/types.js";

const log = createLogger("lvis");

/**
 * Bound on ONE list response, counted over the serialized payload rather than a
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
  readResource(serverId: string, uri: string): Promise<{
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
      // Bounded on the axis that is actually unbounded — server count times
      // catalogue size — by dropping whole servers from the tail until the payload
      // fits, and saying how many were dropped.
      let omittedServers = 0;
      while (
        servers.length > 1
        && JSON.stringify({ servers }).length > MCP_RESOURCE_LIST_MAX_CHARS
      ) {
        servers.pop();
        omittedServers += 1;
      }
      return {
        output: JSON.stringify({
          servers,
          ...(omittedServers > 0 ? { omittedServers } : {}),
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
        const read = await access.readResource(serverId, uri);
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
        log.warn(
          `mcp_resource_read failed server=${serverId} uri=${uri}: `
            + `${err instanceof Error ? err.message : String(err)}`,
        );
        return errorResult(t("be_mcpResourceTools.readFailed"));
      }
    },
  });
}
