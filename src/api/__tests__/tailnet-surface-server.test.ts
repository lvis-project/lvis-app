import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAuthorizedTailnetController,
  isAuthorizedTailnetObserver,
  startTailnetSurfaceServer,
  type TailnetPairingOptions,
  type TailnetSurfaceServer,
  type TailnetWebOptions,
} from "../tailnet-surface-server.js";
import { TailnetControllerReceiptStore } from "../tailnet-controller-receipt-store.js";
import { createPlatformConversationTimeline } from "../../engine/conversation-platform-protocol.js";
import { createSharedConversationProjectionStore } from "../../engine/shared-conversation-projection.js";
import type { ConversationCommandPort } from "../../main/conversation-command-port.js";
import type { TailnetPairedShareAuthorizer } from "../../main/tailnet-paired-share-authorizer.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

const CAPABILITY = "lvis.example.com/cap/conversation-observer";
const CONVERSATION_ID = "owner-session-do-not-expose";
const OWNER_ONLY_SENTINEL = "OWNER_ONLY_SECRET_DO_NOT_EXPOSE";
const WEB_ORIGIN = "https://lvis.example.ts.net";
const PNG = Buffer.from("iVBORw0KGgo=", "base64");

// Node's fetch follows the Fetch Standard bad-port list. The OS can hand a
// transient listener one of these ports (notably 6000), so reserve a port the
// test client can actually reach instead of producing a nondeterministic HTTP
// boundary failure.
const FETCH_BAD_TEST_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
]);

let servers: TailnetSurfaceServer[] = [];
let stores: ReturnType<typeof createSharedConversationProjectionStore>[] = [];
let receiptDirs: string[] = [];

afterEach(async () => {
  const active = servers;
  servers = [];
  await Promise.all(active.map((server) => server.close()));
  for (const store of stores) store.stop();
  stores = [];
  for (const directory of receiptDirs.splice(0)) await cleanupTmpDir(directory);
});

interface FixtureOptions {
  readonly conversationId?: () => string;
  readonly replayLimitPerConversation?: number;
  readonly maxConnections?: number;
  readonly maxWebReadRequestsPerWindow?: number;
  readonly maxStreamLifetimeMs?: number;
  readonly controllerCommandPort?: ConversationCommandPort;
  readonly controllerReceiptStore?: TailnetControllerReceiptStore;
  readonly maxRequestsPerWindow?: number;
  readonly pairedSharing?: TailnetPairedShareAuthorizer;
  readonly pairing?: TailnetPairingOptions;
  readonly requestWindowMs?: number;
  readonly web?: TailnetWebOptions;
}

async function fixture(options: FixtureOptions = {}) {
  const timeline = createPlatformConversationTimeline();
  const receiptStore = options.controllerCommandPort === undefined
    ? undefined
    : options.controllerReceiptStore ?? createReceiptStore();
  const store = createSharedConversationProjectionStore(timeline, {
    ...(options.replayLimitPerConversation === undefined
      ? {}
      : { replayLimitPerConversation: options.replayLimitPerConversation }),
  });
  stores.push(store);
  const server = await startTailnetSurfaceServer({
    port: await reservePort(),
    expectedAppCapability: CAPABILITY,
    projectionStore: store,
    getCurrentConversationId: options.conversationId ?? (() => CONVERSATION_ID),
    ...(options.maxWebReadRequestsPerWindow === undefined
      ? {} : { maxWebReadRequestsPerWindow: options.maxWebReadRequestsPerWindow }),
    isConversationBusy: () => false,
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    ...(options.maxStreamLifetimeMs === undefined
      ? {}
      : { maxStreamLifetimeMs: options.maxStreamLifetimeMs }),
    ...(options.maxRequestsPerWindow === undefined
      ? {}
      : { maxRequestsPerWindow: options.maxRequestsPerWindow }),
    ...(options.requestWindowMs === undefined ? {} : { requestWindowMs: options.requestWindowMs }),
    ...(options.pairedSharing === undefined ? {} : { pairedSharing: options.pairedSharing }),
    ...(options.pairing === undefined ? {} : { pairing: options.pairing }),
    ...(options.web === undefined ? {} : { web: options.web }),
    ...(options.controllerCommandPort === undefined
      ? {}
      : { controller: { commandPort: options.controllerCommandPort, receiptStore: receiptStore! } }),
  });
  servers.push(server);
  return { timeline, store, server };
}

