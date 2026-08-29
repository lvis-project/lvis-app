/**
 * LVIS-owned stdio MCP shim for ACP subscription runtimes.
 *
 * The external ACP runtime starts this process with two ephemeral environment
 * values created by the main process. This shim then exposes only MCP
 * `tools/list` and `tools/call`; it does not expose a filesystem, terminal,
 * browser, resource, prompt, sampling, or permission capability.
 *
 * The loopback HTTP bridge is intentionally narrow and versioned:
 *
 * - `GET /v1/tools` with `Authorization: Bearer <token>` returns
 *   `{ tools: [{ name, description, inputSchema }] }`.
 * - `POST /v1/tools/call` with the same header and JSON
 *   `{ name, arguments }` returns
 *   `{ content: [{ type: "text", text }], isError: boolean }`.
 *
 * The main process owns that bridge, binds it only to `127.0.0.1`, validates
 * each call against the currently exposed LVIS ToolSchema set, and emits at
 * most one sanitized LVIS tool-call event for the active provider round. This
 * child never executes a tool itself. Consequently every accepted invocation
 * continues through LVIS ToolExecutor, permissions, approvals, and audit.
 */
import { request as httpRequest, type RequestOptions } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { SUBSCRIPTION_TOOL_BRIDGE_CONTRACT } from "../shared/subscription-runtime.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

import { isPlainRecord } from "../shared/is-record.js";
const BRIDGE_URL_ENV = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.urlEnv;
const BRIDGE_TOKEN_ENV = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.tokenEnv;
const BRIDGE_HOST = "127.0.0.1";
const TOOLS_PATH = "/v1/tools";
const TOOL_CALL_PATH = "/v1/tools/call";
const MAX_BRIDGE_RESPONSE_BYTES = 512 * 1024;
const MAX_TOOL_CALL_REQUEST_BYTES = 128 * 1024;
const MAX_TOOL_COUNT = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxToolCount;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_DESCRIPTION_LENGTH = 16 * 1024;
const MAX_SCHEMA_DIALECT_LENGTH = 1_024;
const MAX_SCHEMA_BYTES = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxSchemaBytes;
const MAX_JSON_DEPTH = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxJsonDepth;
const MAX_JSON_KEYS = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxJsonKeys;
const MAX_JSON_ARRAY_ITEMS = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxJsonArrayItems;
const MAX_JSON_STRING_LENGTH = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxJsonStringLength;
const MAX_RESULT_TEXT_LENGTH = 16 * 1024;
const MAX_TOKEN_LENGTH = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const TOKEN = /^[A-Za-z0-9_-]+$/u;

interface JsonRecord {
  readonly [key: string]: JsonValue;
}

type JsonValue = string | number | boolean | null | JsonRecord | readonly JsonValue[];

export interface SubscriptionToolMcpServerConfig {
  readonly bridgeUrl: URL;
  readonly token: string;
}

type SubscriptionMcpTool = Pick<Tool, "name" | "description" | "inputSchema">;

type BridgeCallResult = CallToolResult;

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isSafeString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return isBoundedText(value, maxLength, allowEmpty)
    && !CONTROL_CHARACTERS.test(value);
}


function isBoundedText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0);
}

function safeToolError(text: string): BridgeCallResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

const BRIDGE_UNAVAILABLE = safeToolError("LVIS host tool bridge is unavailable.");
const INVALID_TOOL_REQUEST = safeToolError("Invalid LVIS tool request.");

/**
 * Read only the ephemeral bridge connection values supplied by the main
 * process. The URL must be an exact loopback HTTP origin: allowing an arbitrary
 * hostname here would turn an ACP runtime launch descriptor into an SSRF path.
 */
export function readSubscriptionToolMcpServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SubscriptionToolMcpServerConfig {
  const rawUrl = environment[BRIDGE_URL_ENV];
  const token = environment[BRIDGE_TOKEN_ENV];
  if (!isSafeString(rawUrl, 1_024) || !isSafeString(token, MAX_TOKEN_LENGTH)) {
    throw new Error("invalid-subscription-tool-bridge-config");
  }
  if (token.length < 32 || !TOKEN.test(token)) {
    throw new Error("invalid-subscription-tool-bridge-config");
  }

  let bridgeUrl: URL;
  try {
    bridgeUrl = new URL(rawUrl);
  } catch {
    throw new Error("invalid-subscription-tool-bridge-config");
  }
  const port = bridgeUrl.port ? Number(bridgeUrl.port) : NaN;
  if (
    bridgeUrl.protocol !== "http:"
    || bridgeUrl.hostname !== BRIDGE_HOST
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || bridgeUrl.username
    || bridgeUrl.password
    || bridgeUrl.pathname !== "/"
    || bridgeUrl.search
    || bridgeUrl.hash
  ) {
    throw new Error("invalid-subscription-tool-bridge-config");
  }
  return Object.freeze({ bridgeUrl, token });
}

function hasOnlyKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function sanitizeJsonValue(
  value: unknown,
  depth = 0,
  state: { keys: number },
): JsonValue | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return isBoundedText(value, MAX_JSON_STRING_LENGTH, true) ? value : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= MAX_JSON_DEPTH) return null;
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) return null;
    const output: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return null;
      const item = sanitizeJsonValue(descriptor.value, depth + 1, state);
      if (item === null && descriptor.value !== null) return null;
      output.push(item);
    }
    return Object.freeze(output);
  }
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  state.keys += keys.length;
  if (state.keys > MAX_JSON_KEYS) return null;
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of keys) {
    if (!isSafeString(key, MAX_TOOL_NAME_LENGTH, true)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    const item = sanitizeJsonValue(descriptor.value, depth + 1, state);
    if (item === null && descriptor.value !== null) return null;
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      value: item,
      writable: false,
    });
  }
  return Object.freeze(output) as JsonRecord;
}

function serializedJsonBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}

function sanitizeTool(value: unknown): SubscriptionMcpTool | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["name", "description", "inputSchema"])) {
    return null;
  }
  const name = ownValue(value, "name");
  const description = ownValue(value, "description");
  const rawInputSchema = ownValue(value, "inputSchema");
  if (
    !isSafeString(name, MAX_TOOL_NAME_LENGTH)
    || !TOOL_NAME.test(name)
    || !isBoundedText(description, MAX_TOOL_DESCRIPTION_LENGTH, true)
    || !isPlainRecord(rawInputSchema)
  ) {
    return null;
  }
  const schemaType = ownValue(rawInputSchema, "type");
  const rawProperties = ownValue(rawInputSchema, "properties");
  const rawRequired = ownValue(rawInputSchema, "required");
  const rawAdditionalProperties = ownValue(rawInputSchema, "additionalProperties");
  const rawSchemaDialect = ownValue(rawInputSchema, "$schema");
  const allowedSchemaKeys = [
    "type",
    "properties",
    ...(rawRequired === undefined ? [] : ["required"]),
    ...(rawAdditionalProperties === undefined ? [] : ["additionalProperties"]),
    ...(rawSchemaDialect === undefined ? [] : ["$schema"]),
  ];
  if (
    !hasOnlyKeys(rawInputSchema, allowedSchemaKeys)
    || schemaType !== "object"
    || !isPlainRecord(rawProperties)
    || (rawAdditionalProperties !== undefined && typeof rawAdditionalProperties !== "boolean")
    || (rawRequired !== undefined && !Array.isArray(rawRequired))
    || (rawSchemaDialect !== undefined && !isSafeString(rawSchemaDialect, MAX_SCHEMA_DIALECT_LENGTH))
  ) {
    return null;
  }

  const state = { keys: 0 };
  const properties = sanitizeJsonValue(rawProperties, 0, state);
  if (!properties || Array.isArray(properties) || typeof properties !== "object") return null;
  const propertyRecord = properties as JsonRecord;
  const required: string[] = [];
  if (rawRequired !== undefined) {
    if (rawRequired.length > MAX_JSON_ARRAY_ITEMS) return null;
    for (let index = 0; index < rawRequired.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(rawRequired, String(index));
      if (!descriptor || !("value" in descriptor) || !isSafeString(descriptor.value, MAX_TOOL_NAME_LENGTH)) {
        return null;
      }
      if (!Object.hasOwn(propertyRecord, descriptor.value) || required.includes(descriptor.value)) return null;
      required.push(descriptor.value);
    }
  }

  const inputSchema = {
    type: "object" as const,
    properties: propertyRecord as Record<string, object>,
    ...(rawSchemaDialect === undefined ? {} : { $schema: rawSchemaDialect }),
    ...(rawAdditionalProperties === undefined ? {} : { additionalProperties: rawAdditionalProperties }),
    ...(rawRequired === undefined ? {} : { required }),
  };
  const size = serializedJsonBytes(inputSchema);
  if (size === null || size > MAX_SCHEMA_BYTES) return null;
  return { name, description, inputSchema };
}

function sanitizeToolList(value: unknown): SubscriptionMcpTool[] | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["tools"])) return null;
  const rawTools = ownValue(value, "tools");
  if (!Array.isArray(rawTools) || rawTools.length > MAX_TOOL_COUNT) return null;
  const tools: SubscriptionMcpTool[] = [];
  const names = new Set<string>();
  for (let index = 0; index < rawTools.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rawTools, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    const tool = sanitizeTool(descriptor.value);
    if (!tool || names.has(tool.name)) return null;
    names.add(tool.name);
    tools.push(tool);
  }
  return tools;
}

