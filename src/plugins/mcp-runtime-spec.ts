/**
 * Shared parser for the `runtime` block on MCP plugin entries.
 *
 * Both the catalog row reader (`cloud-marketplace-fetcher.ts`) and
 * the install-time manifest reader (`mcp-marketplace-install.ts`) need
 * to validate the same discriminated union shape. Loop #5 code-review
 * MEDIUM flagged the duplicated parsers as drift risk: if the two
 * copies diverge, the renderer's pre-install preview could classify a
 * runtime block differently from the install path's actual behavior.
 *
 * This is the single source of truth.
 */

import type { McpOAuthMetadata, McpRuntimeSpec } from "./types.js";
import {
  ENV_NAME_RE,
  HTTP_HEADER_NAME_RE,
  MAX_NAME_LEN,
  RESERVED_ENV_NAMES,
  RESERVED_HEADERS,
} from "../mcp/safe-names.js";

const CLIENT_REGISTRATION_MODES = new Set([
  "client-id-metadata-document",
  "dynamic",
  "preregistration",
  "manual",
]);

/**
 * Parse a `runtime` block (advisory catalog row OR authoritative
 * extracted manifest) into the {@link McpRuntimeSpec} discriminated
 * union. Returns undefined when the discriminator or required field
 * is missing — the caller decides whether that's a hard failure
 * (install path) or a soft fallback (catalog preview).
 */
export function parseMcpRuntimeSpec(value: unknown): McpRuntimeSpec | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const auth = r.auth;
  const validStdioAuth =
    auth === "none" || auth === "api-key" || auth === "sso" ? auth : undefined;
  const validHttpAuth =
    auth === "none" || auth === "api-key" || auth === "sso" || auth === "oauth"
      ? auth
      : undefined;

  if (r.transport === "stdio") {
    if (typeof r.command !== "string" || r.command.trim().length === 0) return undefined;
    const args = Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const env =
      r.env && typeof r.env === "object" && !Array.isArray(r.env)
        ? Object.fromEntries(
            Object.entries(r.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
    const out: McpRuntimeSpec = { transport: "stdio", command: r.command };
    if (args && args.length > 0) out.args = args;
    if (env && Object.keys(env).length > 0) out.env = env;
    if (validStdioAuth) out.auth = validStdioAuth;
    if (typeof r.apiKeyEnv === "string") {
      const v = r.apiKeyEnv.trim();
      if (
        v.length > 0 &&
        v.length <= MAX_NAME_LEN &&
        ENV_NAME_RE.test(v) &&
        !RESERVED_ENV_NAMES.has(v.toUpperCase())
      ) {
        out.apiKeyEnv = v;
      }
    }
    return out;
  }
  if (r.transport === "http") {
    if (typeof r.url !== "string" || r.url.trim().length === 0) return undefined;
    const out: McpRuntimeSpec = { transport: "http", url: r.url };
    if (validHttpAuth) out.auth = validHttpAuth;
    if (typeof r.apiKeyHeader === "string") {
      const v = r.apiKeyHeader.trim();
      if (
        v.length > 0 &&
        v.length <= MAX_NAME_LEN &&
        HTTP_HEADER_NAME_RE.test(v) &&
        !RESERVED_HEADERS.has(v.toLowerCase())
      ) {
        out.apiKeyHeader = v;
      }
    }
    if (typeof r.allowPrivateNetworks === "boolean") {
      out.allowPrivateNetworks = r.allowPrivateNetworks;
    }
    const oauth = parseMcpOAuthMetadata(r.oauth);
    if (oauth) out.oauth = oauth;
    return out;
  }
  return undefined;
}

export function parseMcpOAuthMetadata(value: unknown): McpOAuthMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: McpOAuthMetadata = {};
  if (typeof raw.resource === "string" && raw.resource.trim()) {
    out.resource = raw.resource.trim();
  }
  if (typeof raw.resourceMetadataUrl === "string" && raw.resourceMetadataUrl.trim()) {
    out.resourceMetadataUrl = raw.resourceMetadataUrl.trim();
  }
  if (Array.isArray(raw.authorizationServers)) {
    const authorizationServers = raw.authorizationServers.filter(
      (server): server is string => typeof server === "string" && server.trim().length > 0,
    ).map((server) => server.trim());
    if (authorizationServers.length > 0) out.authorizationServers = authorizationServers;
  }
  if (Array.isArray(raw.scopes)) {
    const scopes = raw.scopes.filter(
      (scope): scope is string => typeof scope === "string" && scope.trim().length > 0,
    ).map((scope) => scope.trim());
    if (scopes.length > 0) out.scopes = scopes;
  }
  if (typeof raw.clientRegistration === "string" && CLIENT_REGISTRATION_MODES.has(raw.clientRegistration)) {
    out.clientRegistration = raw.clientRegistration as McpOAuthMetadata["clientRegistration"];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
