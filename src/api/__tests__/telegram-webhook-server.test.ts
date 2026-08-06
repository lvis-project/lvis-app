import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PlatformBridgeInboundGateway,
  PlatformBridgeInboundResult,
  PlatformBridgeRawWebhookRequest,
} from "../../main/platform-bridge-inbound.js";
import {
  configureTelegramWebhookServerLimits,
  startTelegramWebhookServer,
  TELEGRAM_WEBHOOK_HEADERS_TIMEOUT_MS,
  TELEGRAM_WEBHOOK_KEEP_ALIVE_TIMEOUT_MS,
  TELEGRAM_WEBHOOK_MAX_CONNECTIONS,
  TELEGRAM_WEBHOOK_REQUEST_TIMEOUT_MS,
  type TelegramWebhookServer,
} from "../telegram-webhook-server.js";

const WEBHOOK_PATH = "/telegram/webhook";
const servers: TelegramWebhookServer[] = [];

function gatewayFor(
  result: PlatformBridgeInboundResult = "accepted",
): Pick<PlatformBridgeInboundGateway, "handleWebhook"> & {
  handleWebhook: ReturnType<typeof vi.fn>;
} {
  return {
    handleWebhook: vi.fn(async () => result),
  };
}

async function start(
  gateway: Pick<PlatformBridgeInboundGateway, "handleWebhook"> = gatewayFor(),
  overrides: Partial<Omit<Parameters<typeof startTelegramWebhookServer>[0], "gateway" | "path">> = {},
): Promise<TelegramWebhookServer> {
  const server = await startTelegramWebhookServer({
    gateway,
    host: "127.0.0.1",
    port: 0,
    path: WEBHOOK_PATH,
    ...overrides,
  });
  servers.push(server);
  return server;
}

