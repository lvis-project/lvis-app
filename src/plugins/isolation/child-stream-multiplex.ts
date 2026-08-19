/**
 * One framed stdio stream, four kinds of traffic
 * (`docs/blueprints/plugin-process-isolation.md` §5.2).
 *
 * The host owns the child's pipes, and both contracts have to share them:
 * MCP + lifecycle requests travel host→child, hostApi requests travel
 * child→host, and notifications travel both ways. §5.2 chose a spawned stdio
 * child precisely BECAUSE its argv can be wrapped by ASRT, so a second channel
 * (a socket, an extra descriptor) would have to be carried through the sandbox
 * wrap as well — three new pieces of attack surface for a multiplex that four
 * disjoint message shapes give for free.
 *
 * They are disjoint by construction, not by convention: the hostApi wire was
 * never JSON-RPC (`host-api-wire.ts` messages carry `callId`/`kind`, never
 * `method`/`id`), so {@link classifyMultiplexedMessage} discriminates on fields
 * that only one shape has. A message matching none of them is `unknown` and is
 * DROPPED by both sides rather than guessed at — guessing is how a malformed
 * frame becomes a call to the wrong handler.
 *
 * ELECTRON-FREE BY CONSTRUCTION: the child imports this.
 */
import type { Readable, Writable } from "node:stream";
import { frameMessage, StdioFrameDecoder } from "../../mcp/stdio-framing.js";
import { isPluginInstanceMethod } from "./plugin-instance-wire.js";

/** A decoded frame, before anyone has decided what it is. */
export type MultiplexedMessage = Record<string, unknown>;

/**
 * What one frame is.
 *
 * `mcp-request` and `instance-request` are split because they are answered by
 * DIFFERENT handlers in the child — the `PluginMcpServer` and the lifecycle
 * handler — and routing them from one place is what keeps the child from
 * needing a second decoder.
 */
export type MultiplexedKind =
  | "mcp-request"
  | "instance-request"
  | "rpc-response"
  | "host-api-request"
  | "host-api-reply"
  | "host-api-notification"
  | "unknown";

export function classifyMultiplexedMessage(
  message: MultiplexedMessage,
): MultiplexedKind {
  if (typeof message.method === "string") {
    return isPluginInstanceMethod(message.method) ? "instance-request" : "mcp-request";
  }
  // Checked BEFORE `callId` alone: a hostApi request and its reply share the
  // correlation field and are told apart by what else they carry.
  if (typeof message.path === "string" && typeof message.callId === "string") {
    return "host-api-request";
  }
  if (typeof message.callId === "string" && typeof message.ok === "boolean") {
    return "host-api-reply";
  }
  if (typeof message.kind === "string") return "host-api-notification";
  if (message.id !== undefined && ("result" in message || "error" in message)) {
    return "rpc-response";
  }
  return "unknown";
}

/**
 * A framed message stream over one pair of Node streams.
 *
 * ONE decoder per direction, which is the reason this is a class and not two
 * loose functions: attaching a second decoder to the same `Readable` would give
 * two consumers two independent views of the same bytes, and a partial frame
 * would then be reassembled twice.
 */
export class FramedMessageStream {
  private readonly decoder = new StdioFrameDecoder();
  private started = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onMessage: (message: MultiplexedMessage) => void,
  ) {}

  start(): void {
    if (this.started) throw new Error("[child-stream-multiplex] already started");
    this.started = true;
    this.input.on("data", (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) this.onMessage(message);
    });
  }

  /**
   * Write one whole frame.
   *
   * Every writer on this side funnels through here so a frame is always one
   * `write` call. Two writers each emitting header-then-body could interleave
   * and produce a stream neither peer can resynchronise.
   */
  send(message: unknown): void {
    this.output.write(frameMessage(message));
  }
}

/** A request awaiting its reply. */
interface PendingCall<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout | undefined;
}

/**
 * Correlate outbound requests with inbound replies, and fail every one of them
 * when the peer goes away.
 *
 * Both sides need this and they key it differently — the host by JSON-RPC `id`,
 * the child by `callId` — so it is generic over the key rather than written
 * twice. {@link rejectAll} is the reason it exists at all: a pending call whose
 * peer died must REJECT, because a promise that never settles is exactly the
 * hung host this whole boundary is supposed to make impossible.
 */
export class PendingCallTable<T> {
  private readonly pending = new Map<string, PendingCall<T>>();
  private closedReason: string | undefined;

  get openCount(): number {
    return this.pending.size;
  }

  /**
   * Register a call.
   *
   * `timeoutMs` is optional and is left UNSET for tool calls on purpose: a
   * gated hostApi write can block on a human for as long as the human takes
   * (§7.5), and a boundary deadline there would abandon a call the host is
   * still servicing. The lifecycle requests, whose host-side bounds already
   * exist, pass their own.
   */
  register(
    key: string,
    timeoutMs: number | undefined,
    onTimeout: (key: string) => void,
  ): Promise<T> {
    if (this.closedReason !== undefined) {
      return Promise.reject(new Error(this.closedReason));
    }
    if (this.pending.has(key)) {
      return Promise.reject(
        new Error(`[child-stream-multiplex] duplicate pending call '${key}'`),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(key);
              onTimeout(key);
              reject(
                new Error(
                  `[child-stream-multiplex] call '${key}' exceeded ${timeoutMs}ms`,
                ),
              );
            }, timeoutMs);
      // `unref` so a pending deadline cannot by itself keep the host alive.
      timer?.unref?.();
      this.pending.set(key, { resolve, reject, timer });
    });
  }

  settle(key: string, value: T): boolean {
    const call = this.pending.get(key);
    if (!call) return false;
    this.pending.delete(key);
    if (call.timer) clearTimeout(call.timer);
    call.resolve(value);
    return true;
  }

  fail(key: string, error: Error): boolean {
    const call = this.pending.get(key);
    if (!call) return false;
    this.pending.delete(key);
    if (call.timer) clearTimeout(call.timer);
    call.reject(error);
    return true;
  }

  /** The peer is gone. Every pending call rejects and no new one is accepted. */
  rejectAll(reason: string): number {
    this.closedReason = reason;
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(new Error(reason));
    }
    return calls.length;
  }
}
