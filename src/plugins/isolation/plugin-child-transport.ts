/**
 * The host end of one plugin child's pipes
 * (`docs/blueprints/plugin-process-isolation.md` §5.2).
 *
 * It owns exactly one thing: turning a pair of streams into the two contracts
 * that run over them — outbound requests (MCP `tools/call` and the five
 * lifecycle methods of `plugin-instance-wire.ts`) and inbound hostApi traffic,
 * which it hands to a {@link HostApiDispatcher}.
 *
 * STREAM-INJECTED, not process-owning. The spawn, the ASRT wrap and the
 * managed-child registration live in `out-of-process-plugin.ts`; this class
 * takes a {@link ChildLink}. That split is what lets the protocol be exercised
 * over in-memory paired streams — the pattern `stdio-server-loop`'s own tests
 * use — while the confinement is exercised against a real process, instead of
 * one slow test having to prove both.
 *
 * A DEAD CHILD IS A FAILED CALL, never a hung one. Every pending request
 * rejects when the pipes close, and every host-side subscription the child
 * opened is released. That is the whole recovery §2.4 promises: today a hung
 * in-process handler detaches and holds a generation lease forever; here the
 * process dies and the lease goes with it.
 */
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  classifyMultiplexedMessage,
  FramedMessageStream,
  PendingCallTable,
  type MultiplexedMessage,
} from "./child-stream-multiplex.js";
import {
  HostApiDispatcher,
  type HostApiDispatcherOptions,
} from "./host-api-dispatcher.js";
import type { HostApiNotification, HostApiRequest } from "./host-api-wire.js";

/** A JSON-RPC error as it arrives from the child. */
interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
}

/**
 * A failed request to the child, with the child's own JSON-RPC code preserved.
 *
 * The code is kept because the child distinguishes "the plugin is not
 * constructed yet" from "your method does not exist" from "the handler threw",
 * and collapsing all three into one message would leave the host unable to tell
 * a protocol mistake from a plugin bug.
 */
class PluginChildRequestError extends Error {
  readonly code: number;

  constructor(method: string, body: JsonRpcErrorBody) {
    super(`[plugin-child-transport] ${method}: ${body.message}`);
    this.name = "PluginChildRequestError";
    this.code = body.code;
  }
}

/** The child's pipes plus the one thing only its owner can do: end it. */
export interface ChildLink {
  /** Framed messages FROM the child (its stdout). */
  readonly input: Readable;
  /** Framed messages TO the child (its stdin). */
  readonly output: Writable;
  /**
   * End the child.
   *
   * Called by {@link PluginChildTransport.close} and by nothing else, so the
   * transport never has to know whether it is holding a real process or a pair
   * of in-memory streams.
   */
  terminate(reason: string): void;
  /**
   * The child went away on its own — it exited, or the spawn failed.
   *
   * Owned by the link rather than watched by the transport because only the
   * link knows what "gone" means for what it is holding. The transport's part
   * is what it does about it, which is the same either way: reject everything
   * pending, so a dead child is a failed call and never a hung host.
   */
  onGone(handler: (reason: string) => void): void;
}

export interface PluginChildTransportOptions
  extends Omit<HostApiDispatcherOptions, "notifications"> {
  readonly link: ChildLink;
}

export class PluginChildTransport {
  private readonly stream: FramedMessageStream;
  private readonly pending = new PendingCallTable<unknown>();
  private readonly dispatcher: HostApiDispatcher;
  private readonly link: ChildLink;
  private closedReason: string | undefined;

  constructor(options: PluginChildTransportOptions) {
    this.link = options.link;
    this.dispatcher = new HostApiDispatcher({
      ...options,
      notifications: {
        deliver: (notification) => this.sendToChild(notification),
      },
    });
    this.stream = new FramedMessageStream(
      options.link.input,
      options.link.output,
      (message) => this.route(message),
    );
  }

  /**
   * Begin reading, and start listening for the child going away.
   *
   * The gone-handler is attached HERE rather than at the first request: a child
   * that dies while it is still constructing must fail the construct call, and
   * construct is the first request there is.
   */
  start(): void {
    this.link.onGone((reason) => this.close(reason));
    this.stream.start();
  }

  /**
   * Send one request and await the child's reply.
   *
   * `timeoutMs` is left UNSET by callers whose wait is already bounded on the
   * host side — a tool call sits under `runWithCeiling`, a `start()` under
   * `runStartWithTimeout`. Passing one here in addition would put a second,
   * quieter deadline on the same operation and make which of them fired a
   * matter of milliseconds.
   */
  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closedReason !== undefined) throw new Error(this.closedReason);
    const id = randomUUID();
    const settled = this.pending.register(id, timeoutMs, () => {
      // A request that outlived its deadline means the child stopped answering.
      // Killing it is the recovery, not an escalation: the alternative is a
      // confined process running plugin code that nothing is waiting for.
      this.close(`[plugin-child-transport] '${method}' timed out after ${String(timeoutMs)}ms`);
    });
    this.stream.send({ jsonrpc: "2.0", id, method, params });
    return await settled;
  }

  /** Push a host-originated notification to the child. */
  sendToChild(notification: HostApiNotification): void {
    if (this.closedReason !== undefined) return;
    this.stream.send(notification);
  }

  /**
   * The child is gone, or is being ended.
   *
   * Idempotent, because it is reached from three directions that can race — the
   * process exiting, a request deadline, and the host stopping the plugin.
   */
  close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.link.terminate(reason);
    this.pending.rejectAll(reason);
    this.dispatcher.childGone();
  }

  private route(message: MultiplexedMessage): void {
    switch (classifyMultiplexedMessage(message)) {
      case "rpc-response": {
        const id = String(message.id);
        if (message.error !== undefined) {
          this.pending.fail(
            id,
            new PluginChildRequestError(id, message.error as JsonRpcErrorBody),
          );
          return;
        }
        this.pending.settle(id, message.result);
        return;
      }
      case "host-api-request":
        void this.dispatcher
          .handle(message as unknown as HostApiRequest)
          .then((reply) => this.stream.send(reply));
        return;
      case "host-api-notification":
        this.dispatcher.handleNotification(message as unknown as HostApiNotification);
        return;
      default:
        // An MCP request, an instance request, or an unrecognised frame. The
        // host is a client on these pipes and never a server, so a frame in the
        // server direction is a confused child — dropped, not answered, because
        // answering would mean implementing a surface the host does not have.
        return;
    }
  }
}
