/**
 * Tier A host-mediated egress gate — pure policy core for `hostApi.hostFetch`.
 *
 * Extracted from the per-plugin HostApi factory so the egress contract can be
 * unit-tested without standing up the full plugin runtime (mirrors
 * `network-access-allowlist.test.ts`). The factory wires the audit/telemetry
 * side-effects and the concrete Electron `net` fetch around this core.
 *
 * Layers, in order (complete mediation — every request passes all of them):
 *   1. {@link validateHttpUrl} — scheme + host + embedded-credential reject.
 *   2. https-only — a plugin must not egress host-mediated traffic in cleartext.
 *      One exemption: a loopback endpoint the manifest declared by literal name
 *      (see {@link evaluateHostFetch}), proven by resolution to stay on this
 *      machine. Cleartext that never reaches a wire has nothing to eavesdrop.
 *   3. deny-by-default allow-list — the target host must dot-boundary-match a
 *      domain declared in `manifest.networkAccess.allowedDomains`.
 *   4. {@link ensurePublicHttpUrl} — DNS-aware SSRF control. The target host is
 *      resolved and rejected if any address lands on a private / loopback /
 *      link-local / metadata range. This is the layer the cloud-marketplace
 *      fetcher and MCP client already apply; hostFetch previously delegated it
 *      to the OS proxy, which only holds when a corporate forward proxy/PAC is
 *      configured. Off-corp (dev laptop, no proxy) `net.fetch` resolves DNS
 *      locally and goes direct, so an attacker-controlled or DNS-rebound
 *      allow-listed domain could pivot to 169.254.169.254 / 127.0.0.1 / RFC1918.
 *
 * The private-network escape hatch is the per-plugin governance opt-in
 * `manifest.networkAccess.allowPrivateNetworks` (declarative, user-approved at
 * install), mirroring the MCP per-server `allowPrivateNetworks` flag. It is
 * NOT an unconditional skip: absent/false ⇒ private targets are rejected.
 *
 * Loopback is a SEPARATE axis from that flag, in both directions: RFC1918 reach
 * never implies reach into the user's own machine, and a declared local
 * endpoint never implies reach into the LAN. It is opened by the allow-list
 * itself — a manifest that writes `localhost` / `127.0.0.1` / `::1` into
 * `networkAccess.allowedDomains` has asked for the local machine by name, in
 * the same user-visible install-time declaration that governs every other host,
 * and has asked for nothing else. That is what makes a user-configured local
 * inference server (LM Studio / LiteLLM / an internal proxy) reachable from a
 * plugin setting instead of a control that cannot control anything.
 */
import { isLoopbackHost, urlHostMatchesAllowList } from "./host-allow-list.js";
import {
  validateHttpUrl,
  ensurePublicHttpUrl,
  resolvesToLoopbackOnly,
  resolvesToPrivateNetworkOnly,
  NetworkGuardError,
} from "../core/network-guard.js";
import { methodEffect, type Effect } from "../permissions/effect-kind.js";

/** Reason buckets used for egress-denial telemetry + audit detail. */
export type HostFetchDenyReason =
  | "invalid-url"
  | "non-https"
  | "malformed-allowlist"
  | "not-allowlisted"
  | "ssrf-blocked";

/** A denied request — the caller emits audit/telemetry then throws `message`. */
export interface HostFetchDeny {
  ok: false;
  reason: HostFetchDenyReason;
  /** Audit-line detail (no secrets). */
  detail: string;
  /** Error message surfaced to the calling plugin. */
  message: string;
}

/** An allowed request — the caller egresses to `url`. */
export interface HostFetchAllow {
  ok: true;
  url: URL;
  /** Normalized HTTP method this decision was evaluated for (uppercased). */
  method: string;
  /**
   * Host-observed effect class derived from the method alone (NON-FORGEABLE —
   * the host owns the verb at the egress chokepoint, not the plugin). Computed
   * from the SINGLE-SOT {@link methodEffect}: safe verbs (GET/HEAD/OPTIONS) are
   * reads; everything else is a write. Observability only: this changes NO
   * egress decision — the allow-list / SSRF / deny-by-default layers below are
   * unaffected.
   */
  effect: Effect;
}

export type HostFetchDecision = HostFetchAllow | HostFetchDeny;

