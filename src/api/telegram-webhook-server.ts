/**
 * Narrow loopback-only HTTP ingress for a Telegram Bot API webhook.
 *
 * This module deliberately owns no Telegram credentials or JSON parsing. It
 * preserves the provider body and node headers exactly for the injected
 * PlatformBridgeInboundGateway, whose provider verifier must authenticate and
 * decode the delivery before it can reach host-owned authorization.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Socket } from "node:net";
import type { PlatformBridgeInboundGateway, PlatformBridgeInboundResult } from "../main/platform-bridge-inbound.js";

/** This ingress is never reachable from a non-loopback interface. */
const LOOPBACK_HOST = "127.0.0.1";
/** Telegram updates are compact; cap the raw ingress before provider parsing. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** The server rejects a configured cap above its platform bridge allowance. */
const ABSOLUTE_MAX_BODY_BYTES = 64 * 1024;
const SAFE_WEBHOOK_PATH = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/;

/**
 * Telegram uses short, request/response webhook deliveries; it has no
 * long-lived stream route. Keep the TCP socket budget intentionally small so
 * a local proxy cannot turn partial HTTP requests into an unbounded resource
 * reservation in the desktop process.
 */
export const TELEGRAM_WEBHOOK_MAX_CONNECTIONS = 32;
/** Bound incomplete HTTP headers before application request handling begins. */
export const TELEGRAM_WEBHOOK_HEADERS_TIMEOUT_MS = 10_000;
/** Bound the complete request body lifetime, including slow chunked bodies. */
export const TELEGRAM_WEBHOOK_REQUEST_TIMEOUT_MS = 60_000;
/** Do not retain idle proxy sockets beyond a short webhook reuse window. */
export const TELEGRAM_WEBHOOK_KEEP_ALIVE_TIMEOUT_MS = 5_000;

/**
 * Apply the fixed transport limits in one explicit, unit-testable boundary.
 * They are deliberately not owner configuration: relaxing the listener's
 * resource bounds is not needed to operate a Telegram webhook.
 */
export function configureTelegramWebhookServerLimits(
  server: Pick<Server, "maxConnections" | "headersTimeout" | "requestTimeout" | "keepAliveTimeout">,
): void {
  server.maxConnections = TELEGRAM_WEBHOOK_MAX_CONNECTIONS;
  server.headersTimeout = TELEGRAM_WEBHOOK_HEADERS_TIMEOUT_MS;
  server.requestTimeout = TELEGRAM_WEBHOOK_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = TELEGRAM_WEBHOOK_KEEP_ALIVE_TIMEOUT_MS;
}

/** Configuration for the isolated Telegram webhook listener. */
export interface TelegramWebhookServerOptions {
  /** The provider-neutral, host-owned inbound command boundary. */
  readonly gateway: Pick<PlatformBridgeInboundGateway, "handleWebhook">;
  /** Must be the literal IPv4 loopback address `127.0.0.1`. */
  readonly host?: string;
  /** TCP port to bind. Use 0 only for local tests or a discovery-managed proxy. */
  readonly port?: number;
  /** Exact raw request path, such as `/telegram/webhook`; queries never match. */
  readonly path: string;
  /** Raw byte cap, positive and no greater than 64 KiB. Defaults to 64 KiB. */
  readonly maxBodyBytes?: number;
  /** Alias matching the provider-neutral gateway terminology. */
  readonly maxRawBodyBytes?: number;
  /** Fixed operational messages only; it never receives request data or errors. */
  readonly log?: (message: string) => void;
}

/** A running, private webhook listener. */
export interface TelegramWebhookServer {
  /** The actual bound port, including when `port: 0` was requested. */
  readonly port: number;
  /** Stop accepting, destroy live sockets, and resolve safely on repeated calls. */
  close(): Promise<void>;
}

type RawBodyReadResult =
  | { readonly kind: "body"; readonly rawBody: Uint8Array }
  | { readonly kind: "too-large" }
  | { readonly kind: "aborted" };

