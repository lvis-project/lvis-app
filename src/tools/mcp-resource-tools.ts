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
import { scrubShortError } from "../shared/dlp.js";
import { t } from "../i18n/index.js";
import { MCP_RESOURCE_URI_MAX_CHARS } from "../shared/mcp-resource-bounds.js";
import { MAX_TOOL_RESULT_TOKENS } from "../shared/tool-result-trim.js";
import { estimateTokens } from "../shared/token-estimate.js";
import type { McpResourceSummary } from "../mcp/types.js";

const log = createLogger("lvis");

/**
 * The same 4-chars-per-token reading `estimateTokens` uses. Explicit here so the
 * derivation below is a calculation rather than a coincidence.
 */
const APPROX_CHARS_PER_TOKEN = 4;

/**
 * How many dropped servers are named before the rest become a count. Server ids are
 * bounded to 128 chars, so naming without a cap is ~131 chars each — enough to
 * overflow the whole budget on its own at a few dozen servers, which is the one
 * place the bound was still an assumption.
 */
const MAX_NAMED_OMITTED_SERVERS = 20;

/**
 * Bound on ONE list response, over the serialized payload.
 *
 * DERIVED from the host's own tool-result wire cap rather than hand-copied, so the
 * two cannot drift: a result over `MAX_TOOL_RESULT_TOKENS` is stubbed before the
 * provider send and the model has to page it back with `read_tool_result_chunk`, so
 * a list the model cannot read inline costs two round trips just to learn what
 * exists. A budget above the wire cap would be a bound that satisfies itself and
 * nobody else.
 *
 * This is the CHAR budget, used as a fast pre-filter while tiering. The wire cap is
 * counted in TOKENS, and dense JSON runs close enough to 4 chars/token that a
 * char-only bound landed ~4% over the real ceiling — a list that filled the budget
 * was still stubbed, which is the outcome the sizing exists to avoid. The final
 * postcondition is therefore asserted with `estimateTokens`, in the unit the host
 * actually gates on; a 10% headroom keeps the two from disagreeing on the edge.
 *
 * Deliberately SMALLER than the 32 KB per-read bound, and the asymmetry is the
 * point: a resource read IS the payload the user asked for, while a list is
 * navigation — it only has to be big enough to choose from.
 *
 * Spent across BOTH axes, because either alone is unbounded: discovery caps
 * resources per server at 200 but never their bytes, and a `serverId`-narrowed
 * call always yields exactly one server. Every clip is REPORTED — a silent one
 * reads as "that is all there is".
 */
