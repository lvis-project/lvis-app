import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  A2A_DIRECT_JSONRPC_METHODS,
  A2A_ERROR_INFO_DOMAIN,
  A2A_HOST_ERROR_INFO_DOMAIN,
  A2A_ERROR_INFO_TYPE,
  A2A_JSONRPC_VERSION,
  A2A_PROTOCOL_VERSION,
  A2A_PUSH_JSONRPC_METHODS,
  A2AJsonRpcErrorDefinition,
  A2AHostJsonRpcErrorDefinition,
  A2AJsonRpcMethod,
  StandardJsonRpcErrorDefinition,
  type A2AAgentCard,
  type A2AAgentCardTemplate,
  type A2ADirectJsonRpcMethod,
  type A2ADirectJsonRpcResult,
  type A2AJsonObject,
  type A2AJsonRpcId,
  type A2AJsonRpcRequest,
  type A2AJsonValue,
  type A2ARouterErrorDefinition,
  type StandardJsonRpcErrorDefinition as StandardErrorDefinition,
} from "../shared/a2a-wire.js";
import { parseA2AStrictJson } from "./a2a-strict-json.js";
import { isCanonicalA2APublicHttpsOrigin } from "../shared/a2a-public-origin.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_BODY_BYTES = 1024 * 1024;
const HANDLER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const A2A_ROOT_PATTERN = /^\/a2a\/([a-z0-9][a-z0-9-]{0,63})\/?$/;
const A2A_CARD_PATTERN =
  /^\/a2a\/([a-z0-9][a-z0-9-]{0,63})\/\.well-known\/agent-card\.json$/;
const DIRECT_METHODS = new Set<string>(A2A_DIRECT_JSONRPC_METHODS);
const PUSH_METHODS = new Set<string>(A2A_PUSH_JSONRPC_METHODS);

export class A2AHandlerError extends Error {
  readonly definition: A2ARouterErrorDefinition | StandardErrorDefinition;

  constructor(definition: A2ARouterErrorDefinition | StandardErrorDefinition) {
    super(definition.message);
    this.name = "A2AHandlerError";
    this.definition = definition;
  }
}

export interface A2ARequestHandler {
  /** Stable URL path segment. Profile display names never become addresses. */
  id: string;
  card: A2AAgentCardTemplate;
  handle(method: A2ADirectJsonRpcMethod, params: A2AJsonObject): Promise<A2ADirectJsonRpcResult>;
  /**
   * Optional raw-wire path for profiles whose contract binds exact HTTP body
   * bytes or response headers. The ph3 loopback handlers intentionally omit
   * this seam and continue through {@link handle} unchanged.
   */
  handleWire?(
    request: Readonly<A2AJsonRpcRequest>,
    context: Readonly<A2AWireRequestContext>,
  ): Promise<A2AWireHandlerResult>;
}

export interface A2AWireRequestContext {
  rawBody: Uint8Array;
  authorization?: string;
  extensions?: string | readonly string[];
}

export interface A2AWireHandlerResult {
  result: A2ADirectJsonRpcResult;
  headers?: Readonly<Record<string, string>>;
}

/** A complete handler-owned wire failure; values are emitted without logging. */
export class A2AWireResponseError extends Error {
  constructor(
    readonly status: number,
    readonly error: Readonly<{ code: number; message: string; data?: A2AJsonValue }>,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(error.message);
    this.name = "A2AWireResponseError";
  }
}

export interface A2AHttpRouterAuditEvent {
  type: "a2a-wire-drop";
  reason: "unknown-handler" | "invalid-request" | "handler-error";
  handlerId?: string;
  method?: string;
}

export interface A2AHttpRouter {
  /** Stable, sorted handler ids exposed by this immutable boot snapshot. */
  readonly handlerIds: readonly string[];
  isPublicAgentCardRequest(path: string, method: string): boolean;
  tryHandle(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
  ): Promise<boolean>;
}

