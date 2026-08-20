import type { PluginHostApi } from "./types.js";
import {
  HOSTAPI_EFFECT_BY_PATH,
  pathEffectClass,
} from "../permissions/effect-kind.js";
import type { PluginRuntimeGenerationAccess } from "./plugin-host-generation.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("plugin-host-effect-scope");

type ScopeState =
  | "preparing" | "published" | "superseded" | "discarded" | "retired";

const PREPARED_SUBSCRIPTIONS = new Set([
  "config.onChange",
  "onEvent",
  "onPluginsChanged",
  "onShutdown",
]);
const QUEUED_SIGNALS = new Set(["emitEvent", "logEvent"]);
const PREPARED_SIGNAL_LIMIT = 64;

interface GenerationBinding {
  access: PluginRuntimeGenerationAccess;
  generationId: string;
}

interface QueuedSignal {
  invoke(): void;
}

function preparationError(pluginId: string, path: string): Error {
  return new Error(
    `[plugin:${pluginId}] hostApi.${path} is unavailable while a replacement generation is preparing`,
  );
}

/**
 * Exact owner for HostApi effects created by one immutable plugin generation.
 * The scope is explicit (not ALS-only), so callbacks scheduled by start() keep
 * the correct generation even after the factory call has returned.
 */
export class HostApiGenerationScope {
  readonly token = Object.freeze({});
  private state: ScopeState = "preparing";
  private binding: GenerationBinding | undefined;
  private readonly disposers = new Set<() => void>();
  private readonly queuedSignals: QueuedSignal[] = [];
  private readonly publishActions: Array<() => void> = [];
  private readonly supersedeActions: Array<() => void> = [];

  constructor(readonly pluginId: string) {}

  bindGeneration(
    access: PluginRuntimeGenerationAccess,
    generationId: string,
  ): void {
    if (this.binding)
      throw new Error(
        `plugin '${this.pluginId}' generation scope is already bound`,
      );
    if (this.state !== "preparing")
      throw new Error(
        `plugin '${this.pluginId}' generation scope is not preparing`,
      );
    this.binding = Object.freeze({ access, generationId });
  }

  publish(): void {
    this.preparePublish()();
  }

  /** Validate before commit and return an assignment-safe publication closure. */
  preparePublish(): () => void {
    if (!this.binding)
      throw new Error(
        `plugin '${this.pluginId}' generation scope is not bound`,
      );
    if (this.state !== "preparing")
      throw new Error(
        `plugin '${this.pluginId}' generation scope cannot publish from ${this.state}`,
      );
    return () => {
      if (this.state !== "preparing") return;
      for (const action of this.publishActions) action();
      this.state = "published";
    };
  }

  resume(): void {
    if (!this.binding)
      throw new Error(
        `plugin '${this.pluginId}' generation scope is not bound`,
      );
    if (this.state === "published") return;
    if (this.state !== "superseded") {
      throw new Error(
        `plugin '${this.pluginId}' generation scope cannot resume from ${this.state}`,
      );
    }
    for (const action of this.publishActions) action();
    this.state = "published";
  }

  supersede(): void {
    if (this.state !== "published") return;
    this.state = "superseded";
    for (const action of this.supersedeActions) action();
  }

  isPreparing(): boolean {
    return this.state === "preparing";
  }

  stagePublish(action: () => void): void {
    if (this.state === "preparing") {
      this.publishActions.push(action);
      return;
    }
    if (this.state === "published") {
      action();
      return;
    }
    throw new Error(
      `plugin '${this.pluginId}' generation scope cannot publish effects from ${this.state}`,
    );
  }

  onSupersede(action: () => void): void {
    if (this.state === "preparing" || this.state === "published") {
      this.supersedeActions.push(action);
      return;
    }
    if (this.state === "superseded") action();
  }

