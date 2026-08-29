/**
 * Main-owned bridge between a subscription runtime's tool protocol and the
 * normal LVIS tool loop.  It intentionally knows only the tool schemas that
 * LVIS already selected for the current round; it never receives a project
 * path, shell command, renderer object, or credential.
 *
 * Codex consumes `dynamicTools` directly. ACP runtimes consume the same
 * bounded set through a short-lived loopback MCP child. In both cases a tool
 * request becomes an ordinary `StreamEvent.tool_call` in the caller, so
 * ToolExecutor, PermissionManager, audit, plugins, and MCP policy remain the
 * sole execution authority.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { ToolSchema } from "../engine/llm/types.js";
import { mainDir } from "./main-paths.js";

import { SUBSCRIPTION_TOOL_BRIDGE_CONTRACT } from "../shared/subscription-runtime.js";
const MAX_TOOL_COUNT = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxToolCount;
const MAX_SOURCE_TOOL_NAME_LENGTH = 256;
const MAX_REMOTE_TOOL_NAME_LENGTH = 128;
const MAX_DESCRIPTION_CHARACTERS = 1_024;
const MAX_DESCRIPTION_BYTES = 64 * 1024;
const MAX_SCHEMA_BYTES = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxSchemaBytes;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_HTTP_BODY_BYTES = 128 * 1024;
const MAX_JSON_DEPTH = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxJsonDepth;
const MAX_JSON_KEYS = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxJsonKeys;
const MAX_JSON_ARRAY_ITEMS = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxJsonArrayItems;
const MAX_JSON_STRING_LENGTH = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxJsonStringLength;
const MCP_SERVER_NAME = "lvis-host-tools";
const MCP_CHILD_ENV = "ELECTRON_RUN_AS_NODE";
const BRIDGE_URL_ENV = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.urlEnv;
const BRIDGE_TOKEN_ENV = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.tokenEnv;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DESCRIPTION_CONTROL_CHARACTERS = /[\u0000\u007f]/;
const SAFE_REMOTE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonRecord | JsonValue[];
type JsonRecord = { [key: string]: JsonValue };

export interface SubscriptionHostToolCall {
  /** Host-minted and safe for the normal LVIS ToolExecutor use-id contract. */
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * The consumer must enqueue the normal engine tool call before resolving this
 * promise. Its text is returned only to the remote runtime; it is never shown
 * to the renderer as a tool result.
 */
export type SubscriptionHostToolCallHandler = (
  call: SubscriptionHostToolCall,
) => Promise<string> | string;

/** Structural ACP `session/new.mcpServers` configuration. */
export interface SubscriptionToolBridgeMcpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface SubscriptionToolBridgeMcpOptions {
  /** Test seam; production runs the bundled standalone MCP stdio helper. */
  readonly command?: string;
  /** Test seam; production points at the bundled standalone MCP helper. */
  readonly args?: readonly string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeJsonValue(
  value: unknown,
  depth = 0,
  state: { keys: number } = { keys: 0 },
): value is JsonValue {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= MAX_JSON_STRING_LENGTH;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= MAX_JSON_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.length <= MAX_JSON_ARRAY_ITEMS
      && value.every((entry) => isSafeJsonValue(entry, depth + 1, state));
  }
  if (!isPlainRecord(value)) return false;
  const entries = Object.entries(value);
  state.keys += entries.length;
  if (state.keys > MAX_JSON_KEYS) return false;
  return entries.every(([key, entry]) =>
    key !== "__proto__"
    && key !== "constructor"
    && key !== "prototype"
    && !CONTROL_CHARACTERS.test(key)
    && isSafeJsonValue(entry, depth + 1, state));
}

function jsonClone<T extends JsonValue>(value: T): T | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    const parsed: unknown = JSON.parse(serialized);
    return isSafeJsonValue(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maxBytes) return null;
  return CONTROL_CHARACTERS.test(value) ? null : value;
}

function boundedDescription(value: unknown): string | null {
  if (
    typeof value !== "string"
    || !value
    || value.length > MAX_DESCRIPTION_CHARACTERS
    || Buffer.byteLength(value, "utf8") > MAX_DESCRIPTION_BYTES
    || DESCRIPTION_CONTROL_CHARACTERS.test(value)
  ) return null;
  return value;
}

function cloneToolSchema(schema: ToolSchema): ToolSchema | null {
  const name = boundedString(schema.name, MAX_SOURCE_TOOL_NAME_LENGTH);
  const description = boundedDescription(schema.description);
  if (!name || !description || !isPlainRecord(schema.inputSchema)) return null;
  const inputSchema = jsonClone(schema.inputSchema as JsonRecord);
  if (!inputSchema || Buffer.byteLength(JSON.stringify(inputSchema), "utf8") > MAX_SCHEMA_BYTES) return null;
  return Object.freeze({
    name,
    description,
    inputSchema: inputSchema as ToolSchema["inputSchema"],
  });
}