export interface CreateA2AHttpRouterOptions {
  handlers: readonly A2ARequestHandler[];
  /** Fixed host-owned public origin; request Host/forwarded headers are ignored. */
  advertisedOrigin?: string;
  audit?: (event: A2AHttpRouterAuditEvent) => void;
  log?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CORE_A2A_RESPONSE_HEADERS = new Set(["content-type", "a2a-version"]);

function hasCoreA2AResponseHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
  return headers !== undefined && Object.keys(headers).some(
    (name) => CORE_A2A_RESPONSE_HEADERS.has(name.toLowerCase()),
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...headers,
    "content-type": JSON_CONTENT_TYPE,
    "a2a-version": A2A_PROTOCOL_VERSION,
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overCap = false;
    req.on("data", (chunk: Buffer) => {
      if (overCap) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overCap = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overCap) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function isValidRequestId(value: unknown): value is A2AJsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}

function supportsProtocolVersion(value: string | string[] | undefined): boolean {
  return typeof value === "string" && /^1\.0(?:\.\d+)?$/.test(value);
}

function sendSuccess(
  res: ServerResponse,
  id: A2AJsonRpcId,
  result: A2ADirectJsonRpcResult,
  headers: Record<string, string> = {},
): void {
  sendJson(res, 200, { jsonrpc: A2A_JSONRPC_VERSION, id, result }, headers);
}

function sendWireFailure(
  res: ServerResponse,
  id: A2AJsonRpcId,
  failure: A2AWireResponseError,
): void {
  sendJson(
    res,
    failure.status,
    { jsonrpc: A2A_JSONRPC_VERSION, id, error: failure.error },
    { ...failure.headers },
  );
}

function sendFailure(
  res: ServerResponse,
  id: A2AJsonRpcId,
  definition: A2ARouterErrorDefinition | StandardErrorDefinition,
  metadata?: Record<string, string>,
): void {
  const reason = "reason" in definition ? definition.reason : undefined;
  const domain = reason === A2AHostJsonRpcErrorDefinition.OPERATION_REJECTED.reason
    ? A2A_HOST_ERROR_INFO_DOMAIN
    : A2A_ERROR_INFO_DOMAIN;
  const data: A2AJsonValue | undefined = reason
    ? [
        {
          "@type": A2A_ERROR_INFO_TYPE,
          reason,
          domain,
          ...(metadata ? { metadata } : {}),
        },
      ]
    : undefined;
  sendJson(res, 200, {
    jsonrpc: A2A_JSONRPC_VERSION,
    id,
    error: {
      code: definition.code,
      message: definition.message,
      ...(data ? { data } : {}),
    },
  });
}

function parseRequest(raw: Uint8Array): {
  request?: A2AJsonRpcRequest;
  error?: StandardErrorDefinition;
} {
  let parsed: unknown;
  try {
    parsed = parseA2AStrictJson(raw, { maxBytes: MAX_BODY_BYTES });
  } catch {
    return { error: StandardJsonRpcErrorDefinition.PARSE_ERROR };
  }
  if (!isRecord(parsed)) return { error: StandardJsonRpcErrorDefinition.INVALID_REQUEST };
  if (
    parsed.jsonrpc !== A2A_JSONRPC_VERSION ||
    typeof parsed.method !== "string" ||
    !("id" in parsed) ||
    !isValidRequestId(parsed.id) ||
    (parsed.params !== undefined && !isRecord(parsed.params))
  ) {
    return { error: StandardJsonRpcErrorDefinition.INVALID_REQUEST };
  }
  return {
    request: {
      jsonrpc: A2A_JSONRPC_VERSION,
      id: parsed.id,
      method: parsed.method,
      ...(parsed.params === undefined ? {} : { params: parsed.params as A2AJsonObject }),
    },
  };
}

function interfaceUrl(req: IncomingMessage, handlerId: string, advertisedOrigin?: string): string {
  return advertisedOrigin
    ? advertisedOrigin.slice(0, -1) + "/a2a/" + handlerId
    : "http://127.0.0.1:" + String(req.socket.localPort) + "/a2a/" + handlerId;
}

export function buildA2AAgentCard(
  handler: A2ARequestHandler,
  advertisedInterfaceUrl: string,
): A2AAgentCard {
  return {
    ...handler.card,
    supportedInterfaces: [
      {
        url: advertisedInterfaceUrl,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
  };
}

function sendCard(req: IncomingMessage, res: ServerResponse, handler: A2ARequestHandler, advertisedOrigin?: string): void {
  const card = buildA2AAgentCard(handler, interfaceUrl(req, handler.id, advertisedOrigin));
  const payload = JSON.stringify(card);
  const etag = '"' + createHash("sha256").update(payload).digest("hex") + '"';
  res.writeHead(200, {
    "content-type": JSON_CONTENT_TYPE,
    "cache-control": "public, max-age=60",
    etag,
    "last-modified": new Date(0).toUTCString(),
  });
  res.end(payload);
}

function hasJsonContentType(req: IncomingMessage): boolean {
  const value = req.headers["content-type"];
  return (
    typeof value === "string" &&
    value.split(";", 1)[0].trim().toLowerCase() === "application/json"
  );
}

function includesInlinePushConfig(params: A2AJsonObject): boolean {
  const configuration = params.configuration;
  return (
    isRecord(configuration) &&
    ("taskPushNotificationConfig" in configuration ||
      "task_push_notification_config" in configuration)
  );
}

export function createA2AHttpRouter(options: CreateA2AHttpRouterOptions): A2AHttpRouter {
  if (options.advertisedOrigin !== undefined) {
    if (!isCanonicalA2APublicHttpsOrigin(options.advertisedOrigin)) {
      throw new Error("a2a-advertised-origin-invalid");
    }
  }
  const handlers = new Map<string, A2ARequestHandler>();
  for (const handler of options.handlers) {
    if (!HANDLER_ID_PATTERN.test(handler.id)) {
      throw new Error("invalid A2A handler id: " + handler.id);
    }
    if (handlers.has(handler.id)) {
      throw new Error("duplicate A2A handler id: " + handler.id);
    }
    if (
      handler.card.capabilities.streaming ||
      handler.card.capabilities.pushNotifications ||
      handler.card.capabilities.extendedAgentCard
    ) {
      throw new Error("A2A handler advertises an unsupported wire capability: " + handler.id);
    }
    handlers.set(handler.id, handler);
  }

  const handlerIds = Object.freeze([...handlers.keys()].sort());

  const router: A2AHttpRouter = {
    handlerIds,
    isPublicAgentCardRequest(path, method) {
      return method === "GET" && A2A_CARD_PATTERN.test(path);
    },

    async tryHandle(req, res, path, method) {
      const cardMatch = A2A_CARD_PATTERN.exec(path);
      const rootMatch = A2A_ROOT_PATTERN.exec(path);
      const match = cardMatch ?? rootMatch;
      if (!match) return false;

      const handlerId = match[1];
      const handler = handlers.get(handlerId);
      if (!handler) {
        options.audit?.({ type: "a2a-wire-drop", reason: "unknown-handler", handlerId });
        sendJson(res, 404, { ok: false, error: "a2a-handler-not-found" });
        return true;
      }

      if (cardMatch) {
        if (method !== "GET") {
          sendJson(res, 405, { ok: false, error: "method-not-allowed" });
          return true;
        }
        sendCard(req, res, handler, options.advertisedOrigin);
        return true;
      }

      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method-not-allowed" });
        return true;
      }
      if (!hasJsonContentType(req)) {
        sendFailure(res, null, A2AJsonRpcErrorDefinition.CONTENT_TYPE_NOT_SUPPORTED);
        return true;
      }

      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { ok: false, error: "payload-too-large" });
        return true;
      }
      const parsed = parseRequest(raw);
      if (!parsed.request) {
        options.audit?.({ type: "a2a-wire-drop", reason: "invalid-request", handlerId });
        sendFailure(res, null, parsed.error ?? StandardJsonRpcErrorDefinition.INVALID_REQUEST);
        return true;
      }

      const request = parsed.request;
      if (!supportsProtocolVersion(req.headers["a2a-version"])) {
        sendFailure(
          res,
          request.id,
          A2AJsonRpcErrorDefinition.VERSION_NOT_SUPPORTED,
          { supportedVersions: A2A_PROTOCOL_VERSION },
        );
        return true;
      }

      if (
        request.method === A2AJsonRpcMethod.SEND_STREAMING_MESSAGE ||
        request.method === A2AJsonRpcMethod.SUBSCRIBE_TO_TASK ||
        request.method === A2AJsonRpcMethod.GET_EXTENDED_AGENT_CARD
      ) {
        sendFailure(res, request.id, A2AJsonRpcErrorDefinition.UNSUPPORTED_OPERATION);
        return true;
      }
      if (PUSH_METHODS.has(request.method)) {
        sendFailure(res, request.id, A2AJsonRpcErrorDefinition.PUSH_NOTIFICATION_NOT_SUPPORTED);
        return true;
      }
      if (!DIRECT_METHODS.has(request.method)) {
        sendFailure(res, request.id, StandardJsonRpcErrorDefinition.METHOD_NOT_FOUND);
        return true;
      }
      const params = request.params ?? {};
      if (
        request.method === A2AJsonRpcMethod.SEND_MESSAGE &&
        includesInlinePushConfig(params)
      ) {
        sendFailure(res, request.id, A2AJsonRpcErrorDefinition.PUSH_NOTIFICATION_NOT_SUPPORTED);
        return true;
      }

      try {
        if (handler.handleWire) {
          const authorization = req.headers.authorization;
          const extensions = req.headers["a2a-extensions"];
          const reply = await handler.handleWire(request, Object.freeze({
            rawBody: Uint8Array.from(raw),
            ...(typeof authorization === "string" ? { authorization } : {}),
            ...((typeof extensions === "string" || Array.isArray(extensions)) ? { extensions } : {}),
          }));
          if (hasCoreA2AResponseHeader(reply.headers)) {
            throw new Error("a2a-wire-core-response-header-reserved");
          }
          sendSuccess(res, request.id, reply.result, reply.headers === undefined ? {} : { ...reply.headers });
        } else {
          const result = await handler.handle(
            request.method as A2ADirectJsonRpcMethod,
            params,
          );
          sendSuccess(res, request.id, result);
        }
      } catch (error) {
        if (error instanceof A2AWireResponseError) {
          if (hasCoreA2AResponseHeader(error.headers)) {
            options.audit?.({
              type: "a2a-wire-drop",
              reason: "handler-error",
              handlerId,
              method: request.method,
            });
            options.log?.("A2A handler " + handlerId + " failed");
            sendFailure(res, request.id, StandardJsonRpcErrorDefinition.INTERNAL_ERROR);
            return true;
          }
          sendWireFailure(res, request.id, error);
          return true;
        }
        if (error instanceof A2AHandlerError) {
          sendFailure(res, request.id, error.definition);
          return true;
        }
        options.audit?.({
          type: "a2a-wire-drop",
          reason: "handler-error",
          handlerId,
          method: request.method,
        });
        options.log?.("A2A handler " + handlerId + " failed");
        sendFailure(res, request.id, StandardJsonRpcErrorDefinition.INTERNAL_ERROR);
      }
      return true;
    },
  };
  return Object.freeze(router);
}