export interface HostFetchGuardInput {
  pluginId: string;
  /** Raw target passed by the plugin (string or URL, already stringified). */
  rawUrl: string;
  /**
   * HTTP method of the request — defaults to `"GET"` when omitted (matches the
   * `init.method` default at the hostFetch chokepoint). Used ONLY to compute the
   * host-observed {@link HostFetchAllow.effect}; it does not gate egress.
   */
  method?: string;
  /**
   * Normalized `manifest.networkAccess.allowedDomains`, validated at manifest
   * load / host API creation. Deny-by-default when empty.
   */
  allowedDomains: string[];
  /**
   * `manifest.networkAccess.allowPrivateNetworks` — the declarative,
   * user-approved governance opt-in for reaching RFC1918 / ULA endpoints.
   * Deny-by-default: absent/false rejects private targets. Loopback is NOT this
   * flag — see the loopback axis in the file header.
   */
  allowPrivateNetworks?: boolean;
  /**
   * Injectable SSRF resolver — defaults to {@link ensurePublicHttpUrl}. Tests
   * inject a resolver backed by a mocked `node:dns` so the layered decision can
   * be exercised without live DNS. Production passes nothing.
   */
  ensurePublicUrl?: typeof ensurePublicHttpUrl;
  /**
   * Injectable loopback proof — defaults to {@link resolvesToLoopbackOnly}.
   * Same seam, same reason as {@link ensurePublicUrl}.
   */
  resolveLoopbackOnly?: typeof resolvesToLoopbackOnly;
  /**
   * Injectable private-network proof — defaults to
   * {@link resolvesToPrivateNetworkOnly}. Same seam, same reason.
   */
  resolvePrivateOnly?: typeof resolvesToPrivateNetworkOnly;
}

function deny(
  pluginId: string,
  reason: HostFetchDenyReason,
  detail: string,
  message: string,
): HostFetchDeny {
  return { ok: false, reason, detail, message: `[plugin:${pluginId}] ${message}` };
}

/**
 * Run the full Tier A egress gate for one hostFetch call. Pure except for the
 * DNS resolution inside {@link ensurePublicHttpUrl}; emits no side effects so
 * the caller owns audit/telemetry. Returns a decision the caller acts on.
 */