interface BridgedToolSchema {
  readonly originalName: string;
  readonly remoteSchema: ToolSchema;
}

function remoteToolName(originalName: string, occupied: ReadonlyMap<string, BridgedToolSchema>): string {
  const base = SAFE_REMOTE_TOOL_NAME.test(originalName)
    ? originalName
    : `lvis_${createHash("sha256").update(originalName, "utf8").digest("hex").slice(0, 48)}`;
  if (!occupied.has(base)) return base;
  for (let suffix = 1; suffix <= MAX_TOOL_COUNT; suffix += 1) {
    const serial = String(suffix);
    const candidate = `${base.slice(0, MAX_REMOTE_TOOL_NAME_LENGTH - serial.length - 1)}_${serial}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("subscription-host-tool-schema-invalid");
}

function sameToken(candidate: string | null, expected: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization);
  return match?.[1] ?? null;
}

function writeJson(response: ServerResponse, statusCode: number, value: JsonValue): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-store",
    "connection": "close",
  });
  response.end(body);
}

async function closeMcpServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => {
    try {
      server.close(() => resolveClose());
    } catch {
      resolveClose();
    }
  });
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > MAX_HTTP_BODY_BYTES) return null;
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isPlainRecord(parsed) && isSafeJsonValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function unknownToolResponse(): JsonRecord {
  return {
    content: [{ type: "text", text: "LVIS could not accept that host tool request." }],
    isError: true,
  };
}

/**
 * A one-turn bridge. It accepts at most one host tool request because the
 * normal engine must execute that request and rebuild context/tool schemas
 * before the subscription runtime receives another model turn.
 */
export class SubscriptionToolBridge {
  private readonly schemas: readonly ToolSchema[];
  private readonly schemasByRemoteName = new Map<string, BridgedToolSchema>();
  private readonly originalToolNames = new Set<string>();
  private handler: SubscriptionHostToolCallHandler | null = null;
  private accepted = false;
  private stopped = false;
  private mcpServer: Server | null = null;
  private mcpStartingServer: Server | null = null;
  private mcpConfig: SubscriptionToolBridgeMcpServerConfig | null = null;
  private mcpStartPromise: Promise<SubscriptionToolBridgeMcpServerConfig> | null = null;

  constructor(tools: readonly ToolSchema[] | undefined) {
    const provided = tools ?? [];
    if (provided.length > MAX_TOOL_COUNT) throw new Error("subscription-host-tools-too-many");
    const cloned: ToolSchema[] = [];
    for (const schema of provided) {
      const safe = cloneToolSchema(schema);
      if (!safe || this.originalToolNames.has(safe.name)) {
        throw new Error("subscription-host-tool-schema-invalid");
      }
      const remoteName = remoteToolName(safe.name, this.schemasByRemoteName);
      const remoteSchema = Object.freeze({ ...safe, name: remoteName });
      this.originalToolNames.add(safe.name);
      this.schemasByRemoteName.set(remoteName, Object.freeze({
        originalName: safe.name,
        remoteSchema,
      }));
      cloned.push(remoteSchema);
    }
    this.schemas = Object.freeze(cloned);
  }

  /** Safe copies suitable for Codex App Server `dynamicTools`. */
  get tools(): readonly ToolSchema[] {
    return this.schemas;
  }

  /** Set only for the currently active service stream. */
  setHandler(handler: SubscriptionHostToolCallHandler | null): void {
    if (this.stopped) return;
    this.handler = handler;
  }

  async invoke(name: unknown, input: unknown): Promise<string> {
    if (this.stopped || this.accepted) throw new Error("subscription-host-tool-unavailable");
    const schema = typeof name === "string" && SAFE_REMOTE_TOOL_NAME.test(name)
      ? this.schemasByRemoteName.get(name)
      : undefined;
    if (!schema || !isPlainRecord(input) || !isSafeJsonValue(input)) {
      throw new Error("subscription-host-tool-invalid");
    }
    const safeInput = jsonClone(input as JsonRecord);
    if (!safeInput) {
      throw new Error("subscription-host-tool-invalid");
    }
    let callPayloadBytes: number;
    try {
      callPayloadBytes = Buffer.byteLength(JSON.stringify({ name, arguments: safeInput }), "utf8");
    } catch {
      throw new Error("subscription-host-tool-invalid");
    }
    if (Buffer.byteLength(JSON.stringify(safeInput), "utf8") > MAX_ARGUMENT_BYTES || callPayloadBytes > MAX_HTTP_BODY_BYTES) {
      throw new Error("subscription-host-tool-invalid");
    }
    const handler = this.handler;
    if (!handler) throw new Error("subscription-host-tool-unavailable");
    this.accepted = true;
    return handler(Object.freeze({
      id: `subscription_${randomUUID()}`,
      name: schema.originalName,
      input: safeInput as Record<string, unknown>,
    }));
  }

  /**
   * Lazily host the tiny local endpoint used by the bundled ACP MCP child.
   * The unguessable, session-scoped token is deliberately passed only to that
   * child through its MCP env entry and is destroyed on `stop()`.
   */
  async startMcpServer(
    options: SubscriptionToolBridgeMcpOptions = {},
  ): Promise<SubscriptionToolBridgeMcpServerConfig> {
    if (this.stopped) throw new Error("subscription-host-tool-unavailable");
    if (this.mcpConfig) return this.mcpConfig;
    if (this.mcpStartPromise) return this.mcpStartPromise;

    const start = this.startMcpServerOnce(options);
    this.mcpStartPromise = start;
    void start.finally(() => {
      if (this.mcpStartPromise === start) this.mcpStartPromise = null;
    }).catch(() => undefined);
    return start;
  }

  private async startMcpServerOnce(
    options: SubscriptionToolBridgeMcpOptions,
  ): Promise<SubscriptionToolBridgeMcpServerConfig> {
    const token = randomBytes(32).toString("base64url");
    const server = createServer((request, response) => {
      void this.handleMcpHttpRequest(request, response, token);
    });
    this.mcpStartingServer = server;
    try {
      await this.listenMcpServer(server);
      if (this.stopped) throw new Error("subscription-host-tool-unavailable");
      const address = server.address();
      if (!address || typeof address === "string" || !Number.isSafeInteger(address.port) || address.port <= 0) {
        throw new Error("subscription-host-tool-server-failed");
      }
      const args = options.args ?? [join(mainDir, "subscription-tool-mcp-server.js")];
      const command = options.command ?? process.execPath;
      if (!command || !Array.isArray(args) || args.some((arg) => !boundedString(arg, 8 * 1024))) {
        throw new Error("subscription-host-tool-server-failed");
      }
      if (this.stopped) throw new Error("subscription-host-tool-unavailable");
      this.mcpServer = server;
      this.mcpConfig = Object.freeze({
        name: MCP_SERVER_NAME,
        command,
        args: Object.freeze([...args]),
        env: Object.freeze({
          [MCP_CHILD_ENV]: "1",
          [BRIDGE_URL_ENV]: "http://127.0.0.1:" + address.port,
          [BRIDGE_TOKEN_ENV]: token,
        }),
      });
      return this.mcpConfig;
    } catch (error) {
      await closeMcpServer(server);
      throw error;
    } finally {
      if (this.mcpStartingServer === server) this.mcpStartingServer = null;
    }
  }

  private async listenMcpServer(server: Server): Promise<void> {
    await new Promise<void>((resolveListen, rejectListen) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        server.removeListener("error", fail);
        server.removeListener("close", closeBeforeReady);
        callback();
      };
      const fail = () => finish(() => rejectListen(new Error("subscription-host-tool-server-failed")));
      // A close can win before the listen callback without producing an error
      // event. Rejecting here lets stop() await and clean the start safely.
      const closeBeforeReady = () => finish(() => rejectListen(new Error("subscription-host-tool-unavailable")));
      server.once("error", fail);
      server.once("close", closeBeforeReady);
      server.listen(0, "127.0.0.1", () => finish(resolveListen));
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.handler = null;
    const runningServer = this.mcpServer;
    const startingServer = this.mcpStartingServer;
    this.mcpServer = null;
    this.mcpConfig = null;
    await Promise.all([
      ...(runningServer ? [closeMcpServer(runningServer)] : []),
      ...(startingServer && startingServer !== runningServer ? [closeMcpServer(startingServer)] : []),
    ]);
    const start = this.mcpStartPromise;
    if (start) {
      try {
        await start;
      } catch {
        // Stop deliberately cancels an in-flight listener; never rethrow it.
      }
    }
    // A listener can finish after the first close attempt. startMcpServerOnce
    // normally closes it on the stopped recheck; retain this final guard.
    const lateServer = this.mcpServer;
    this.mcpServer = null;
    this.mcpConfig = null;
    if (lateServer && lateServer !== runningServer) await closeMcpServer(lateServer);
  }

  private async handleMcpHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    if (!sameToken(bearerToken(request), token)) {
      writeJson(response, 401, unknownToolResponse());
      return;
    }
    if (request.method === "GET" && request.url === "/v1/tools") {
      writeJson(response, 200, { tools: this.schemas as unknown as JsonValue[] });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/tools/call") {
      writeJson(response, 404, unknownToolResponse());
      return;
    }
    const body = await readJsonBody(request);
    if (!body) {
      writeJson(response, 400, unknownToolResponse());
      return;
    }
    try {
      const text = await this.invoke(body.name, body.arguments);
      // The engine executes the accepted call and starts a fresh remote model
      // round with the resulting tool_result. Returning an error prevents an
      // external runtime from bypassing that round boundary locally.
      writeJson(response, 200, {
        content: [{ type: "text", text }],
        isError: true,
      });
    } catch {
      writeJson(response, 200, unknownToolResponse());
    }
  }
}
