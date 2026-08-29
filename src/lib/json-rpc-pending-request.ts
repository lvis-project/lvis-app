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
