/**
 * Session-scoped AsyncLocalStorage for threading the current ConversationLoop
 * sessionId through async call chains — including the in-process MCP loopback
 * path (LoopbackTransport → PluginMcpServer.handle → PluginToolDelegate) —
 * without polluting every intermediate function signature.
 *
 * Usage:
 *  - ConversationLoop.runTurn wraps this.queryLoop() in sessionContext.run()
 *    so every tool call within the turn carries the correct session ID.
 *  - pluginRuntimeToolDelegate reads sessionContext.getStore()?.sessionId
 *    to consult the per-session on-demand activation map (Gate 4).
 *
 * Propagation guarantee: Node.js AsyncLocalStorage propagates through all
 * Promise chains and microtask callbacks created within the run() scope.
 * LoopbackTransport.send() calls server.handle() synchronously via await
 * inside the run() scope, so the store is available when the delegate fires.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface SessionContextStore {
  readonly sessionId: string;
}

export const sessionContext = new AsyncLocalStorage<SessionContextStore>();
