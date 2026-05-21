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

describe("fetchPublicHttpResponse (mocked fetch)", () => {
  it("returns a successful response after validating the host", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchPublicHttpResponse("https://example.com/");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses an injected fetch implementation after DNS validation", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = vi.fn(async () =>
      new Response("chromium", { status: 200 }),
    );

    const resp = await fetchPublicHttpResponse("https://example.com/", {
      fetchImpl,
      headers: { "User-Agent": "LVIS-Assistant/0.1.0" },
    });

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("chromium");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({
        redirect: "manual",
        headers: { "User-Agent": "LVIS-Assistant/0.1.0" },
      }),
    );
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
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchPublicHttpResponse("https://start.example.com/");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("final");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both hops should have triggered DNS validation.
    expect(lookupMock).toHaveBeenCalledTimes(2);
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
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchPublicHttpResponse("https://start.example.com/"),
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
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchPublicHttpResponse("https://start.example.com/", {
      allowPrivateNetworks: true,
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("private");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts after too many redirects", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async (url: string) => {
      return new Response(null, {
        status: 302,
        headers: { location: new URL("/next", url).toString() },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchPublicHttpResponse("https://loop.example.com/start", {
        maxRedirects: 2,
      }),
    ).rejects.toThrowError(/too many redirects/);
  });
});
