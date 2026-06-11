/**
 * `StdioChildTransport` — the host (client) side of the out-of-process plugin
 * path (mcp-alignment-design.md §3.1, `untrusted-stdio-isolation`).
 *
 * Spawns a subprocess that runs {@link StdioServerLoop} + a `PluginMcpServer` and
 * frames RC JSON-RPC over its stdin/stdout (the same byte-accurate Content-Length
 * framing as `stdio-framing.ts`). A {@link PluginMcpHost} drives it exactly as it
 * drives the in-process {@link LoopbackTransport} for first-party plugins — same
 * host, same projection, a different transport — which is the hybrid topology's
 * untrusted arm.
 *
 * Isolation/containment: because the plugin runs in a separate process, a crash
 * or hang is contained — `exit`/`error` surface via `onClose` (rejecting the
 * client's pending requests), and `close()` SIGTERMs the child. OS sandboxing
 * (bubblewrap / sandbox-exec) is an ADDITIONAL hardening layer applied by
 * prefixing the spawn command (e.g. `bwrap --unshare-all -- node entry`); the
 * process boundary here is the containment primitive it builds on.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { frameMessage, StdioFrameDecoder } from "./stdio-framing.js";
import type { JsonRpcMessage, JsonRpcResponse, McpTransport } from "./mcp-client.js";

export interface StdioChildOptions {
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Optional sandbox wrapper: given the base command+args, return the wrapped
   * command+args (e.g. bubblewrap). Identity by default (process isolation only).
   */
  sandboxWrap?: (command: string, args: string[]) => { command: string; args: string[] };
}

export class StdioChildTransport implements McpTransport {
  readonly kind = "stdio" as const;

  private child: ChildProcess | null = null;
  private alive = false;
  private readonly decoder = new StdioFrameDecoder();
  private messageHandler: ((msg: JsonRpcResponse) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly options: StdioChildOptions = {},
  ) {}

  async open(): Promise<void> {
    const { command, args } = this.options.sandboxWrap
      ? this.options.sandboxWrap(this.command, this.args)
      : { command: this.command, args: this.args };

    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.alive = true;

    child.stdout?.on("data", (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) {
        this.messageHandler?.(message as unknown as JsonRpcResponse);
      }
    });
    child.on("exit", (code, signal) => this.fail(`child exited code=${code} signal=${signal}`));
    child.on("error", (err) => this.fail(`child error: ${err.message}`));
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.alive || !this.child?.stdin) {
      throw new Error("[stdio-child] transport not open");
    }
    this.child.stdin.write(frameMessage(message));
  }

  async close(): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    this.child?.kill("SIGTERM");
    this.closeHandler?.("closed");
  }

  isAlive(): boolean {
    return this.alive;
  }

  onMessage(handler: (msg: JsonRpcResponse) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  /** Mark dead exactly once and surface the reason (crash/hang containment). */
  private fail(reason: string): void {
    if (!this.alive) return;
    this.alive = false;
    this.closeHandler?.(reason);
  }
}