function requestServer(
  server: TelegramWebhookServer,
  options: Readonly<{
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    flushOnly?: boolean;
  }> = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const hasExplicitTransferFraming = options.headers?.["content-length"] !== undefined
      || options.headers?.["transfer-encoding"] !== undefined;
    const headers = {
      "content-type": "application/json; charset=utf-8",
      ...(body === undefined || options.flushOnly || hasExplicitTransferFraming
        ? {}
        : { "content-length": String(Buffer.byteLength(body)) }),
      ...options.headers,
    };
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: server.port,
      method: options.method ?? "POST",
      path: options.path ?? WEBHOOK_PATH,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: res.headers,
        });
      });
    });
    req.once("error", reject);
    if (options.flushOnly) {
      req.flushHeaders();
      return;
    }
    req.end(body);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("telegram-webhook-server — narrow ingress boundary", () => {
  it("passes only raw body bytes and Node headers to the gateway", async () => {
    const gateway = gatewayFor();
    const server = await start(gateway);
    const body = '{"update_id":1,"message":{"text":"hello"}}';

    const response = await requestServer(server, {
      body,
      headers: { "x-telegram-bot-api-secret-token": "header-value-only" },
    });

    expect(response.status).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["content-length"]).toBe("0");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(gateway.handleWebhook).toHaveBeenCalledTimes(1);
    const request = gateway.handleWebhook.mock.calls[0]?.[0] as PlatformBridgeRawWebhookRequest;
    expect(Buffer.from(request.rawBody).toString("utf8")).toBe(body);
    expect(request.headers?.["x-telegram-bot-api-secret-token"]).toBe("header-value-only");
    expect(request.headers?.["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("does not expose lookalike paths, query strings, or non-POST methods", async () => {
    const gateway = gatewayFor();
    const server = await start(gateway);

    const [wrongPath, query, method] = await Promise.all([
      requestServer(server, { path: "/telegram/other", body: "{}" }),
      requestServer(server, { path: `${WEBHOOK_PATH}?attempt=1`, body: "{}" }),
      requestServer(server, { method: "GET", body: "{}" }),
    ]);

    expect(wrongPath.status).toBe(404);
    expect(query.status).toBe(404);
    expect(method.status).toBe(405);
    expect(wrongPath.body).toBe("");
    expect(query.body).toBe("");
    expect(method.body).toBe("");
    expect(gateway.handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects non-JSON and encoded input before gateway verification", async () => {
    const gateway = gatewayFor();
    const server = await start(gateway);

    const [missingType, wrongType, encoded] = await Promise.all([
      requestServer(server, { body: "{}", headers: { "content-type": "" } }),
      requestServer(server, { body: "{}", headers: { "content-type": "text/plain" } }),
      requestServer(server, { body: "{}", headers: { "content-encoding": "gzip" } }),
    ]);

    expect(missingType.status).toBe(400);
    expect(wrongType.status).toBe(400);
    expect(encoded.status).toBe(400);
    expect(missingType.body).toBe("");
    expect(wrongType.body).toBe("");
    expect(encoded.body).toBe("");
    expect(gateway.handleWebhook).not.toHaveBeenCalled();
  });

  it("allows the explicit identity content encoding", async () => {
    const gateway = gatewayFor();
    const server = await start(gateway);

    const response = await requestServer(server, {
      body: "{}",
      headers: { "content-encoding": "identity" },
    });

    expect(response.status).toBe(204);
    expect(gateway.handleWebhook).toHaveBeenCalledTimes(1);
  });

  it("rejects declared oversize bodies before reading or invoking the gateway", async () => {
    const gateway = gatewayFor();
    const server = await start(gateway, { maxBodyBytes: 8 });

    const response = await requestServer(server, {
      headers: { "content-length": "9" },
      flushOnly: true,
    });

    expect(response.status).toBe(413);
    expect(response.body).toBe("");
    expect(gateway.handleWebhook).not.toHaveBeenCalled();
  });

  it("caps a chunked raw stream through the gateway-compatible raw-body option", async () => {
    const gateway = gatewayFor();
    const server = await start(gateway, { maxRawBodyBytes: 8 });

    const response = await requestServer(server, {
      body: Buffer.from("012345678", "utf8"),
      headers: { "transfer-encoding": "chunked" },
    });

    expect(response.status).toBe(413);
    expect(response.body).toBe("");
    expect(gateway.handleWebhook).not.toHaveBeenCalled();
  });
});

describe("telegram-webhook-server — gateway result mapping", () => {
  it.each<readonly [PlatformBridgeInboundResult, number]>([
    ["accepted", 204],
    ["duplicate", 204],
    ["disabled", 204],
    ["invalid-envelope", 204],
    ["slash-command-rejected", 204],
    ["authorization-denied", 204],
    ["authorization-revoked", 204],
    ["idempotency-conflict", 204],
    ["streaming-active", 204],
    ["command-outcome-unknown", 204],
    ["rate-limited", 204],
    ["verification-failed", 401],
    ["request-too-large", 413],
    ["invalid-request", 400],
    ["receipt-unavailable", 503],
    ["idempotency-capacity-reached", 503],
  ])("maps %s to %i with no response detail", async (result, expectedStatus) => {
    const server = await start(gatewayFor(result));

    const response = await requestServer(server, { body: "{}" });

    expect(response.status).toBe(expectedStatus);
    expect(response.body).toBe("");
    expect(response.headers["content-length"]).toBe("0");
  });

  it("maps a thrown gateway error to retryable 503 without logging the thrown detail", async () => {
    const secret = "telegram-bot-secret-must-not-appear";
    const gateway = {
      handleWebhook: vi.fn(async () => {
        throw new Error(secret);
      }),
    } as Pick<PlatformBridgeInboundGateway, "handleWebhook">;
    const log = vi.fn();
    const server = await start(gateway, { log });

    const response = await requestServer(server, { body: "{}" });

    expect(response.status).toBe(503);
    expect(response.body).toBe("");
    expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
  });
});

describe("telegram-webhook-server — lifecycle and configuration", () => {
  it("applies a bounded socket budget and finite HTTP request timeouts", () => {
    const server = {
      maxConnections: 0,
      headersTimeout: 0,
      requestTimeout: 0,
      keepAliveTimeout: 0,
    };

    configureTelegramWebhookServerLimits(server);

    expect(server).toEqual({
      maxConnections: TELEGRAM_WEBHOOK_MAX_CONNECTIONS,
      headersTimeout: TELEGRAM_WEBHOOK_HEADERS_TIMEOUT_MS,
      requestTimeout: TELEGRAM_WEBHOOK_REQUEST_TIMEOUT_MS,
      keepAliveTimeout: TELEGRAM_WEBHOOK_KEEP_ALIVE_TIMEOUT_MS,
    });
    expect(TELEGRAM_WEBHOOK_MAX_CONNECTIONS).toBe(32);
    expect(TELEGRAM_WEBHOOK_HEADERS_TIMEOUT_MS).toBe(10_000);
    expect(TELEGRAM_WEBHOOK_REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(TELEGRAM_WEBHOOK_KEEP_ALIVE_TIMEOUT_MS).toBe(5_000);
  });

  it("binds only to literal 127.0.0.1", async () => {
    await expect(
      startTelegramWebhookServer({
        gateway: gatewayFor(),
        host: "0.0.0.0",
        port: 0,
        path: WEBHOOK_PATH,
      }),
    ).rejects.toThrow("telegram-webhook-server-host-must-be-127-0-0-1");
  });

  it("rejects non-exact configured paths and oversized configured caps", async () => {
    await expect(
      startTelegramWebhookServer({
        gateway: gatewayFor(),
        port: 0,
        path: "/telegram/webhook?query",
      }),
    ).rejects.toThrow("telegram-webhook-server-path-invalid");
    await expect(
      startTelegramWebhookServer({
        gateway: gatewayFor(),
        port: 0,
        path: WEBHOOK_PATH,
        maxBodyBytes: 64 * 1024 + 1,
      }),
    ).rejects.toThrow("telegram-webhook-server-max-body-bytes-invalid");
  });

  it("closes idempotently and destroys a partial-body connection", async () => {
    const server = await start(gatewayFor());
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: server.port,
      method: "POST",
      path: WEBHOOK_PATH,
      headers: {
        "content-type": "application/json",
        "content-length": "100",
      },
    });
    request.on("error", () => {});
    request.write("{");

    await expect(Promise.race([
      Promise.all([server.close(), server.close()]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close-timeout")), 1000)),
    ])).resolves.toBeDefined();
    servers.splice(servers.indexOf(server), 1);
  });
});
