import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, ToolSchema } from "../../engine/llm/types.js";
import { ClaudeCodeConversationRuntime } from "../claude-code-conversation-runtime.js";
import { ClaudeCodeSubscriptionClient, type ClaudeCodeSubscriptionConfigStore } from "../claude-code-subscription-client.js";
import { CLAUDE_CODE_MAX_OUTPUT_BYTES } from "../claude-code-stream.js";
import type { CodexAppServerClient } from "../codex-app-server-client.js";
import * as managed from "../managed-child-processes.js";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { SubscriptionRuntimeService, type AcpSubscriptionRuntimeRegistry } from "../subscription-runtime-service.js";
import { SubscriptionToolBridge } from "../subscription-tool-bridge.js";
import { claudeCodeSubscriptionStatus } from "../../shared/claude-code-subscription.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

const SESSION = "550e8400-e29b-41d4-a716-446655440000";
const HOST_TOOL = "mcp__lvis-host-tools__read_project_file";
const TOOL: ToolSchema = {
  name: "read_project_file", description: "Read a file through the host",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};
const init = (tools: string[] = []) => ({ type: "system", subtype: "init", session_id: SESSION,
  tools, mcp_servers: tools.length ? [{ name: "lvis-host-tools", status: "connected" }] : [], plugins: [] });
const assistant = (content: unknown[] = [{ type: "text", text: "hello" }]) => ({
  type: "assistant", session_id: SESSION, parent_tool_use_id: null, message: { content },
});
const result = (extra = {}) => ({ type: "result", subtype: "success", is_error: false,
  result: "hello", session_id: SESSION, ...extra });
const auth = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" };

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = -1;
  exitCode: number | null = null;
  readonly kill = vi.fn(() => true);
  input = "";
  constructor() { super(); this.stdin.on("data", (chunk) => { this.input += String(chunk); }); }
  send(event: unknown): void { this.stdout.write(`${JSON.stringify(event)}\n`); }
  close(code = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
  dispose(): void { for (const stream of [this.stdin, this.stdout, this.stderr]) stream.destroy(); }
}

