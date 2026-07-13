import { AsyncLocalStorage } from "node:async_hooks";

const toolExecutionCwd = new AsyncLocalStorage<string>();

/**
 * Return the cwd bound to the currently executing tool, if any.
 *
 * Re-entrant tool calls (for example plugin HostApi.callTool) use this as
 * their fallback when they do not have an explicit conversation entry-point
 * cwd. AsyncLocalStorage keeps concurrent conversations isolated without
 * mutating the process-wide working directory.
 */
export function currentToolExecutionCwd(): string | undefined {
  return toolExecutionCwd.getStore();
}

/** Bind a tool's authorized cwd for the complete asynchronous execution chain. */
export function runWithToolExecutionCwd<T>(cwd: string, fn: () => T): T {
  return toolExecutionCwd.run(cwd, fn);
}