export async function evaluateHostFetch(
  input: HostFetchGuardInput,
): Promise<HostFetchDecision> {
  const {
    pluginId,
    rawUrl,
    method = "GET",
    allowedDomains,
    allowPrivateNetworks = false,
    ensurePublicUrl = ensurePublicHttpUrl,
    resolveLoopbackOnly = resolvesToLoopbackOnly,
    resolvePrivateOnly = resolvesToPrivateNetworkOnly,
  } = input;
  // Host-observed effect — derived from the verb the host holds at the
  // chokepoint, not from anything the plugin self-declares. Recorded on the
  // allow decision; it does not participate in any deny branch below.
  const normalizedMethod = method.toUpperCase();
  const effect: Effect = methodEffect(normalizedMethod);

  let url: URL;
  try {
    url = validateHttpUrl(rawUrl);
  } catch (err) {
    const reason = err instanceof NetworkGuardError ? err.message : "invalid URL";
    return deny(pluginId, "invalid-url", `invalid URL: ${reason}`, `hostFetch rejected: ${reason}`);
  }

  // Is this target the user's own machine, declared as such? Both halves are
  // required, and neither can be inferred from the other:
  //   - the host is a loopback LITERAL, so an ordinary name cannot claim the
  //     exemption merely by resolving to 127.0.0.1 (that is rebinding, and it
  //     stays the SSRF layer's business);
  //   - that literal is in `allowedDomains`, so this remains the deny-by-default
  //     declaration the user approved at install, not a standing permission for
  //     every plugin to talk to whatever is listening locally.
  const allowListed = urlHostMatchesAllowList(url.hostname, allowedDomains);
  const declaredLoopback = allowListed && isLoopbackHost(url.hostname);

  // https-only — validateHttpUrl permits http(s) (shared util), but a plugin
  // must not send host-mediated traffic in cleartext.
  //
  // A declared loopback endpoint is the exemption: those bytes never reach a
  // network, so the confidentiality https buys has nothing to protect here —
  // and requiring https anyway means a local inference server (LM Studio,
  // LiteLLM, an internal proxy), which speaks http on 127.0.0.1 by default, is
  // unreachable no matter what the user configures. The exemption is not taken
  // on the hostname's word: `resolveLoopbackOnly` requires every resolved
  // address to be loopback, so a `localhost` pointed at a routable address by a
  // poisoned hosts file or a rebinding answer falls through to this deny rather
  // than putting the request on the wire in cleartext.
  if (url.protocol !== "https:") {
    const provenLocal = declaredLoopback && (await resolveLoopbackOnly(url.hostname));
    // The second cleartext exemption: an INTRANET endpoint. Three conditions,
    // none inferable from another — the host is in the user-approved
    // allow-list, the manifest carries the user-approved
    // `allowPrivateNetworks` governance opt-in, and every address behind the
    // name is proven private (or loopback — split-horizon names may answer
    // both). The proof is what keeps this from being "http is fine now": a
    // name with one public address puts cleartext on the open wire and stays
    // denied. Residual risk, stated rather than hidden: on a hostile LAN an
    // attacker's DNS can satisfy "resolves private" with its own RFC1918
    // address. That is inherent to trusting private DNS at all, it is the
    // reality the opt-in flag asks the user to approve, and it is strictly
    // less exposure than the ungated `fetch` these plugins used before.
    const provenPrivate =
      !provenLocal
      && allowListed
      && allowPrivateNetworks
      && (await resolvePrivateOnly(url.hostname));
    if (!provenLocal && !provenPrivate) {
      const suffix = declaredLoopback
        ? " (declared loopback host does not resolve to loopback)"
        : allowListed && allowPrivateNetworks
          ? " (allowPrivateNetworks is declared but the host does not resolve to private addresses only)"
          : "";
      return deny(
        pluginId,
        "non-https",
        `non-https scheme ${url.protocol}//${url.hostname}${suffix}`,
        declaredLoopback
          ? `hostFetch denied: ${url.hostname} is declared as loopback but does not resolve to a loopback address`
          : allowListed && allowPrivateNetworks
            ? `hostFetch denied: cleartext to ${url.hostname} requires every resolved address to be private (got a non-private answer or no answer)`
            : `hostFetch denied: only https is permitted (got ${url.protocol})`,
      );
    }
  }

  // Deny-by-default allow-list (complete mediation): the plugin may only reach
  // hosts declared in `manifest.networkAccess.allowedDomains`. The list has
  // already been normalized/validated before this hot path.
  if (!allowListed) {
    return deny(
      pluginId,
      "not-allowlisted",
      `${url.protocol}//${url.hostname} not in networkAccess.allowedDomains`,
      `hostFetch denied: ${url.hostname} is not in networkAccess.allowedDomains (deny-by-default)`,
    );
  }

  // DNS-aware SSRF control. An allow-listed name resolving to a private /
  // loopback / link-local / metadata address is rejected unless the plugin's
  // manifest explicitly opts into private-network egress. This closes the
  // off-corp (no-proxy) direct-resolution and DNS-rebinding pivots that the
  // host-suffix allow-list alone cannot.
  try {
    // `allowLoopback` is scoped to the declared-literal decision above and is
    // never derived from `allowPrivateNetworks`: an RFC1918 grant cannot reach
    // 127.0.0.1, and a local-endpoint grant cannot reach the LAN.
    await ensurePublicUrl(url.toString(), {
      allowPrivateNetworks,
      allowLoopback: declaredLoopback,
    });
  } catch (err) {
    const reason = err instanceof NetworkGuardError ? err.message : "SSRF check failed";
    return deny(
      pluginId,
      "ssrf-blocked",
      `${url.protocol}//${url.hostname} ${reason}`,
      `hostFetch denied: ${reason}`,
    );
  }

  return { ok: true, url, method: normalizedMethod, effect };
}

/** Statuses that name another location instead of answering. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** How many gated hops a `redirect: "follow"` request may take after the first. */
export const MAX_REDIRECT_HOPS = 5;