/** Write an intentionally empty response: no request detail is ever reflected. */
function sendEmpty(res: ServerResponse, status: number): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-length": "0" });
  res.end();
}

/** Content-Type must name JSON; optional parameters (for example charset) are accepted. */
function isJsonContentType(value: string | readonly string[] | undefined): boolean {
  if (typeof value !== "string") return false;
  const [mediaType] = value.split(";", 1);
  return mediaType?.trim().toLowerCase() === "application/json";
}

/** A webhook must not be transparently decompressed before signature verification. */
function isIdentityContentEncoding(value: string | readonly string[] | undefined): boolean {
  return value === undefined
    || (typeof value === "string" && value.trim().toLowerCase() === "identity");
}

/**
 * Validate Content-Length without coercion. An arbitrary-length decimal is
 * still meaningful: a declared value over the cap is rejected before body
 * reads, even when it cannot fit in JavaScript's numeric range.
 */
function declaredContentLength(
  value: string | readonly string[] | undefined,
  maxBodyBytes: number,
): "within-cap" | "over-cap" | "invalid" {
  if (value === undefined) return "within-cap";
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return "invalid";
  try {
    return BigInt(value) > BigInt(maxBodyBytes) ? "over-cap" : "within-cap";
  } catch {
    return "invalid";
  }
}

/** Read raw bytes only. It never JSON-decodes, stringifies, or logs the body. */
function readRawBody(req: IncomingMessage, maxBodyBytes: number): Promise<RawBodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const finish = (result: RawBodyReadResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        // Drain rather than buffer the remaining stream. The caller sends its
        // empty 413 response then closes the socket once it is flushed.
        finish({ kind: "too-large" });
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish({ kind: "body", rawBody: Buffer.concat(chunks, total) });
    const onAborted = () => finish({ kind: "aborted" });
    const onError = () => finish({ kind: "aborted" });

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });
}

/** Gateway outcomes deliberately reveal only retry semantics to Telegram. */
function statusForGatewayResult(result: PlatformBridgeInboundResult): number {
  switch (result) {
    case "verification-failed":
      return 401;
    case "request-too-large":
      return 413;
    case "invalid-request":
      return 400;
    case "receipt-unavailable":
    case "idempotency-capacity-reached":
      return 503;
    default:
      // The provider received the delivery. Permanent command/admission
      // rejections are acknowledged so they cannot cause unbounded retries.
      return 204;
  }
}

/** End a rejected request, then sever a body stream that this listener will not consume. */
function rejectAndClose(req: IncomingMessage, res: ServerResponse, status: number): void {
  const destroySocket = () => {
    if (!req.socket.destroyed) req.socket.destroy();
  };
  res.once("finish", destroySocket);
  res.once("close", destroySocket);
  sendEmpty(res, status);
  req.resume();
}

/** Finish an over-cap request, then sever an abusive or chunked body stream. */
function rejectTooLargeAndClose(req: IncomingMessage, res: ServerResponse): void {
  rejectAndClose(req, res, 413);
}

/** Incoming URLs are deliberately not decoded or normalized before comparison. */
function isExactWebhookRequestPath(url: string | undefined, expectedPath: string): boolean {
  return url === expectedPath;
}

/** Close a node server while ensuring keep-alive and partial-body sockets cannot hang shutdown. */
function closeServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

/** Await a bound loopback port without exposing an error's potentially sensitive context. */
function listen(server: Server, port: number, log?: (message: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = () => {
      server.off("error", onError);
      log?.("telegram webhook server could not start");
      reject(new Error("telegram-webhook-server-start-failed"));
    };
    server.once("error", onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string" || !Number.isInteger(address.port) || address.port < 1) {
        void closeServer(server, new Set<Socket>()).finally(() => {
          reject(new Error("telegram-webhook-server-address-invalid"));
        });
        return;
      }
      log?.("telegram webhook server listening");
      resolve(address.port);
    });
  });
}

