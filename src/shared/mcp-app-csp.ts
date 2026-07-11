/**
 * MCP-App Content Security Policy — single source of truth.
 *
 * Built in the MAIN process ONLY, from the RESOURCE's own `_meta.ui.csp` that main
 * just fetched via `resources/read`. It is emitted as the sandbox-proxy document's
 * `Content-Security-Policy` **response header**.
 *
 * ─── Why main, and never the renderer ────────────────────────────────────────
 * This CSP is the containment boundary for code we do not trust (server-authored
 * HTML). Its input must therefore never round-trip through the renderer: a
 * compromised renderer could forge a permissive policy object and widen the very
 * envelope that contains the untrusted app. Derive it in main; never accept it
 * renderer-forwarded.
 *
 * ─── Why the header is the effective ceiling (measured, not assumed) ─────────
 * The app HTML runs in an inner `<iframe sandbox="allow-scripts" srcdoc=...>`. A
 * `srcdoc` document INHERITS the embedding document's CSP, and a `<meta>` CSP
 * inside it can only ever INTERSECT — narrow, never widen. Verified in a real
 * Electron <webview>: with the proxy header at `img-src 'none'`, an inner frame
 * whose own meta declared `img-src data:` was still blocked, citing the OUTER policy.
 *
 * Consequence: the header IS the ceiling, so it must be built **per resource** —
 * restrictive default + ONLY that resource's declared domains. A blanket permissive
 * superset would silently grant every app every other app's allowances, violating
 * the spec's No-Loosening MUST (the host MUST NOT allow undeclared domains).
 *
 * ─── Spec shape: domain BUCKETS, not directive names ─────────────────────────
 * `McpUiResourceCsp` declares `connectDomains` / `resourceDomains` / `frameDomains`
 * / `baseUriDomains`. The previous host type was keyed by CSP *directive* names
 * (`scriptSrc`/`connectSrc`/…), so a spec-conformant server's `connectDomains` was
 * silently DROPPED. Consuming the spec shape is what fixes that.
 *
 * Note `frame-ancestors` is only meaningful in a header (it is spec-ignored in a
 * `<meta>`). In a <webview> the proxy is a TOP-LEVEL browsing context, so it has no
 * ancestors and the directive is inert — verified: `frame-ancestors 'none'` does not
 * block the proxy. Kept as deliberate defense-in-depth.
 */
import type { McpUiResourceCsp } from "../mcp/types.js";

/**
 * Restrictive floor. Every network-capable directive starts at `'none'`; only the
 * resource's own declared domains open it.
 *
 * `'unsafe-inline'` for script/style is intentional and is not the hole here: the
 * app is an opaque-origin sandboxed frame with no same-origin server, and inline
 * script is how MCP Apps are authored. `data:`/`blob:` are local, not exfiltration
 * channels. There is deliberately NO `https:` wildcard and NO hardcoded CDN
 * allowlist — either would let any app reach hosts it never declared.
 */
const DEFAULT_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["default-src", ["'none'"]],
  ["script-src", ["'unsafe-inline'"]],
  ["style-src", ["'unsafe-inline'", "data:"]],
  ["img-src", ["data:", "blob:"]],
  ["font-src", ["data:"]],
  ["media-src", ["data:", "blob:"]],
  ["connect-src", ["'none'"]],
  // `frame-src` does NOT gate the inner `srcdoc` app frame (no URL is fetched) —
  // verified empirically — so this only constrains URL-framing the app attempts.
  ["frame-src", ["'none'"]],
  ["worker-src", ["'none'"]],
  ["base-uri", ["'none'"]],
  ["form-action", ["'none'"]],
  ["frame-ancestors", ["'none'"]],
];

/**
 * Spec bucket → the CSP directives it opens. `resourceDomains` is defined as
 * "origins for static resources (images, scripts, stylesheets, fonts, media)", so it
 * fans out across all five.
 */
const BUCKET_TO_DIRECTIVES: ReadonlyArray<readonly [keyof McpUiResourceCsp, readonly string[]]> = [
  ["connectDomains", ["connect-src"]],
  ["resourceDomains", ["script-src", "style-src", "img-src", "font-src", "media-src"]],
  ["frameDomains", ["frame-src"]],
  ["baseUriDomains", ["base-uri"]],
];

/**
 * Only absolute `https://` origins survive. Rejects wildcards, bare schemes,
 * credentials, and anything containing separators that could smuggle a second
 * directive into the header.
 */
function sanitizeDeclaredOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const source = raw.trim();
  if (source.length === 0) return undefined;
  if (source.endsWith(":") || source.includes("*") || source.includes(";") || /\s/.test(source)) {
    return undefined;
  }
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** The sanitized origins a resource declared in one bucket. */
function readBucket(csp: McpUiResourceCsp | undefined, bucket: keyof McpUiResourceCsp): string[] {
  const raw = csp?.[bucket];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((origin) => sanitizeDeclaredOrigin(origin))
    .filter((origin): origin is string => origin !== undefined);
}

/**
 * Every sanitized origin a resource declared, across all buckets.
 *
 * The main-process `webRequest` gate on the partition uses this so the NETWORK layer
 * grants exactly what the CSP grants. Without it the two layers drift: the CSP would
 * permit a declared `connectDomains` host while the gate silently cancelled the
 * request, so a conformant server's declared network access would never work.
 */
export function declaredOrigins(csp?: McpUiResourceCsp): string[] {
  const origins = new Set<string>();
  for (const [bucket] of BUCKET_TO_DIRECTIVES) {
    for (const origin of readBucket(csp, bucket)) origins.add(origin);
  }
  return [...origins];
}

function addSources(base: readonly string[], additions: readonly string[]): string[] {
  const merged = new Set(base);
  for (const source of additions) merged.add(source);
  // `'none'` is meaningless — and invalid — alongside a real source.
  if (merged.size > 1) merged.delete("'none'");
  return [...merged];
}

/**
 * The effective policy for ONE resource, as a raw directive string — the form
 * emitted as that resource's sandbox-proxy `Content-Security-Policy` header.
 *
 * @param csp The RESOURCE's declared `_meta.ui.csp`. A `csp` found on a TOOL result
 *   is ignored by callers: per spec, `csp`/`permissions` live on the resource, while
 *   the tool's `_meta.ui` carries only `resourceUri` + rendering hints.
 */
export function buildMcpCspHeader(csp?: McpUiResourceCsp): string {
  const directives = new Map<string, string[]>(
    DEFAULT_CSP_DIRECTIVES.map(([name, sources]) => [name, [...sources]]),
  );
  for (const [bucket, targets] of BUCKET_TO_DIRECTIVES) {
    const declared = readBucket(csp, bucket);
    if (declared.length === 0) continue;
    for (const directive of targets) {
      directives.set(directive, addSources(directives.get(directive) ?? [], declared));
    }
  }
  return [...directives.entries()]
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

/** The same policy in `<meta http-equiv>` form. Used by CSP probe harnesses/tests. */
export function buildMcpCsp(csp?: McpUiResourceCsp): string {
  return `<meta http-equiv="Content-Security-Policy" content="${buildMcpCspHeader(csp)}">`;
}

/** Wrap a document in the meta form. Retained for CSP probe harnesses/tests. */
export function wrapWithCsp(html: string, csp?: McpUiResourceCsp): string {
  const cspMeta = buildMcpCsp(csp);
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${cspMeta}`);
  }
  return `<!doctype html><html><head>${cspMeta}</head><body>${html}</body></html>`;
}
