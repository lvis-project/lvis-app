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
const { evaluateHostFetch, runHostFetchHops, MAX_REDIRECT_HOPS } = await import(
  "../host-fetch-guard.js",
);

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

// ─── the hop loop — every followed redirect faces the same gate ─────────────

/** Public addresses for every lookup: the SSRF layer approves, the loop decides. */
function publicDns(): void {
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
}

/**
 * A scripted single-hop transport. Each entry answers one hop; the snapshots
 * are taken AT CALL TIME because the loop mutates one shared Headers object
 * across hops — reading it afterwards would show every call the final state.
 */
function scriptedTransport(responses: Response[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
    });
    const next = responses.shift();
    if (!next) throw new Error("scripted transport ran out of responses");
    return next;
  }) as unknown as typeof fetch;
  return { transport, calls };
}

const redirect = (status: number, location: string): Response =>
  new Response(null, { status, headers: { location } });

async function firstAllow(rawUrl: string, method = "GET") {
  const decision = await evaluateHostFetch({
    pluginId: "p",
    rawUrl,
    method,
    allowedDomains: ["api.example.com", "sso.example.com"],
  });
  if (!decision.ok) throw new Error(`test setup: first hop denied: ${decision.message}`);
  return decision;
}

function hopOptions(
  first: Awaited<ReturnType<typeof firstAllow>>,
  init: Omit<RequestInit, "method">,
  transport: typeof fetch,
) {
  const denials: Array<{ reason: string; detail: string }> = [];
  const hops: string[] = [];
  return {
    options: {
      pluginId: "p",
      first,
      init,
      transport,
      allowedDomains: ["api.example.com", "sso.example.com"],
      allowPrivateNetworks: false,
      auditHop: (line: string) => hops.push(line),
      auditDeny: (reason: string, detail: string) => denials.push({ reason, detail }),
    },
    denials,
    hops,
  };
}

describe("runHostFetchHops — redirect policy", () => {
  it("default (no redirect field) refuses a redirect, after one hop only", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "https://api.example.com/next")]);
    const { options, denials } = hopOptions(await firstAllow("https://api.example.com/a"), {}, transport);
    await expect(runHostFetchHops(options)).rejects.toThrow(/redirect refused/);
    expect(calls).toHaveLength(1);
    expect(denials[0]?.reason).toBe("redirect-cap");
  });

  it("an unrecognized policy value fails closed to the refusal", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "https://api.example.com/next")]);
    const { options } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "totally-new-mode" as RequestRedirect },
      transport,
    );
    await expect(runHostFetchHops(options)).rejects.toThrow(/redirect refused/);
    expect(calls).toHaveLength(1);
  });

  it("manual RETURNS the 3xx with its location readable — the SSO-detection case", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([
      redirect(302, "https://sso.example.com/login?from=api"),
    ]);
    const { options } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "manual" },
      transport,
    );
    const response = await runHostFetchHops(options);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://sso.example.com/login?from=api");
    expect(calls).toHaveLength(1);
  });

  it("follow takes the hop when the next URL passes the gate, and audits it", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([
      redirect(302, "https://sso.example.com/token"),
      new Response("landed", { status: 200 }),
    ]);
    const { options, hops } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow" },
      transport,
    );
    const response = await runHostFetchHops(options);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("landed");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.example.com/a",
      "https://sso.example.com/token",
    ]);
    expect(hops).toEqual(["host_fetch https://sso.example.com method=GET effect=read hop=1"]);
  });

  it("follow REFUSES a hop to a host outside the allow-list — the gate runs per hop", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "https://evil.com/steal")]);
    const { options, denials } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow" },
      transport,
    );
    await expect(runHostFetchHops(options)).rejects.toThrow(/not in networkAccess.allowedDomains/);
    expect(calls).toHaveLength(1);
    expect(denials[0]).toEqual({
      reason: "not-allowlisted",
      detail: "redirect hop 1: https://evil.com not in networkAccess.allowedDomains",
    });
  });

  it("follow refuses a downgrade to cleartext on a later hop — scheme is re-gated too", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([redirect(302, "http://api.example.com/a")]);
    const { options, denials } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow" },
      transport,
    );
    await expect(runHostFetchHops(options)).rejects.toThrow(/only https is permitted/);
    expect(calls).toHaveLength(1);
    expect(denials[0]?.reason).toBe("non-https");
  });

  it("stops at the hop cap instead of looping", async () => {
    publicDns();
    const bounce = () => redirect(302, "https://api.example.com/again");
    const { transport, calls } = scriptedTransport([
      bounce(), bounce(), bounce(), bounce(), bounce(), bounce(),
    ]);
    const { options, denials } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow" },
      transport,
    );
    await expect(runHostFetchHops(options)).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(MAX_REDIRECT_HOPS + 1);
    expect(denials[0]?.reason).toBe("redirect-cap");
  });

  it("a 3xx without a location is a final response, not a hop", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([new Response(null, { status: 302 })]);
    const { options } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow" },
      transport,
    );
    const response = await runHostFetchHops(options);
    expect(response.status).toBe(302);
    expect(calls).toHaveLength(1);
  });
});

