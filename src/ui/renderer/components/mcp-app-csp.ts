import type { McpUiCspPolicy } from "../../../mcp/types.js";

// MCP App renderer keeps a host-built CSP. `_meta.ui.csp` may add only
// sanitized resource directives; fixed boundary directives stay locked down.

const DEFAULT_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["default-src", ["'none'"]],
  ["script-src", ["'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com"]],
  ["style-src", ["'unsafe-inline'", "data:", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"]],
  ["img-src", ["data:", "blob:", "https:"]],
  ["font-src", ["data:", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "https://unpkg.com"]],
  ["connect-src", ["'none'"]],
  ["media-src", ["'none'"]],
  ["frame-src", ["'none'"]],
  ["worker-src", ["'none'"]],
  ["base-uri", ["'none'"]],
  ["form-action", ["'none'"]],
  ["frame-ancestors", ["'none'"]],
];

const CSP_METADATA_DIRECTIVES: ReadonlyArray<readonly [string, keyof McpUiCspPolicy, string]> = [
  ["script-src", "scriptSrc", "script-src"],
  ["style-src", "styleSrc", "style-src"],
  ["img-src", "imgSrc", "img-src"],
  ["font-src", "fontSrc", "font-src"],
  ["connect-src", "connectSrc", "connect-src"],
  ["media-src", "mediaSrc", "media-src"],
  ["frame-src", "frameSrc", "frame-src"],
  ["worker-src", "workerSrc", "worker-src"],
];

const CSP_METADATA_LITERAL_SOURCES = new Map<string, ReadonlySet<string>>([
  ["img-src", new Set(["data:", "blob:"])],
  ["font-src", new Set(["data:"])],
  ["media-src", new Set(["data:", "blob:"])],
  ["worker-src", new Set(["blob:"])],
]);

function sanitizeCspSource(raw: unknown, directive: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const source = raw.trim();
  if (CSP_METADATA_LITERAL_SOURCES.get(directive)?.has(source)) return source;
  if (source.endsWith(":") || source.includes("*") || source.includes(";") || /\s/.test(source)) return undefined;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function readMetadataSources(
  policy: McpUiCspPolicy | undefined,
  directive: string,
  camelKey: keyof McpUiCspPolicy,
  kebabKey: string,
): string[] {
  if (!policy) return [];
  const raw = policy[camelKey] ?? policy[kebabKey];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((source) => sanitizeCspSource(source, directive))
    .filter((source): source is string => source !== undefined);
}

function mergeCspSources(base: readonly string[], additions: readonly string[]): string[] {
  const merged = new Set(base);
  for (const source of additions) merged.add(source);
  if (merged.size > 1) merged.delete("'none'");
  return [...merged];
}

export function buildMcpCsp(policy?: McpUiCspPolicy): string {
  const directives = new Map<string, string[]>(
    DEFAULT_CSP_DIRECTIVES.map(([name, sources]) => [name, [...sources]]),
  );
  for (const [directive, camelKey, kebabKey] of CSP_METADATA_DIRECTIVES) {
    const additions = readMetadataSources(policy, directive, camelKey, kebabKey);
    if (additions.length === 0) continue;
    directives.set(directive, mergeCspSources(directives.get(directive) ?? [], additions));
  }
  const csp = [...directives.entries()]
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
}

export function wrapWithCsp(html: string, policy?: McpUiCspPolicy): string {
  const cspMeta = buildMcpCsp(policy);
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${cspMeta}`);
  }
  return `<!doctype html><html><head>${cspMeta}</head><body>${html}</body></html>`;
}
