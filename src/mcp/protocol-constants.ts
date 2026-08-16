/**
 * MCP protocol wire constants — the single authority (design §8).
 *
 * The `2026-07-28` revision is now FINAL (current). These values are pinned to
 * the published schema (`schema/2026-07-28/schema.ts`), not the pre-release
 * draft the first alignment slice was built against. Finalization moved the
 * spec-reserved error codes into the `-32020..-32099` partition (the draft used
 * `-32003`/`-32004`, which are implementation-defined range) and replaced
 * resource-not-found `-32002` with `-32602` (Invalid Params); `-32002` is
 * burned and must not be reused.
 *
 * Every module that speaks MCP wire (external client, plugin server, plugin
 * host, server projection) imports from here — the previous per-module copies
 * are exactly how the draft numbering outlived finalization.
 */

/** The stateless protocol revision LVIS speaks by default. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/**
 * Dual-era exception only (design §0): proposed to an EXTERNAL server that does
 * not implement `server/discover`. First-party plugins never negotiate this.
 */
export const MCP_LEGACY_PROTOCOL_VERSION = "2024-11-05";

// ─── Reserved per-request `_meta` keys (`RequestMetaObject`) ───
// (`io.modelcontextprotocol/serverInfo` — the result-`_meta` identity a server
// SHOULD stamp — joins this list when the stamping lands.)
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

// ─── JSON-RPC 2.0 codes ───
export const RPC_INVALID_PARAMS = -32602;
export const RPC_METHOD_NOT_FOUND = -32601;

/**
 * Resource not found rides `-32602` (Invalid Params) since `2026-07-28` —
 * same wire value as {@link RPC_INVALID_PARAMS}, its own name so call sites
 * say what they mean. The pre-final `-32002` is burned.
 */
export const RPC_RESOURCE_NOT_FOUND = -32602;

// ─── MCP-reserved partition (`-32020..-32099`), final numbering ───
// (`-32020` HeaderMismatch joins when the client grows a consumer for it —
// the header-mismatch retry lands with the dual-era fallback rework.)
export const RPC_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export const RPC_UNSUPPORTED_PROTOCOL_VERSION = -32022;
