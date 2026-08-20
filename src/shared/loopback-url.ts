/**
 * One answer to "is this http URL local enough to skip https?"
 *
 * Two gates asked that question and answered it differently. `mcp-governance`
 * matched exactly `localhost` / `127.0.0.1` / `::1`, so a server on 127.0.0.2 --
 * loopback, traffic never leaving the host -- was refused as needing HTTPS.
 * `marketplace-package-assets` accepted all of 127.0.0.0/8 plus `*.localhost`.
 * The same URL therefore earned a different privilege depending on which door
 * it arrived at.
 *
 * WHY ITS OWN MODULE. `core/network-guard.ts` is the natural home and cannot be
 * one: it imports `node:dns` and `node:net`, and one of the two consumers is
 * reachable from renderer code. `marketplace-package-assets.ts` is renderer-safe
 * but is a marketplace-asset module; a URL predicate imported from there is what
 * makes the next caller write a third copy instead.
 *
 * WHAT THIS DOES NOT ANSWER, and the four other loopback checks in the tree that
 * are deliberately not this one:
 *
 *   - `network-guard.isLoopbackAddress` classifies a RESOLVED IP, not a URL. It
 *     handles `::ffff:127.0.0.1` because DNS produces that spelling; a
 *     hand-written URL does not, so it is absent below rather than forgotten.
 *   - `http-server.isLoopbackBindHost` refuses the hostname `localhost`
 *     outright, and says why: it decides what to BIND, and a name must not be
 *     able to resolve elsewhere between the check and `listen()`. That argument
 *     does not transfer here -- these callers connect out, and refusing
 *     `localhost` would refuse every local model server.
 *   - `ipc/gated.validateSender` asks whether an Electron frame is one of OUR
 *     origins (the dev server), not whether a host is local.
 *   - `a2a-remote-contracts` asks the INVERSE, denying local for a URL that must
 *     be a public remote agent, and refuses every IP literal so it needs no
 *     loopback range at all.
 *
 * `*.localhost` is NOT accepted, and its removal is the one behaviour change
 * here. RFC 6761 says a resolver SHOULD map those names to loopback; Node's
 * `getaddrinfo` does not, so on a stock macOS or Linux host the label is not
 * evidence of anything -- it resolves through the same `/etc/hosts` and DNS that
 * can point it at a remote address, which is the exact hazard `http-server`
 * documents. Refusing it means an https URL is required instead.
 *
 * Renderer-safe: no imports.
 */

/**
 * Whether `value` is an `http:` URL whose host is the local machine by literal
 * address, or the name `localhost` itself.
 *
 * Returns `false` for anything that does not parse, for any other scheme
 * (including `https:`, which callers admit on its own terms), and for every
 * hostname that is not one of the forms above.
 */
export function isLoopbackHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  return isLoopbackUrlHostname(parsed.hostname);
}

/**
 * The hostname half, for a caller that already parsed the URL.
 *
 * Takes `URL.hostname` as the parser produced it: lowercased, IPv4 canonicalised
 * from any of the octal/decimal/short forms, IPv6 canonicalised and still
 * bracketed. A trailing root dot survives parsing and is stripped here.
 */
export function isLoopbackUrlHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost") return true;
  if (host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
