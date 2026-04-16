import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ToolCallBlock, TokenUsage, GenericMessage, ToolSchema } from "../engine/llm/types.js";

export interface ChatTurnRequest {
  vendor: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: GenericMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
}

export interface ChatTurnResponse {
  text: string;
  thought?: string;
  toolCalls: ToolCallBlock[];
  stopReason: "end_turn" | "tool_use";
  usage?: TokenUsage;
}

export interface ChatServiceManagerOptions {
  pythonPath: string;
  projectRoot: string;
  host?: string;
  port?: number;
}

export class ChatServiceManager {
  private readonly pythonPath: string;
  private readonly projectRoot: string;
  private readonly host: string;
  private readonly port: number;
  private process: ChildProcess | null = null;
  private starting: Promise<void> | null = null;

  constructor(options: ChatServiceManagerOptions) {
    this.pythonPath = options.pythonPath;
    this.projectRoot = options.projectRoot;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 43131;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async turn(request: ChatTurnRequest): Promise<ChatTurnResponse> {
    await this.ensureStarted();
    const response = await fetch(`${this.baseUrl}/chat/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const payload = (await response.json()) as { detail?: string };
        detail = payload.detail ?? "";
      } catch {
        detail = await response.text().catch(() => "");
      }
      throw new Error(detail || `chat service error ${response.status}`);
    }
    return (await response.json()) as ChatTurnResponse;
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    try {
      await fetch(`${this.baseUrl}/shutdown`, { method: "POST" });
    } catch {
      // ignore shutdown fetch failures and fall back to process kill
    }
    this.process.kill("SIGTERM");
    this.process = null;
    this.starting = null;
  }

  private async ensureStarted(): Promise<void> {
    if (await this.isHealthy()) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<void> {
    const chatScript = this.resolveChatScriptPath();
    await access(chatScript);

    const proc = spawn(
      this.pythonPath,
      [chatScript, "--host", this.host, "--port", String(this.port)],
      {
        cwd: this.projectRoot,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.process = proc;

    proc.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.log(`[chat-service] ${line}`);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.error(`[chat-service] ${line}`);
    });
    proc.on("exit", () => {
      this.process = null;
    });

    await this.waitForHealth();
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitForHealth(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`chat service did not become healthy within ${timeoutMs}ms`);
  }

  private resolveChatScriptPath(): string {
    const isDev =
      !!(process as { defaultApp?: boolean }).defaultApp || !process.resourcesPath;

    if (isDev) {
      return join(this.projectRoot, "backend", "chat_agent", "chat.py");
    }

    return join(process.resourcesPath, "backend", "chat_agent", "chat.py");
  }
}
