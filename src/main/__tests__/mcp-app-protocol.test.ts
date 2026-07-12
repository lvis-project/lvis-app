import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMcpAppProxySession,
  disposeMcpAppProxySession,
  installMcpAppProtocolHandler,
  isDeclaredOriginForServer,
  isMcpAppPermissionGranted,
  _resetMcpAppProxySessions,
  _resetMcpAppProtocolHandlers,
} from "../mcp-app-protocol.js";
import { buildMcpCspHeader } from "../../shared/mcp-app-csp.js";
import { encodeMcpServerId } from "../../shared/mcp-app-partition.js";
import type { McpUiResourceCsp } from "../../mcp/types.js";

/**
 * MAJOR-1 (cluster critic) — the `lvis-mcp-app://` `protocol.handle` callback makes
 * EVERY security decision for the containment boundary (400 bad-url, 404 unknown
 * token, 403 authority/token mismatch, and the CSP header value), yet nothing in the
 * suite invoked it — the partition test only asserted it was registered. So a refactor
 * that dropped the authority check or emitted a permissive CSP kept the whole gate
 * green. These tests capture the handler and drive it directly.
 */

type Handler = (request: { url: string }) => Response;

/** Capture the callback `installMcpAppProtocolHandler` registers on a fresh session. */
function installAndCapture(partition = "lvis-mcp-app:probe"): Handler {
  const handle = vi.fn();
  const ses = { protocol: { handle } } as unknown as Electron.Session;
  installMcpAppProtocolHandler(partition, ses);
  expect(handle).toHaveBeenCalledWith("lvis-mcp-app", expect.any(Function));
  return handle.mock.calls[0][1] as Handler;
}

function proxyUrlFor(serverId: string, csp?: McpUiResourceCsp): { url: string; token: string } {
  const url = createMcpAppProxySession(serverId, csp);
  const token = new URL(url).searchParams.get("t")!;
  return { url, token };
}

beforeEach(() => {
  _resetMcpAppProxySessions();
  _resetMcpAppProtocolHandlers();
});

describe("mcp-app-protocol — the protocol.handle security callback", () => {
  it("valid token + matching authority → 200 with the resource's CSP as a response HEADER", async () => {
    const handler = installAndCapture();
    const csp: McpUiResourceCsp = { connectDomains: ["https://api.example.com"] };
    const { url } = proxyUrlFor("srv-a", csp);

    const res = handler({ url });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(buildMcpCspHeader(csp));
    // The declared host is in the header; the restrictive floor is intact.
    expect(res.headers.get("Content-Security-Policy")).toContain("connect-src https://api.example.com");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toContain("text/html");
    // The static proxy document is script-free (the inner iframe is created by the
    // relay preload at runtime, not baked in) — so assert on its actual content.
    const body = await res.text();
    expect(body).toContain("<title>MCP App</title>");
    expect(body).not.toContain("<script"); // nothing the server controls runs here
  });

  it("serves the host-computed `allow` meta ONLY for a resource that declared permissions", async () => {
    const handler = installAndCapture();
    // A resource that declared geolocation ⇒ the proxy document carries the allow meta,
    // computed in main from the closed feature table (never renderer/app-supplied).
    const withPerms = createMcpAppProxySession("srv-perm", undefined, { geolocation: {} });
    const withBody = await handler({ url: withPerms }).text();
    expect(withBody).toContain('<meta name="lvis-mcp-app-allow" content="geolocation">');

    // A resource that declared NOTHING ⇒ no allow meta at all (fail-closed default).
    const noPerms = createMcpAppProxySession("srv-noperm");
    const noBody = await handler({ url: noPerms }).text();
    expect(noBody).not.toContain("lvis-mcp-app-allow");
  });

  it("AUTHORITY/TOKEN MISMATCH → 403 (a proxy origin cannot serve another server's session)", () => {
    const handler = installAndCapture();
    const { token } = proxyUrlFor("srv-a");
    // Same valid token, but the URL authority is a DIFFERENT server's hex.
    const otherAuthority = encodeMcpServerId("srv-b");
    const res = handler({ url: `lvis-mcp-app://${otherAuthority}/proxy.html?t=${token}` });
    expect(res.status).toBe(403);
  });

  it("unknown token → 404", () => {
    const handler = installAndCapture();
    const authority = encodeMcpServerId("srv-a");
    const res = handler({ url: `lvis-mcp-app://${authority}/proxy.html?t=does-not-exist` });
    expect(res.status).toBe(404);
  });

  it("absent token → 404", () => {
    const handler = installAndCapture();
    const authority = encodeMcpServerId("srv-a");
    const res = handler({ url: `lvis-mcp-app://${authority}/proxy.html` });
    expect(res.status).toBe(404);
  });

  it("malformed url → 400", () => {
    const handler = installAndCapture();
    const res = handler({ url: "::::not a url::::" });
    expect(res.status).toBe(400);
  });

  it("a disposed token no longer resolves → 404 (dispose is honored)", () => {
    const handler = installAndCapture();
    const { url, token } = proxyUrlFor("srv-a");
    expect(handler({ url }).status).toBe(200);
    disposeMcpAppProxySession(token);
    expect(handler({ url }).status).toBe(404);
  });
});