function createReceiptStore(): TailnetControllerReceiptStore {
  const directory = mkdtempSync(join(tmpdir(), "lvis-tailnet-surface-receipts-"));
  receiptDirs.push(directory);
  return new TailnetControllerReceiptStore({ filePath: join(directory, "command-receipts.json") });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function observerHeaders(role = "observer"): Record<string, string> {
  return {
    "Tailscale-User-Login": "owner@example.com",
    "Tailscale-App-Capabilities": JSON.stringify({
      [CAPABILITY]: [{ role }],
    }),
  };
}

function controllerHeaders(): Record<string, string> {
  return {
    "Tailscale-User-Login": "owner@example.com",
    "Tailscale-App-Capabilities": JSON.stringify({
      [CAPABILITY]: [{ role: "controller" }],
    }),
  };
}
const PAIRED_ACTOR_ID: `tailnet:${string}` = `tailnet:${"e".repeat(64)}`;
const PAIRED_SHARE = Object.freeze({
  pairingId: "11111111-1111-4111-8111-111111111111",
  pairingEpoch: 1,
  shareId: "22222222-2222-4222-8222-222222222222",
  shareEpoch: 1,
  scope: "33333333-3333-4333-8333-333333333333",
});

function pairedSharing(options: Readonly<{ observe: boolean; control: boolean }>) {
  let active = true;
  const listeners = new Set<() => void>();
  const pairedShareGuard = {
    isCurrent(binding: typeof PAIRED_SHARE): boolean {
      return active
        && binding.pairingId === PAIRED_SHARE.pairingId
        && binding.pairingEpoch === PAIRED_SHARE.pairingEpoch
        && binding.shareId === PAIRED_SHARE.shareId
        && binding.shareEpoch === PAIRED_SHARE.shareEpoch
        && binding.scope === PAIRED_SHARE.scope;
    },
  };
  const authorizer: TailnetPairedShareAuthorizer = {
    actorIdFor: (login) => login === "owner@example.com" ? PAIRED_ACTOR_ID : null,
    authorize(login, conversationId, required) {
      if (
        !active
        || login !== "owner@example.com"
        || conversationId !== CONVERSATION_ID
        || (required === "observe" && !options.observe)
        || (required === "control" && !options.control)
      ) {
        return null;
      }
      return {
        actorId: PAIRED_ACTOR_ID,
        pairedShare: PAIRED_SHARE,
        pairedShareGuard,
        permission: options.control ? "control" : "observe",
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    authorizer,
    revoke: () => {
      active = false;
      for (const listener of [...listeners]) listener();
    },
  };
}



function url(server: TailnetSurfaceServer, path: string): string {
  return "http://127.0.0.1:" + server.port + path;
}
function tailnetRoleHeaders(
  roles: readonly ("observer" | "controller" | "pairing")[],
  login = "owner@example.com",
): Record<string, string> {
  return {
    "Tailscale-User-Login": login,
    "Tailscale-App-Capabilities": JSON.stringify({
      [CAPABILITY]: roles.map((role) => ({ role })),
    }),
  };
}

function webSessionHeaders(
  cookieToken: string,
  csrfToken: string,
  roles: readonly ("observer" | "controller" | "pairing")[] = ["observer"],
  login = "owner@example.com",
): Record<string, string> {
  return {
    ...tailnetRoleHeaders(roles, login),
    Cookie: "__Host-lvis-tailnet-v2=" + cookieToken,
    Origin: WEB_ORIGIN,
    Referer: WEB_ORIGIN + "/tailnet/v2/web",
    "Sec-Fetch-Site": "same-origin",
    "X-Lvis-Tailnet-Csrf": csrfToken,
  };
}

interface RawWebDocumentResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: string;
}

function responseHeader(value: string | readonly string[] | undefined): string {
  return typeof value === "string" ? value : value?.join("; ") ?? "";
}

async function requestTailnetGet(
  server: TailnetSurfaceServer,
  path: string,
  headers: Record<string, string>,
  agent?: HttpAgent,
): Promise<RawWebDocumentResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url(server, path), { method: "GET", headers, agent }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers as RawWebDocumentResponse["headers"],
        body,
      }));
    });
    request.once("error", reject);
    request.end();
  });
}
async function requestWebDocument(
  server: TailnetSurfaceServer,
  headers: Record<string, string>,
): Promise<RawWebDocumentResponse> {
  return requestTailnetGet(server, "/tailnet/v2/web", headers);
}

async function openWebSession(
  server: TailnetSurfaceServer,
  headers: Record<string, string> = observerHeaders(),
): Promise<Readonly<{ html: string; cookieToken: string; csrfToken: string; setCookie: string; csp: string }>> {
  const response = await requestWebDocument(
    server,
    {
      ...headers,
      "Sec-Fetch-Site": headers["Sec-Fetch-Site"] ?? "none",
      "Sec-Fetch-Mode": headers["Sec-Fetch-Mode"] ?? "navigate",
      "Sec-Fetch-Dest": headers["Sec-Fetch-Dest"] ?? "document",
    },
  );
  const html = response.body;
  const setCookie = responseHeader(response.headers["set-cookie"]);
  const csp = responseHeader(response.headers["content-security-policy"]);
  const cookieToken = /__Host-lvis-tailnet-v2=([A-Za-z0-9_-]{43})/.exec(setCookie)?.[1];
  const csrfToken = /"csrfToken":"([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
  if (response.status !== 200 || cookieToken === undefined || csrfToken === undefined) {
    throw new Error("could not open Tailnet Web session");
  }
  return Object.freeze({ html, cookieToken, csrfToken, setCookie, csp });
}


async function reservePort(): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const probe = createNetServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const candidate = typeof address === "object" && address ? address.port : 0;
        probe.close((error) => error ? reject(error) : resolve(candidate));
      });
    });
    if (port > 0 && !FETCH_BAD_TEST_PORTS.has(port)) return port;
  }
  throw new Error("could not reserve a fetch-safe Tailnet test port");
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  includes: string,
  timeoutMs = 1_000,
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("tailnet SSE read timed out")), timeoutMs);
  });
  try {
    let received = "";
    while (true) {
      const chunk = await Promise.race([reader.read(), timeoutPromise]);
      if (chunk.done) return received;
      received += new TextDecoder().decode(chunk.value);
      if (received.includes(includes)) return received;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function dataFrames(stream: string): unknown[] {
  return [...stream.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]!));
}