function sanitizeCallResult(value: unknown): BridgeCallResult | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["content", "isError"])) return null;
  const content = ownValue(value, "content");
  const isError = ownValue(value, "isError");
  if (!Array.isArray(content) || content.length !== 1 || typeof isError !== "boolean") return null;
  const first = content[0];
  if (!isPlainRecord(first) || !hasOnlyKeys(first, ["type", "text"])) return null;
  const type = ownValue(first, "type");
  const text = ownValue(first, "text");
  if (type !== "text" || !isBoundedText(text, MAX_RESULT_TEXT_LENGTH, true)) return null;
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function sanitizeToolArguments(value: unknown): Record<string, JsonValue> | null {
  if (!isPlainRecord(value)) return null;
  const sanitized = sanitizeJsonValue(value, 0, { keys: 0 });
  if (!sanitized || Array.isArray(sanitized) || typeof sanitized !== "object") return null;
  const size = serializedJsonBytes(sanitized);
  return size !== null && size <= MAX_TOOL_CALL_REQUEST_BYTES
    ? sanitized as Record<string, JsonValue>
    : null;
}

function bridgeUrl(config: SubscriptionToolMcpServerConfig, path: string): URL {
  return new URL(path, config.bridgeUrl);
}

function requestBridge(
  config: SubscriptionToolMcpServerConfig,
  method: "GET" | "POST",
  path: string,
  body?: string,
): Promise<unknown> {
  const url = bridgeUrl(config, path);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${config.token}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
  }
  const options: RequestOptions = {
    agent: false,
    headers,
    host: BRIDGE_HOST,
    method,
    path: `${url.pathname}${url.search}`,
    port: Number(url.port),
    protocol: "http:",
    timeout: TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs,
  };
  return new Promise<unknown>((resolveRequest, rejectRequest) => {
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      rejectRequest(new Error("subscription-tool-bridge-unavailable"));
    };
    const request = httpRequest(options, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        fail();
        return;
      }
      const contentLength = response.headers["content-length"];
      if (
        typeof contentLength === "string"
        && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BRIDGE_RESPONSE_BYTES)
      ) {
        response.resume();
        fail();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BRIDGE_RESPONSE_BYTES) {
          response.destroy();
          fail();
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", fail);
      response.once("end", () => {
        if (settled) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
        } catch {
          fail();
          return;
        }
        settled = true;
        resolveRequest(parsed);
      });
    });
    request.once("error", fail);
    request.once("timeout", () => {
      request.destroy();
      fail();
    });
    try {
      request.end(body);
    } catch {
      fail();
    }
  });
}

/**
 * HTTP-only client for the parent-owned loopback bridge. Its public methods
 * turn all network, response-shape, and bound failures into safe MCP results;
 * untrusted ACP runtime output never determines a host tool execution.
 */
export class SubscriptionToolBridgeClient {
  constructor(private readonly config: SubscriptionToolMcpServerConfig) {}

  async listTools(): Promise<SubscriptionMcpTool[]> {
    try {
      const tools = sanitizeToolList(await requestBridge(this.config, "GET", TOOLS_PATH));
      return tools ?? [];
    } catch {
      return [];
    }
  }

  async callTool(name: unknown, args: unknown): Promise<BridgeCallResult> {
    if (!isSafeString(name, MAX_TOOL_NAME_LENGTH) || !TOOL_NAME.test(name)) {
      return INVALID_TOOL_REQUEST;
    }
    const argumentsRecord = sanitizeToolArguments(args);
    if (!argumentsRecord) return INVALID_TOOL_REQUEST;
    let body: string;
    try {
      body = JSON.stringify({ name, arguments: argumentsRecord });
    } catch {
      return INVALID_TOOL_REQUEST;
    }
    if (Buffer.byteLength(body, "utf8") > MAX_TOOL_CALL_REQUEST_BYTES) return INVALID_TOOL_REQUEST;
    try {
      return sanitizeCallResult(await requestBridge(this.config, "POST", TOOL_CALL_PATH, body))
        ?? BRIDGE_UNAVAILABLE;
    } catch {
      return BRIDGE_UNAVAILABLE;
    }
  }
}

/** Create the minimal MCP server; callers must connect it to a stdio transport. */
export function createSubscriptionToolMcpServer(
  config: SubscriptionToolMcpServerConfig,
): Server {
  const bridge = new SubscriptionToolBridgeClient(config);
  const server = new Server(
    { name: "lvis-subscription-host-tools", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await bridge.listTools(),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    bridge.callTool(request.params.name, request.params.arguments ?? {}));
  return server;
}

/** Start the shim when this compiled module is launched as the MCP command. */
export async function runSubscriptionToolMcpServer(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const server = createSubscriptionToolMcpServer(readSubscriptionToolMcpServerConfig(environment));
  await server.connect(new StdioServerTransport());
}

export function isSubscriptionToolMcpServerEntrypoint(
  entry = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (!entry) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isSubscriptionToolMcpServerEntrypoint()) {
  // MCP reserves stdout for JSON-RPC. Do not log bridge failures or environment
  // details; a non-zero exit is enough for the ACP client to fail closed.
  void runSubscriptionToolMcpServer().catch(() => {
    process.exitCode = 1;
  });
}
