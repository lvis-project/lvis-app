/**
 * NetworkGuard (Tier A2) unit tests.
 *
 * No live HTTP or DNS is performed. `dns.lookup` is stubbed via
 * `vi.mock` and `fetch` (for the redirect test) via `vi.stubGlobal`.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// ─── dns mock — configurable per test via `lookupMock` ──────────────
type LookupResult = { address: string; family: number };

const lookupMock = vi.fn<
  (host: string, opts: unknown) => Promise<LookupResult[]>
>();

vi.mock("node:dns", () => ({
  promises: {
    lookup: (host: string, opts: unknown) => lookupMock(host, opts),
  },
}));

// Module must be imported AFTER the mock.
import {
  isGloballyRoutableAddress,
  NetworkGuardError,
  validateHttpUrl,
  ensurePublicHttpUrl,
  fetchPublicHttpResponse,
} from "../network-guard.js";

beforeEach(() => {
  lookupMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateHttpUrl", () => {
  it("accepts a normal https URL", () => {
    const url = validateHttpUrl("https://example.com/path?q=1");
    expect(url.hostname).toBe("example.com");
    expect(url.protocol).toBe("https:");
  });

  it("accepts a normal http URL", () => {
    const url = validateHttpUrl("http://example.com/");
    expect(url.hostname).toBe("example.com");
  });

  it("rejects ftp scheme", () => {
    expect(() => validateHttpUrl("ftp://example.com/")).toThrowError(
      NetworkGuardError,
    );
  });

  it("rejects javascript: scheme", () => {
    expect(() => validateHttpUrl("javascript:alert(1)")).toThrowError(
      NetworkGuardError,
    );
  });

  it("rejects file:// scheme", () => {
    expect(() => validateHttpUrl("file:///etc/passwd")).toThrowError(
      NetworkGuardError,
    );
  });

  it("rejects URLs with embedded user:pass credentials", () => {
    expect(() =>
      validateHttpUrl("http://user:pass@example.com/"),
    ).toThrowError(/credentials/);
  });

  it("rejects URLs with only an embedded username", () => {
    expect(() => validateHttpUrl("http://user@example.com/")).toThrowError(
      /credentials/,
    );
  });

  it("rejects a malformed URL", () => {
    expect(() => validateHttpUrl("not a url")).toThrowError(/malformed/);
  });
});

describe("ensurePublicHttpUrl — IP literal blocking", () => {
  it("blocks http://10.0.0.1 (RFC 1918)", async () => {
    await expect(ensurePublicHttpUrl("http://10.0.0.1/")).rejects.toThrowError(
      /non-public/,
    );
  });

  it("blocks http://127.0.0.1 (loopback)", async () => {
    await expect(
      ensurePublicHttpUrl("http://127.0.0.1/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("blocks http://169.254.169.254 (AWS metadata)", async () => {
    await expect(
      ensurePublicHttpUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("blocks http://192.168.1.1 (home LAN)", async () => {
    await expect(
      ensurePublicHttpUrl("http://192.168.1.1/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("blocks http://172.16.0.5 (12-bit private)", async () => {
    await expect(
      ensurePublicHttpUrl("http://172.16.0.5/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("blocks http://100.64.0.1 (CGNAT)", async () => {
    await expect(
      ensurePublicHttpUrl("http://100.64.0.1/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("blocks http://0.0.0.0 (this network)", async () => {
    await expect(
      ensurePublicHttpUrl("http://0.0.0.0/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("accepts a host that resolves to a public IPv4", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const url = await ensurePublicHttpUrl("https://example.com/");
    expect(url.hostname).toBe("example.com");
    expect(lookupMock).toHaveBeenCalledOnce();
  });

  it("rejects a host that resolves to a private IPv4 (DNS-based bypass)", async () => {
    // Attacker-controlled domain returns 10.0.0.5 via DNS.
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(
      ensurePublicHttpUrl("https://evil.example.com/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("rejects when ANY resolved address is private (mixed DNS response)", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(
      ensurePublicHttpUrl("https://mixed.example.com/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("rejects when host fails to resolve (empty address list)", async () => {
    lookupMock.mockResolvedValueOnce([]);
    await expect(
      ensurePublicHttpUrl("https://ghost.example.com/"),
    ).rejects.toThrowError(/did not resolve/);
  });
});

describe("ensurePublicHttpUrl — explicit private network access", () => {
  it("allows RFC1918 IPv4 literals when explicitly enabled", async () => {
    const url = await ensurePublicHttpUrl("http://10.185.177.209/", {
      allowPrivateNetworks: true,
    });
    expect(url.hostname).toBe("10.185.177.209");
  });

  it("allows DNS hosts that resolve to RFC1918 IPv4 when explicitly enabled", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.185.177.209", family: 4 }]);
    const url = await ensurePublicHttpUrl("https://internal.example.com/", {
      allowPrivateNetworks: true,
    });
    expect(url.hostname).toBe("internal.example.com");
  });

  it("keeps loopback blocked even when private network access is enabled", async () => {
    await expect(
      ensurePublicHttpUrl("http://127.0.0.1/", { allowPrivateNetworks: true }),
    ).rejects.toThrowError(/non-public/);
  });

  it("allows loopback only when the separate loopback gate is enabled", async () => {
    const url = await ensurePublicHttpUrl("http://127.0.0.1/", {
      allowLoopback: true,
    });
    expect(url.hostname).toBe("127.0.0.1");
  });

  it("keeps CGNAT blocked when only private network access is enabled", async () => {
    await expect(
      ensurePublicHttpUrl("http://100.75.34.2:30000/v1", {
        allowPrivateNetworks: true,
      }),
    ).rejects.toThrowError(/non-public/);
  });

  it("allows CGNAT only when the separate tailnet gate is enabled", async () => {
    const url = await ensurePublicHttpUrl("http://100.75.34.2:30000/v1", {
      allowCarrierGradeNat: true,
    });
    expect(url.hostname).toBe("100.75.34.2");
  });

  it("allows DNS hosts that resolve into CGNAT when the tailnet gate is enabled", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "100.75.34.2", family: 4 }]);
    const url = await ensurePublicHttpUrl("http://host.example.ts.net/v1", {
      allowCarrierGradeNat: true,
    });
    expect(url.hostname).toBe("host.example.ts.net");
  });

  it("allows the IPv4-mapped IPv6 form of a CGNAT address when the tailnet gate is enabled", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "::ffff:100.75.34.2", family: 6 }]);
    const url = await ensurePublicHttpUrl("http://mapped.example.ts.net/v1", {
      allowCarrierGradeNat: true,
    });
    expect(url.hostname).toBe("mapped.example.ts.net");
  });

  it("keeps RFC1918 blocked when only the tailnet gate is enabled", async () => {
    await expect(
      ensurePublicHttpUrl("http://10.185.177.209/", { allowCarrierGradeNat: true }),
    ).rejects.toThrowError(/non-public/);
  });

  it("keeps loopback and metadata blocked when the tailnet gate is enabled", async () => {
    await expect(
      ensurePublicHttpUrl("http://127.0.0.1/", { allowCarrierGradeNat: true }),
    ).rejects.toThrowError(/non-public/);
    await expect(
      ensurePublicHttpUrl("http://169.254.169.254/latest/meta-data/", {
        allowCarrierGradeNat: true,
      }),
    ).rejects.toThrowError(/non-public/);
  });

  it("honours a predicate that scopes the tailnet gate to one origin", async () => {
    const scoped = (url: URL) => url.origin === "http://100.75.34.2:30000";
    const url = await ensurePublicHttpUrl("http://100.75.34.2:30000/v1", {
      allowCarrierGradeNat: scoped,
    });
    expect(url.port).toBe("30000");
    await expect(
      ensurePublicHttpUrl("http://100.75.34.2:8080/v1", { allowCarrierGradeNat: scoped }),
    ).rejects.toThrowError(/non-public/);
  });

  it("keeps link-local metadata blocked even when private network access is enabled", async () => {
    await expect(
      ensurePublicHttpUrl("http://169.254.169.254/latest/meta-data/", {
        allowPrivateNetworks: true,
      }),
    ).rejects.toThrowError(/non-public/);
  });
});

describe("ensurePublicHttpUrl — IPv6", () => {
  it("blocks http://[::1] (IPv6 loopback)", async () => {
    await expect(ensurePublicHttpUrl("http://[::1]/")).rejects.toThrowError(
      /non-public/,
    );
  });

  it("blocks http://[fe80::1] (IPv6 link-local)", async () => {
    await expect(
      ensurePublicHttpUrl("http://[fe80::1]/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("blocks http://[fc00::1] (IPv6 ULA)", async () => {
    await expect(
      ensurePublicHttpUrl("http://[fc00::1]/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("blocks http://[fd00::1] (IPv6 ULA)", async () => {
    await expect(
      ensurePublicHttpUrl("http://[fd00::1]/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("blocks IPv4-mapped IPv6 [::ffff:10.0.0.1]", async () => {
    await expect(
      ensurePublicHttpUrl("http://[::ffff:10.0.0.1]/"),
    ).rejects.toThrowError(/non-public/);
  });

  it("accepts a public IPv6 literal without calling DNS", async () => {
    // 2606:4700:4700::1111 is a Cloudflare public resolver — literal only.
    const url = await ensurePublicHttpUrl("http://[2606:4700:4700::1111]/");
    expect(url.hostname).toBe("[2606:4700:4700::1111]");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("allows IPv6 ULA when private network access is explicitly enabled", async () => {
    const url = await ensurePublicHttpUrl("http://[fd00::1]/", {
      allowPrivateNetworks: true,
    });
    expect(url.hostname).toBe("[fd00::1]");
  });
});

describe("isGloballyRoutableAddress — the IANA special-purpose registry", () => {
  // These ranges were reachable before the transport's classifier and the
  // guard's were merged: the guard knew RFC1918 and little else, so a
  // redirect or a DNS answer landing on multicast, on reserved space, or on
  // documentation address space passed as "public". None of them can carry an
  // HTTP conversation with a host on the internet, which is what makes them
  // useful to an attacker steering a request and useless to a real caller.
  it.each([
    ["0.0.0.0", "this network"],
    ["192.0.0.1", "IETF protocol assignments"],
    ["192.0.2.1", "documentation (TEST-NET-1)"],
    ["192.88.99.1", "6to4 relay anycast"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.1", "documentation (TEST-NET-2)"],
    ["203.0.113.1", "documentation (TEST-NET-3)"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("refuses %s (%s)", (address) => {
    expect(isGloballyRoutableAddress(address)).toBe(false);
  });

  it.each([
    ["192.0.0.9", "PCP anycast"],
    ["192.0.0.10", "NAT64/DNS64 discovery"],
  ])("still allows %s (%s), which IANA marks globally reachable", (address) => {
    expect(isGloballyRoutableAddress(address)).toBe(true);
  });

  it.each([
    ["ff02::1", "link-local all-nodes multicast"],
    ["2001:db8::1", "documentation"],
    ["2002::1", "6to4"],
    ["3fff::1", "documentation"],
    ["5f00::1", "SRv6 SIDs"],
    ["100::1", "discard-only, and outside global unicast"],
  ])("refuses [%s] (%s)", (address) => {
    expect(isGloballyRoutableAddress(address)).toBe(false);
  });

  it("still allows 64:ff9b::1 (NAT64), which sits outside global unicast", () => {
    expect(isGloballyRoutableAddress("64:ff9b::1")).toBe(true);
  });

  it("allows an ordinary public IPv6 address", () => {
    expect(isGloballyRoutableAddress("2606:4700:4700::1111")).toBe(true);
  });

  // The old IPv6 test was textual — `lower === "::1"`, `startsWith("fc")` —
  // and an address is not obliged to arrive in its compressed form. A DNS
  // answer is not normalised the way a URL literal is, so the fully expanded
  // loopback address reached the guard as written and read as public.
  it("recognises the expanded form of an address, not just the compressed one", () => {
    expect(isGloballyRoutableAddress("0:0:0:0:0:0:0:1")).toBe(false);
    expect(isGloballyRoutableAddress("fe80:0:0:0:0:0:0:1")).toBe(false);
    expect(isGloballyRoutableAddress("fd00:0:0:0:0:0:0:1")).toBe(false);
  });

  it("refuses an unknown address family", () => {
    expect(isGloballyRoutableAddress("not-an-address")).toBe(false);
  });
});

describe("ensurePublicHttpUrl — reserved space is not reachable by opting in", () => {
  // `allowPrivateNetworks` names the user's own LAN, which is a destination
  // with a legitimate yes. It must not double as a key to every block the
  // registry lists, or one option would quietly widen the guard from "reach
  // my network" to "reach anything".
  it.each(["224.0.0.1", "240.0.0.1", "192.0.2.1"])(
    "keeps %s blocked even with private network access enabled",
    async (address) => {
      await expect(
        ensurePublicHttpUrl(`http://${address}/`, { allowPrivateNetworks: true }),
      ).rejects.toThrowError(/non-public/);
    },
  );

  it("keeps the LAN reachable with that same option", async () => {
    const url = await ensurePublicHttpUrl("http://10.0.0.5/", {
      allowPrivateNetworks: true,
    });
    expect(url.hostname).toBe("10.0.0.5");
  });

  it("refuses a DNS answer that resolves to multicast", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "224.0.0.251", family: 4 }]);
    await expect(ensurePublicHttpUrl("http://mdns.example/")).rejects.toThrowError(
      /non-public/,
    );
  });
});

describe("ensurePublicHttpUrl — syntactic rejects", () => {
  it("rejects non-http protocol", async () => {
    await expect(ensurePublicHttpUrl("ftp://example.com/")).rejects.toThrowError(
      NetworkGuardError,
    );
  });

  it("rejects embedded credentials", async () => {
    await expect(
      ensurePublicHttpUrl("http://user:pass@example.com/"),
    ).rejects.toThrowError(/credentials/);
  });

  it("rejects a malformed URL", async () => {
    await expect(ensurePublicHttpUrl("not-a-url")).rejects.toThrowError(
      /malformed/,
    );
  });
});

/**
 * The ambient `fetch`, as these tests require it to be: unreachable.
 *
 * The guard takes its transport as a required argument and must never touch
 * the global. Stubbing the global with the SAME mock the test injects would
 * hide a regression back to the ambient stack — the call counts would match
 * either way. A throwing stub makes that regression fail instead of pass.
 */
