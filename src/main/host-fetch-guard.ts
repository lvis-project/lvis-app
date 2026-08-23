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
    if (!provenLocal) {
      return deny(
        pluginId,
        "non-https",
        declaredLoopback
          ? `non-https scheme ${url.protocol}//${url.hostname} (declared loopback host does not resolve to loopback)`
          : `non-https scheme ${url.protocol}//${url.hostname}`,
        declaredLoopback
          ? `hostFetch denied: ${url.hostname} is declared as loopback but does not resolve to a loopback address`
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