  postPublish(): readonly Error[] {
    if (this.state !== "published") return [];
    const errors: Error[] = [];
    for (const signal of this.queuedSignals.splice(0)) {
      try {
        signal.invoke();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return errors;
  }

  registerDisposer(dispose: () => void): void {
    if (this.state === "discarded" || this.state === "retired") {
      dispose();
      return;
    }
    this.disposers.add(dispose);
  }

  wrapCallback<TArgs extends readonly unknown[]>(
    callback: (...args: TArgs) => unknown,
  ): (...args: TArgs) => Promise<void> {
    return async (...args: TArgs): Promise<void> => {
      const binding = this.binding;
      if (this.state !== "published" || !binding) return;
      let lease;
      try {
        lease = await binding.access.acquireExact(
          this.pluginId,
          binding.generationId,
        );
      } catch {
        return;
      }
      try {
        await binding.access.runWithLease(lease, async () => {
          await callback(...args);
        });
      } finally {
        lease.release();
      }
    };
  }

  /**
   * Wrap a callback whose result NOBODY awaits, and contain what it throws.
   *
   * {@link wrapCallback} returns a promise; a bus listener has no caller to
   * hand one to. Discarding it with `void` does not discard the FAILURE —
   * `runWithLease` propagates what the callback threw, so the discarded
   * promise rejects with nothing attached. Node's default since v15 turns an
   * unhandled rejection into an uncaught exception, and the Electron main
   * process registers a handler for NEITHER — the only `uncaughtException`
   * handler in this repo is in `scripts/run-electron-dev.mjs`, which is the
   * launcher process and not this one. So one plugin's listener was enough to
   * end the host. The event buses whose listeners get wrapped already contain
   * their SYNCHRONOUS ones with a per-listener try/catch and a log line
   * (`plugins/config-change-bus.ts`, `boot/types.ts`); this is that same
   * containment for the wrapped ones, so both halves of one bus fail alike.
   *
   * DELIBERATELY NOT FOLDED INTO {@link wrapCallback}. `onShutdown` hands its
   * wrapped callback to a runner that AWAITS it and needs the rejection —
   * swallowing it there would report a plugin's failed shutdown as a clean
   * one. The difference is whether a caller is waiting, and that is known at
   * the wrap site, not inside the wrapper.
   */
  wrapListener<TArgs extends readonly unknown[]>(
    callback: (...args: TArgs) => unknown,
  ): (...args: TArgs) => void {
    const wrapped = this.wrapCallback(callback);
    return (...args: TArgs): void => {
      void wrapped(...args).catch((error: unknown) => {
        log.warn(
          `[plugin:${this.pluginId}] host listener failed: %s`,
          error instanceof Error ? error.message : String(error),
        );
      });
    };
  }

  wrapHostApi(hostApi: PluginHostApi): PluginHostApi {
    const cache = new WeakMap<object, object>();
    const wrapObject = (target: object, prefix: string): object => {
      const cached = cache.get(target);
      if (cached) return cached;
      const proxy = new Proxy(target, {
        get: (inner, property, receiver) => {
          const value = Reflect.get(inner, property, receiver) as unknown;
          if (typeof property !== "string") return value;
          const path = prefix ? `${prefix}.${property}` : property;
          if (typeof value === "function") {
            return (...args: unknown[]) =>
              this.invoke(
                path,
                value as (...innerArgs: unknown[]) => unknown,
                inner,
                args,
              );
          }
          if (value && typeof value === "object")
            return wrapObject(value, path);
          return value;
        },
      });
      cache.set(target, proxy);
      return proxy;
    };
    return wrapObject(hostApi, "") as PluginHostApi;
  }

  discard(): void {
    if (this.state === "published" || this.state === "superseded") {
      throw new Error(
        `plugin '${this.pluginId}' published generation scope cannot be discarded`,
      );
    }
    if (this.state === "discarded" || this.state === "retired") return;
    this.state = "discarded";
    this.queuedSignals.length = 0;
    this.publishActions.length = 0;
    this.supersedeActions.length = 0;
    this.disposeAll();
  }

  retire(): readonly Error[] {
    if (this.state === "retired") return [];
    this.state = "retired";
    this.queuedSignals.length = 0;
    this.publishActions.length = 0;
    this.supersedeActions.length = 0;
    return this.disposeAll();
  }

  private invoke(
    path: string,
    method: (...args: unknown[]) => unknown,
    receiver: object,
    args: unknown[],
  ): unknown {
    if (this.state === "discarded" || this.state === "retired") {
      throw new Error(
        `[plugin:${this.pluginId}] hostApi.${path} belongs to a retired generation`,
      );
    }
    if (this.state === "superseded") {
      const binding = this.binding;
      if (
        !binding ||
        !binding.access.isExactAdmitted(this.pluginId, binding.generationId)
      ) {
        throw new Error(
          `[plugin:${this.pluginId}] hostApi.${path} belongs to a retired generation`,
        );
      }
      return method.apply(receiver, args);
    }
    if (this.state !== "preparing") return method.apply(receiver, args);

    if (PREPARED_SUBSCRIPTIONS.has(path)) return method.apply(receiver, args);
    if (QUEUED_SIGNALS.has(path)) {
      if (this.queuedSignals.length >= PREPARED_SIGNAL_LIMIT) {
        throw new Error(
          `[plugin:${this.pluginId}] prepared HostApi signal limit exceeded`,
        );
      }
      const clonedArgs = structuredClone(args);
      this.queuedSignals.push({
        invoke: () => {
          method.apply(receiver, clonedArgs);
        },
      });
      return undefined;
    }

    const effect = pathEffectClass(path);
    // A path with no entry in the effect SOT is refused, which is what now
    // covers `callTool`: it was removed from that map when the hostApi surface
    // was frozen, because the surviving `callTool` is the plugin UI webview
    // bridge rather than a hostApi member. Naming it here as well restated a
    // rule the last clause already enforces, and a redundant special case
    // reads as a rule of its own — someone removing the map entry later would
    // reasonably assume this line was still doing the work.
    if (effect === "write" || effect === "verb-derived" || !HOSTAPI_EFFECT_BY_PATH[path]) {
      throw preparationError(this.pluginId, path);
    }
    return method.apply(receiver, args);
  }

  private disposeAll(): Error[] {
    const errors: Error[] = [];
    for (const dispose of [...this.disposers].reverse()) {
      try {
        dispose();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.disposers.delete(dispose);
      }
    }
    return errors;
  }
}