describe("Tailnet observer authorization", () => {
  it("requires a human identity and the exact observer app capability", () => {
    expect(isAuthorizedTailnetObserver(observerHeaders() as never, CAPABILITY)).toBe(true);
    expect(isAuthorizedTailnetObserver({
      "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: [{ role: "observer" }] }),
    }, CAPABILITY)).toBe(false);
    expect(isAuthorizedTailnetObserver(observerHeaders("controller") as never, CAPABILITY)).toBe(false);
    expect(isAuthorizedTailnetObserver({
      "tailscale-user-login": "   ",
      "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: [{ role: "observer" }] }),
    }, CAPABILITY)).toBe(false);
    expect(isAuthorizedTailnetObserver({
      "tailscale-user-login": "owner@example.com",
      "tailscale-app-capabilities": "{invalid",
    }, CAPABILITY)).toBe(false);
  });

  it("fails closed for an oversized capability header", () => {
    expect(isAuthorizedTailnetObserver({
      "tailscale-user-login": "owner@example.com",
      "tailscale-app-capabilities": "x".repeat(16 * 1024 + 1),
    }, CAPABILITY)).toBe(false);
  });

  it("requires the separately granted controller role for remote commands", () => {
    expect(isAuthorizedTailnetController(controllerHeaders() as never, CAPABILITY)).toBe(true);
    expect(isAuthorizedTailnetController(observerHeaders() as never, CAPABILITY)).toBe(false);
  });
});