describe("runHostFetchHops — method, body, and credentials across a followed hop", () => {
  it("303 turns POST into a bodyless GET, per fetch", async () => {
    publicDns();
    const { transport, calls } = scriptedTransport([
      redirect(303, "https://api.example.com/created"),
      new Response("ok", { status: 200 }),
    ]);
    const first = await firstAllow("https://api.example.com/submit", "POST");
    const { options } = hopOptions(
      first,
      { redirect: "follow", body: "payload", headers: { "content-type": "application/json" } },
      transport,
    );
    await runHostFetchHops(options);
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[1]).toMatchObject({ method: "GET", url: "https://api.example.com/created" });
    expect(calls[1]!.headers["content-type"]).toBeUndefined();
  });

  it("307 keeps the verb and the body", async () => {
    publicDns();
    let secondHopBody: unknown;
    const inner = scriptedTransport([
      redirect(307, "https://api.example.com/moved"),
      new Response("ok", { status: 200 }),
    ]);
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/moved")) secondHopBody = init?.body;
      return (inner.transport as unknown as typeof fetch)(input as string, init);
    }) as typeof fetch;
    const first = await firstAllow("https://api.example.com/submit", "PUT");
    const { options } = hopOptions(first, { redirect: "follow", body: "payload" }, transport);
    await runHostFetchHops(options);
    expect(inner.calls[1]).toMatchObject({ method: "PUT" });
    expect(secondHopBody).toBe("payload");
  });

  it("a cross-origin hop drops authorization and cookie; a same-origin hop keeps them", async () => {
    publicDns();
    const crossOrigin = scriptedTransport([
      redirect(302, "https://sso.example.com/login"),
      new Response("ok", { status: 200 }),
    ]);
    const { options: crossOptions } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      {
        redirect: "follow",
        headers: { authorization: "Bearer t", cookie: "sid=1", "x-app": "keep" },
      },
      crossOrigin.transport,
    );
    await runHostFetchHops(crossOptions);
    expect(crossOrigin.calls[0]!.headers.authorization).toBe("Bearer t");
    expect(crossOrigin.calls[1]!.headers.authorization).toBeUndefined();
    expect(crossOrigin.calls[1]!.headers.cookie).toBeUndefined();
    expect(crossOrigin.calls[1]!.headers["x-app"]).toBe("keep");

    const sameOrigin = scriptedTransport([
      redirect(302, "https://api.example.com/b"),
      new Response("ok", { status: 200 }),
    ]);
    const { options: sameOptions } = hopOptions(
      await firstAllow("https://api.example.com/a"),
      { redirect: "follow", headers: { authorization: "Bearer t" } },
      sameOrigin.transport,
    );
    await runHostFetchHops(sameOptions);
    expect(sameOrigin.calls[1]!.headers.authorization).toBe("Bearer t");
  });

  it("refuses to replay a stream body across a 307 instead of sending it empty", async () => {
    publicDns();
    const { transport } = scriptedTransport([redirect(307, "https://api.example.com/moved")]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    const first = await firstAllow("https://api.example.com/submit", "PUT");
    const { options } = hopOptions(first, { redirect: "follow", body: stream }, transport);
    await expect(runHostFetchHops(options)).rejects.toThrow(/cannot replay a stream body/);
  });
});
