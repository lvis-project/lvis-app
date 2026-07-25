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
import { t } from "../i18n/index.js";
import {
  MCP_RESOURCE_MAX_PER_SERVER,
  MCP_RESOURCE_URI_MAX_CHARS,
} from "../shared/mcp-resource-bounds.js";
import type { McpResourceSummary } from "../mcp/types.js";

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

export function createMcpResourceListTool(deps: McpResourceToolDeps): Tool {
  return createDynamicTool({
    name: "mcp_resource_list",
    description: t("be_mcpResourceTools.listDescription"),
    source: "builtin",
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
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const wanted = typeof a.serverId === "string" ? a.serverId : undefined;
      const servers = deps
        .listResources()
        .filter((entry) => (wanted ? entry.serverId === wanted : true))
        .map((entry) => ({
          serverId: entry.serverId,
          // Already validated and bounded at the client boundary; the cap is
          // re-applied here so a future discovery change cannot widen what the
          // model sees in one turn.
          resources: entry.resources.slice(0, MCP_RESOURCE_MAX_PER_SERVER).map((resource) => ({
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
      return { output: JSON.stringify({ servers }), isError: false };
    },
  });
}

export function createMcpResourceReadTool(deps: McpResourceToolDeps): Tool {
  return createDynamicTool({
    name: "mcp_resource_read",
    description: t("be_mcpResourceTools.readDescription"),
    source: "builtin",
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
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const serverId = typeof a.serverId === "string" ? a.serverId.trim() : "";
      const uri = typeof a.uri === "string" ? a.uri.trim() : "";
      if (serverId.length === 0 || uri.length === 0 || uri.length > MCP_RESOURCE_URI_MAX_CHARS) {
        return errorResult(t("be_mcpResourceTools.invalidRequest"));
      }
      try {
        const read = await deps.readResource(serverId, uri);
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
        // The server's own message can carry host paths, so it is logged by the
        // client and not forwarded here. The model gets a stable reason instead,
        // which is also what keeps a failed read from becoming a probe channel.
        void err;
        return errorResult(t("be_mcpResourceTools.readFailed"));
      }
    },
  });
}
