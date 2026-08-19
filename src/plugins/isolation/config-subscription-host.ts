/**
 * The HOST half of the config members and the four subscription members
 * (`docs/blueprints/plugin-process-isolation.md` §3.1).
 *
 * Each handler here does one thing: turn a message back into the call the
 * in-process plugin would have made on the REAL `PluginHostApi`, and hold the
 * lifetime that call creates. It re-implements none of what that object does —
 * the permission assertion in `onEvent`, the `format: "secret"` rejection and
 * restart policy in `config.set`, the self-event filter in `onPluginsChanged`,
 * the incarnation guard on every callback — because a second copy of any of
 * those is a second answer to a security question.
 *
 * WHY THIS IS A FACTORY AND NOT A TABLE ENTRY. `HOSTAPI_DISPATCH_TABLE` is a
 * module constant, and every member here needs the hostApi belonging to ONE
 * plugin incarnation: `config.set` writes that plugin's settings, `onEvent`
 * asserts that plugin's event access. A static entry has no way to name which
 * incarnation it is serving, so the binding happens where the dispatcher is
 * constructed — the same place `pluginId`, `generationId` and `isActive`
 * already come from — and the result is passed as `HostApiDispatcherOptions.table`.
 *
 * WHY NO HANDLER TELLS THE CHILD IT WAS CLOSED. A host-side teardown runs for
 * three reasons and only one of them is a message: `disposed` came from the
 * child, `peer-gone` means there is nobody to write to, and `revoked` — the one
 * that would need a `subscription-closed` notification — has no host-side
 * trigger today (`SubscriptionScope.release` closes as `disposed`). When one is
 * added it belongs in the dispatcher's own release path, which already owns the
 * envelope, rather than in six handlers each stamping their own.
 */
import type { PluginHostApi } from "../types.js";
import {
  defineHostApiPath,
  type HostApiCall,
  type HostApiPathHandler,
  type SubscriptionScope,
} from "./host-api-dispatcher.js";
import { HostApiBoundaryError } from "./host-api-wire.js";
import type { ConfigSubscriptionPath } from "./config-subscription-child.js";

/** The members the host actually services; `config.get` never arrives. */
export type DispatchedConfigSubscriptionPath = Exclude<
  ConfigSubscriptionPath,
  "config.get"
>;

/**
 * The live hostApi for the incarnation this dispatcher serves.
 *
 * Narrowed to the members this group calls so a test can bind a fake without
 * standing up the other thirty, and so a future member arriving here is a
 * deliberate widening rather than an unnoticed reach into the whole surface.
 */
export type ConfigSubscriptionHostApi = Pick<
  PluginHostApi,
  "config" | "onEvent" | "onPluginsChanged" | "onShutdown"
>;

/**
 * Read a positional argument the contract declares as a string.
 *
 * Fails with the boundary's own code rather than letting `undefined` reach the
 * hostApi, where `config.set(undefined, v)` would persist a key literally named
 * "undefined" and report success.
 */
function stringArgument(call: HostApiCall, index: number, name: string): string {
  const value = call.args[index];
  if (typeof value !== "string") {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[config-subscription-host] '${call.path}': ${name} must be a string`,
      { path: call.path, index },
    );
  }
  return value;
}

/** Refuse a call whose arity does not match the member's declared arguments. */
function requireArity(call: HostApiCall, arity: number): void {
  if (call.args.length !== arity) {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[config-subscription-host] '${call.path}': expected ${arity} arguments, received ${call.args.length}`,
      { path: call.path, arity, received: call.args.length },
    );
  }
}

/**
 * Register the host side under the child's id, undoing the host subscription if
 * the id is refused.
 *
 * The undo is the whole point: a duplicate or post-mortem id makes `adopt`
 * throw, and without this the host would be left subscribed to an event bus on
 * behalf of a registration no ledger knows about — a leak with no symptom,
 * which is the failure mode the ledger exists to prevent.
 */