export const MCP_RESOURCE_LIST_MAX_CHARS = Math.floor(
  MAX_TOOL_RESULT_TOKENS * APPROX_CHARS_PER_TOKEN * 0.9,
);

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
        offset: {
          type: "number",
          description: t("be_mcpResourceTools.offsetDescription"),
        },
      },
    },
    execute: async (rawInput) => {
      const access = getAccess();
      if (!access) return errorResult(t("be_mcpResourceTools.notReady"));
      const a = (rawInput ?? {}) as Record<string, unknown>;
      // A serverId that is PRESENT but unusable is a request error, not a request
      // for everything: silently widening the scope of a narrowed call is how a
      // model ends up reading a catalogue it did not ask for. Its own message, not
      // the read tool's — that one names a `uri` parameter this tool does not have.
      if (a.serverId !== undefined && typeof a.serverId !== "string") {
        return errorResult(t("be_mcpResourceTools.invalidServerId"));
      }
      // Trimming at the source means the tail is not on the wire at all, so unlike a
      // stubbed result it cannot be paged back with `read_tool_result_chunk`. Without
      // an offset that made the head a permanent ceiling on what the model could ever
      // see — 3 of 200 resources for a verbose server, in every turn.
      const offsetRaw = a.offset;
      if (
        offsetRaw !== undefined
        && (typeof offsetRaw !== "number"
          || !Number.isSafeInteger(offsetRaw)
          || offsetRaw < 0)
      ) {
        return errorResult(t("be_mcpResourceTools.invalidOffset"));
      }
      const offset = typeof offsetRaw === "number" ? offsetRaw : 0;
      const wanted = typeof a.serverId === "string" ? a.serverId : undefined;
      // Paging is only well-defined for a NARROWED call. The index applies per server,
      // so a single cursor across several of them advances every server by the others'
      // shown counts and makes the entries in between unreachable by any offset a
      // caller would try. Requiring `serverId` keeps `nextOffset` meaning exactly one
      // thing instead of silently skipping the middle of a catalogue.
      if (offset > 0 && wanted === undefined) {
        return errorResult(t("be_mcpResourceTools.offsetNeedsServerId"));
      }
      const servers = access
        .listResources()
        .filter((entry) => (wanted ? entry.serverId === wanted : true))
        .map((entry) => ({
          serverId: entry.serverId,
          resources: entry.resources.slice(offset).map((resource) => ({
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
      let unnamedOmittedServers = 0;
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
          // cannot narrow to a server it was never told about. The list is itself
          // CHARGED against the budget and capped — otherwise, once `used` reaches the
          // budget every remaining server takes this branch, and a payload of nothing
          // but ids could leave over budget with no tier left to trim.
          if (omittedServerIds.length < MAX_NAMED_OMITTED_SERVERS) {
            omittedServerIds.push(server.serverId);
            used += server.serverId.length + 3;
          } else {
            unnamedOmittedServers += 1;
          }
        }
      }
      // Final guarantee, on the REAL payload. The per-server accounting above sums
      // server objects; the envelope adds its own keys, the commas between them, and
      // the omission lists — which grow as servers are dropped. Asserting the
      // postcondition ("the output is within budget") here rather than inferring it
      // from the parts is what makes the bound a bound; a test measuring the output
      // caught this being 8,564 against an 8,192 budget.
      // Where to resume, for the narrowed call that is the only shape paging is defined
      // for. Emitted whenever something was withheld, so the model does not have to
      // infer that a next page exists from a count.
      const nextOffset = () => {
        if (wanted === undefined) return undefined;
        const shown = kept.reduce((sum, server) => sum + server.resources.length, 0);
        return offset + shown;
      };
      const payload = () => ({
        servers: kept,
        ...(omittedServerIds.length > 0 ? { omittedServerIds } : {}),
        ...(unnamedOmittedServers > 0 ? { unnamedOmittedServers } : {}),
        ...(omittedResources > 0 ? { omittedResources } : {}),
        ...(descriptionsOmitted ? { descriptionsOmitted: true } : {}),
        ...((omittedResources > 0 || unnamedOmittedServers > 0 || omittedServerIds.length > 0)
          && nextOffset() !== undefined
          ? { nextOffset: nextOffset() }
          : {}),
      });
      // Holds UNCONDITIONALLY, in BOTH units: the char budget is the fast filter and
      // the token count is what the host actually gates on. Terminates because each
      // step removes a kept server while the id list it feeds is capped, and it also
      // breaks if a step ever fails to shrink the payload — a pop that adds more id
      // than it removes body would otherwise grind `kept` to empty and still return
      // over budget, which is how the previous version's "the empty case is small"
      // reasoning failed.
      const overBudget = (): boolean => {
        const text = JSON.stringify(payload());
        return text.length > budget || estimateTokens(text) > MAX_TOOL_RESULT_TOKENS;
      };
      while (kept.length > 0 && overBudget()) {
        const before = serialize(payload());
        const last = kept[kept.length - 1];
        // Trim the tail RESOURCE first and drop the server only when it has none left:
        // popping a whole server for a marginal overshoot returned an empty catalogue
        // for the ordinary "one server, slightly too big" shape, which is the shape this
        // whole bound exists to serve.
        if (last.resources.length > 1) {
          last.resources = last.resources.slice(0, -1);
          omittedResources += 1;
        } else {
          kept.pop();
          omittedResources += last.resources.length;
          if (omittedServerIds.length < MAX_NAMED_OMITTED_SERVERS) {
            omittedServerIds.push(last.serverId);
          } else {
            unnamedOmittedServers += 1;
          }
        }
        if (serialize(payload()) >= before) break;
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
            + scrubShortError(err instanceof Error ? err.message : String(err)),
        );
        return errorResult(t("be_mcpResourceTools.readFailed"));
      }
    },
  });
}
