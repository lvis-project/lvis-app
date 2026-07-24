/**
 * A runtime operation whose caller-facing ceiling fired before the underlying
 * plugin handler settled. The original error remains the public message while
 * the settlement promise lets generation/account lease owners retain authority
 * until detached work is actually finished.
 */
export class PluginRuntimeDetachedOperationError extends Error {
  readonly settlement: Promise<unknown>;

  constructor(error: Error, settlement: Promise<unknown>) {
    super(error.message, { cause: error });
    this.name = "PluginRuntimeDetachedOperationError";
    this.settlement = settlement;
  }
}

export function isPluginRuntimeDetachedOperationError(
  error: unknown,
): error is PluginRuntimeDetachedOperationError {
  return error instanceof PluginRuntimeDetachedOperationError;
}
