/**
 * Streamable HTTP request-metadata headers (final `2026-07-28` spec).
 *
 * The transport mirrors selected JSON-RPC body fields into HTTP headers so
 * intermediaries can route without parsing the body. A conformant server
 * REJECTS a POST whose required headers are missing or do not match the body
 * (`-32020` HeaderMismatch), so these are not optional decoration:
 *
 *  - `MCP-Protocol-Version` — MUST equal the body's
 *    `_meta["io.modelcontextprotocol/protocolVersion"]`. Derived FROM the body
 *    here so the two can never disagree. Legacy-era requests carry no `_meta`
 *    protocol version and therefore no header (the header postdates the legacy
 *    era we fall back to).
 *  - `Mcp-Method` — the JSON-RPC `method`, on every request.
 *  - `Mcp-Name` — `params.name` (`tools/call`, `prompts/get`) or `params.uri`
 *    (`resources/read`), Base64-sentinel-encoded when not header-safe.
 *  - `Mcp-Param-{Name}` — tool parameters the SERVER designated via the
 *    `x-mcp-header` schema extension. Clients on this transport MUST mirror
 *    them and MUST reject tool definitions whose annotations violate the
 *    constraints (excluding just that tool from `tools/list`).
 *
 * Header names here are lowercase: HTTP field names are case-insensitive and
 * the transport's header map is lowercase-normalized to prevent case-collision
 * duplicates.
 */
import { META_PROTOCOL_VERSION } from "./protocol-constants.js";

/** RFC 9110 `token` / `1*tchar` — the only shape a header name may take. */
const TCHAR_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Methods whose `Mcp-Name` source field is defined by the spec. */
const NAME_SOURCE: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";

/**
 * Encode one header value per the spec's Value Encoding rules: pass plain
 * ASCII through; Base64-sentinel everything that is not safely representable
 * (non-ASCII, control chars, leading/trailing whitespace) — and any plain
 * value that itself matches the sentinel pattern, to avoid ambiguity.
 */
export function encodeMcpHeaderValue(value: string): string {
  const headerSafe =
    /^[\x21-\x7e]([\x20\x21-\x7e\x09]*[\x21-\x7e])?$/.test(value) && !/[\r\n]/.test(value);
  const sentinelShaped = value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX);
  if (headerSafe && !sentinelShaped) return value;
  return `${SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${SENTINEL_SUFFIX}`;
}

/**
 * Derive the standard request-metadata headers from one outbound JSON-RPC
 * message. Pure body → header projection; returns an empty object for messages
 * with no `method` (never sent by this client).
 */
export function deriveStandardHeaders(message: object): Record<string, string> {
  const headers: Record<string, string> = {};
  const method = (message as { method?: unknown }).method;
  if (typeof method !== "string" || method.length === 0) return headers;
  headers["mcp-method"] = method;

  const rawParams = (message as { params?: unknown }).params;
  const params =
    rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : undefined;

  const meta = params?._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const version = (meta as Record<string, unknown>)[META_PROTOCOL_VERSION];
    if (typeof version === "string" && version.length > 0) {
      headers["mcp-protocol-version"] = version;
    }
  }

  const nameField = NAME_SOURCE[method];
  if (nameField !== undefined) {
    const raw = params?.[nameField];
    if (typeof raw === "string" && raw.length > 0) {
      headers["mcp-name"] = encodeMcpHeaderValue(raw);
    }
  }
  return headers;
}

interface SchemaNode {
  [key: string]: unknown;
}

/**
 * One validated `x-mcp-header` annotation: the designated header-name part and
 * the exact `properties`-chain path of the annotated parameter.
 */
export interface McpParamHeaderAnnotation {
  headerName: string;
  path: string[];
}

/** Keywords whose subtrees may not carry a reachable `x-mcp-header`. */
const NON_CHAIN_KEYWORDS = [
  "items",
  "prefixItems",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
] as const;

