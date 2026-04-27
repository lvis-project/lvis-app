/**
 * Shared parser for the `runtime` block on MCP plugin entries.
 *
 * Both the catalog row reader (`real-cloud-marketplace-fetcher.ts`) and
 * the install-time manifest reader (`mcp-marketplace-install.ts`) need
 * to validate the same discriminated union shape. Loop #5 code-review
 * MEDIUM flagged the duplicated parsers as drift risk: if the two
 * copies diverge, the renderer's pre-install preview could classify a
 * runtime block differently from the install path's actual behavior.
 *
 * This is the single source of truth.
 */

import type { McpRuntimeSpec } from "./types.js";

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
  const validAuth =
    auth === "none" || auth === "api-key" || auth === "sso" ? auth : undefined;

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
    if (validAuth) out.auth = validAuth;
    return out;
  }
  if (r.transport === "http") {
    if (typeof r.url !== "string" || r.url.trim().length === 0) return undefined;
    const out: McpRuntimeSpec = { transport: "http", url: r.url };
    if (validAuth) out.auth = validAuth;
    if (typeof r.allowPrivateNetworks === "boolean") {
      out.allowPrivateNetworks = r.allowPrivateNetworks;
    }
    return out;
  }
  return undefined;
}