export interface HostFetchHopOptions {
  /** The plugin whose manifest governs every hop. */
  pluginId: string;
  /** The first request, already evaluated and allowed by {@link evaluateHostFetch}. */
  first: HostFetchAllow;
  /** Everything from the plugin's `init` except `method` (verb-snapshot rule). */
  init: Omit<RequestInit, "method">;
  /**
   * The single-hop transport (`createSingleHopFetch`). CONTRACT: it never
   * follows a redirect — a 3xx comes back as a Response with `location` set.
   * A transport that followed on its own would move requests past this gate,
   * which is the exact failure this loop exists to close.
   */
  transport: typeof fetch;
  /** `manifest.networkAccess.allowedDomains`, same list every hop. */
  allowedDomains: string[];
  /** `manifest.networkAccess.allowPrivateNetworks`, same flag every hop. */
  allowPrivateNetworks: boolean;
  /**
   * Host-side session-cookie injector (the auth-partition vault). When present,
   * it is consulted BEFORE every hop with that hop's resolved URL and returns
   * the `Cookie` header the host should attach — the harvested session cookies
   * live only in the plugin's Electron partition, never in the plugin bundle.
   *
   * Contract:
   *   - Re-run per hop with the hop's own URL, so a redirect that lands on a
   *     different portal path/host gets exactly the cookies scoped to it.
   *   - Returns `""` when nothing applies; the header is then left unset.
   *   - The plugin MUST NOT also send `Cookie` (enforced by the caller before
   *     this loop): host injection is the single source, no double-origin.
   *   - Runs AFTER the cross-origin credential strip below, so a cross-origin
   *     hop first drops any prior `cookie` and then receives only what the
   *     vault scopes to the new origin.
   */
  injectSessionCookie?: (url: URL) => Promise<string>;
  /** Audit sink for an allowed hop (hop >= 1; the caller logged hop 0). */
  auditHop?: (line: string) => void;
  /** Audit sink for a denied hop — same shape the caller uses for hop 0. */
  auditDeny?: (reason: HostFetchDenyReason | "redirect-cap", detail: string) => void;
  /** Test seams, forwarded into {@link evaluateHostFetch} per hop. */
  ensurePublicUrl?: HostFetchGuardInput["ensurePublicUrl"];
  resolveLoopbackOnly?: HostFetchGuardInput["resolveLoopbackOnly"];
  resolvePrivateOnly?: HostFetchGuardInput["resolvePrivateOnly"];
}

/**
 * Drive one hostFetch request through as many gated hops as its policy allows.
 *
 * The policy is the plugin's own `init.redirect`, and each value means what it
 * would mean under `fetch` — with the difference that FOLLOWING is the host's
 * act here, never the transport's:
 *
 *   - `"error"` (and anything unrecognized — fail closed): a redirect throws.
 *     The pre-hop behaviour, byte-compatible in outcome if not in message.
 *   - `"manual"`: the 3xx is RETURNED, headers included. This is what lets a
 *     plugin recognise an SSO bounce as an expired session instead of a
 *     generic transport failure. It hands over no new reach: any follow-up
 *     request the plugin makes with that `location` re-enters `hostFetch` at
 *     hop 0 and faces the full gate.
 *   - `"follow"`: the host follows, at most {@link MAX_REDIRECT_HOPS} hops, and
 *     EVERY hop passes the complete gate — scheme, allow-list, DNS/SSRF —
 *     before any bytes move. This is the mode `net.fetch` could never offer:
 *     there, a followed hop was a request no gate ever saw.
 *
 * Method and body follow the fetch spec across a followed hop: 303 always
 * becomes GET, 301/302 become GET when the verb was POST, 307/308 keep both.
 * The verb can only move TOWARD the read class, so the effect recorded from
 * the original snapshot never understates what was sent. A stream body that
 * a 307/308 would need to replay throws instead of replaying a drained stream.
 * On a cross-ORIGIN hop the `authorization`, `proxy-authorization` and
 * `cookie` headers are dropped — credentials meant for one origin do not
 * travel to another, allow-listed or not.
 */