describe("Tailnet observer HTTP boundary", () => {
  it("binds only fixed literal loopback ports", async () => {
    const timeline = createPlatformConversationTimeline();
    const store = createSharedConversationProjectionStore(timeline);
    stores.push(store);
    const options = {
      port: await reservePort(),
      expectedAppCapability: CAPABILITY,
      projectionStore: store,
      getCurrentConversationId: () => CONVERSATION_ID,
      isConversationBusy: () => false,
    };

    await expect(startTailnetSurfaceServer({ ...options, host: "localhost" })).rejects.toThrow(
      "literal 127.0.0.1",
    );
    await expect(startTailnetSurfaceServer({ ...options, port: 0 })).rejects.toThrow(
      "nonzero TCP port",
    );
    await expect(startTailnetSurfaceServer({
      ...options,
      expectedAppCapability: "__proto__",
    })).rejects.toThrow("valid expected app capability");
    await expect(startTailnetSurfaceServer({
      ...options,
      controller: {
        commandPort: { execute: vi.fn() } as unknown as ConversationCommandPort,
        receiptStore: createReceiptStore(),
      },
    })).rejects.toThrow("reservable conversation command port");
    const sharing = pairedSharing({ observe: true, control: false });
    await expect(startTailnetSurfaceServer({
      ...options,
      web: { origin: WEB_ORIGIN },
    })).rejects.toThrow("tailnet web requires paired sharing");
    await expect(startTailnetSurfaceServer({
      ...options,
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN + "/" },
    })).rejects.toThrow("tailnet web requires paired sharing");

  });

  it("exposes neither Local API nor A2A routes and never trusts a bearer", async () => {
    const { server } = await fixture();

    const unauthenticated = await fetch(url(server, "/tailnet/v1/status"));
    expect(unauthenticated.status).toBe(401);

    const localApi = await fetch(url(server, "/v1/health"), {
      headers: observerHeaders(),
    });
    expect(localApi.status).toBe(404);

    const a2a = await fetch(url(server, "/a2a/agent/.well-known/agent-card.json"), {
      headers: observerHeaders(),
    });
    expect(a2a.status).toBe(404);

    const mutation = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      method: "POST",
      headers: observerHeaders(),
    });
    expect(mutation.status).toBe(405);

    const bearerOnly = await fetch(url(server, "/tailnet/v1/status"), {
      headers: { Authorization: "Bearer local-api-secret" },
    });
    expect(bearerOnly.status).toBe(401);

    const disabledController = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(disabledController.status).toBe(404);
  });

  it("requires an active P2 pairing/share even after Tailscale capability authorization", async () => {
    const sharing = pairedSharing({ observe: false, control: false });
    const { server } = await fixture({ pairedSharing: sharing.authorizer });

    const response = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      headers: observerHeaders(),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "pairing-share-required" });
  });

  it("requires a separate P2 control share before a controller command is admitted", async () => {
    const sharing = pairedSharing({ observe: true, control: false });
    const submit = vi.fn();
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      controllerCommandPort: commandPort,
    });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    expect(status.status).toBe(200);
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;

    const response = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        id: "paired-control-required-0001",
        type: "conversation.send",
        input: "must not be admitted",
        scope,
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "pairing-share-required" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("closes a P2 paired observer stream as soon as the local owner revokes its share", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({ pairedSharing: sharing.authorizer });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;
    const controller = new AbortController();
    const response = await fetch(
      url(server, "/tailnet/v1/conversation/events?scope=" + encodeURIComponent(scope)),
      { headers: observerHeaders(), signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await readUntil(reader, ": connected");

    sharing.revoke();

    const stream = await readUntil(reader, "reauthorize-required");
    expect(stream).toContain("event: reauthorize-required");
    controller.abort();
  });


  it("issues a browser session only behind P2 sharing and blocks native browser bypass", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { timeline, server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "safe Tailnet response" },
    });
    const session = await openWebSession(server);

    expect(session.setCookie).toMatch(
      /^__Host-lvis-tailnet-v2=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/,
    );
    expect(session.csp).toContain("default-src 'none'");
    expect(session.csp).toContain("connect-src 'self'");
    expect(session.csp).toContain("frame-ancestors 'none'");
    expect(session.html).toContain("textContent");
    expect(session.html).not.toContain(session.cookieToken);
    expect(session.html).not.toContain(CONVERSATION_ID);
    expect(session.html).not.toContain(OWNER_ONLY_SENTINEL);
    expect(session.html).not.toContain(PAIRED_ACTOR_ID);

    const nativeBrowser = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      headers: { ...observerHeaders(), Origin: WEB_ORIGIN },
    });
    expect(nativeBrowser.status).toBe(403);
    expect(await nativeBrowser.json()).toMatchObject({ error: "browser-observer-not-ready" });

    const noCookie = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: {
        ...tailnetRoleHeaders(["observer"]),
        Origin: WEB_ORIGIN,
        Referer: WEB_ORIGIN + "/tailnet/v2/web",
        "Sec-Fetch-Site": "same-origin",
        "X-Lvis-Tailnet-Csrf": session.csrfToken,
      },
    });
    expect(noCookie.status).toBe(401);

    const wrongOrigin = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: { ...webSessionHeaders(session.cookieToken, session.csrfToken), Origin: "https://wrong.ts.net" },
    });
    expect(wrongOrigin.status).toBe(403);

    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("access-control-allow-origin")).toBeNull();
    const payload = await snapshot.json() as { snapshot: Record<string, unknown> };
    expect(payload.snapshot).toMatchObject({ assistantText: "safe Tailnet response" });
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain(CONVERSATION_ID);
    expect(wire).not.toContain(PAIRED_ACTOR_ID);

    const replayedByAnotherLogin = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(
        session.cookieToken,
        session.csrfToken,
        ["observer"],
        "another-owner@example.com",
      ),
    });
    expect(replayedByAnotherLogin.status).toBe(401);
    expect(replayedByAnotherLogin.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("rejects browser Fetch Metadata before consuming the native observer budget", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      maxRequestsPerWindow: 1,
    });
    const browser = await requestTailnetGet(
      server,
      "/tailnet/v1/conversation/snapshot",
      {
        ...observerHeaders(),
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Dest": "iframe",
      },
    );
    expect(browser.status).toBe(403);
    expect(JSON.parse(browser.body)).toMatchObject({ error: "browser-observer-not-ready" });

    const cli = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      headers: observerHeaders(),
    });
    expect(cli.status).toBe(200);
  });



  it("rejects cross-site documents while keeping same-browser tabs independently usable", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
    });
    const first = await openWebSession(server);
    const crossSite = await requestWebDocument(server, {
      ...observerHeaders(),
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "iframe",
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).toContain("same-origin-required");

    const second = await openWebSession(server, {
      ...observerHeaders(),
      Cookie: "__Host-lvis-tailnet-v2=" + first.cookieToken,
      Origin: WEB_ORIGIN,
      "Sec-Fetch-Site": "same-origin",
    });
    expect(second.cookieToken).toBe(first.cookieToken);
    expect(second.csrfToken).not.toBe(first.csrfToken);
    expect(first.html).toContain("MIN_SNAPSHOT_REFRESH_MS = 1000");
    expect(first.html).toContain("function eventName(frame)");
    expect(first.html).not.toContain("frame.includes");

    const firstTab = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(first.cookieToken, first.csrfToken),
    });
    expect(firstTab.status).toBe(200);
    const secondTab = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(second.cookieToken, second.csrfToken),
    });
    expect(secondTab.status).toBe(200);
  });
  it("keeps two Web tabs within an isolated, bounded read budget", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
      maxRequestsPerWindow: 2,
      maxWebReadRequestsPerWindow: 2,
    });
    const first = await openWebSession(server);
    const second = await openWebSession(server);

    const native = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    expect(native.status).toBe(429);

    const firstSnapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(first.cookieToken, first.csrfToken),
    });
    expect(firstSnapshot.status).toBe(200);
    const secondSnapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(second.cookieToken, second.csrfToken),
    });
    expect(secondSnapshot.status).toBe(200);
    const exhausted = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(first.cookieToken, first.csrfToken),
    });
    expect(exhausted.status).toBe(429);
  });


  it("requires same-origin CSRF plus control grants before a Web command reaches the broker", async () => {

    const sharing = pairedSharing({ observe: true, control: true });
    const submit = vi.fn(() => ({ completion: Promise.resolve({
      text: "done",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    }) }));
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      controllerCommandPort: commandPort,
      web: { origin: WEB_ORIGIN },
    });
    const session = await openWebSession(server, tailnetRoleHeaders(["observer", "controller"]));
    expect(session.html).toContain("\"canControl\":true");

    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const scope = (await snapshot.json() as { snapshot: { scope: string } }).snapshot.scope;
    const command = {
      id: "web-command-0001",
      type: "conversation.send",
      input: "remote browser message",
      scope,
    };

    const wrongCsrf = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, "x".repeat(43), ["controller"]),
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(wrongCsrf.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();

    const observerOnly = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["observer"]),
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(observerOnly.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();

    const accepted = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]),
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      accepted: true,
      command: { id: command.id, scope },
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tailnet-controller",
        actorId: PAIRED_ACTOR_ID,
        pairedShare: PAIRED_SHARE,
      }),
      expect.objectContaining({
        kind: "message.send",
        payload: { input: command.input },
        publicTurn: expect.objectContaining({
          turnId: expect.stringMatching(/^tailnet-turn_[A-Za-z0-9_-]{43}$/),
          abortController: expect.any(AbortController),
        }),
      }),
    );
  });


  it("clears Web sessions and closes the Web stream as soon as the owner revokes sharing", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
    });
    const session = await openWebSession(server);
    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const scope = (await snapshot.json() as { snapshot: { scope: string } }).snapshot.scope;
    const controller = new AbortController();
    const events = await fetch(
      url(server, "/tailnet/v2/web/events?scope=" + encodeURIComponent(scope)),
      {
        headers: webSessionHeaders(session.cookieToken, session.csrfToken),
        signal: controller.signal,
      },
    );
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    await readUntil(reader, ": connected");

    sharing.revoke();

    const stream = await readUntil(reader, "reauthorize-required");
    expect(stream).toContain("event: reauthorize-required");
    const afterRevoke = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.headers.get("set-cookie")).toContain("Max-Age=0");
    controller.abort();
  });

  it("closes a Web SSE immediately when the browser logs out", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
    });
    const session = await openWebSession(server);
    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const scope = (await snapshot.json() as { snapshot: { scope: string } }).snapshot.scope;
    const controller = new AbortController();
    const events = await fetch(
      url(server, "/tailnet/v2/web/events?scope=" + encodeURIComponent(scope)),
      { headers: webSessionHeaders(session.cookieToken, session.csrfToken), signal: controller.signal },
    );
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    await readUntil(reader, ": connected");

    const logout = await fetch(url(server, "/tailnet/v2/web/logout"), {
      method: "POST",
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    expect(logout.status).toBe(200);
    const stream = await readUntil(reader, "reauthorize-required");
    expect(stream).toContain("event: reauthorize-required");
    const afterLogout = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    expect(afterLogout.status).toBe(401);
    controller.abort();
  });


  it("uses reconnect rather than reauthorization for Web stream lifetime expiry", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
      maxStreamLifetimeMs: 40,
    });
    const session = await openWebSession(server);
    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const scope = (await snapshot.json() as { snapshot: { scope: string } }).snapshot.scope;
    const events = await fetch(
      url(server, "/tailnet/v2/web/events?scope=" + encodeURIComponent(scope)),
      { headers: webSessionHeaders(session.cookieToken, session.csrfToken) },
    );
    expect(events.status).toBe(200);
    const stream = await readUntil(events.body!.getReader(), "reconnect-required", 2_000);
    expect(stream).toContain("event: reconnect-required");
    expect(stream).not.toContain("event: reauthorize-required");
  });

  it("redeems a one-use pairing code only with the separate pairing capability", async () => {
    const sharing = pairedSharing({ observe: false, control: false });
    const claimInvitation = vi.fn()
      .mockResolvedValueOnce({ expiresAt: 4_102_444_800_000 })
      .mockResolvedValueOnce(null);
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      pairing: { claimInvitation },
    });
    const code = "lvis-pair-v1." + "A".repeat(43);

    const observerAttempt = await fetch(url(server, "/tailnet/v2/pairing/claim"), {
      method: "POST",
      headers: { ...observerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(observerAttempt.status).toBe(401);

    const browserAttempt = await fetch(url(server, "/tailnet/v2/pairing/claim"), {
      method: "POST",
      headers: {
        ...observerHeaders("pairing"),
        "content-type": "application/json",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Dest": "empty",
      },
      body: JSON.stringify({ code }),
    });
    expect(browserAttempt.status).toBe(403);
    expect(claimInvitation).not.toHaveBeenCalled();

    const accepted = await fetch(url(server, "/tailnet/v2/pairing/claim"), {
      method: "POST",
      headers: { ...observerHeaders("pairing"), "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      pending: true,
      expiresAt: 4_102_444_800_000,
    });
    expect(claimInvitation).toHaveBeenCalledWith(code, PAIRED_ACTOR_ID);

    // Pairing alone still has no observe/control authority.
    const snapshot = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      headers: observerHeaders(),
    });
    expect(snapshot.status).toBe(403);

    const duplicate = await fetch(url(server, "/tailnet/v2/pairing/claim"), {
      method: "POST",
      headers: { ...observerHeaders("pairing"), "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: "pairing-code-unavailable" });
  });


  it("bounds authenticated observer request floods per Tailnet identity", async () => {
    const { server } = await fixture({ maxRequestsPerWindow: 2, requestWindowMs: 60_000 });
    const first = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const second = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), { headers: observerHeaders() });
    const third = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: "tailnet-rate-limited" });
  });

  it("does not let a rotated login header multiply tracked identities on one connection", async () => {
    // S-5: Tailscale-User-Login is a client-supplied claim. A local caller
    // that rotates it across many values on a single connection must not be
    // able to mint a fresh tracked-identity bucket per value -- the limiter
    // pins the bucket to whichever login the connection first authorized
    // with, so this flood can only ever consume one of the
    // MAX_TRACKED_RATE_IDENTITIES (128) slots.
    const { server } = await fixture({ maxRequestsPerWindow: 500, requestWindowMs: 60_000 });
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let i = 0; i < 200; i += 1) {
        const response = await requestTailnetGet(
          server,
          "/tailnet/v1/status",
          tailnetRoleHeaders(["observer"], `attacker-${i}@example.com`),
          agent,
        );
        expect(response.status).toBe(200);
      }
    } finally {
      agent.destroy();
    }

    // A different identity, on its own connection, must still be admitted:
    // the header-rotation flood above could not have exhausted the
    // tracked-identity map.
    const legitimate = await requestTailnetGet(
      server,
      "/tailnet/v1/status",
      tailnetRoleHeaders(["observer"], "genuine-owner@example.com"),
    );
    expect(legitimate.status).toBe(200);
  });

  it("keeps serving a previously-tracked identity when the identity map is at capacity", async () => {
    // S-5: the old limiter returned false for every caller once
    // MAX_TRACKED_RATE_IDENTITIES (128) buckets were tracked, including
    // callers with an existing, well-behaved bucket. A caller that is
    // already tracked must always be served from its own bucket regardless
    // of how full the map is, and a brand-new identity arriving at capacity
    // must be admitted by evicting the oldest tracked bucket rather than
    // being refused outright.
    const { server } = await fixture({ maxRequestsPerWindow: 500, requestWindowMs: 60_000 });
    const legitimateHeaders = tailnetRoleHeaders(["observer"], "genuine-owner@example.com");

    const first = await requestTailnetGet(server, "/tailnet/v1/status", legitimateHeaders);
    expect(first.status).toBe(200);

    // Fill the remaining 127 slots with distinct identities, each on its
    // own fresh connection, bringing the map to exactly 128 tracked
    // identities without evicting the one tracked above.
    for (let i = 0; i < 127; i += 1) {
      const response = await requestTailnetGet(
        server,
        "/tailnet/v1/status",
        tailnetRoleHeaders(["observer"], `flood-${i}@example.com`),
      );
      expect(response.status).toBe(200);
    }

    const second = await requestTailnetGet(server, "/tailnet/v1/status", legitimateHeaders);
    expect(second.status).toBe(200);

    // One more genuinely new identity pushes the map past capacity; it must
    // still be admitted (via eviction), never denied outright.
    const overflow = await requestTailnetGet(
      server,
      "/tailnet/v1/status",
      tailnetRoleHeaders(["observer"], "overflow-owner@example.com"),
    );
    expect(overflow.status).toBe(200);
  });

  it("accepts only a controller-gated, idempotent narrow message.send command", async () => {
    const submit = vi.fn(() => ({ completion: Promise.resolve({
      text: "done",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    }) }));
    const commandPort = {
      execute: vi.fn(),
      submit,
    } as unknown as ConversationCommandPort;
    const { server } = await fixture({ controllerCommandPort: commandPort });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const { conversation } = await status.json() as { conversation: { scope: string } };
    const command = {
      id: "controller-send-0001",
      type: "conversation.send",
      input: "remote surface message",
      scope: conversation.scope,
    };

    const observerAttempt = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...observerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(observerAttempt.status).toBe(401);

    const accepted = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      accepted: true,
      command: { id: command.id, scope: command.scope },
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tailnet-controller",
        actorId: expect.stringMatching(/^tailnet:[a-f0-9]{64}$/),
      }),
      { kind: "message.send", payload: { input: command.input } },
    );

    const duplicate = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    expect(submit).toHaveBeenCalledOnce();

    const conflict = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, input: "different request" }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "idempotency-conflict" });

    const browserAttempt = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: {
        ...controllerHeaders(),
        "content-type": "application/json",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Dest": "empty",
      },
      body: JSON.stringify({ ...command, id: "controller-send-0002" }),
    });
    expect(browserAttempt.status).toBe(403);
    expect(await browserAttempt.json()).toMatchObject({ error: "browser-controller-not-ready" });

    const elevatedWirePayload = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, id: "controller-send-0003", inputOrigin: "user-keyboard" }),
    });
    expect(elevatedWirePayload.status).toBe(400);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("keeps a completed receipt across a new public scope and rejects reuse in another conversation", async () => {
    let conversationId = CONVERSATION_ID;
    const receiptStore = createReceiptStore();
    const submit = vi.fn(() => ({ completion: Promise.resolve({
      text: "done",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    }) }));
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const first = await fixture({
      controllerCommandPort: commandPort,
      controllerReceiptStore: receiptStore,
      conversationId: () => conversationId,
    });
    const firstStatus = await fetch(url(first.server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const firstScope = (await firstStatus.json() as { conversation: { scope: string } }).conversation.scope;
    const command = {
      id: "controller-restart-0001",
      type: "conversation.send" as const,
      input: "a durable controller command",
      scope: firstScope,
    };
    expect((await fetch(url(first.server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(command),
    })).status).toBe(202);
    // Let the detached completion persist its terminal receipt before the new
    // server simulates a restart with a newly minted public scope.
    await Promise.resolve();
    await Promise.resolve();

    const restarted = await fixture({
      controllerCommandPort: commandPort,
      controllerReceiptStore: receiptStore,
      conversationId: () => conversationId,
    });
    const restartedStatus = await fetch(url(restarted.server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const restartedScope = (await restartedStatus.json() as { conversation: { scope: string } }).conversation.scope;
    expect(restartedScope).not.toBe(firstScope);
    const duplicate = await fetch(url(restarted.server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, scope: restartedScope }),
    });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    expect(submit).toHaveBeenCalledOnce();

    conversationId = "new-private-conversation";
    const changedStatus = await fetch(url(restarted.server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const changedScope = (await changedStatus.json() as { conversation: { scope: string } }).conversation.scope;
    const conflict = await fetch(url(restarted.server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, scope: changedScope }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "idempotency-conflict" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("fails closed without submit when a previous process left a reserved receipt", async () => {
    const receiptStore = createReceiptStore();
    const command = {
      id: "controller-unknown-0001",
      type: "conversation.send" as const,
      input: "do not replay this command",
    };
    const actorId = `tailnet:${sha256("owner@example.com")}`;
    expect(receiptStore.reserve({
      keyDigest: sha256(`${actorId}\u0000${command.id}`),
      intentDigest: sha256(JSON.stringify({ type: command.type, input: command.input, attachmentIds: [] })),
      conversationDigest: sha256(CONVERSATION_ID),
      ownerId: "00000000-0000-4000-8000-000000000099",
    })).toEqual({ kind: "reserved" });
    const submit = vi.fn();
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({ controllerCommandPort: commandPort, controllerReceiptStore: receiptStore });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;
    const response = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, scope }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "command-outcome-unknown" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("fails closed without submit when the durable receipt file is corrupt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lvis-tailnet-corrupt-receipts-"));
    receiptDirs.push(directory);
    const filePath = join(directory, "command-receipts.json");
    writeFileSync(filePath, "not-json", "utf8");
    const receiptStore = new TailnetControllerReceiptStore({ filePath });
    const submit = vi.fn();
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({ controllerCommandPort: commandPort, controllerReceiptStore: receiptStore });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;
    const response = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        id: "controller-corrupt-0001",
        type: "conversation.send",
        input: "must not submit",
        scope,
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "receipt-unavailable" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("stages a paired native image outside the command receipt and consumes it exactly once", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const submit = vi.fn(() => ({
      completion: Promise.resolve({
        text: "done",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      }),
    }));
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      controllerCommandPort: commandPort,
    });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;

    const uploaded = await fetch(url(server, "/tailnet/v3/attachments"), {
      method: "POST",
      headers: {
        ...controllerHeaders(),
        "content-type": "image/png",
        "x-lvis-tailnet-scope": scope,
      },
      body: PNG,
    });
    expect(uploaded.status).toBe(202);
    const uploadBody = await uploaded.json() as {
      attachment: { id: string; scope: string; expiresAt: number };
    };
    expect(uploadBody.attachment).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      scope,
    });
    expect(JSON.stringify(uploadBody)).not.toContain(PNG.toString("base64"));

    const command = {
      id: "paired-image-command-0001",
      type: "conversation.send",
      input: "describe this image",
      attachmentIds: [uploadBody.attachment.id],
      scope,
    };
    const accepted = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(accepted.status).toBe(202);
    const acceptedBody = await accepted.json() as { turn?: { id?: string } };
    expect(acceptedBody.turn?.id).toMatch(/^tailnet-turn_[A-Za-z0-9_-]{43}$/);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: PAIRED_ACTOR_ID, pairedShare: PAIRED_SHARE }),
      expect.objectContaining({
        kind: "message.send",
        payload: {
          input: command.input,
          attachments: [{
            type: "image",
            mimeType: "image/png",
            image: "data:image/png;base64,iVBORw0KGgo=",
          }],
        },
        publicTurn: expect.objectContaining({ turnId: acceptedBody.turn?.id }),
      }),
    );

    const reuse = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, id: "paired-image-command-0002" }),
    });
    expect(reuse.status).toBe(409);
    expect(await reuse.json()).toMatchObject({ error: "attachment-unavailable" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("uses the same paired Web boundary for image staging and keeps its turn handle cancellable only through the host", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const submit = vi.fn(() => ({
      completion: Promise.resolve({
        text: "done",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      }),
    }));
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "turn-not-found" })
      .mockResolvedValueOnce({ ok: true, cancelled: true });
    const commandPort = { execute, submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      controllerCommandPort: commandPort,
      web: { origin: WEB_ORIGIN },
    });
    const session = await openWebSession(server, tailnetRoleHeaders(["observer", "controller"]));
    expect(session.html).toContain("stageSelectedImages");
    expect(session.html).toContain("turn.cancel-own");
    expect(session.html).toContain("/tailnet/v3/web/attachments");

    const snapshotResponse = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const scope = (await snapshotResponse.json() as { snapshot: { scope: string } }).snapshot.scope;
    const uploaded = await fetch(url(server, "/tailnet/v3/web/attachments"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]),
        "content-type": "image/png",
        "x-lvis-tailnet-scope": scope,
      },
      body: PNG,
    });
    expect(uploaded.status).toBe(202);
    const attachmentId = (await uploaded.json() as { attachment: { id: string } }).attachment.id;

    const sent = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "web-paired-image-command-0001",
        type: "conversation.send",
        input: "remote image",
        attachmentIds: [attachmentId],
        scope,
      }),
    });
    expect(sent.status).toBe(202);
    const turnId = (await sent.json() as { turn: { id: string } }).turn.id;
    expect(turnId).toMatch(/^tailnet-turn_[A-Za-z0-9_-]{43}$/);

    const notFound = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "web-paired-cancel-0001",
        type: "turn.cancel-own",
        turnId,
        scope,
      }),
    });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: "turn-not-found" });

    const cancelled = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "web-paired-cancel-0002",
        type: "turn.cancel-own",
        turnId,
        scope,
      }),
    });
    expect(cancelled.status).toBe(202);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorId: PAIRED_ACTOR_ID, pairedShare: PAIRED_SHARE }),
      { kind: "turn.cancel-own", turnId },
    );
  });


  it("whitelists owner-safe assistant text and never serializes internal ids or owner detail", async () => {
    const { timeline, server } = await fixture();
    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "legacy-stream-id-777",
      event: {
        kind: "assistant.reasoning.delta",
        ownerDetail: { text: OWNER_ONLY_SENTINEL },
      },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "legacy-stream-id-777",
      event: {
        kind: "tool.started",
        tool: {
          name: "filesystem.read",
          groupId: "group-id-do-not-expose",
          toolUseId: "tool-use-id-do-not-expose",
          displayOrder: 1,
        },
        ownerDetail: { input: { path: "C:/secret/" + OWNER_ONLY_SENTINEL } },
      },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "legacy-stream-id-777",
      event: { kind: "assistant.text.delta", text: "shareable assistant answer" },
    });

    const response = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      headers: observerHeaders(),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; snapshot: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.snapshot).toMatchObject({
      assistantText: "shareable assistant answer",
      cursor: 2,
      scope: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });

    const wire = JSON.stringify(payload);
    expect(wire).not.toContain(CONVERSATION_ID);
    expect(wire).not.toContain("legacy-stream-id-777");
    expect(wire).not.toContain(OWNER_ONLY_SENTINEL);
    expect(wire).not.toContain("group-id-do-not-expose");
    expect(wire).not.toContain("tool-use-id-do-not-expose");
  });

  it("uses Last-Event-ID plus the public scope for replay, and requires a snapshot without the scope", async () => {
    const { timeline, server } = await fixture();
    const first = timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "first" },
    });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const statusPayload = await status.json() as { conversation: { scope: string } };
    const scope = statusPayload.conversation.scope;
    const second = timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "second" },
    });

    const controller = new AbortController();
    const response = await fetch(
      url(server, "/tailnet/v1/conversation/events?scope=" + encodeURIComponent(scope)),
      {
        headers: { ...observerHeaders(), "Last-Event-ID": String(first.cursor) },
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    const stream = await readUntil(response.body!.getReader(), "second");
    const events = dataFrames(stream) as Array<{ cursor: number; event: { kind: string; text?: string } }>;
    expect(events).toEqual([
      expect.objectContaining({
        cursor: second.cursor,
        scope,
        event: { kind: "assistant.text.delta", text: "second" },
      }),
    ]);
    controller.abort();

    const missingScope = await fetch(url(server, "/tailnet/v1/conversation/events"), {
      headers: { ...observerHeaders(), "Last-Event-ID": String(first.cursor) },
    });
    expect(missingScope.status).toBe(409);
    expect(await missingScope.json()).toMatchObject({
      ok: false,
      error: "snapshot-required",
      scope,
    });
  });

  it("forces a resync rather than following a previous main conversation after a switch", async () => {
    let currentConversation = CONVERSATION_ID;
    const { timeline, server } = await fixture({
      conversationId: () => currentConversation,
    });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const { conversation } = await status.json() as { conversation: { scope: string } };

    const controller = new AbortController();
    const response = await fetch(
      url(server, "/tailnet/v1/conversation/events?scope=" + encodeURIComponent(conversation.scope)),
      { headers: observerHeaders(), signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await readUntil(reader, ": connected");

    currentConversation = "new-owner-session-do-not-expose";
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "stale event must not be shared" },
    });

    const stream = await readUntil(reader, "resync-required");
    expect(stream).toContain("event: resync-required");
    expect(stream).not.toContain("stale event must not be shared");
    controller.abort();
  });

  it("returns a snapshot-required response for a replay gap", async () => {
    const { timeline, server } = await fixture({ replayLimitPerConversation: 1 });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "old" },
    });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const { conversation } = await status.json() as { conversation: { scope: string } };
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "new" },
    });

    const response = await fetch(
      url(server, "/tailnet/v1/conversation/events?scope=" + encodeURIComponent(conversation.scope) + "&afterCursor=0"),
      { headers: observerHeaders() },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "snapshot-required",
      scope: conversation.scope,
    });
  });

  it("ends a bounded stream with a reauthorization control event", async () => {
    const { server } = await fixture({ maxStreamLifetimeMs: 40 });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const { conversation } = await status.json() as { conversation: { scope: string } };

    const response = await fetch(
      url(server, "/tailnet/v1/conversation/events?scope=" + encodeURIComponent(conversation.scope)),
      { headers: observerHeaders() },
    );
    expect(response.status).toBe(200);
    const stream = await readUntil(response.body!.getReader(), "reauthorize-required", 2_000);
    expect(stream).toContain("event: reauthorize-required");
  });
});
