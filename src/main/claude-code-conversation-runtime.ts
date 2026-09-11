/**
 * Main-owned Claude Code print-mode transport.
 *
 * One session object owns a durable CLI session id and turns it into LVIS
 * StreamEvents. Native tools are denied; only the LVIS host MCP bridge may
 * appear. Credentials stay inside CLAUDE_CONFIG_DIR and are never read here.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { StreamEvent, ToolSchema } from "../engine/llm/types.js";
import { CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID } from "../shared/claude-code-subscription.js";
import {
  ClaudeCodeSubscriptionError,
  sanitizedClaudeCodeEnvironment,
} from "./claude-code-subscription-client.js";
import { forceKillManagedChildProcess, spawnManaged } from "./managed-child-processes.js";
import { writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import type { SubscriptionToolBridge } from "./subscription-tool-bridge.js";

const TURN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MCP_SERVER_NAME = "lvis-host-tools";
const HOST_TOOL_ACCEPTED = "LVIS accepted the host tool request and will provide its result in the next model round.";

type SpawnClaude = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export interface ClaudeCodeConversationRuntimeOptions {
  readonly executablePath: string;
  readonly runtimeHome: string;
  readonly workspaceDir: string;
  readonly runtimeTempDir: string;
  readonly bridge: SubscriptionToolBridge;
  readonly spawn?: SpawnClaude;
  readonly platform?: NodeJS.Platform;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("");
}

export class ClaudeCodeConversationRuntime {
  readonly provider = CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID;
  private readonly executablePath: string;
  private readonly runtimeHome: string;
  private readonly workspaceDir: string;
  private readonly runtimeTempDir: string;
  private readonly bridge: SubscriptionToolBridge;
  private readonly spawn: SpawnClaude;
  private readonly platform: NodeJS.Platform;
  private sessionId: string | null = null;
  private activeChild: ChildProcess | null = null;
  private stopped = false;

  constructor(options: ClaudeCodeConversationRuntimeOptions) {
    this.executablePath = options.executablePath;
    this.runtimeHome = options.runtimeHome;
    this.workspaceDir = options.workspaceDir;
    this.runtimeTempDir = options.runtimeTempDir;
    this.bridge = options.bridge;
    this.spawn = options.spawn
      ?? ((command, args, spawnOptions) => spawnManaged(command, args, spawnOptions, {
        label: "claude-code-conversation",
      }));
    this.platform = options.platform ?? process.platform;
  }

  async *streamTurn(
    text: string,
    abortSignal?: AbortSignal,
    _attachments?: readonly unknown[],
  ): AsyncIterable<StreamEvent> {
    if (this.stopped) {
      throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
    }
    if (abortSignal?.aborted) {
      const error = new Error("subscription-runtime-aborted");
      error.name = "AbortError";
      throw error;
    }

    const mcpConfigPath = await this.writeMcpConfig();
    const toolAllowList = this.bridge.tools.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool.name}`);
    const args = [
      "-p",
      text,
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigPath,
      "--tools",
      toolAllowList.length > 0 ? toolAllowList.join(",") : "",
      ...(toolAllowList.length > 0 ? ["--permission-mode", "bypassPermissions"] as const : []),
      ...(this.sessionId ? ["--resume", this.sessionId] as const : []),
    ];

    let toolBoundary = false;
    let completed = false;
    const queue: StreamEvent[] = [];
    let waiter: ((value: IteratorResult<StreamEvent>) => void) | null = null;
    let failure: Error | null = null;
    let closed = false;

    const push = (event: StreamEvent): void => {
      if (closed || failure || toolBoundary && event.type !== "tool_call" && event.type !== "message_complete") {
        return;
      }
      if (waiter) {
        const resolveWaiter = waiter;
        waiter = null;
        resolveWaiter({ value: event, done: false });
        return;
      }
      queue.push(event);
    };

    const finish = (): void => {
      closed = true;
      if (waiter) {
        const resolveWaiter = waiter;
        waiter = null;
        resolveWaiter({ value: undefined as never, done: true });
      }
    };

    const fail = (error: Error): void => {
      if (failure) return;
      failure = error;
      closed = true;
      queue.length = 0;
      if (waiter) {
        const resolveWaiter = waiter;
        waiter = null;
        // Consumers observe failure through the async iterator reject path.
        resolveWaiter({ value: undefined as never, done: true });
      }
    };

    const onAbort = (): void => {
      void this.cancelActiveTurn();
      const error = new Error("subscription-runtime-aborted");
      error.name = "AbortError";
      fail(error);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    this.bridge.setHandler(async (call) => {
      if (toolBoundary || this.stopped) {
        throw new ClaudeCodeSubscriptionError("claude-code-operation-failed");
      }
      toolBoundary = true;
      push({ type: "tool_call", id: call.id, name: call.name, input: call.input });
      push({ type: "message_complete", stopReason: "tool_use" });
      finish();
      void this.cancelActiveTurn();
      return HOST_TOOL_ACCEPTED;
    });

    const child = this.spawn(this.executablePath, args, {
      cwd: this.workspaceDir,
      env: sanitizedClaudeCodeEnvironment(
        this.runtimeHome,
        process.env,
        this.platform,
        this.runtimeTempDir,
      ),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.activeChild = child;

    const timer = setTimeout(() => {
      void this.cancelActiveTurn();
      fail(new ClaudeCodeSubscriptionError("claude-code-operation-failed"));
    }, TURN_TIMEOUT_MS);

    let outputBytes = 0;
    let lineBuffer = "";
    const decoder = new StringDecoder("utf8");
    const consume = (chunk: Buffer | string): void => {
      if (failure || closed && toolBoundary) return;
      const textChunk = typeof chunk === "string" ? chunk : decoder.write(chunk);
      outputBytes += Buffer.byteLength(textChunk, "utf8");
      if (outputBytes > MAX_OUTPUT_BYTES) {
        void this.cancelActiveTurn();
        fail(new ClaudeCodeSubscriptionError("claude-code-operation-failed"));
        return;
      }
      lineBuffer += textChunk;
      while (true) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (!line) continue;
        this.handleJsonLine(line, push, () => {
          toolBoundary = true;
        });
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => consume(chunk));
    // stderr is drained without retention; it may contain paths or diagnostics.
    child.stderr?.on("data", () => undefined);
    child.once("error", () => {
      fail(new ClaudeCodeSubscriptionError("claude-code-runtime-unavailable"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (this.activeChild === child) this.activeChild = null;
      lineBuffer += decoder.end();
      const trailing = lineBuffer.trim();
      if (trailing) {
        this.handleJsonLine(trailing, push, () => {
          toolBoundary = true;
        });
      }
      if (failure) return;
      if (toolBoundary) {
        completed = true;
        finish();
        return;
      }
      if (code === 0) {
        push({ type: "message_complete", stopReason: "end_turn" });
        completed = true;
        finish();
        return;
      }
      fail(new ClaudeCodeSubscriptionError("claude-code-operation-failed"));
    });

    try {
      while (true) {
        if (failure) throw failure;
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) break;
        const next = await new Promise<IteratorResult<StreamEvent>>((resolveNext) => {
          waiter = resolveNext;
        });
        if (failure) throw failure;
        if (next.done) break;
        yield next.value;
      }
    } finally {
      this.bridge.setHandler(null);
      abortSignal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      if (!completed && !toolBoundary) await this.cancelActiveTurn();
    }
  }

  async cancelActiveTurn(): Promise<void> {
    const child = this.activeChild;
    if (!child) return;
    this.activeChild = null;
    try {
      forceKillManagedChildProcess(child);
    } catch {
      // Best-effort interrupt.
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.cancelActiveTurn();
    await this.bridge.stop();
  }

  private handleJsonLine(
    line: string,
    push: (event: StreamEvent) => void,
    markToolBoundary: () => void,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if (typeof parsed.session_id === "string" && parsed.session_id) {
      this.sessionId = parsed.session_id;
    }
    if (parsed.type === "assistant" && isRecord(parsed.message)) {
      const content = parsed.message.content;
      const text = textFromContent(content);
      if (text) push({ type: "text_delta", text });
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!isRecord(part) || part.type !== "tool_use") continue;
          // Host MCP tools are executed by the bridge child; native tools never
          // appear because --tools allowlists only mcp__lvis-host-tools__*.
          markToolBoundary();
        }
      }
      return;
    }
    if (parsed.type === "result" || parsed.stop_reason === "end_turn") {
      // Final metadata line; message_complete is emitted on process exit.
      return;
    }
  }

  private async writeMcpConfig(): Promise<string> {
    await fs.mkdir(this.runtimeTempDir, { recursive: true, mode: 0o700 });
    const path = join(this.runtimeTempDir, `mcp-${Date.now()}.json`);
    if (this.bridge.tools.length === 0) {
      await writeFileAtomicAtPath(path, `${JSON.stringify({ mcpServers: {} })}\n`);
      return path;
    }
    const mcp = await this.bridge.startMcpServer();
    const document = {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: mcp.command,
          args: [...mcp.args],
          env: { ...mcp.env },
        },
      },
    };
    await writeFileAtomicAtPath(path, `${JSON.stringify(document)}\n`);
    return path;
  }
}

/** Expose remote MCP tool names for tests and diagnostics. */
export function claudeCodeMcpToolNames(tools: readonly ToolSchema[]): string[] {
  return tools.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool.name}`);
}