export async function runHostFetchHops(options: HostFetchHopOptions): Promise<Response> {
  const {
    pluginId,
    first,
    init,
    transport,
    allowedDomains,
    allowPrivateNetworks,
    auditHop,
    auditDeny,
    ensurePublicUrl,
    resolveLoopbackOnly,
    resolvePrivateOnly,
    injectSessionCookie,
  } = options;
  const requestedPolicy = init.redirect;
  const policy: "error" | "manual" | "follow" =
    requestedPolicy === "manual" || requestedPolicy === "follow" ? requestedPolicy : "error";
  // Normalized ONCE so per-hop credential stripping operates on one object
  // rather than on whatever shape (Headers / entries / record) the plugin sent.
  const headers = new Headers((init.headers as HeadersInit | undefined) ?? {});
  let url = first.url;
  let method = first.method;
  let body = init.body;
  // Attach the vault's session cookies for THIS hop's URL. Set (or cleared)
  // fresh every hop so a followed redirect gets exactly what its own origin
  // scopes to — never the previous hop's. An empty header string means "no
  // applicable cookie": remove the header rather than send an empty one.
  const applyInjectedCookie = async (target: URL): Promise<void> => {
    if (!injectSessionCookie) return;
    const header = await injectSessionCookie(target);
    if (header.length > 0) headers.set("cookie", header);
    else headers.delete("cookie");
  };
  await applyInjectedCookie(url);
  for (let hop = 0; ; hop++) {
    const response = await transport(url.toString(), {
      ...init,
      headers,
      body,
      method,
      // The transport ignores this by contract; pinned so a call site reads
      // true and a future fetch-shaped transport fails toward NOT following.
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    // A 3xx without a location names nowhere; per fetch it is a final response.
    if (location === null) return response;
    if (policy === "error") {
      auditDeny?.(
        "redirect-cap",
        `redirect refused (policy error): ${response.status} at ${url.origin}`,
      );
      throw new Error(
        `[plugin:${pluginId}] hostFetch: redirect refused — ${response.status} from ${url.origin} `
          + `(init.redirect is "error"; pass "manual" to see the redirect or "follow" for gated hops)`,
      );
    }
    if (policy === "manual") return response;
    if (hop >= MAX_REDIRECT_HOPS) {
      auditDeny?.("redirect-cap", `redirect cap exceeded after ${MAX_REDIRECT_HOPS} hops at ${url.origin}`);
      throw new Error(
        `[plugin:${pluginId}] hostFetch: too many redirects (limit ${MAX_REDIRECT_HOPS})`,
      );
    }
    let nextRaw: string;
    try {
      nextRaw = new URL(location, url).toString();
    } catch {
      throw new Error(`[plugin:${pluginId}] hostFetch: unparseable redirect location`);
    }
    // THE point of this loop: the next hop faces the same complete gate the
    // first request did. `net.fetch`'s own follow mode is refused as the
    // transport precisely because it cannot stop here.
    const decision = await evaluateHostFetch({
      pluginId,
      rawUrl: nextRaw,
      method,
      allowedDomains,
      allowPrivateNetworks,
      ...(ensurePublicUrl ? { ensurePublicUrl } : {}),
      ...(resolveLoopbackOnly ? { resolveLoopbackOnly } : {}),
      ...(resolvePrivateOnly ? { resolvePrivateOnly } : {}),
    });
    if (!decision.ok) {
      auditDeny?.(decision.reason, `redirect hop ${hop + 1}: ${decision.detail}`);
      throw new Error(decision.message);
    }
    if (
      response.status === 303
      || ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    } else if (
      (response.status === 307 || response.status === 308)
      && body !== null
      && body !== undefined
      && typeof (body as ReadableStream).getReader === "function"
    ) {
      // The stream was consumed sending hop N; replaying it would send an
      // empty body and call it the same request.
      throw new Error(
        `[plugin:${pluginId}] hostFetch: ${response.status} redirect cannot replay a stream body`,
      );
    }
    if (decision.url.origin !== url.origin) {
      headers.delete("authorization");
      headers.delete("proxy-authorization");
      headers.delete("cookie");
    }
    url = decision.url;
    // Re-scope the vault's cookies to the NEW hop URL. Placed after the
    // cross-origin strip so a same-origin hop refreshes its cookie and a
    // cross-origin hop — whose prior `cookie` was just dropped — receives only
    // what the vault scopes to the new origin (empty ⇒ header stays removed).
    await applyInjectedCookie(url);
    auditHop?.(`host_fetch ${url.origin} method=${method} effect=${decision.effect} hop=${hop + 1}`);
  }
}
