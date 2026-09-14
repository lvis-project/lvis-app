/**
 * Bookkeeping for one in-flight JSON-RPC request awaiting its response.
 *
 * Shared by every request/response client the host runs over a child process
 * or SSE stream (MCP, Codex app-server, ACP runtime and session). It lives in
 * lib/ because none of those transports owns the others; each client extends
 * it with the fields only its own timeout policy needs.
 */
export interface PendingJsonRpcRequest<Timer = NodeJS.Timeout> {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: Timer;
}

interface PendingReply extends PendingJsonRpcRequest {
  method: string;
}

/** Owns request identities and settlement; callers own protocol and close policy. */
export class JsonRpcPendingRequests {
  private nextId = 1;
  private readonly requests = new Map<number, PendingReply>();

  /** Allows an exact wire-size preflight without registering a request. */
  get nextRequestId(): number {
    return this.nextId;
  }

  /** Reserve an ID for a request whose reply is intentionally not awaited. */
  allocateId(): number {
    return this.nextId++;
  }

  begin(options: {
    method: string;
    timeoutMs: number;
    unrefTimer: boolean;
    timeoutError: () => Error;
    onTimeout?: () => void;
  }): { id: number; promise: Promise<unknown> } {
    const id = this.allocateId();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.take(id);
        if (!pending) return;
        pending.reject(options.timeoutError());
        options.onTimeout?.();
      }, options.timeoutMs);
      if (options.unrefTimer) timer.unref?.();
      this.requests.set(id, { method: options.method, resolve, reject, timer });
    });
    return { id, promise };
  }

  take(id: number): Omit<PendingReply, "timer"> | undefined {
    const pending = this.requests.get(id);
    if (!pending) return undefined;
    this.requests.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  rejectAll(error: Error): void {
    for (const id of this.requests.keys()) this.take(id)?.reject(error);
  }
}