/**
 * Validate a tool `inputSchema`'s `x-mcp-header` annotations and collect the
 * valid ones. Returns the annotations on success, or a rejection reason —
 * per spec a Streamable-HTTP client MUST exclude a tool whose annotations
 * violate ANY constraint (empty/malformed name, duplicate, non-primitive or
 * `number` type, or an annotation not statically reachable via a chain of
 * `properties` keys).
 */
export function collectParamHeaderAnnotations(
  inputSchema: SchemaNode,
): { annotations: McpParamHeaderAnnotation[]; reason?: undefined } | { annotations?: undefined; reason: string } {
  const annotations: McpParamHeaderAnnotation[] = [];
  const seen = new Set<string>();

  const walkChain = (node: SchemaNode, path: string[]): string | null => {
    const annotation = node["x-mcp-header"];
    if (annotation !== undefined) {
      if (typeof annotation !== "string" || annotation.length === 0 || !TCHAR_RE.test(annotation)) {
        return `invalid x-mcp-header name at ${path.join(".") || "(root)"}`;
      }
      if (path.length === 0) {
        return "x-mcp-header on the schema root is not a parameter annotation";
      }
      const type = node.type;
      if (type !== "string" && type !== "integer" && type !== "boolean") {
        return `x-mcp-header '${annotation}' on non-primitive/number type '${String(type)}'`;
      }
      const key = annotation.toLowerCase();
      if (seen.has(key)) {
        return `duplicate x-mcp-header name '${annotation}' (case-insensitive)`;
      }
      seen.add(key);
      annotations.push({ headerName: annotation, path: [...path] });
    }
    const properties = node.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [prop, child] of Object.entries(properties as Record<string, unknown>)) {
        if (child && typeof child === "object" && !Array.isArray(child)) {
          const err = walkChain(child as SchemaNode, [...path, prop]);
          if (err) return err;
        }
      }
    }
    return null;
  };

  // Any `x-mcp-header` OUTSIDE a properties-only chain (inside array,
  // composition, conditional, or $ref-style subtrees) invalidates the tool.
  const scanOffChain = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(scanOffChain);
    const node = value as SchemaNode;
    for (const keyword of NON_CHAIN_KEYWORDS) {
      if (keyword in node && hasAnnotationAnywhere(node[keyword])) return true;
    }
    const properties = node.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      return Object.values(properties as Record<string, unknown>).some(scanOffChain);
    }
    return false;
  };
  const hasAnnotationAnywhere = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(hasAnnotationAnywhere);
    const node = value as SchemaNode;
    if ("x-mcp-header" in node) return true;
    return Object.values(node).some(hasAnnotationAnywhere);
  };

  if (scanOffChain(inputSchema)) {
    return { reason: "x-mcp-header annotation outside a properties-only chain" };
  }
  const err = walkChain(inputSchema, []);
  if (err) return { reason: err };
  return { annotations };
}

/** JavaScript safe-integer bound the spec imposes on mirrored integer values. */
const MAX_SAFE = 9_007_199_254_740_991;

/**
 * Extract `Mcp-Param-{Name}` headers from one call's arguments, per the
 * previously validated annotations. Missing and `null` values omit the header
 * (the server MUST NOT expect it then). Values are type-converted and
 * sentinel-encoded.
 */
export function extractParamHeaders(
  annotations: readonly McpParamHeaderAnnotation[],
  args: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { headerName, path } of annotations) {
    let cursor: unknown = args;
    for (const key of path) {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (cursor === undefined || cursor === null) continue;
    let text: string;
    if (typeof cursor === "string") {
      text = cursor;
    } else if (typeof cursor === "boolean") {
      text = cursor ? "true" : "false";
    } else if (typeof cursor === "number" && Number.isInteger(cursor) && Math.abs(cursor) <= MAX_SAFE) {
      text = String(cursor);
    } else {
      // Not a mirrorable value (float, object, unsafe integer) — omit rather
      // than guess; the schema said integer/string/boolean, so a mismatched
      // runtime value is the caller's schema violation, not a header concern.
      continue;
    }
    headers[`mcp-param-${headerName.toLowerCase()}`] = encodeMcpHeaderValue(text);
  }
  return headers;
}
