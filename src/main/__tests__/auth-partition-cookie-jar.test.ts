/**
 * The host-side session-cookie vault: scoping + jar reads.
 *
 * The scoping half is a port of the rules EP's `cookieScope.ts` enforced from
 * inside the plugin, so these cases are deliberately the SAME questions that
 * module answered — including the ONE documented divergence from RFC 6265 §5.4
 * (a Secure cookie is NOT withheld from an `http://` request, because legacy
 * corporate portals serve authenticated pages over plain HTTP). A regression
 * there does not fail loudly at runtime; it silently withholds a session cookie
 * and the portal answers 401, so it is pinned here.
 */
import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import {
  cookieHeaderForUrl,
  domainMatches,
  isCookieExpired,
  normalizeCookieDomain,
  partitionCookieHeaderForUrl,
  partitionCookiesForUrl,
  pathMatches,
  readPartitionJar,
  selectCookiesForUrl,
  type JarCookie,
} from "../auth-partition-cookie-jar.js";

function sessionWithJar(cookies: unknown[]): Session {
  return { cookies: { get: vi.fn(async () => cookies) } } as unknown as Session;
}

describe("cookie domain/path matching", () => {
  it("strips exactly one leading dot — `.example.com` and `example.com` scope alike", () => {
    expect(normalizeCookieDomain(".example.com")).toBe("example.com");
    expect(normalizeCookieDomain("example.com")).toBe("example.com");
    expect(normalizeCookieDomain("..example.com")).toBe(".example.com");
  });

  it("treats a domain-less cookie as host-matching (path check narrows it)", () => {
    expect(domainMatches("portal.example.com", undefined)).toBe(true);
    expect(domainMatches("portal.example.com", "")).toBe(true);
  });

  it("matches a host to its own domain and to sub-domains, not to a sibling", () => {
    expect(domainMatches("example.com", "example.com")).toBe(true);
    expect(domainMatches("portal.example.com", ".example.com")).toBe(true);
    expect(domainMatches("example.com.evil.test", "example.com")).toBe(false);
    expect(domainMatches("notexample.com", "example.com")).toBe(false);
  });

  it("matches paths per RFC 6265 §5.1.4", () => {
    expect(pathMatches("/anything", "/")).toBe(true);
    expect(pathMatches("/app", "/app")).toBe(true);
    expect(pathMatches("/app/sub", "/app")).toBe(true);
    expect(pathMatches("/application", "/app")).toBe(false);
    expect(pathMatches("/app", undefined)).toBe(true);
  });

  it("treats a past expirationDate as expired and a session cookie as not", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 600;
    expect(isCookieExpired({ name: "a", value: "1", expirationDate: past })).toBe(true);
    expect(isCookieExpired({ name: "a", value: "1", expirationDate: future })).toBe(false);
    expect(isCookieExpired({ name: "a", value: "1" })).toBe(false);
  });
});

describe("selectCookiesForUrl", () => {
  const jar: JarCookie[] = [
    { name: "SMSESSION", value: "sso", domain: ".example.com", path: "/" },
    { name: "JSESSIONID", value: "broad", domain: ".example.com", path: "/" },
    { name: "JSESSIONID", value: "specific", domain: "portal.example.com", path: "/app" },
    { name: "OTHER", value: "elsewhere", domain: "other.test", path: "/" },
    {
      name: "STALE",
      value: "old",
      domain: ".example.com",
      path: "/",
      expirationDate: Math.floor(Date.now() / 1000) - 10,
    },
  ];

  it("keeps the most specific cookie when two share a name", () => {
    const picked = selectCookiesForUrl(jar, new URL("https://portal.example.com/app/x"));
    const jsession = picked.find((c) => c.name === "JSESSIONID");
    expect(jsession?.value).toBe("specific");
  });

  it("excludes another host's cookie and an expired one", () => {
    const names = selectCookiesForUrl(jar, new URL("https://portal.example.com/app/x"))
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["JSESSIONID", "SMSESSION"]);
  });

  it("falls back to the broad cookie on a path the specific one does not cover", () => {
    const picked = selectCookiesForUrl(jar, new URL("https://portal.example.com/other"));
    expect(picked.find((c) => c.name === "JSESSIONID")?.value).toBe("broad");
  });

  it("KEEPS a Secure-marked session cookie on an http:// request (legacy-portal divergence)", () => {
    // The upstream IdP marks session cookies Secure while the legacy intranet
    // portal serves authenticated pages over plain HTTP. A strict RFC 6265 §5.4
    // check here would withhold the credential and every such call would 401.
    const header = cookieHeaderForUrl(jar, new URL("http://portal.example.com/app/x"));
    expect(header).toContain("SMSESSION=sso");
    expect(header).toContain("JSESSIONID=specific");
  });

  it("builds an empty header when nothing applies", () => {
    expect(cookieHeaderForUrl(jar, new URL("https://unrelated.test/"))).toBe("");
  });
});

describe("partition jar reads", () => {
  it("enumerates the WHOLE jar rather than filtering by url", async () => {
    const session = sessionWithJar([
      { name: "A", value: "1", domain: ".example.com", path: "/" },
    ]);
    await readPartitionJar(session);
    // `get({})`, not `get({ url })` — the url filter would apply Chromium's own
    // Secure check and undo the divergence pinned above.
    expect(session.cookies.get).toHaveBeenCalledWith({});
  });

  it("returns a Cookie header scoped to the request URL", async () => {
    const session = sessionWithJar([
      { name: "SMSESSION", value: "sso", domain: ".example.com", path: "/" },
      { name: "OTHER", value: "x", domain: "other.test", path: "/" },
    ]);
    const header = await partitionCookieHeaderForUrl(
      session,
      new URL("https://portal.example.com/api/me"),
    );
    expect(header).toBe("SMSESSION=sso");
  });

  it("returns value-carrying cookies for the gated read", async () => {
    const session = sessionWithJar([
      { name: "SMSESSION", value: "sso", domain: ".example.com", path: "/" },
    ]);
    const cookies = await partitionCookiesForUrl(
      session,
      new URL("https://portal.example.com/"),
    );
    expect(cookies).toEqual([
      { name: "SMSESSION", value: "sso", domain: ".example.com", path: "/" },
    ]);
  });

  it("drops undefined attributes rather than emitting them as keys", async () => {
    const session = sessionWithJar([{ name: "A", value: "1" }]);
    const jar = await readPartitionJar(session);
    expect(Object.keys(jar[0]!).sort()).toEqual(["name", "value"]);
  });
});
