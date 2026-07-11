/**
 * MCP-App Content Security Policy — single source of truth.
 *
 * Lives in `shared/` because BOTH sides need it now: the main process emits it
 * as a real `Content-Security-Policy` **response header** on the sandbox-proxy
 * document (`main/mcp-app-protocol.ts`), and the renderer/tests reason about the
 * same policy. It was previously renderer-only (`ui/renderer/components/`), back
 * when the policy could only ride along as a `<meta>` tag inside a `data:` URL.
 *
 * ─── Why the header form is the SOT (measured, not assumed) ───────────────────
 * The app HTML runs in an inner `<iframe sandbox="allow-scripts" srcdoc=...>`.
 * A `srcdoc` document **INHERITS the embedding document's CSP**, and a `<meta>`
 * CSP inside it can only ever **INTERSECT** — it can narrow, never widen. This
 * was verified empirically in a real Electron <webview>: with the proxy header
 * at `img-src 'none'`, an inner frame whose own meta said `img-src data:` was
 * still blocked, citing the OUTER `img-src 'none'`.
 *
 * Consequence: the proxy's header IS the effective envelope for the app. It must
 * therefore be the permissive SUPERSET (this module's DEFAULT + sanitized
 * per-resource additions); the app cannot escape it.
 *
 * Note `frame-ancestors` is only meaningful in a header (it is spec-ignored in a
 * `<meta>`). In a <webview> the proxy is a TOP-LEVEL browsing context, so it has
 * no ancestors and the directive is inert — verified: `frame-ancestors 'none'`
 * does not block the proxy. It is kept as deliberate defense-in-depth.
 */
import type { McpUiCspPolicy } from "../mcp/types.js";

const DEFAULT_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["default-src", ["'none'"]],
  ["script-src", ["'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com"]],
  ["style-src", ["'unsafe-inline'", "data:", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"]],
  ["img-src", ["data:", "blob:", "https:"]],
  ["font-src", ["data:", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "https://unpkg.com"]],
  ["connect-src", ["'none'"]],
  ["media-src", ["'none'"]],
  // The inner app frame is created by the host-owned relay preload as a
  // `srcdoc` iframe. `frame-src` does NOT gate `srcdoc` (no URL is fetched) —
  // verified empirically — so this stays locked to 'none' to block any *URL*
  // framing the app itself might attempt.
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

/**
 * The effective policy as a raw directive string — the form emitted as the
 * sandbox-proxy document's `Content-Security-Policy` **response header**, which
 * the inner app frame then inherits. This is the SOT; the `<meta>` helpers below
 * derive from it.
 */
export function buildMcpCspHeader(policy?: McpUiCspPolicy): string {
  const directives = new Map<string, string[]>(
    DEFAULT_CSP_DIRECTIVES.map(([name, sources]) => [name, [...sources]]),
  );
  for (const [directive, camelKey, kebabKey] of CSP_METADATA_DIRECTIVES) {
    const additions = readMetadataSources(policy, directive, camelKey, kebabKey);
    if (additions.length === 0) continue;
    directives.set(directive, mergeCspSources(directives.get(directive) ?? [], additions));
  }
  return [...directives.entries()]
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

/** The same policy in `<meta http-equiv>` form. */
export function buildMcpCsp(policy?: McpUiCspPolicy): string {
  return `<meta http-equiv="Content-Security-Policy" content="${buildMcpCspHeader(policy)}">`;
}

/** Wrap a document in the meta form. Retained for CSP probe harnesses/tests. */
export function wrapWithCsp(html: string, policy?: McpUiCspPolicy): string {
  const cspMeta = buildMcpCsp(policy);
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${cspMeta}`);
  }
  return `<!doctype html><html><head>${cspMeta}</head><body>${html}</body></html>`;
}
