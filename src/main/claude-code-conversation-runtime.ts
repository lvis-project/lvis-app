/** Main-owned print transport. LVIS retains history and executes host tools. */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import type { StreamEvent, ToolSchema } from "../engine/llm/types.js";
import { JsonLineReader } from "../lib/json-line-reader.js";
import { CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID } from "../shared/claude-code-subscription.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  ClaudeCodeSubscriptionError,
  resolveClaudeCodeSubscriptionExecutable,
  sanitizedClaudeCodeEnvironment,
  validateClaudeCodeRuntimeDirectories,
} from "./claude-code-subscription-client.js";
import {
  CLAUDE_CODE_MAX_OUTPUT_BYTES,
  CLAUDE_CODE_MAX_PROMPT_BYTES,
  CLAUDE_CODE_MCP_SERVER_NAME,
  claudeCodePrintArgs,
  ClaudeCodeStream,
} from "./claude-code-stream.js";
import { forceKillManagedChildProcess, spawnManaged } from "./managed-child-processes.js";
import { writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import { SubscriptionAttachmentTransportError } from "./subscription-attachment-input.js";
import type { SubscriptionToolBridge } from "./subscription-tool-bridge.js";

const MAX_QUEUED_EVENTS = 256;
const HOST_TOOL_ACCEPTED = "LVIS accepted the host tool request and will provide its result in the next model round.";

export interface ClaudeCodeConversationRuntimeOptions {
  readonly executablePath: string;
  readonly runtimeHome: string;
  readonly workspaceDir: string;
  readonly runtimeTempDir: string;
  readonly bridge: SubscriptionToolBridge;
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly platform?: NodeJS.Platform;
  readonly resolveExecutable?: (candidate: string) => Promise<string>;
}

function operationFailed(): ClaudeCodeSubscriptionError {
  return new ClaudeCodeSubscriptionError("claude-code-operation-failed");
}

function abortError(): Error {
  const error = new Error("subscription-runtime-aborted");
  error.name = "AbortError";
  return error;
}

export class ClaudeCodeConversationRuntime {
  readonly provider = CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID;
  private readonly spawn: NonNullable<ClaudeCodeConversationRuntimeOptions["spawn"]>;
  private activeCancel: (() => void) | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly options: ClaudeCodeConversationRuntimeOptions) {
    this.spawn = options.spawn ?? ((command, args, spawnOptions) =>
      spawnManaged(command, args, spawnOptions, { label: "claude-code-conversation" }));
  }

  async *streamTurn(text: string, signal?: AbortSignal, attachments?: readonly unknown[]): AsyncIterable<StreamEvent> {
    if (attachments?.length) throw new SubscriptionAttachmentTransportError("subscription-attachment-not-supported");
    if (this.stopped || this.running || typeof text !== "string" || !text.trim()
      || Buffer.byteLength(text, "utf8") > CLAUDE_CODE_MAX_PROMPT_BYTES) throw operationFailed();
    if (signal?.aborted) throw abortError();
    this.running = true;
    const { bridge, runtimeHome, workspaceDir, runtimeTempDir } = this.options;
    let configPath: string | null = null;
    let child: ChildProcess | null = null;
    let timer: NodeJS.Timeout | undefined;
    let boundaryTask: NodeJS.Immediate | undefined;
    let ended = false;
    let toolBoundary = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const queue: StreamEvent[] = [];
    const notify = () => { const next = wake; wake = null; next?.(); };
    const kill = () => {
      const active = child;
      child = null;
      if (active) forceKillManagedChildProcess(active, "claude-code-turn-cancel");
    };
    const fail = (error: Error) => {
      if (failure || ended) return;
      failure = error;
      queue.length = 0;
      notify();
      kill();
    };
    const push = (event: StreamEvent) => {
      if (ended || failure) return;
      if (queue.length >= MAX_QUEUED_EVENTS) { fail(operationFailed()); return; }
      queue.push(event);
      notify();
    };
    const onAbort = () => {
      if (failure) return;
      failure = abortError();
      queue.length = 0;
      notify();
      kill();
    };
    this.activeCancel = onAbort;
    signal?.addEventListener("abort", onAbort, { once: true });
    const assertActive = () => {
      if (failure) throw failure;
      if (this.stopped || signal?.aborted) throw abortError();
    };

    try {
      await validateClaudeCodeRuntimeDirectories([runtimeHome, workspaceDir, runtimeTempDir]);
      const executable = await (this.options.resolveExecutable
        ?? ((path) => resolveClaudeCodeSubscriptionExecutable(path, this.options.platform)))(this.options.executablePath);
      if (executable !== this.options.executablePath) {
        throw new ClaudeCodeSubscriptionError("claude-code-runtime-invalid-executable");
      }
      assertActive();
      const mcpServers = bridge.tools.length ? {
        [CLAUDE_CODE_MCP_SERVER_NAME]: await bridge.startMcpServer().then((mcp) => ({
          command: mcp.command, args: [...mcp.args], env: { ...mcp.env },
        })),
      } : {};
      assertActive();
      configPath = join(runtimeTempDir, `mcp-${randomUUID()}.json`);
      await writeFileAtomicAtPath(configPath, `${JSON.stringify({ mcpServers })}\n`);
      assertActive();
      const toolNames = claudeCodeMcpToolNames(bridge.tools);
      const stream = new ClaudeCodeStream(toolNames);
      bridge.setHandler((call) => {
        if (!stream.initialized || toolBoundary || failure || ended || this.stopped || signal?.aborted) throw operationFailed();
        stream.acceptHostCall();
        toolBoundary = true;
        boundaryTask = setImmediate(() => {
          if (failure || ended || this.stopped || signal?.aborted) return;
          push({ type: "tool_call", id: call.id, name: call.name, input: call.input });
          push({ type: "message_complete", stopReason: "tool_use" });
          if (failure) return;
          ended = true;
          notify();
          kill();
        });
        return HOST_TOOL_ACCEPTED;
      });
      const spawned = this.spawn(executable, claudeCodePrintArgs(configPath, toolNames), {
        cwd: workspaceDir,
        env: sanitizedClaudeCodeEnvironment(runtimeHome, process.env, this.options.platform, runtimeTempDir),
        stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
        detached: (this.options.platform ?? process.platform) !== "win32",
      });
      child = spawned;
      timer = setTimeout(() => fail(operationFailed()), TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs);
      timer.unref();
      let outputBytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const reader = new JsonLineReader({
        maxLineBytes: CLAUDE_CODE_MAX_OUTPUT_BYTES,
        onMessage: (message) => {
          if (failure || ended) return;
          try {
            for (const value of stream.accept(message)) {
              if (!toolBoundary && value) push({ type: "text_delta", text: value });
            }
          } catch { fail(operationFailed()); }
        },
        onError: () => fail(operationFailed()),
      });
      const consume = (chunk: Buffer | string) => {
        if (failure || ended) return;
        try {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > CLAUDE_CODE_MAX_OUTPUT_BYTES) throw operationFailed();
          decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { stream: true });
          reader.write(chunk);
        } catch { fail(operationFailed()); }
      };
      spawned.on("error", () => fail(new ClaudeCodeSubscriptionError("claude-code-runtime-unavailable")));
      spawned.stdout?.on("error", () => fail(operationFailed()));
      spawned.stderr?.on("error", () => fail(operationFailed()));
      spawned.stdin?.on("error", () => fail(operationFailed()));
      spawned.stdout?.on("data", consume);
      spawned.stderr?.on("data", (chunk: Buffer | string) => {
        if (failure || ended) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > CLAUDE_CODE_MAX_OUTPUT_BYTES) fail(operationFailed());
      });
      spawned.once("close", (code, exitSignal) => {
        // Keep the exact handle through finally: a settled root can still
        // own a live MCP descendant group in the managed-child registry.
        if (failure || ended) return;
        try {
          decoder.decode();
          // EOF supplies a delimiter to validate a final un-terminated frame.
          reader.write("\n");
          reader.close();
          if (failure) return;
          if (code !== 0 || exitSignal) throw operationFailed();
          if (toolBoundary) return;
          stream.assertComplete();
          push({ type: "message_complete", stopReason: stream.stopReason });
          ended = true;
          notify();
        } catch { fail(operationFailed()); }
      });
      if (!spawned.stdin || !spawned.stdout || !spawned.stderr) fail(operationFailed());
      assertActive();
      spawned.stdin!.end(text, (error?: Error | null) => { if (error) fail(operationFailed()); });
      while (true) {
        if (failure) throw failure;
        const next = queue.shift();
        if (next) { yield next; continue; }
        if (ended) break;
        await new Promise<void>((resolveNext) => { wake = resolveNext; });
      }
    } catch (error) {
      if (error instanceof ClaudeCodeSubscriptionError || (error instanceof Error && error.name === "AbortError")) throw error;
      throw operationFailed();
    } finally {
      ended = true;
      this.activeCancel = null;
      bridge.setHandler(null);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      if (boundaryTask) clearImmediate(boundaryTask);
      try { kill(); } finally {
        try { if (configPath) await fs.rm(configPath, { force: true }); }
        finally { this.running = false; }
      }
    }
  }

  async cancelActiveTurn(): Promise<void> { this.activeCancel?.(); }

  async stop(): Promise<void> {
    this.stopped = true;
    this.activeCancel?.();
    await this.options.bridge.stop();
  }
}

export function claudeCodeMcpToolNames(tools: readonly ToolSchema[]): string[] {
  return tools.map((tool) => `mcp__${CLAUDE_CODE_MCP_SERVER_NAME}__${tool.name}`);
}
