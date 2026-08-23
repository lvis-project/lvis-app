/**
 * Tier A hostFetch egress gate — SSRF + allow-list policy.
 *
 * Exercises the pure `evaluateHostFetch` core directly so the egress contract
 * is pinned without standing up the full plugin runtime (mirrors
 * `network-access-allowlist.test.ts`). `node:dns` is stubbed so the DNS-aware
 * SSRF layer can be driven deterministically: an allow-listed name is pointed
 * at a private / loopback / link-local address and the decision is asserted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── dns mock — configurable per test via `lookupMock` ──────────────
const lookupMock = vi.fn<
  (host: string, opts: unknown) => Promise<Array<{ address: string; family: number }>>
>();

vi.mock("node:dns", () => ({
  promises: {
    lookup: (host: string, opts: unknown) => lookupMock(host, opts),
  },
}));

// Module under test imported AFTER the mock so network-guard's
// `import { promises as dns } from "node:dns"` binds to the stub.
const { evaluateHostFetch } = await import("../host-fetch-guard.js");

beforeEach(() => {
  lookupMock.mockReset();
});

const ALLOW = ["api.example.com"];

describe("evaluateHostFetch — allow-list + scheme gating", () => {
  it("denies a host not in the allow-list before any DNS lookup", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://evil.com/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-allowlisted");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("reports allow-list denials by hostname, not host:port", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://evil.com:8443/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("not-allowlisted");
      expect(decision.detail).toBe("https://evil.com not in networkAccess.allowedDomains");
      expect(decision.message).toContain("evil.com is not in networkAccess.allowedDomains");
      expect(decision.detail).not.toContain(":8443");
      expect(decision.message).not.toContain(":8443");
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("denies cleartext http even for an allow-listed host", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://api.example.com/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
  });

  it("denies an empty allow-list (deny-by-default)", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: [],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-allowlisted");
  });

  it("allows an allow-listed host resolving to a public address", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/v1/me",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.url.href).toBe("https://api.example.com/v1/me");
    expect(lookupMock).toHaveBeenCalledOnce();
  });
});

describe("evaluateHostFetch — method-awareness (host-observed effect)", () => {
  async function allowedWithMethod(method?: string) {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    return evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
      ...(method !== undefined ? { method } : {}),
    });
  }

  it.each(["GET", "HEAD", "OPTIONS", "get", "head", "options"])(
    "classifies safe verb %s as effect=read",
    async (method) => {
      const decision = await allowedWithMethod(method);
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.effect).toBe("read");
        expect(decision.method).toBe(method.toUpperCase());
      }
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "post", "put", "patch", "delete"])(
    "classifies mutating verb %s as effect=write",
    async (method) => {
      const decision = await allowedWithMethod(method);
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.effect).toBe("write");
        expect(decision.method).toBe(method.toUpperCase());
      }
    },
  );

  it("defaults to GET / effect=read when method is omitted", async () => {
    const decision = await allowedWithMethod(undefined);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.method).toBe("GET");
      expect(decision.effect).toBe("read");
    }
  });

  it("method does NOT change a deny decision — allow-list still wins (byte-for-byte)", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://evil.com/x",
      allowedDomains: ALLOW,
      method: "POST",
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-allowlisted");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("method does NOT bypass the SSRF guard — a POST to a private IP is still blocked", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
      method: "POST",
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });
});

describe("evaluateHostFetch — SSRF guard on allow-listed names", () => {
  it("rejects an allow-listed name resolving to the AWS metadata IP", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/latest/meta-data/",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });

  it("rejects an allow-listed name resolving to loopback (127.0.0.1)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });

  it("rejects an allow-listed name resolving to an RFC1918 address (DNS rebinding)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "192.168.1.10", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });
});

describe("evaluateHostFetch — allowPrivateNetworks governance opt-in", () => {
  it("permits an RFC1918 target only when the manifest opts in", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.185.177.209", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(true);
  });

  it("still rejects loopback even with allowPrivateNetworks (not a private LAN range)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });

  it("still rejects the metadata IP even with allowPrivateNetworks", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: ALLOW,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });
});

describe("evaluateHostFetch — declared loopback endpoint (local inference server)", () => {
  // What a user pointing a plugin at LM Studio / LiteLLM / a local proxy has:
  // a manifest that names the local machine, and a server that speaks http.
  const LOCAL = ["localhost", "127.0.0.1", "::1", "api.example.com"];

  it("allows cleartext http to a declared 127.0.0.1 endpoint", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://127.0.0.1:1234/v1/embeddings",
      method: "POST",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.effect).toBe("write");
    // An IP literal is its own resolution — no name to rebind, no lookup.
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("allows cleartext http to a declared localhost that resolves to loopback", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://localhost:1234/v1/embeddings",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(true);
  });

  it("allows https to the same declared loopback endpoint", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://127.0.0.1:8443/v1/embeddings",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(true);
  });

  it("matches a declared `::1` against the bracketed URL host", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://[::1]:1234/v1/embeddings",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(true);
  });

  it("denies cleartext http to loopback the manifest never declared", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://127.0.0.1:1234/v1/embeddings",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("denies https to loopback the manifest never declared", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://127.0.0.1:8443/x",
      allowedDomains: ALLOW,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-allowlisted");
  });

  it("denies cleartext http to a declared localhost that resolves off-machine", async () => {
    // Poisoned hosts file / rebinding answer: the literal was declared, but the
    // request would leave the machine, so the https rule applies again.
    lookupMock.mockResolvedValue([{ address: "203.0.113.7", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://localhost:1234/v1/embeddings",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("non-https");
      expect(decision.detail).toContain("does not resolve to loopback");
    }
  });

  it("denies cleartext http to a declared localhost that resolves to loopback AND a routable address", async () => {
    lookupMock.mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
      { address: "203.0.113.7", family: 4 },
    ]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://localhost:1234/v1/embeddings",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
  });

  it("denies cleartext http to a sub-label of a declared localhost", async () => {
    // `foo.localhost` dot-boundary-matches the allow-list entry, but it is not
    // the loopback literal — the exemption is by name, not by suffix.
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://foo.localhost/x",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
  });

  it("keeps cleartext denied for an ordinary allow-listed host, even with allowPrivateNetworks", async () => {
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "http://api.example.com/x",
      allowedDomains: LOCAL,
      allowPrivateNetworks: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("non-https");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("does not let a declared loopback endpoint open the LAN for other hosts", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });

  it("does not let a declared loopback endpoint rebind an ordinary host onto the machine", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const decision = await evaluateHostFetch({
      pluginId: "p",
      rawUrl: "https://api.example.com/x",
      allowedDomains: LOCAL,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("ssrf-blocked");
  });
});