describe("mcp-app-protocol — isMcpAppPermissionGranted (the Electron permission chokepoint)", () => {
  // The `revoked` and `mic-only` real-<webview> cards, in code form: the decision is keyed
  // off the proxy TOKEN in the frame URL, so it fail-closes on every way the token can be
  // wrong, grants ONLY the resource's own declaration, and honors the media-kind split.
  it("grants ONLY what the card's resource declared", () => {
    const url = createMcpAppProxySession("srv-geo", undefined, { geolocation: {} });
    expect(isMcpAppPermissionGranted(url, "geolocation")).toBe(true);
    // declared geolocation does not open the camera (Electron `media`).
    expect(isMcpAppPermissionGranted(url, "media", ["video"])).toBe(false);
  });

  it("a card that declared nothing is denied everything (a session with no declaration grants nothing)", () => {
    const url = createMcpAppProxySession("srv-none", undefined, undefined);
    expect(isMcpAppPermissionGranted(url, "geolocation")).toBe(false);
    expect(isMcpAppPermissionGranted(url, "media", ["video"])).toBe(false);
  });

  it("media-kind split: a mic-only card is granted the mic and DENIED the camera", () => {
    const url = createMcpAppProxySession("srv-mic", undefined, { microphone: {} });
    expect(isMcpAppPermissionGranted(url, "media", ["audio"])).toBe(true);
    expect(isMcpAppPermissionGranted(url, "media", ["video"])).toBe(false);
  });

  it("deny-by-default on every bad token: absent url, foreign scheme, unknown token, authority mismatch", () => {
    const url = createMcpAppProxySession("srv-geo", undefined, { geolocation: {} });
    const token = new URL(url).searchParams.get("t")!;
    expect(isMcpAppPermissionGranted(undefined, "geolocation")).toBe(false);
    expect(isMcpAppPermissionGranted("https://evil.example/x", "geolocation")).toBe(false);
    expect(
      isMcpAppPermissionGranted(
        `lvis-mcp-app://${encodeMcpServerId("srv-geo")}/proxy.html?t=not-a-token`,
        "geolocation",
      ),
    ).toBe(false);
    // Valid token, but the URL authority is a DIFFERENT server's hex → mismatch → deny.
    expect(
      isMcpAppPermissionGranted(
        `lvis-mcp-app://${encodeMcpServerId("srv-other")}/proxy.html?t=${token}`,
        "geolocation",
      ),
    ).toBe(false);
  });

  it("a disposed session is denied (the revoked-card guarantee)", () => {
    const url = createMcpAppProxySession("srv-geo", undefined, { geolocation: {} });
    const token = new URL(url).searchParams.get("t")!;
    expect(isMcpAppPermissionGranted(url, "geolocation")).toBe(true);
    disposeMcpAppProxySession(token);
    expect(isMcpAppPermissionGranted(url, "geolocation")).toBe(false);
  });
});

describe("mcp-app-protocol — declared-origin tracking (CSP ↔ network gate lockstep)", () => {
  it("records exactly the origins a server's resources declared, per server", () => {
    createMcpAppProxySession("srv-a", { connectDomains: ["https://api.example.com"] });
    createMcpAppProxySession("srv-a", { resourceDomains: ["https://cdn.example.com"] });
    createMcpAppProxySession("srv-b", { connectDomains: ["https://only-b.example.com"] });

    expect(isDeclaredOriginForServer("srv-a", "https://api.example.com")).toBe(true);
    expect(isDeclaredOriginForServer("srv-a", "https://cdn.example.com")).toBe(true);
    // Not declared by srv-a...
    expect(isDeclaredOriginForServer("srv-a", "https://only-b.example.com")).toBe(false);
    // ...and never granted for a server with nothing declared.
    expect(isDeclaredOriginForServer("srv-none", "https://api.example.com")).toBe(false);
  });
});
