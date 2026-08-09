import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpSubscriptionSessionClient,
  AcpSubscriptionSessionError,
  MAX_ACP_SUBSCRIPTION_IMAGE_BYTES,
  GROK_BUILD_GOVERNED_AGENT_PROFILE,
  type AcpSubscriptionSessionClientOptions,
  type AcpSubscriptionHostRequestObservation,
} from "../acp-subscription-session-client.js";
import type { AcpSubscriptionMcpServerConfig } from "../acp-subscription-runtime-config.js";
import { MAX_SUBSCRIPTION_ATTACHMENT_BYTES } from "../subscription-attachment-input.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

type RequestHandler = (request: RpcMessage, agent: FakeAcpAgent) => void;
type Spawn = NonNullable<AcpSubscriptionSessionClientOptions["spawn"]>;

class FakeAcpAgent extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: RpcMessage[] = [];
  pid = -1;
  exitCode: number | null = null;
  killed = false;
  private input = "";

  constructor(private readonly handler: RequestHandler) {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => this.consume(String(chunk)));
  }

  kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => {
    this.killed = true;
    return true;
  });

  dispose(): void {
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
  }

  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  respondError(id: number, error: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`);
  }

  sessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    })}\n`);
  }

  hostRequest(id: number, method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  private consume(chunk: string): void {
    this.input += chunk;
    for (;;) {
      const newline = this.input.indexOf("\n");
      if (newline < 0) return;
      const line = this.input.slice(0, newline).trim();
      this.input = this.input.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as RpcMessage;
      this.requests.push(request);
      this.handler(request, this);
    }
  }
}

interface Harness {
  client: AcpSubscriptionSessionClient;
  agent: FakeAcpAgent;
  runtimeRoot: string;
  spawnCalls: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }>;
}

const harnesses: Harness[] = [];
const TEST_RUNTIME_PARENT = process.platform === "win32" ? "C:\\tmp" : tmpdir();
const LVIS_BRIDGE_MCP: readonly AcpSubscriptionMcpServerConfig[] = [{
  name: "lvis-host-tools",
  command: process.execPath,
  args: ["--lvis-acp-mcp", "--stdio"],
  env: {
    ELECTRON_RUN_AS_NODE: "1",
    LVIS_SUBSCRIPTION_TOOL_BRIDGE_URL: "http://127.0.0.1:9",
    LVIS_SUBSCRIPTION_TOOL_BRIDGE_TOKEN: "test-only-bridge-token",
  },
}];

function standardHandler(provider: "kimi-code" | "grok-build"): RequestHandler {
  const authMethod = provider === "kimi-code" ? "login" : "cached_token";
  return (request, agent) => {
    if (typeof request.id !== "number" || typeof request.method !== "string") return;
    switch (request.method) {
      case "initialize":
        agent.respond(request.id, {
          protocolVersion: 1,
          authMethods: [{ id: authMethod }],
        });
        return;
      case "authenticate":
        agent.respond(request.id, {});
        return;
      case "session/new":
        agent.respond(request.id, { sessionId: "session-123" });
        return;
      case "session/prompt":
        return;
      default:
        throw new Error(`Unexpected ACP request: ${request.method}`);
    }
  };
}

