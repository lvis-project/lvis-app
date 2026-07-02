/**
 * http-server + stream-broadcaster — #1436 loopback transport + secret auth.
 *
 * Spins a REAL node:http server on an ephemeral port (port 0) and drives it with
 * REAL `fetch` (node environment). Asserts the fail-closed axes:
 *   - auth on every route (401 missing / 401 wrong / 200 with correct secret),
 *   - dispatch success (200 {ok:true}) and rejection passthrough (403 codes),
 *   - request validation (400 malformed / 400 missing channel / 413 over-cap),
 *   - handler throw → 500 without leaking the thrown message,
 *   - loopback binding (port>0, address 127.0.0.1),
 *   - broadcaster fan-out / unsubscribe / throwing-subscriber isolation.
 *
 * Every server is torn down in afterEach so vitest exits with no leaked handles.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startLocalApiHttpServer,
  type LocalApiHttpServer,
} from "../http-server.js";
import { createStreamBroadcaster } from "../stream-broadcaster.js";
import type { LocalApi, LocalApiResult } from "../local-api.js";

const SECRET = "test-secret-0123456789abcdef";

/** Build a stub dispatcher that returns a fixed result (or throws). */
function stubApi(
  impl: (req: { channel: string; args?: unknown; origin: string }) => LocalApiResult,
): LocalApi {
  return { dispatch: vi.fn(async (req) => impl(req)) };
}

let servers: LocalApiHttpServer[] = [];

async function start(api: LocalApi, secret = SECRET): Promise<LocalApiHttpServer> {
  const broadcaster = createStreamBroadcaster();
  const server = await startLocalApiHttpServer({ api, secret, broadcaster, host: "127.0.0.1", port: 0 });
  servers.push(server);
  return server;
}

