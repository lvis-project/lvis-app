import { createDynamicTool, type Tool } from "./base.js";
import type { SettingsService } from "../data/settings-store.js";
import { t } from "../i18n/index.js";

// ─── web_search provider response shapes ────────────────────────────
// Narrow interfaces + runtime shape guards for the external search-provider
// responses. The provider boundary is untrusted: a response-shape change must
// surface as an explicit `isError` diagnostic, not silently degrade to an
// empty result array (which an untyped cast plus an `?? []` fallback hid).

interface TavilyResult {
  title?: unknown;
  content?: unknown;
  url?: unknown;
}
interface TavilyResponse {
  results?: TavilyResult[];
}
interface SerperOrganic {
  title?: unknown;
  snippet?: unknown;
  link?: unknown;
}
interface SerperResponse {
  organic?: SerperOrganic[];
}

/** A single normalized search hit emitted to the model. */
interface NormalizedSearchResult {
  title: string;
  snippet: string;
  url: string;
}

export class WebSearchShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchShapeError";
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Validates a Tavily response against the documented `{ results: [...] }`
 * shape. Throws {@link WebSearchShapeError} on a mismatch so a provider change
 * surfaces as a tool error rather than an empty result set.
 */
export function parseTavilyResponse(data: unknown): NormalizedSearchResult[] {
  if (typeof data !== "object" || data === null) {
    throw new WebSearchShapeError("Tavily response was not a JSON object");
  }
  const { results } = data as TavilyResponse;
  if (results === undefined) {
    throw new WebSearchShapeError("Tavily response missing `results`");
  }
  if (!Array.isArray(results)) {
    throw new WebSearchShapeError("Tavily `results` was not an array");
  }
  return results.map((r) => ({
    title: asString(r?.title),
    snippet: asString(r?.content),
    url: asString(r?.url),
  }));
}

/**
 * Validates a Serper response against the documented `{ organic: [...] }`
 * shape. Throws {@link WebSearchShapeError} on a mismatch.
 */
export function parseSerperResponse(data: unknown): NormalizedSearchResult[] {
  if (typeof data !== "object" || data === null) {
    throw new WebSearchShapeError("Serper response was not a JSON object");
  }
  const { organic } = data as SerperResponse;
  if (organic === undefined) {
    throw new WebSearchShapeError("Serper response missing `organic`");
  }
  if (!Array.isArray(organic)) {
    throw new WebSearchShapeError("Serper `organic` was not an array");
  }
  return organic.map((r) => ({
    title: asString(r?.title),
    snippet: asString(r?.snippet),
    url: asString(r?.link),
  }));
}

/**
 * Builtin `web_search` tool. Three-tier provider ladder: Tavily / Serper when a
 * matching API key is configured, else a keyless DuckDuckGo HTML fallback.
 *
 * Deps are injected by the boot assembler so the definition itself stays free
 * of boot wiring:
 * - `settingsService` resolves the configured provider + its secret key.
 * - `networkFetch` is the Electron network-stack fetch (honors host-resolver
 *   rules) rather than the global `fetch`.
 */
export function createWebSearchTool(
  settingsService: SettingsService,
  networkFetch: typeof fetch,
): Tool {
  return createDynamicTool({
    name: "web_search",
    description: t("be_tools.webSearchDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: t("be_tools.webSearchQueryDescription") },
        count: { type: "integer", description: t("be_tools.webSearchCountDescription") },
      },
      required: ["query"],
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      const query = args.query as string;
      // Clamp count to integer in [1,10]. Non-numeric / out-of-range falls
      // back to default 5. Prevents arbitrary large values reaching search
      // providers or the DuckDuckGo HTML parser.
      const rawCount = args.count;
      let count = 5;
      if (typeof rawCount === "number" && Number.isFinite(rawCount)) {
        const clamped = Math.min(10, Math.max(1, Math.floor(rawCount)));
        count = clamped;
      }
      const ws = settingsService.get("webSearch");
      const apiKey = settingsService.getSecret(`web.apiKey.${ws.provider}`);
      try {
        if (ws.provider === "tavily" && apiKey) {
          const res = await networkFetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: count }),
          });
          const data: unknown = await res.json();
          const results = parseTavilyResponse(data);
          return {
            output: JSON.stringify({ query, provider: "Tavily", results }),
            isError: false,
          };
        }
        if (ws.provider === "serper" && apiKey) {
          const res = await networkFetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, num: count }),
          });
          const data: unknown = await res.json();
          const results = parseSerperResponse(data);
          return {
            output: JSON.stringify({ query, provider: "Serper", results }),
            isError: false,
          };
        }
        const ddgRes = await networkFetch("https://html.duckduckgo.com/html/", {
          method: "POST",
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ q: query }).toString(),
        });
        const ddgHtml = await ddgRes.text();
        const results: NormalizedSearchResult[] = [];
        const resultBlocks = ddgHtml.split(/class="result\s/g).slice(1, count + 1);
        for (const block of resultBlocks) {
          const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)/);
          const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+)/);
          if (urlMatch) {
            let url = urlMatch[1];
            const uddg = url.match(/uddg=([^&]+)/);
            if (uddg) url = decodeURIComponent(uddg[1]);
            results.push({ title: urlMatch[2].trim(), snippet: snippetMatch?.[1]?.trim() || "", url });
          }
        }
        return {
          output: JSON.stringify({ query, provider: "DuckDuckGo", results }),
          isError: false,
        };
      } catch (error) {
        return {
          output: JSON.stringify({
            query,
            error: t("be_tools.webSearchError"),
            details: (error as Error).message,
          }),
          isError: true,
        };
      }
    },
  });
}