function createHarness(
  provider: "kimi-code" | "grok-build" = "kimi-code",
  options: {
    handler?: RequestHandler;
    onHostRequest?: (request: AcpSubscriptionHostRequestObservation) => void | Promise<void>;
    requestTimeoutMs?: number;
    promptTimeoutMs?: number;
    abortGraceMs?: number;
    runtimeArgs?: readonly string[];
    mcpServers?: readonly AcpSubscriptionMcpServerConfig[];
  } = {},
): Harness {
  const runtimeRoot = mkdtempSync(join(TEST_RUNTIME_PARENT, "lvis-acp-session-client-"));
  const runtimeHome = join(runtimeRoot, "home");
  const workspaceDir = join(runtimeRoot, "workspace");
  const runtimeTempDir = join(runtimeRoot, "temporary");
  mkdirSync(runtimeHome);
  mkdirSync(workspaceDir);
  mkdirSync(runtimeTempDir);
  const agent = new FakeAcpAgent(options.handler ?? standardHandler(provider));
  const spawnCalls: Harness["spawnCalls"] = [];
  const spawn: Spawn = (command, args, spawnOptions) => {
    spawnCalls.push({ command, args, options: spawnOptions });
    return agent as unknown as ChildProcess;
  };
  let client: AcpSubscriptionSessionClient;
  try {
    client = new AcpSubscriptionSessionClient({
      provider,
      runtimeHome,
      workspaceDir,
      runtimeTempDir,
      executablePath: `C:\\approved\\${provider}.exe`,
      resolveExecutable: async () => `C:\\approved\\${provider}.exe`,
      spawn,
      platform: "win32",
      clientVersion: "test-version",
      ...(options.onHostRequest ? { onHostRequest: options.onHostRequest } : {}),
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.promptTimeoutMs ? { promptTimeoutMs: options.promptTimeoutMs } : {}),
      ...(options.abortGraceMs ? { abortGraceMs: options.abortGraceMs } : {}),
      ...(options.runtimeArgs ? { runtimeArgs: options.runtimeArgs } : {}),
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    });
  } catch (error) {
    agent.dispose();
    rmSync(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
  const harness = { client, agent, runtimeRoot, spawnCalls };
  harnesses.push(harness);
  return harness;
}

function requestFor(agent: FakeAcpAgent, method: string): RpcMessage {
  const request = agent.requests.find((candidate) => candidate.method === method);
  if (!request) throw new Error(`Missing ${method} request`);
  return request;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}

function pngData(byteLength: number): string {
  const bytes = Buffer.alloc(byteLength);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes.toString("base64");
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.client.stop();
    harness.agent.dispose();
    await cleanupTmpDir(harness.runtimeRoot);
  }
  vi.restoreAllMocks();
});

