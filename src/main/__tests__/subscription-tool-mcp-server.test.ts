import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  SubscriptionToolBridgeClient,
  readSubscriptionToolMcpServerConfig,
} from "../subscription-tool-mcp-server.js";
import { SUBSCRIPTION_TOOL_BRIDGE_CONTRACT } from "../../shared/subscription-runtime.js";

interface BridgeRequest {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly body: string;
}

interface BridgeHarness {
  readonly bridgeUrl: string;
  readonly requests: BridgeRequest[];
  close(): Promise<void>;
}

const harnesses: BridgeHarness[] = [];

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function createBridgeHarness(
  handler: (request: BridgeRequest, response: ServerResponse) => void | Promise<void>,
): Promise<BridgeHarness> {
  const requests: BridgeRequest[] = [];
  const server = createServer(async (request, response) => {
    const received: BridgeRequest = {
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: await readBody(request),
    };
    requests.push(received);
    await handler(received, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test bridge did not bind TCP");
  const harness: BridgeHarness = {
    bridgeUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
  harnesses.push(harness);
  return harness;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function clientFor(bridgeUrl: string): SubscriptionToolBridgeClient {
  return new SubscriptionToolBridgeClient(readSubscriptionToolMcpServerConfig({
    LVIS_SUBSCRIPTION_TOOL_BRIDGE_URL: bridgeUrl,
    LVIS_SUBSCRIPTION_TOOL_BRIDGE_TOKEN: "mcp_loopback_token_with_at_least_32_chars",
  }));
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

describe("subscription tool MCP shim", () => {
  it("accepts only an ephemeral loopback bridge URL and a bounded bearer token", () => {
    expect(() => readSubscriptionToolMcpServerConfig({
      LVIS_SUBSCRIPTION_TOOL_BRIDGE_URL: "https://127.0.0.1:43123",
      LVIS_SUBSCRIPTION_TOOL_BRIDGE_TOKEN: "mcp_loopback_token_with_at_least_32_chars",
    })).toThrow("invalid-subscription-tool-bridge-config");
    expect(() => readSubscriptionToolMcpServerConfig({
      LVIS_SUBSCRIPTION_TOOL_BRIDGE_URL: "http://localhost:43123",
      LVIS_SUBSCRIPTION_TOOL_BRIDGE_TOKEN: "mcp_loopback_token_with_at_least_32_chars",
    })).toThrow("invalid-subscription-tool-bridge-config");
    expect(() => readSubscriptionToolMcpServerConfig({
      LVIS_SUBSCRIPTION_TOOL_BRIDGE_URL: "http://127.0.0.1:43123/other",
      LVIS_SUBSCRIPTION_TOOL_BRIDGE_TOKEN: "short",
    })).toThrow("invalid-subscription-tool-bridge-config");
  });

  it("proxies dynamic tool discovery only through the versioned bearer-protected endpoint", async () => {
    const harness = await createBridgeHarness((request, response) => {
      expect(request).toMatchObject({
        method: "GET",
        path: "/v1/tools",
        authorization: "Bearer mcp_loopback_token_with_at_least_32_chars",
        body: "",
      });
      writeJson(response, 200, {
        tools: [{
          name: "workspace_search",
          description: "Search the active workspace.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        }],
      });
    });

    await expect(clientFor(harness.bridgeUrl).listTools()).resolves.toEqual([{
      name: "workspace_search",
      description: "Search the active workspace.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }]);
    expect(harness.requests).toHaveLength(1);
  });

  it("refuses a tool list beyond the shared bridge contract and accepts one at the limit", async () => {
    const tool = (index: number) => ({
      name: `tool_${index}`,
      description: "Bounded by the shared contract.",
      inputSchema: { type: "object", properties: {} },
    });
    const limit = SUBSCRIPTION_TOOL_BRIDGE_CONTRACT.maxToolCount;
    let count = limit + 1;
    const harness = await createBridgeHarness((_request, response) => {
      writeJson(response, 200, { tools: Array.from({ length: count }, (_, i) => tool(i)) });
    });

    await expect(clientFor(harness.bridgeUrl).listTools()).resolves.toEqual([]);
    count = limit;
    await expect(clientFor(harness.bridgeUrl).listTools()).resolves.toHaveLength(limit);
  });

  it("preserves the JSON Schema dialect when listing a bridged tool", async () => {
    const harness = await createBridgeHarness((_request, response) => {
      writeJson(response, 200, {
        tools: [{
          name: "workspace_search",
          description: "Search the active workspace.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        }],
      });
    });

    await expect(clientFor(harness.bridgeUrl).listTools()).resolves.toEqual([{
      name: "workspace_search",
      description: "Search the active workspace.",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }]);
  });

  it("forwards a bounded JSON tool call without executing it in the child", async () => {
    const harness = await createBridgeHarness((request, response) => {
      expect(request).toMatchObject({
        method: "POST",
        path: "/v1/tools/call",
        authorization: "Bearer mcp_loopback_token_with_at_least_32_chars",
      });
      expect(JSON.parse(request.body)).toEqual({
        name: "workspace_write",
        arguments: { content: "first line\nsecond line", path: "notes.txt" },
      });
      writeJson(response, 200, {
        content: [{ type: "text", text: "LVIS accepted this call." }],
        isError: true,
      });
    });

    await expect(clientFor(harness.bridgeUrl).callTool("workspace_write", {
      content: "first line\nsecond line",
      path: "notes.txt",
    })).resolves.toEqual({
      content: [{ type: "text", text: "LVIS accepted this call." }],
      isError: true,
    });
  });

  it("fails closed for malformed bridge results and does not forward invalid calls", async () => {
    const harness = await createBridgeHarness((request, response) => {
      writeJson(response, 200, request.path === "/v1/tools"
        ? { tools: [{ name: "bad.tool", description: "invalid", inputSchema: { type: "object", properties: {} } }] }
        : { content: [{ type: "image", text: "not allowed" }], isError: false });
    });
    const client = clientFor(harness.bridgeUrl);

    await expect(client.listTools()).resolves.toEqual([]);
    await expect(client.callTool("workspace_search", { query: "ok" })).resolves.toEqual({
      content: [{ type: "text", text: "LVIS host tool bridge is unavailable." }],
      isError: true,
    });
    await expect(client.callTool("bad.tool", { query: "must not reach host" })).resolves.toEqual({
      content: [{ type: "text", text: "Invalid LVIS tool request." }],
      isError: true,
    });
    expect(harness.requests).toHaveLength(2);
  });
});
