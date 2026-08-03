export type PluginRuntimeStartupState =
  | "accepting_pre_start_operations"
  | "starting"
  | "started";

/**
 * Serializes boot-only durable plugin operations ahead of the one runtime start.
 * Admission is intentionally synchronous: once start() is called, no later
 * operation can enter the tail or touch durable plugin state. A failed start
 * remains sealed in `starting` and all callers receive the same rejection;
 * startup is never retried implicitly or reported as started.
 */
export class PluginRuntimePreStartPhase {
  private state: PluginRuntimeStartupState = "accepting_pre_start_operations";
  private tail: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | null = null;

  getState(): PluginRuntimeStartupState {
    return this.state;
  }

  admit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== "accepting_pre_start_operations") {
      return Promise.reject(
        new Error("plugin runtime no longer accepts pre-start operations"),
      );
    }

    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  start(startPlugins: () => Promise<void>): Promise<void> {
    if (this.startPromise) return this.startPromise;

    // This transition must happen before the first await so a caller that does
    // not await start() still seals pre-start admission immediately.
    this.state = "starting";
    this.startPromise = (async () => {
      await this.tail;
      await startPlugins();
      this.state = "started";
    })();
    return this.startPromise;
  }
}