describe("AcpSubscriptionSessionClient", () => {
  it("uses JSONL stdin pipes for initialize/authenticate/session/new and streams text plus thought", async () => {
    const { client, agent, spawnCalls } = createHarness();

    await expect(client.start()).resolves.toEqual({ provider: "kimi-code", sessionId: "session-123" });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: "C:\\approved\\kimi-code.exe",
      args: ["acp"],
      options: {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    });
    expect(agent.requests.slice(0, 3)).toEqual([
      expect.objectContaining({ method: "initialize", params: expect.objectContaining({
        protocolVersion: 1,
        clientInfo: { name: "lvis", version: "test-version" },
      }) }),
      expect.objectContaining({ method: "authenticate", params: { method_id: "login" } }),
      expect.objectContaining({ method: "session/new", params: expect.objectContaining({ mcpServers: [] }) }),
    ]);

    const prompt = await client.startPrompt({ text: "hello" });
    const events = prompt.events[Symbol.asyncIterator]();
    agent.sessionUpdate("session-123", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "reasoning" },
    });
    agent.sessionUpdate("session-123", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "answer" },
    });

    expect(await events.next()).toEqual({ value: { type: "reasoning_delta", text: "reasoning" }, done: false });
    expect(await events.next()).toEqual({ value: { type: "text_delta", text: "answer" }, done: false });

    const promptRequest = requestFor(agent, "session/prompt");
    agent.respond(99_999, { stopReason: "end_turn" });
    agent.respond(promptRequest.id as number, { stopReason: "end_turn" });

    expect(await events.next()).toEqual({
      value: { type: "message_complete", stopReason: "end_turn" },
      done: false,
    });
    expect(await events.next()).toEqual({ value: undefined, done: true });
    await expect(prompt.completion).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("fails closed when exactly the bounded event capacity leaves no terminal-event slot", async () => {
    const { client, agent } = createHarness();
    await client.start();
    const prompt = await client.startPrompt({ text: "fill the bounded stream queue" });
    const events = prompt.events[Symbol.asyncIterator]();
    const promptRequest = requestFor(agent, "session/prompt");
    const notificationClient = client as unknown as {
      handleNotification(method: string, params: unknown): void;
    };

    // Drive the parsed-notification boundary synchronously so all 256 accepted
    // deltas occupy the queue before the corresponding JSON-RPC completion.
    for (let index = 0; index < 256; index += 1) {
      notificationClient.handleNotification("session/update", {
        sessionId: "session-123",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "queued-" + index },
        },
      });
    }
    agent.respond(promptRequest.id as number, { stopReason: "end_turn" });
    await nextTurn();

    await expect(events.next()).rejects.toMatchObject({ code: "acp-session-operation-failed" });
    await expect(prompt.completion).rejects.toMatchObject({ code: "acp-session-operation-failed" });
    expect(agent.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("sends original image blocks only after ACP image capability negotiation", async () => {
    const respondNormally = standardHandler("kimi-code");
    const { client, agent } = createHarness("kimi-code", {
      handler: (request, current) => {
        if (request.method === "initialize" && typeof request.id === "number") {
          current.respond(request.id, {
            protocolVersion: 1,
            authMethods: [{ id: "login" }],
            agentCapabilities: { promptCapabilities: { image: true } },
          });
          return;
        }
        respondNormally(request, current);
      },
    });

    await client.start();
    const prompt = await client.startPrompt({
      text: "Inspect the original image.",
      attachments: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    });
    const request = requestFor(agent, "session/prompt");
    expect(request.params).toEqual({
      sessionId: "session-123",
      prompt: [
        { type: "text", text: "Inspect the original image." },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    });
    agent.respond(request.id as number, { stopReason: "end_turn" });
    await expect(prompt.completion).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("fails closed without ACP image capability and never writes session/prompt", async () => {
    const { client, agent } = createHarness();
    await client.start();

    await expect(client.startPrompt({
      text: "Do not send this image.",
      attachments: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    })).rejects.toMatchObject({ code: "subscription-attachment-not-supported" });
    expect(agent.requests.filter((request) => request.method === "session/prompt")).toHaveLength(0);
  });

  it("accepts an image at the negotiated 256KiB ACP budget", async () => {
    const respondNormally = standardHandler("kimi-code");
    const { client, agent } = createHarness("kimi-code", {
      handler: (request, current) => {
        if (request.method === "initialize" && typeof request.id === "number") {
          current.respond(request.id, {
            protocolVersion: 1,
            authMethods: [{ id: "login" }],
            agentCapabilities: { promptCapabilities: { image: true } },
          });
          return;
        }
        respondNormally(request, current);
      },
    });
    await client.start();
    const data = pngData(MAX_ACP_SUBSCRIPTION_IMAGE_BYTES);

    const prompt = await client.startPrompt({
      text: "Fits the ACP native image budget.",
      attachments: [{ type: "image", mimeType: "image/png", data }],
    });
    const request = requestFor(agent, "session/prompt");
    expect(request.params).toMatchObject({
      sessionId: "session-123",
      prompt: [
        { type: "text", text: "Fits the ACP native image budget." },
        { type: "image", mimeType: "image/png", data },
      ],
    });
    agent.respond(request.id as number, { stopReason: "end_turn" });
    await expect(prompt.completion).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("rejects a generic 25MiB image before writing an ACP prompt", async () => {
    const respondNormally = standardHandler("kimi-code");
    const { client, agent } = createHarness("kimi-code", {
      handler: (request, current) => {
        if (request.method === "initialize" && typeof request.id === "number") {
          current.respond(request.id, {
            protocolVersion: 1,
            authMethods: [{ id: "login" }],
            agentCapabilities: { promptCapabilities: { image: true } },
          });
          return;
        }
        respondNormally(request, current);
      },
    });
    await client.start();
    const data = pngData(MAX_SUBSCRIPTION_ATTACHMENT_BYTES);

    await expect(client.startPrompt({
      text: "Do not write this oversized ACP image.",
      attachments: [{ type: "image", mimeType: "image/png", data }],
    })).rejects.toMatchObject({ code: "subscription-attachment-too-large" });
    expect(agent.requests.filter((request) => request.method === "session/prompt")).toHaveLength(0);
  });

  it("enforces the ACP aggregate image budget before writing", async () => {
    const respondNormally = standardHandler("kimi-code");
    const { client, agent } = createHarness("kimi-code", {
      handler: (request, current) => {
        if (request.method === "initialize" && typeof request.id === "number") {
          current.respond(request.id, {
            protocolVersion: 1,
            authMethods: [{ id: "login" }],
            agentCapabilities: { promptCapabilities: { image: true } },
          });
          return;
        }
        respondNormally(request, current);
      },
    });
    await client.start();
    const eachImage = pngData((MAX_ACP_SUBSCRIPTION_IMAGE_BYTES / 2) + 1);

    await expect(client.startPrompt({
      text: "The total, not either image, exceeds the ACP budget.",
      attachments: [
        { type: "image", mimeType: "image/png", data: eachImage },
        { type: "image", mimeType: "image/png", data: eachImage },
      ],
    })).rejects.toMatchObject({ code: "subscription-attachment-too-large" });
    expect(agent.requests.filter((request) => request.method === "session/prompt")).toHaveLength(0);
  });

  it("forwards exactly one host-created LVIS MCP launch descriptor to session/new", async () => {
    const mcpServers: readonly AcpSubscriptionMcpServerConfig[] = [{
      name: "lvis-subscription-tools",
      command: process.execPath,
      args: ["--lvis-acp-mcp", "--stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1", LVIS_ACP_SESSION: "host-created" },
    }];
    const { client, agent } = createHarness("kimi-code", { mcpServers });

    await client.start();

    expect(requestFor(agent, "session/new").params).toMatchObject({ mcpServers });
    expect((requestFor(agent, "session/new").params as { mcpServers: unknown }).mcpServers).toEqual(mcpServers);
  });

  it("rejects arbitrary or multiple MCP launch descriptors before starting an ACP process", () => {
    const trusted: AcpSubscriptionMcpServerConfig = {
      name: "lvis-subscription-tools",
      command: process.execPath,
      args: ["--lvis-acp-mcp", "--stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };

    expect(() => createHarness("kimi-code", {
      mcpServers: [{ ...trusted, cwd: "C:\\untrusted" } as unknown as AcpSubscriptionMcpServerConfig],
    })).toThrow("invalid-acp-subscription-mcp-server-config");
    expect(() => createHarness("kimi-code", {
      mcpServers: [trusted, trusted],
    })).toThrow("invalid-acp-subscription-mcp-server-config");
  });

  it("keeps the Grok governed profile frozen with a complete MCP-only allowlist", () => {
    expect(GROK_BUILD_GOVERNED_AGENT_PROFILE).toEqual({
      name: "lvis-governed-chat",
      description: "LVIS governed subscription chat; use only the supplied LVIS MCP bridge.",
      promptMode: "full",
      promptBody: "Use only the LVIS host MCP bridge. Do not use native tools, external MCP servers, subagents, skills, project instructions, or web tools.",
      tools: ["mcp__lvis-host-tools__workspace_read"],
      permissionMode: "dontAsk",
      agentsMd: false,
      discoverSkills: false,
      inheritSkills: false,
      injectDefaultTools: false,
      mcpInheritance: "none",
      skills: [],
    });
    expect(Object.isFrozen(GROK_BUILD_GOVERNED_AGENT_PROFILE)).toBe(true);
    expect(Object.isFrozen(GROK_BUILD_GOVERNED_AGENT_PROFILE.tools)).toBe(true);
    expect(Object.isFrozen(GROK_BUILD_GOVERNED_AGENT_PROFILE.skills)).toBe(true);
    expect(GROK_BUILD_GOVERNED_AGENT_PROFILE.tools).not.toHaveLength(0);
    expect(GROK_BUILD_GOVERNED_AGENT_PROFILE.tools.every((tool) => tool.startsWith("mcp__"))).toBe(true);
  });

  it("preserves the exact Kimi session/new payload without Grok metadata", async () => {
    const { client, agent, runtimeRoot } = createHarness("kimi-code", { mcpServers: LVIS_BRIDGE_MCP });

    await client.start();

    const sessionParams = requestFor(agent, "session/new").params;
    expect(sessionParams).toEqual({
      cwd: join(runtimeRoot, "workspace"),
      mcpServers: LVIS_BRIDGE_MCP,
    });
    expect(sessionParams).not.toHaveProperty("_meta");
  });

  it("injects the exact governed profile into Grok session/new only", async () => {
    const { client, agent, runtimeRoot } = createHarness("grok-build", { mcpServers: LVIS_BRIDGE_MCP });

    await client.start();

    expect(requestFor(agent, "session/new").params).toEqual({
      cwd: join(runtimeRoot, "workspace"),
      mcpServers: LVIS_BRIDGE_MCP,
      _meta: { agentProfile: GROK_BUILD_GOVERNED_AGENT_PROFILE },
    });
  });

  it("uses the shared Grok transport and authentication manifest", async () => {
    const { client, agent, spawnCalls } = createHarness("grok-build");

    await expect(client.start()).resolves.toEqual({ provider: "grok-build", sessionId: "session-123" });

    expect(spawnCalls[0]).toMatchObject({ args: ["--no-auto-update", "agent", "stdio"] });
    expect(requestFor(agent, "authenticate")).toMatchObject({
      params: { methodId: "cached_token", _meta: { headless: true } },
    });
  });

  it("sends session/cancel on AbortSignal and force-kills after the bounded grace period", async () => {
    const { client, agent } = createHarness("kimi-code", { abortGraceMs: 1 });
    await client.start();
    const abortController = new AbortController();
    const prompt = await client.startPrompt({ text: "cancel me", abortSignal: abortController.signal });
    const iterator = prompt.events[Symbol.asyncIterator]();
    const pendingEvent = iterator.next();

    abortController.abort();

    await expect(pendingEvent).rejects.toMatchObject({ name: "AbortError", code: "acp-session-aborted" });
    await expect(prompt.completion).rejects.toMatchObject({ name: "AbortError", code: "acp-session-aborted" });
    await nextTurn();
    expect(agent.requests).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "session-123" },
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    expect(agent.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects reverse host permission requests without exposing params and tears down the transport", async () => {
    const onHostRequest = vi.fn();
    const { client, agent } = createHarness("kimi-code", { onHostRequest });
    await client.start();
    const prompt = await client.startPrompt({ text: "no host tools" });
    const iterator = prompt.events[Symbol.asyncIterator]();
    const pendingEvent = iterator.next();

    agent.hostRequest(77, "session/request_permission", {
      command: "do-not-run",
      token: "runtime-secret",
    });

    await expect(pendingEvent).rejects.toMatchObject({ code: "acp-session-host-request-rejected" });
    await nextTurn();
    expect(onHostRequest).toHaveBeenCalledWith({
      provider: "kimi-code",
      sessionId: "session-123",
      requestId: 77,
      method: "session/request_permission",
      kind: "permission",
    });
    expect(JSON.stringify(onHostRequest.mock.calls)).not.toContain("runtime-secret");
    expect(agent.requests).toContainEqual({
      jsonrpc: "2.0",
      id: 77,
      error: { code: -32601, message: "Host capabilities are unavailable" },
    });
    expect(agent.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.each([
    ["without an LVIS bridge MCP", undefined],
    ["with the LVIS bridge MCP", LVIS_BRIDGE_MCP],
  ] as const)("treats raw ACP tool updates as redacted no-ops %s", async (_scenario, mcpServers) => {
    const rawInput = "raw-tool-input-secret";
    const rawOutput = "raw-tool-output-secret";
    const onHostRequest = vi.fn();
    const { client, agent } = createHarness("kimi-code", { mcpServers, onHostRequest });
    await client.start();
    const prompt = await client.startPrompt({ text: "continue normally" });
    const iterator = prompt.events[Symbol.asyncIterator]();

    agent.sessionUpdate("session-123", {
      sessionUpdate: "tool_call",
      toolCallId: "native-tool-1",
      input: { command: "do-not-execute", token: rawInput },
    });
    agent.sessionUpdate("session-123", {
      sessionUpdate: "tool_call_update",
      toolCallId: "native-tool-1",
      status: "completed",
      output: { stdout: rawOutput, token: rawOutput },
    });
    await nextTurn();

    expect(agent.kill).not.toHaveBeenCalled();
    expect(onHostRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(agent.requests)).not.toContain(rawInput);
    expect(JSON.stringify(agent.requests)).not.toContain(rawOutput);
    expect(agent.requests).not.toContainEqual(expect.objectContaining({ method: "session/cancel" }));

    agent.sessionUpdate("session-123", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "safe answer" },
    });
    const promptRequest = requestFor(agent, "session/prompt");
    agent.respond(promptRequest.id as number, { stopReason: "end_turn" });

    const streamed = [
      await iterator.next(),
      await iterator.next(),
      await iterator.next(),
    ];
    expect(streamed).toEqual([
      { value: { type: "text_delta", text: "safe answer" }, done: false },
      { value: { type: "message_complete", stopReason: "end_turn" }, done: false },
      { value: undefined, done: true },
    ]);
    const visible = JSON.stringify(streamed);
    expect(visible).not.toContain(rawInput);
    expect(visible).not.toContain(rawOutput);
    await expect(prompt.completion).resolves.toEqual({ stopReason: "end_turn" });
    expect(agent.kill).not.toHaveBeenCalled();
  });

  it("fails closed for an unrecognized native session update", async () => {
    const { client, agent } = createHarness();
    await client.start();
    const prompt = await client.startPrompt({ text: "stay text-only" });
    const iterator = prompt.events[Symbol.asyncIterator]();
    const pendingEvent = iterator.next();

    agent.sessionUpdate("session-123", {
      sessionUpdate: "permission_request",
      title: "outside LVIS",
    });

    await expect(pendingEvent).rejects.toMatchObject({ code: "acp-session-native-tool-rejected" });
    expect(agent.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("fails closed for a session update whose opaque session id does not match", async () => {
    const { client, agent } = createHarness();
    await client.start();
    const prompt = await client.startPrompt({ text: "stay in this session" });
    const iterator = prompt.events[Symbol.asyncIterator]();
    const pendingEvent = iterator.next();

    agent.sessionUpdate("different-session", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "must not leak" },
    });

    await expect(pendingEvent).rejects.toMatchObject({ code: "acp-session-invalid-response" });
    expect(agent.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("projects only a safe schema diagnostic from a session/prompt RPC error", async () => {
    const rawDetail = "Invalid schema for function 'read_project_file': endpoint=private.example token=secret";
    const { client, agent } = createHarness();
    await client.start();
    const prompt = await client.startPrompt({ text: "use a declared host tool" });
    const iterator = prompt.events[Symbol.asyncIterator]();
    const promptRequest = requestFor(agent, "session/prompt");

    agent.respondError(promptRequest.id as number, {
      code: -32_000,
      message: rawDetail,
      data: { statusCode: 400 },
    });

    const failure = await iterator.next().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "acp-session-operation-failed",
      providerError: {
        providerCode: "invalid_function_parameters",
        messagePreview: "Invalid schema for function 'read_project_file'.",
      },
    });
    expect(JSON.stringify(failure)).not.toContain(rawDetail);
    expect(JSON.stringify(failure)).not.toContain("private.example");
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("rejects arbitrary runtime argv instead of allowing provider CLI flag injection", () => {
    expect(() => createHarness("grok-build", { runtimeArgs: ["agent", "stdio", "--unsafe"] })).toThrow(
      expect.objectContaining({
        code: "acp-session-runtime-args-not-allowed",
      }) as AcpSubscriptionSessionError,
    );
  });

  it("times out a missing initialization response and force-kills the managed process", async () => {
    const { client, agent } = createHarness("kimi-code", {
      requestTimeoutMs: 5,
      handler: () => {},
    });

    await expect(client.start()).rejects.toMatchObject({ code: "acp-session-request-timeout" });
    expect(agent.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("does not send session/prompt when cancellation wins during ACP startup", async () => {
    let initializeRequest: RpcMessage | undefined;
    const respondNormally = standardHandler("kimi-code");
    const { client, agent } = createHarness("kimi-code", {
      handler: (request, current) => {
        if (request.method === "initialize") {
          initializeRequest = request;
          return;
        }
        respondNormally(request, current);
      },
    });
    const abortController = new AbortController();
    const pendingPrompt = client.startPrompt({
      text: "cancel before prompt",
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => expect(initializeRequest).toBeDefined());
    abortController.abort();
    if (typeof initializeRequest?.id !== "number") throw new Error("missing-initialize-request");
    agent.respond(initializeRequest.id, {
      protocolVersion: 1,
      authMethods: [{ id: "login" }],
    });

    await expect(pendingPrompt).rejects.toMatchObject({
      name: "AbortError",
      code: "acp-session-aborted",
    });
    expect(agent.requests.filter((request) => request.method === "session/prompt")).toHaveLength(0);
  });
});