function url(server: LocalApiHttpServer, path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

function authHeaders(secret = SECRET): Record<string, string> {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

afterEach(async () => {
  const toClose = servers;
  servers = [];
  for (const s of toClose) {
    await s.close();
  }
});

describe("http-server — auth on every route", () => {
  it("returns 401 without Authorization", async () => {
    const server = await start(stubApi(() => ({ ok: true, data: {} })));
    const res = await fetch(url(server, "/v1/health"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("returns 401 with a wrong secret", async () => {
    const server = await start(stubApi(() => ({ ok: true, data: {} })));
    const res = await fetch(url(server, "/v1/health"), { headers: authHeaders("wrong-secret") });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("returns 200 health with the correct secret", async () => {
    const server = await start(stubApi(() => ({ ok: true, data: {} })));
    const res = await fetch(url(server, "/v1/health"), { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("http-server — POST /v1/dispatch", () => {
  it("public-read success → 200 {ok:true,data}", async () => {
    const api = stubApi(() => ({ ok: true, data: { mode: "plan" } }));
    const server = await start(api);
    const res = await fetch(url(server, "/v1/dispatch"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "lvis:permissions:get-mode" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { mode: "plan" } });
    expect(api.dispatch).toHaveBeenCalledWith({ channel: "lvis:permissions:get-mode", origin: "local-api" });
  });

  it("gesture-gated rejection passes through as 403", async () => {
    const api = stubApi(() => ({ ok: false, error: "gesture-required-origin-unsupported" }));
    const server = await start(api);
    const res = await fetch(url(server, "/v1/dispatch"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "lvis:permissions:set-mode", args: { mode: "auto" } }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "gesture-required-origin-unsupported" });
    expect(api.dispatch).toHaveBeenCalledWith({
      channel: "lvis:permissions:set-mode",
      args: { mode: "auto" },
      origin: "local-api",
    });
  });

  it("non-public rejection passes through as 403", async () => {
    const api = stubApi(() => ({ ok: false, error: "channel-not-public" }));
    const server = await start(api);
    const res = await fetch(url(server, "/v1/dispatch"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "lvis:settings:get" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "channel-not-public" });
  });

  it("malformed JSON body → 400 invalid-request", async () => {
    const server = await start(stubApi(() => ({ ok: true, data: {} })));
    const res = await fetch(url(server, "/v1/dispatch"), {
      method: "POST",
      headers: authHeaders(),
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid-request" });
  });

  it("missing channel → 400 invalid-request", async () => {
    const server = await start(stubApi(() => ({ ok: true, data: {} })));
    const res = await fetch(url(server, "/v1/dispatch"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ args: { foo: 1 } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid-request" });
  });

  it("non-object body (array) → 400 invalid-request", async () => {
    const server = await start(stubApi(() => ({ ok: true, data: {} })));
    const res = await fetch(url(server, "/v1/dispatch"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(["not", "an", "object"]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid-request" });
  });

  it(">1MiB body → 413 payload-too-large", async () => {
    const api = stubApi(() => ({ ok: true, data: {} }));
    const server = await start(api);
    const big = "x".repeat(1024 * 1024 + 10);
    const res = await fetch(url(server, "/v1/dispatch"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "lvis:chat:sessions", filler: big }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: "payload-too-large" });
    expect(api.dispatch).not.toHaveBeenCalled();
  });

  it("dispatcher throw → 500 internal-error, thrown message NOT leaked", async () => {
    const secretMessage = "SUPER-SECRET-STACK-DETAIL-9f3a";
    const api = stubApi(() => {
      throw new Error(secretMessage);
    });
    const server = await start(api);
    const res = await fetch(url(server, "/v1/dispatch"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "lvis:chat:sessions" }),
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: "internal-error" });
    expect(text).not.toContain(secretMessage);
  });
});

describe("http-server — unknown routes / methods", () => {
  it("unknown path → 404 not-found", async () => {
    const server = await start(stubApi(() => ({ ok: true, data: {} })));
    const res = await fetch(url(server, "/v1/nope"), { headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not-found" });
  });

  it("wrong method on /v1/dispatch → 405 method-not-allowed", async () => {
    const server = await start(stubApi(() => ({ ok: true, data: {} })));
    const res = await fetch(url(server, "/v1/dispatch"), { method: "GET", headers: authHeaders() });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ ok: false, error: "method-not-allowed" });
  });

  it("wrong method on /v1/health → 405 method-not-allowed", async () => {
    const server = await start(stubApi(() => ({ ok: true, data: {} })));
    const res = await fetch(url(server, "/v1/health"), { method: "POST", headers: authHeaders() });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ ok: false, error: "method-not-allowed" });
  });
});

describe("http-server — loopback binding", () => {
  it("binds an ephemeral port > 0 on 127.0.0.1", async () => {
    const api = stubApi(() => ({ ok: true, data: {} }));
    const broadcaster = createStreamBroadcaster();
    const server = await startLocalApiHttpServer({ api, secret: SECRET, broadcaster, port: 0 });
    servers.push(server);
    expect(server.port).toBeGreaterThan(0);
    // Reachable on loopback with the correct secret.
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/health`, { headers: authHeaders() });
    expect(res.status).toBe(200);
  });
});

describe("stream-broadcaster", () => {
  it("fans out a frame to two subscribers", () => {
    const b = createStreamBroadcaster();
    const a = vi.fn();
    const c = vi.fn();
    b.subscribe(a);
    b.subscribe(c);
    expect(b.subscriberCount()).toBe(2);
    b.sink("lvis:chat:stream", { streamId: 1, type: "text_delta", text: "hi" });
    expect(a).toHaveBeenCalledWith("lvis:chat:stream", { streamId: 1, type: "text_delta", text: "hi" });
    expect(c).toHaveBeenCalledWith("lvis:chat:stream", { streamId: 1, type: "text_delta", text: "hi" });
  });

  it("unsubscribe stops delivery and is idempotent", () => {
    const b = createStreamBroadcaster();
    const a = vi.fn();
    const unsub = b.subscribe(a);
    unsub();
    unsub(); // idempotent — no throw, count stays 0
    expect(b.subscriberCount()).toBe(0);
    b.sink("lvis:chat:stream", { streamId: 1 });
    expect(a).not.toHaveBeenCalled();
  });

  it("a throwing subscriber does not break the others", () => {
    const b = createStreamBroadcaster();
    const bad = vi.fn(() => {
      throw new Error("display sink blew up");
    });
    const good = vi.fn();
    b.subscribe(bad);
    b.subscribe(good);
    expect(() => b.sink("lvis:chat:stream", { streamId: 1 })).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing during a broadcast is safe (snapshot iteration)", () => {
    const b = createStreamBroadcaster();
    const order: string[] = [];
    let unsubB: () => void = () => {};
    const a = vi.fn(() => {
      order.push("a");
      unsubB(); // remove b mid-broadcast; snapshot must still deliver to b
    });
    const bFn = vi.fn(() => {
      order.push("b");
    });
    b.subscribe(a);
    unsubB = b.subscribe(bFn);
    b.sink("lvis:chat:stream", { streamId: 1 });
    expect(order).toEqual(["a", "b"]);
    expect(b.subscriberCount()).toBe(1);
  });
});