const roots: string[] = [];
const children: FakeChild[] = [];
const owners: Array<{ stop(): Promise<void> }> = [];
beforeEach(() => {
  // Block the complete tree-kill boundary, not just ChildProcess.kill: fake
  // children must never trigger native PID discovery or process signalling.
  vi.spyOn(managed, "forceKillManagedChildProcess").mockImplementation((child) => { child.kill(); });
  vi.spyOn(managed, "spawnManaged").mockImplementation(() => { throw new Error("Unexpected real process launch"); });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
  for (const child of children.splice(0)) child.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function paths() {
  const root = mkdtempSync(join(tmpdir(), "lvis-claude-runtime-"));
  roots.push(root);
  const value = { runtimeHome: join(root, "home"), workspaceDir: join(root, "workspace"), runtimeTempDir: join(root, "tmp") };
  for (const path of Object.values(value)) mkdirSync(path, { mode: 0o700 });
  return value;
}

function spawnHarness(script?: (child: FakeChild, args: readonly string[]) => void) {
  let ready!: (child: FakeChild) => void;
  const started = new Promise<FakeChild>((resolve) => { ready = resolve; });
  const calls: Array<{ child: FakeChild; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = vi.fn((_command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild(); children.push(child); calls.push({ child, args, options }); ready(child);
    if (script) setImmediate(() => script(child, args));
    return child as unknown as ChildProcess;
  });
  return { spawn, calls, started };
}

function conversation(tools: readonly ToolSchema[] = [], resolveExecutable?: (path: string) => Promise<string>) {
  const directories = paths();
  const harness = spawnHarness();
  const bridge = new SubscriptionToolBridge(tools);
  vi.spyOn(bridge, "startMcpServer").mockResolvedValue({
    name: "lvis-host-tools", command: "/host/mcp", args: [], env: { TEST_BRIDGE_TOKEN: "ephemeral-only" },
  });
  const runtime = new ClaudeCodeConversationRuntime({ ...directories, bridge, ...harness,
    executablePath: "/approved/claude", resolveExecutable: resolveExecutable ?? (async (path) => path) });
  owners.push(runtime);
  return { ...harness, ...directories, runtime, bridge };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("CLI conversation boundary", () => {
  it("keeps prompts off argv, disables built-ins, verifies result, and cleans its config", async () => {
    const h = conversation();
    const done = collect(h.runtime.streamTurn("private prompt"));
    const child = await h.started;
    expect(child.input).toBe("private prompt");
    const { args, options } = h.calls[0]!;
    expect(args).not.toContain("private prompt");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("bypassPermissions");
    expect(options).toMatchObject({ cwd: h.workspaceDir, stdio: ["pipe", "pipe", "pipe"], shell: false });
    child.send(init()); child.send(assistant()); child.send(result()); child.close();
    expect(await done).toEqual([{ type: "text_delta", text: "hello" }, { type: "message_complete", stopReason: "end_turn" }]);
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("reads stdout arriving after exit and a valid final frame without newline", async () => {
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello")); const child = await h.started;
    child.send(init()); child.emit("exit", 0, null); child.send(assistant());
    child.stdout.write(JSON.stringify(result())); child.emit("close", 0, null);
    expect((await done).at(-1)).toEqual({ type: "message_complete", stopReason: "end_turn" });
  });

  it.each([
    ["empty output", []],
    ["missing result", [init(), assistant()]],
    ["errored assistant", [init(), { ...assistant(), error: "authentication_failed" }]],
    ["failed result", [init(), result({ subtype: "error_during_execution", is_error: true })]],
    ["missing is_error", [init(), result({ is_error: undefined })]],
    ["native tool", [init(), assistant([{ type: "tool_use", id: "call", name: "Bash", input: {} }])]],
    ["native catalog", [init(["Bash"])]],
    ["missing init", [result()]],
    ["session changed", [init(), result({ session_id: "another-session" })]],
    ["denied permission", [init(), result({ permission_denials: [{ tool_name: "Bash" }] })]],
    ["startup hook", [{ type: "system", subtype: "hook_started", session_id: SESSION }]],
    ["plugin", [{ ...init(), plugins: [{ name: "unexpected" }] }]],
    ["extra result", [init(), result(), result()]],
  ])("rejects %s instead of synthesizing success", async (_name, records) => {
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello"));
    const expected = expect(done).rejects.toMatchObject({ code: "claude-code-operation-failed" });
    const child = await h.started; for (const record of records) child.send(record); child.close();
    await expected; expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it.each(["not json\n", "{\"type\":", "garbage"]) ("rejects malformed tail %s after a valid result", async (tail) => {
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello"));
    const expected = expect(done).rejects.toMatchObject({ code: "claude-code-operation-failed" });
    const child = await h.started; child.send(init()); child.send(result()); child.stdout.write(tail); child.close();
    await expected;
  });

  it("preserves split Unicode and refuses a truncated UTF-8 character", async () => {
    for (const invalid of [false, true]) {
      const h = conversation(); const done = collect(h.runtime.streamTurn("hello"));
      const expected = invalid ? expect(done).rejects.toMatchObject({ code: "claude-code-operation-failed" }) : null;
      const child = await h.started; child.send(init());
      const message = Buffer.from(`${JSON.stringify(assistant([{ type: "text", text: "한글" }]))}\n`);
      for (const byte of message) child.stdout.write(Buffer.from([byte]));
      child.send(result()); if (invalid) child.stdout.write(Buffer.from([0xed])); child.close();
      if (expected) await expected;
      else expect((await done)[0]).toEqual({ type: "text_delta", text: "한글" });
    }
  });

  it("only a validated bridge call produces a host tool event", async () => {
    const h = conversation([TOOL]); const done = collect(h.runtime.streamTurn("read file")); const child = await h.started;
    const { args } = h.calls[0]!;
    expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", HOST_TOOL]);
    const config = args[args.indexOf("--mcp-config") + 1]!;
    expect(readFileSync(config, "utf8")).toContain("ephemeral-only");
    if (process.platform !== "win32") expect(statSync(config).mode & 0o777).toBe(0o600);
    child.send(init([HOST_TOOL, "EndConversation"]));
    child.send(assistant([{ type: "tool_use", id: "announced", name: HOST_TOOL, input: { path: "a" } }]));
    expect(child.kill).not.toHaveBeenCalled();
    await h.bridge.invoke("read_project_file", { path: "a" });
    const events = await done;
    expect(events).toEqual([{ type: "tool_call", id: expect.any(String), name: "read_project_file", input: { path: "a" } },
      { type: "message_complete", stopReason: "tool_use" }]);
    expect(child.kill).toHaveBeenCalledTimes(1); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
    await expect(h.bridge.invoke("read_project_file", { path: "b" })).rejects.toThrow();
  });

  it("does not treat an announced but uncalled MCP tool as completion", async () => {
    const h = conversation([TOOL]); const done = collect(h.runtime.streamTurn("read file"));
    const expected = expect(done).rejects.toThrow(); const child = await h.started;
    child.send(init([HOST_TOOL])); child.send(assistant([{ type: "tool_use", id: "call", name: HOST_TOOL, input: {} }]));
    child.send(result()); child.close(); await expected;
  });

  it("allows the CLI termination control without turning it into a host call", async () => {
    const h = conversation([TOOL]); const done = collect(h.runtime.streamTurn("hello")); const child = await h.started;
    child.send(init([HOST_TOOL, "EndConversation"]));
    child.send(assistant([{ type: "tool_use", id: "end", name: "EndConversation", input: {} }]));
    child.send(result({ result: "" })); child.close(); expect(await done).toEqual([{ type: "message_complete", stopReason: "end_turn" }]);
  });

  it("rejects a second stream, cancels the first, and drops late output", async () => {
    const h = conversation(); const controller = new AbortController();
    const done = collect(h.runtime.streamTurn("hello", controller.signal)); const expected = expect(done).rejects.toMatchObject({ name: "AbortError" });
    const child = await h.started;
    await expect(collect(h.runtime.streamTurn("concurrent"))).rejects.toThrow();
    controller.abort(); child.send(init()); child.send(result()); await expected;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not spawn after cancellation during asynchronous executable validation", async () => {
    let release!: (path: string) => void;
    const ready = new Promise<string>((resolve) => { release = resolve; });
    const h = conversation([], () => ready); const controller = new AbortController();
    const done = collect(h.runtime.streamTurn("hello", controller.signal)); const expected = expect(done).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); release("/approved/claude"); await expected;
    expect(h.spawn).not.toHaveBeenCalled(); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it.each(["stdin", "stdout", "stderr", "process"])("owns %s errors and cleanup", async (surface) => {
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello")); const expected = expect(done).rejects.toThrow();
    const child = await h.started;
    const target: EventEmitter = surface === "process" ? child : child[surface as "stdin" | "stdout" | "stderr"];
    target.emit("error", new Error("private failure"));
    await expected; expect(child.kill).toHaveBeenCalledTimes(1); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("bounds actual combined output bytes and queued events", async () => {
    for (const flood of ["bytes", "events"]) {
      const h = conversation(); const done = collect(h.runtime.streamTurn("hello")); const expected = expect(done).rejects.toThrow();
      const child = await h.started; child.send(init());
      if (flood === "bytes") child.stderr.write(Buffer.alloc(CLAUDE_CODE_MAX_OUTPUT_BYTES + 1));
      else for (let index = 0; index < 300; index++) child.send(assistant());
      await expected; expect(child.kill).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects unsupported attachments before creating a process", async () => {
    const h = conversation(); await expect(collect(h.runtime.streamTurn("hello", undefined, [{}])))
      .rejects.toMatchObject({ code: "subscription-attachment-not-supported" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("cancels timed-out children through the owned process boundary", async () => {
    vi.useFakeTimers();
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello")); const expected = expect(done).rejects.toThrow();
    const child = await h.started; vi.advanceTimersByTime(TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs);
    await expected; expect(child.kill).toHaveBeenCalledTimes(1); expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("does not replay a native session when supplied the next full history envelope", async () => {
    const h = conversation();
    for (const text of ["complete history: first request", "complete history: first request, first answer, second request"]) {
      const completed = collect(h.runtime.streamTurn(text));
      await vi.waitFor(() => expect(h.calls.at(-1)?.child.input).toBe(text));
      const call = h.calls.at(-1)!; call.child.send(init()); call.child.send(result()); call.child.close(); await completed;
      expect(call.args).not.toContain("--resume"); expect(call.args).toContain("--no-session-persistence");
      expect(call.child.input).toBe(text);
    }
  });

  it("aborts buffered output even after the process completed", async () => {
    const h = conversation(); const controller = new AbortController();
    const iterator = h.runtime.streamTurn("hello", controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next(); const child = await h.started;
    child.send(init()); child.send(assistant()); child.send(result()); child.close(); await first;
    controller.abort(); await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cleans a config and handler when spawn throws", async () => {
    const h = conversation(); h.spawn.mockImplementationOnce(() => { throw new Error("private spawn path"); });
    await expect(collect(h.runtime.streamTurn("hello"))).rejects.toMatchObject({ code: "claude-code-operation-failed" });
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("preserves terminal-only text and the provider's length stop", async () => {
    const h = conversation(); const done = collect(h.runtime.streamTurn("hello")); const child = await h.started;
    child.send(init()); child.send(result({ result: "actual final text", stop_reason: "max_tokens" })); child.close();
    expect(await done).toEqual([{ type: "text_delta", text: "actual final text" }, { type: "message_complete", stopReason: "max_tokens" }]);
  });

  it("refuses an executable whose canonical target changed", async () => {
    const h = conversation([], async () => "/replacement/claude");
    await expect(collect(h.runtime.streamTurn("hello"))).rejects.toMatchObject({ code: "claude-code-runtime-invalid-executable" });
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

function clientHarness(script: (child: FakeChild, args: readonly string[]) => void, configStore?: ClaudeCodeSubscriptionConfigStore) {
  const directories = paths(); const harness = spawnHarness(script);
  const client = new ClaudeCodeSubscriptionClient({ ...directories, ...harness, executablePath: "/approved/claude",
    resolveExecutable: async (path) => path, configStore });
  owners.push(client); return { ...directories, ...harness, client };
}

describe("CLI account and verification boundary", () => {
  it("classifies the documented logged-out exit 1 as signed out", async () => {
    const h = clientHarness((child) => { child.send({ loggedIn: false }); child.close(1); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified", connection: "signed-out" });
  });

  it.each([
    ["API key", { ...auth, authMethod: "api_key" }, 0],
    ["unknown auth", { loggedIn: true }, 0],
    ["missing subscription", { ...auth, subscriptionType: null }, 0],
    ["inconsistent exit", auth, 1],
    ["malformed JSON", "not-json", 0],
  ])("does not claim connected for %s", async (_name, payload, code) => {
    const h = clientHarness((child) => { child.send(payload); child.close(code); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unavailable", connection: "unknown" });
  });

  it("does not parse credential-bearing stderr as an auth response", async () => {
    const h = clientHarness((child) => { child.stderr.write(JSON.stringify(auth)); child.close(); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unavailable", connection: "unknown" });
  });

  it("verifies the same isolated stream contract as chat", async () => {
    const h = clientHarness((child, args) => {
      if (args[0] === "--version") child.stdout.write("2.1.0 (Claude Code)\n");
      else if (args[0] === "auth") child.send(auth);
      else { child.send(init()); child.send(result({ result: "LVIS_OK" })); }
      child.close();
    });
    expect(await h.client.verify()).toMatchObject({ runtime: "ready", connection: "connected", version: "2.1.0" });
    expect(h.calls[2]!.child.input).toBe("Reply with exactly: LVIS_OK");
    expect(h.calls[2]!.args).not.toContain("Reply with exactly: LVIS_OK");
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("does not retain verification after an invalid print result", async () => {
    const h = clientHarness((child, args) => {
      if (args[0] === "--version") child.stdout.write("2.1.0\n");
      else if (args[0] === "auth") child.send(auth);
      else { child.send(init()); child.send(result({ is_error: true })); }
      child.close();
    });
    await expect(h.client.verify()).rejects.toThrow();
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unverified", connection: "connected" });
    expect(readdirSync(h.runtimeTempDir)).toEqual([]);
  });

  it("stop cancels captured commands and prevents future launches", async () => {
    const h = clientHarness(() => undefined); const pending = h.client.getStatus(); const child = await h.started;
    await h.client.stop(); expect(await pending).toMatchObject({ runtime: "unavailable" });
    await expect(h.client.verify()).rejects.toThrow(); expect(h.calls).toHaveLength(1); expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("keeps the approved executable if persistence fails", async () => {
    const store = { setExecutable: vi.fn(async () => { throw new Error("disk failure"); }) } as unknown as ClaudeCodeSubscriptionConfigStore;
    const h = clientHarness(() => undefined, store);
    await expect(h.client.setExecutable("/new/claude")).rejects.toThrow("disk failure");
    expect(h.client.getConfiguredExecutable()).toBe("/approved/claude");
  });

  it("serializes executable persistence against another configuration change", async () => {
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => { finish = resolve; });
    const store = { setExecutable: vi.fn(() => writing), clearExecutable: vi.fn() } as unknown as ClaudeCodeSubscriptionConfigStore;
    const h = clientHarness(() => undefined, store); const first = h.client.setExecutable("/new/claude");
    await expect(h.client.clearExecutable()).rejects.toThrow(); finish(); await first;
    expect(h.client.getConfiguredExecutable()).toBe("/new/claude"); expect(store.clearExecutable).not.toHaveBeenCalled();
  });

  it("rejects invalid captured UTF-8 rather than replacing protocol bytes", async () => {
    const h = clientHarness((child) => { child.stdout.write(Buffer.from([0xed])); child.close(); });
    expect(await h.client.getStatus()).toMatchObject({ runtime: "unavailable", connection: "unknown" });
  });

  it("opens a complete trusted login URL once and ignores cancelled output", async () => {
    const directories = paths(); const h = spawnHarness(); const openExternal = vi.fn();
    const client = new ClaudeCodeSubscriptionClient({ ...directories, ...h, executablePath: "/approved/claude",
      resolveExecutable: async (path) => path, openExternal }); owners.push(client);
    await client.startBrowserLogin(); const child = await h.started;
    expect(h.calls[0]!.args).toEqual(["auth", "login"]);
    child.stdout.write("See https://untrusted.invalid/help\nhttps://user:secret@claude.ai/oauth\n");
    child.stdout.write("https://claude.ai/oauth/"); await Promise.resolve(); expect(openExternal).not.toHaveBeenCalled();
    child.stdout.write("authorize?code=private\n"); await Promise.resolve();
    child.stderr.write("https://claude.ai/oauth/authorize?code=second\n"); await Promise.resolve();
    expect(openExternal).toHaveBeenCalledTimes(1);
    await client.stop(); child.stdout.write("https://claude.ai/oauth/authorize?code=late\n");
    await Promise.resolve(); expect(openExternal).toHaveBeenCalledTimes(1);
  });
});

describe("Claude service integration", () => {
  it("revokes a failed actual stream and re-verifies before the next session", async () => {
    const directories = paths(); const h = spawnHarness(); const audit = vi.fn();
    const namespace: FeatureNamespaceHandle = {
      dir: directories.runtimeHome,
      async childDir(name) { const path = join(directories.runtimeHome, name); mkdirSync(path, { recursive: true }); return path; },
      async readJson(_name, fallback) { return fallback; }, async writeJson() {},
    };
    const status = claudeCodeSubscriptionStatus("ready", "connected", "2.1.0");
    const verify = vi.fn(async () => status);
    const client = {
      getStatus: vi.fn(async () => status), verify, getConfiguredExecutable: () => "/approved/claude",
      getRuntimePaths: () => directories, stop: vi.fn(async () => undefined),
    } as unknown as ClaudeCodeSubscriptionClient;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace, audit, claudeCodeClient: client,
      codexClient: { stop: vi.fn() } as unknown as CodexAppServerClient,
      acpRegistry: { stopAll: vi.fn() } as unknown as AcpSubscriptionRuntimeRegistry,
      createClaudeCodeConversationRuntime: (options) => new ClaudeCodeConversationRuntime({ ...options, ...h,
        resolveExecutable: async (path) => path }),
    });
    owners.push(service);
    await service.verify("claude-code");
    const session = await service.openTextSession({ kind: "subscription", provider: "claude-code" });
    const pending = collect(session.streamTurn("hello"));
    const expected = expect(pending).rejects.toMatchObject({ code: "subscription-operation-failed" });
    const child = await h.started; child.send(init()); child.send(result({ is_error: true })); child.close(); await expected;
    expect(audit).toHaveBeenCalledExactlyOnceWith({ provider: "claude-code", outcome: "session-failed" });
    expect((await service.getStatus("claude-code")).capabilities.chat).toBe(false);
    await service.openTextSession({ kind: "subscription", provider: "claude-code" });
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