function adoptOrUndo(
  scope: SubscriptionScope,
  subscriptionId: string,
  unsubscribe: () => void,
): void {
  try {
    scope.adopt(subscriptionId, () => {
      unsubscribe();
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }
}

/**
 * The five dispatchable members of this group, bound to one incarnation.
 *
 * `config.get` is absent by design: its contract answers `child-local`, the
 * table already refuses it, and servicing it here would make the
 * round-trip-free decision untrue in a way nothing would report.
 */
export function configSubscriptionDispatchPaths(
  hostApi: ConfigSubscriptionHostApi,
): Record<DispatchedConfigSubscriptionPath, HostApiPathHandler> {
  return {
    "config.set": defineHostApiPath("config.set", async (call) => {
      requireArity(call, 2);
      const key = stringArgument(call, 0, "key");
      // The value is whatever the plugin passed; the dispatcher has already
      // proven it survives JSON, and the schema decision belongs to the host
      // implementation, not to this handler.
      await hostApi.config.set(key, call.args[1]);
    }),

    "config.onChange": defineHostApiPath("config.onChange", async (call, scope) => {
      requireArity(call, 2);
      const key = stringArgument(call, 0, "key");
      const subscriptionId = stringArgument(call, 1, "subscriptionId");
      const unsubscribe = hostApi.config.onChange(key, (value) => {
        scope.deliver(subscriptionId, { key, value });
      });
      adoptOrUndo(scope, subscriptionId, unsubscribe);
      return { handleId: subscriptionId };
    }),

    onEvent: defineHostApiPath("onEvent", async (call, scope) => {
      requireArity(call, 2);
      const eventType = stringArgument(call, 0, "eventType");
      const subscriptionId = stringArgument(call, 1, "subscriptionId");
      // Throws when the plugin has no access to this event type. That check is
      // the host's and stays the host's — the child stub does not pre-filter,
      // so there is exactly one place the answer comes from.
      const unsubscribe = hostApi.onEvent(eventType, (data) => {
        scope.deliver(subscriptionId, { data });
      });
      adoptOrUndo(scope, subscriptionId, unsubscribe);
      return { handleId: subscriptionId };
    }),

    onPluginsChanged: defineHostApiPath("onPluginsChanged", async (call, scope) => {
      requireArity(call, 1);
      const subscriptionId = stringArgument(call, 0, "subscriptionId");
      const unsubscribe = hostApi.onPluginsChanged((event) => {
        scope.deliver(subscriptionId, { event });
      });
      adoptOrUndo(scope, subscriptionId, unsubscribe);
      return { handleId: subscriptionId };
    }),

    /**
     * `lifetime: "host-terminated"`, `result: "void"` — and both are load-bearing.
     *
     * The child gets no disposer because it cannot end this one, so the ledger
     * entry exists for the OTHER two deaths: the host firing shutdown, and the
     * child dying first. The host's in-process contract is that it AWAITS the
     * plugin's handler, and a notification cannot be awaited — so the wait is
     * the registration itself. The host fires the event and blocks on the entry
     * closing; the child releases it when its handler settles, and that release
     * is the reply. A child that died instead closes the entry as `peer-gone`
     * and the wait ends the same way, which is why nothing here holds a timeout
     * of its own: the bound belongs to the lifecycle caller that awaits this
     * handler, not to six copies of one policy.
     */
    onShutdown: defineHostApiPath("onShutdown", async (call, scope) => {
      requireArity(call, 1);
      const subscriptionId = stringArgument(call, 0, "subscriptionId");
      let ended = false;
      let finish: (() => void) | undefined;
      // Adopt BEFORE registering the shutdown handler: `hostApi.onShutdown`
      // returns no disposer, so a handler registered against a refused id could
      // never be taken back off the host's shutdown list.
      scope.adopt(subscriptionId, () => {
        ended = true;
        finish?.();
      });
      hostApi.onShutdown(async () => {
        // Already released — the child is gone, or the incarnation was torn
        // down. There is no handler left to wait for.
        if (ended) return;
        const settled = new Promise<void>((resolve) => {
          finish = resolve;
        });
        scope.deliver(subscriptionId, {});
        await settled;
      });
    }),
  };
}
