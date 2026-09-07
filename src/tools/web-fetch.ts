import { createDynamicTool, type Tool } from "./base.js";
import { fetchPublicHttpResponse } from "../core/network-guard.js";
import { t } from "../i18n/index.js";

// ─── web_fetch private-network policy helpers ───────────────────────
// The `allowPrivateNetwork` input opts a fetch into private / loopback
// targets; every gate below keys off that single flag so the policy has one
// source of truth.

function webFetchRequiresPrivateNetwork(input: unknown): boolean {
  const args = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  return args.allowPrivateNetwork === true;
}

function webFetchPrivateNetworkPolicy(
  input: unknown,
): boolean | ((url: URL) => boolean) {
  const args = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  if (args.allowPrivateNetwork === true) return true;
  return false;
}

/**
 * The identity an approval of this fetch is remembered under: the DESTINATION,
 * not the URL.
 *
 * A key per URL would make "always allow" mean "allow this exact page", which
 * no one wants often enough to click; a key of the tool name alone would make
 * it mean "allow every fetch anywhere", which is the standing egress primitive
 * this tool must not have. The host it reaches is the unit a person can
 * actually decide about, and it is the unit that bounds where data can go.
 *
 * The private-network discriminant stays in the key, so authorizing an
 * internal host for a private-network fetch never silently answers for the
 * public one, or the reverse.
 */
function webFetchApprovalCacheKey(input: unknown): string | undefined {
  const args = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  if (typeof args.url !== "string") return undefined;
  try {
    const parsed = new URL(args.url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      return undefined;
    }
    const scope = webFetchRequiresPrivateNetwork(input) ? "private-network:" : "";
    return `web_fetch:host:${scope}${parsed.hostname.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

function webFetchCategoryForInput(input: unknown): "network" {
  // Always `network`, whether or not the URL is private. The destination is
  // model-chosen, so a public URL is an egress channel just as much as a
  // private one, and every exclusion that rests on this category — withheld
  // from unattended lanes, not covered by an away-authority read grant, no
  // standing allow rule — must keep applying to both.
  //
  // What separates an ordinary public fetch from an exfiltrating one is the
  // REQUEST, not the destination, and the host screens for that in
  // `screenEgressRequest` (permissions/reviewer/risk-classifier.ts): a
  // screened-clean public fetch rates LOW and runs unprompted, while a
  // credential, an oversized tail, an opaque blob or userinfo in the URL still
  // escalates. Grading the destination instead put a dialog in front of
  // ordinary reading, and a dialog answered that often is answered with
  // "always".
  void webFetchRequiresPrivateNetwork(input);
  return "network";
}

function htmlToPlainTextForWebFetch(html: string): string {
  let output = "";
  let skippedTag: "script" | "style" | null = null;

  for (let i = 0; i < html.length;) {
    if (skippedTag) {
      const lower = html.slice(i, i + skippedTag.length + 4).toLowerCase();
      if (lower.startsWith(`</${skippedTag}`)) {
        const close = html.indexOf(">", i);
        if (close === -1) break;
        i = close + 1;
        skippedTag = null;
        output += " ";
        continue;
      }
      i += 1;
      continue;
    }

    if (html[i] === "<") {
      const close = html.indexOf(">", i + 1);
      if (close === -1) break;
      const tag = html.slice(i + 1, close).trim().toLowerCase();
      const tagName = tag.match(/^\/?\s*([a-z0-9:-]+)/)?.[1];
      if (!tag.startsWith("/") && (tagName === "script" || tagName === "style")) {
        skippedTag = tagName;
      }
      output += " ";
      i = close + 1;
      continue;
    }

    output += html[i];
    i += 1;
  }

  return decodeCommonHtmlEntities(output)
    .replace(/\s+/g, " ")
    .trim();
}

function decodeCommonHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'");
}

/**
 * Builtin `web_fetch` tool. Fetches a public URL and returns readable text.
 *
 * `networkFetch` (the Electron network-stack fetch, injected by the boot
 * assembler) is threaded straight into the SSRF guard so the definition holds
 * no boot wiring of its own.
 */
export function createWebFetchTool(networkFetch: typeof fetch): Tool {
  return createDynamicTool({
    name: "web_fetch",
    description: t("be_tools.webFetchDescription"),
    source: "builtin",
    category: "network",
    categoryForInput: (input) => webFetchCategoryForInput(input),
    isReadOnly: () => true,
    arbitraryEgress: true,
    approvalCacheKey: (input) => webFetchApprovalCacheKey(input),
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: t("be_tools.webFetchUrlDescription") },
        allowPrivateNetwork: {
          type: "boolean",
          description: t("be_tools.webFetchAllowPrivateNetworkDescription"),
        },
      },
      required: ["url"],
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      const url = args.url as string;
      const allowPrivateNetwork = webFetchPrivateNetworkPolicy(rawInput);
      try {
        // SSRF guard: route through NetworkGuard so private / loopback /
        // link-local / metadata endpoints are rejected per hop (incl. redirect
        // chain) and bad schemes / embedded credentials are refused up front.
        const response = await fetchPublicHttpResponse(url, {
          allowPrivateNetworks: allowPrivateNetwork,
          fetchImpl: networkFetch,
          headers: { "User-Agent": "LVIS-Assistant/0.1.0" },
        });
        const html = await response.text();
        const text = htmlToPlainTextForWebFetch(html);
        return {
          output: JSON.stringify({
            url,
            content: text.slice(0, 5000),
            truncated: text.length > 5000,
          }),
          isError: false,
        };
      } catch (error) {
        return {
          output: JSON.stringify({
            url,
            error: t("be_tools.webFetchError"),
            details: (error as Error).message,
          }),
          isError: true,
        };
      }
    },
  });
}