const ambientFetchIsOffLimits = (() => {
  throw new Error("network-guard reached the ambient fetch; it must use fetchImpl");
}) as unknown as typeof fetch;

describe("fetchPublicHttpResponse (mocked fetch)", () => {
  it("returns a successful response after validating the host", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    );
    vi.stubGlobal("fetch", ambientFetchIsOffLimits);

    const resp = await fetchPublicHttpResponse("https://example.com/", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the injected fetch implementation when provided", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async () =>
      new Response("electron", { status: 200 }),
    );

    const resp = await fetchPublicHttpResponse("https://example.com/", {
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("electron");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("validates every hop of a redirect chain", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://final.example.com/ok" },
        }),
      )
      .mockResolvedValueOnce(new Response("final", { status: 200 }));
    vi.stubGlobal("fetch", ambientFetchIsOffLimits);

    const resp = await fetchPublicHttpResponse("https://start.example.com/", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("final");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both hops should have triggered DNS validation.
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  // The guard's per-hop re-validation is only real if it survives the transport
  // swap: a host caller runs on an injected Chromium-stack fetch, and that
  // transport returns the 3xx instead of chasing it. Both properties are
  // measured here against the injected implementation, not the ambient one.
  it("re-validates every hop of a redirect chain served by an injected transport", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const ambient = vi.fn();
    vi.stubGlobal("fetch", ambient);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://final.example.com/ok" },
        }),
      )
      .mockResolvedValueOnce(new Response("final", { status: 200 }));

    const resp = await fetchPublicHttpResponse("https://start.example.com/", {
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(ambient).not.toHaveBeenCalled();
    // Every hop is asked for manually so the guard, not the transport, decides
    // whether the next request happens.
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).redirect).toBe("manual");
    }
  });

  it("rejects a private redirect target reached through an injected transport", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.1/internal" },
      }),
    );

    await expect(
      fetchPublicHttpResponse("https://start.example.com/", {
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toThrowError(/non-public/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a private target before an injected transport is called", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const fetchMock = vi.fn();

    await expect(
      fetchPublicHttpResponse("https://intranet.example.com/", {
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toThrowError(/non-public/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a redirect that points to a private IP", async () => {
    // First hop resolves public, second hop is http://10.0.0.1/ → blocked
    // before fetch is called.
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
    ]);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.1/internal" },
      }),
    );
    vi.stubGlobal("fetch", ambientFetchIsOffLimits);

    await expect(
      fetchPublicHttpResponse("https://start.example.com/", {
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrowError(/non-public/);
    // fetch ran exactly once (the first hop); the second hop was blocked
    // by ensurePublicHttpUrl before any network call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows a private-IP redirect when explicitly enabled", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://10.0.0.1/internal" },
        }),
      )
      .mockResolvedValueOnce(new Response("private", { status: 200 }));
    vi.stubGlobal("fetch", ambientFetchIsOffLimits);

    const resp = await fetchPublicHttpResponse("https://start.example.com/", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      allowPrivateNetworks: true,
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("private");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("scopes private-IP redirects through the allowPrivateNetworks predicate", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.1/internal" },
      }),
    );
    vi.stubGlobal("fetch", ambientFetchIsOffLimits);

    await expect(
      fetchPublicHttpResponse("https://start.example.com/", {
        fetchImpl: fetchMock as unknown as typeof fetch,
        allowPrivateNetworks: (url) => url.hostname === "start.example.com",
      }),
    ).rejects.toThrowError(/non-public/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("scopes loopback redirects through the allowLoopback predicate", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
      }),
    );
    vi.stubGlobal("fetch", ambientFetchIsOffLimits);

    await expect(
      fetchPublicHttpResponse("https://start.example.com/", {
        fetchImpl: fetchMock as unknown as typeof fetch,
        allowLoopback: (url) => url.hostname === "start.example.com",
      }),
    ).rejects.toThrowError(/non-public/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts after too many redirects", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async (url: string) => {
      return new Response(null, {
        status: 302,
        headers: { location: new URL("/next", url).toString() },
      });
    });
    vi.stubGlobal("fetch", ambientFetchIsOffLimits);

    await expect(
      fetchPublicHttpResponse("https://loop.example.com/start", {
        fetchImpl: fetchMock as unknown as typeof fetch,
        maxRedirects: 2,
      }),
    ).rejects.toThrowError(/too many redirects/);
  });
});