/**
 * Start a single-purpose Telegram ingress server.
 *
 * The listener is always bound to `127.0.0.1`; an owner-operated HTTPS reverse
 * proxy/tunnel is responsible for any public Telegram webhook endpoint.
 */
export async function startTelegramWebhookServer(
  options: TelegramWebhookServerOptions,
): Promise<TelegramWebhookServer> {
  if (!options || typeof options !== "object") {
    throw new TypeError("telegram-webhook-server-options-invalid");
  }
  if (typeof options.gateway?.handleWebhook !== "function") {
    throw new TypeError("telegram-webhook-server-gateway-invalid");
  }
  if (options.host !== undefined && options.host !== LOOPBACK_HOST) {
    throw new TypeError("telegram-webhook-server-host-must-be-127-0-0-1");
  }
  if (typeof options.path !== "string" || !SAFE_WEBHOOK_PATH.test(options.path)) {
    throw new TypeError("telegram-webhook-server-path-invalid");
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("telegram-webhook-server-port-invalid");
  }
  if (
    options.maxBodyBytes !== undefined
    && options.maxRawBodyBytes !== undefined
    && options.maxBodyBytes !== options.maxRawBodyBytes
  ) {
    throw new TypeError("telegram-webhook-server-max-body-bytes-conflict");
  }
  const maxBodyBytes = options.maxBodyBytes ?? options.maxRawBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (
    !Number.isSafeInteger(maxBodyBytes)
    || maxBodyBytes < 1
    || maxBodyBytes > ABSOLUTE_MAX_BODY_BYTES
  ) {
    throw new TypeError("telegram-webhook-server-max-body-bytes-invalid");
  }
  if (options.log !== undefined && typeof options.log !== "function") {
    throw new TypeError("telegram-webhook-server-log-invalid");
  }

  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    if (!isExactWebhookRequestPath(req.url, options.path)) {
      rejectAndClose(req, res, 404);
      return;
    }
    if (req.method !== "POST") {
      rejectAndClose(req, res, 405);
      return;
    }
    if (!isJsonContentType(req.headers["content-type"])) {
      rejectAndClose(req, res, 400);
      return;
    }
    if (!isIdentityContentEncoding(req.headers["content-encoding"])) {
      rejectAndClose(req, res, 400);
      return;
    }

    const declaredLength = declaredContentLength(req.headers["content-length"], maxBodyBytes);
    if (declaredLength === "invalid") {
      rejectAndClose(req, res, 400);
      return;
    }
    if (declaredLength === "over-cap") {
      rejectTooLargeAndClose(req, res);
      return;
    }

    void (async () => {
      const body = await readRawBody(req, maxBodyBytes);
      if (body.kind === "aborted") return;
      if (body.kind === "too-large") {
        rejectTooLargeAndClose(req, res);
        return;
      }
      try {
        const result = await options.gateway.handleWebhook({
          rawBody: body.rawBody,
          // Do not normalize or copy Node's headers: provider verification
          // needs the wire representation selected by node:http.
          headers: req.headers,
        });
        sendEmpty(res, statusForGatewayResult(result));
      } catch {
        // A bridge failure is retriable, but the thrown detail is never logged
        // or sent to the provider.
        options.log?.("telegram webhook gateway failed");
        sendEmpty(res, 503);
      }
    })().catch(() => {
      // `readRawBody` is internally non-throwing; this is a final fail-safe
      // against a future edit creating an unhandled request rejection.
      options.log?.("telegram webhook request failed");
      sendEmpty(res, 503);
    });
  });
  configureTelegramWebhookServerLimits(server);

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    // node's parser rejected the request before a handler existed. Reply with
    // no detail, then close; the parser error can contain request fragments.
    options.log?.("telegram webhook client error");
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });

  const boundPort = await listen(server, port, options.log);
  let closing: Promise<void> | undefined;
  return {
    port: boundPort,
    close: () => {
      closing ??= closeServer(server, sockets);
      return closing;
    },
  };
}
