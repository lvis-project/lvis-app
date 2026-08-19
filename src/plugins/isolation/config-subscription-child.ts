/**
 * The CHILD half of the config members and the four subscription members
 * (`docs/blueprints/plugin-process-isolation.md` §3.1).
 *
 * Six members, one file, because they share two things nothing else does: a
 * config snapshot that only the child reads, and a handler that never crosses.
 * Splitting them across the two sides of the boundary would put the encode and
 * the decode of the same payload in two files that nothing forces to agree, so
 * the payload codecs live HERE and the host handler imports them — this file is
 * Electron-free (it reaches only `host-api-wire.ts` and the public contract),
 * and `config-subscription-host.ts` is not.
 *
 * WHAT A `handler-registration` MEMBER ACTUALLY DOES. The plugin passes a
 * function; a function cannot cross. The child registers it locally under an id
 * IT allocates, sends the id, and hands the plugin back a disposer that closes
 * the LOCAL registration. The id is child-allocated rather than host-allocated
 * because the handler has to be reachable before the first event can arrive: a
 * child that waited for the reply to learn its id would have a window in which
 * an event has nowhere to go.
 *
 * WHY THE SUBSCRIBE REQUEST IS NOT AWAITED. All four members return
 * synchronously in the in-process contract — three a disposer, `onShutdown`
 * nothing — and a process boundary is not synchronous. Returning a Promise
 * would be a contract change for every plugin. So the local registration is the
 * synchronous part and the round trip runs behind it; a subscribe that FAILS is
 * reported through the log channel and the local registration is dropped, never
 * left half-open pretending to be subscribed.
 */
import type { PluginLifecycleEvent } from "../types.js";
import { HostApiBoundaryError } from "./host-api-wire.js";
import type { HostApiPath } from "./host-api-path-contracts.js";
import type { HostApiCaller } from "./plugin-child-runtime.js";

/** The members this pair implements, named once so both sides agree. */
export type ConfigSubscriptionPath =
  | "config.get"
  | "config.set"
  | "config.onChange"
  | "onEvent"
  | "onPluginsChanged"
  | "onShutdown";

/**
 * What `config.onChange` puts on the wire.
 *
 * The value is WRAPPED rather than sent bare because the callback's declared
 * type is `T | undefined` and "the key was cleared" has to stay distinguishable
 * from "the notification carried no payload". As a property, `undefined`
 * survives the round trip as an absent field and reads back as `undefined`; as
 * the whole payload it would be indistinguishable from a malformed message.
 */
export interface ConfigChangeEvent {
  readonly key: string;
  readonly value?: unknown;
}

/** What `onEvent` puts on the wire. Wrapped for the same reason. */
export interface HostEventDelivery {
  readonly data?: unknown;
}

/** What `onPluginsChanged` puts on the wire. */
export interface PluginLifecycleDelivery {
  readonly event: PluginLifecycleEvent;
}

/**
 * Read one event payload as a record, or refuse.
 *
 * The host is the trust root for this direction, so this is not a security
 * check — it is the check that turns "the two sides disagree about a payload
 * shape" into a named failure instead of the plugin's callback silently
 * receiving `undefined` and treating it as data.
 */
function asEventRecord(payload: unknown, label: string): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[config-subscription-child] ${label}: event payload is not an object`,
    );
  }
  return payload as Record<string, unknown>;
}

/** Take a `config.onChange` event off the wire. */
export function decodeConfigChange(payload: unknown): ConfigChangeEvent {
  const record = asEventRecord(payload, "config.onChange");
  const { key } = record;
  if (typeof key !== "string") {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[config-subscription-child] config.onChange: event names no key`,
    );
  }
  return { key, value: record.value };
}

/** Take an `onEvent` event off the wire. */
export function decodeHostEvent(payload: unknown): HostEventDelivery {
  return { data: asEventRecord(payload, "onEvent").data };
}

/** Take an `onPluginsChanged` event off the wire. */
export function decodePluginLifecycle(payload: unknown): PluginLifecycleDelivery {
  const record = asEventRecord(payload, "onPluginsChanged");
  const event = record.event as PluginLifecycleEvent | undefined;
  if (
    event === undefined
    || typeof event !== "object"
    || typeof (event as { type?: unknown }).type !== "string"
  ) {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[config-subscription-child] onPluginsChanged: event carries no discriminant`,
    );
  }
  return { event };
}

/** One child-side registration, as `plugin-child-runtime.ts` hands it back. */
interface ChildSubscriptionHandle {
  readonly subscriptionId: string;
  readonly dispose: () => void;
}

/** What the child runtime lends this group so it does not re-derive any of it. */
export interface ConfigSubscriptionChildDeps {
  readonly pluginId: string;
  /** The one place the envelope is stamped and the call id allocated. */
  readonly call: HostApiCaller;
  /** The one child-side subscription ledger, shared with every other member. */
  readonly openSubscription: (
    path: HostApiPath,
    handler: (payload: unknown) => void,
  ) => ChildSubscriptionHandle;
  /**
   * The child's copy of the resolved config, seeded from the construction push.
   *
   * MUTABLE and shared with `config.set`, which writes into it only after the
   * host has confirmed the write. That is what makes a plugin's own
   * set-then-get see its own value: `set` is awaited, and the snapshot is
   * current by the time it resolves.
   */
  readonly config: Record<string, unknown>;
  /** `context.log`, so an async failure with no caller to throw to is still seen. */
  readonly report: (message: string, meta?: unknown) => void;
}

/** A hostApi member as the stub builder wants it. */
type ChildMember = (...args: unknown[]) => unknown;

/**
 * Reject a member argument the plugin got wrong, at the plugin's own call site.
 *
 * These are plugin bugs, not wire failures, and the in-process version answers
 * several of them with a silent `undefined` — `config.get(42)` reads as "unset"
 * rather than "you passed a number". A member that cannot tell those apart is a
 * member whose answer cannot be trusted, so this throws instead.
 */
function requireStringArgument(
  pluginId: string,
  member: string,
  name: string,
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `[plugin-child:${pluginId}] hostApi.${member}: '${name}' must be a string`,
    );
  }
  return value;
}

function requireFunctionArgument(
  pluginId: string,
  member: string,
  name: string,
  value: unknown,
): (...args: unknown[]) => unknown {
  if (typeof value !== "function") {
    throw new TypeError(
      `[plugin-child:${pluginId}] hostApi.${member}: '${name}' must be a function`,
    );
  }
  return value as (...args: unknown[]) => unknown;
}

/**
 * Open a subscription: register locally, then ask the host to wire its side.
 *
 * The round trip is deliberately not awaited (see the file header). What it
 * MUST not do is fail silently — a plugin holding a disposer for a
 * subscription the host never opened would receive nothing and have no way to
 * find out, which is the same symptom as a working subscription for an event
 * that never fires.
 */
function subscribe(
  deps: ConfigSubscriptionChildDeps,
  path: HostApiPath,
  args: (subscriptionId: string) => readonly unknown[],
  handler: (payload: unknown) => void,
): ChildSubscriptionHandle {
  const subscription = deps.openSubscription(path, handler);
  void deps.call(path, args(subscription.subscriptionId)).catch((error: unknown) => {
    deps.report(`hostApi.${path}: the host refused the subscription`, {
      subscriptionId: subscription.subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Drop the local half too. Keeping it would leave the plugin holding a
    // disposer for a registration that exists on neither side.
    subscription.dispose();
  });
  return subscription;
}

/**
 * The six members, wired to the boundary.
 *
 * Returned as a partial map rather than installed directly so
 * `plugin-child-runtime.ts` composes the groups in one place — four authors
 * adding four spreads, instead of four authors editing one switch.
 */
export function createConfigSubscriptionChildMembers(
  deps: ConfigSubscriptionChildDeps,
): Record<ConfigSubscriptionPath, ChildMember> {
  const { pluginId } = deps;
  return {
    // No round trip: the resolved config was pushed at construction and the
    // child reads its own copy. `config.get` is synchronous in the contract and
    // a process boundary is not, so this is the member the design answers by
    // never sending it — the dispatcher refuses it if it ever arrives.
    "config.get": (...args) =>
      deps.config[requireStringArgument(pluginId, "config.get", "key", args[0])],

    "config.set": async (...args) => {
      const key = requireStringArgument(pluginId, "config.set", "key", args[0]);
      const value = args[1];
      await deps.call("config.set", [key, value]);
      // Only AFTER the host confirms. Writing the snapshot optimistically would
      // make a rejected write (a `format: "secret"` key, an inactive
      // incarnation) readable through `config.get` as though it had persisted.
      deps.config[key] = value;
    },

    "config.onChange": (...args) => {
      const key = requireStringArgument(pluginId, "config.onChange", "key", args[0]);
      const callback = requireFunctionArgument(
        pluginId,
        "config.onChange",
        "callback",
        args[1],
      );
      const subscription = subscribe(
        deps,
        "config.onChange",
        (subscriptionId) => [key, subscriptionId],
        (payload) => {
          const change = decodeConfigChange(payload);
          // The snapshot moves BEFORE the callback runs, so a callback that
          // reads `config.get(key)` sees the value it was just handed rather
          // than the one it replaced.
          deps.config[change.key] = change.value;
          callback(change.value);
        },
      );
      return () => {
        subscription.dispose();
      };
    },

    onEvent: (...args) => {
      const eventType = requireStringArgument(pluginId, "onEvent", "eventType", args[0]);
      const handler = requireFunctionArgument(pluginId, "onEvent", "handler", args[1]);
      const subscription = subscribe(
        deps,
        "onEvent",
        (subscriptionId) => [eventType, subscriptionId],
        (payload) => {
          handler(decodeHostEvent(payload).data);
        },
      );
      return () => {
        subscription.dispose();
      };
    },

    onPluginsChanged: (...args) => {
      const handler = requireFunctionArgument(
        pluginId,
        "onPluginsChanged",
        "handler",
        args[0],
      );
      const subscription = subscribe(
        deps,
        "onPluginsChanged",
        (subscriptionId) => [subscriptionId],
        (payload) => {
          handler(decodePluginLifecycle(payload).event);
        },
      );
      return () => {
        subscription.dispose();
      };
    },

    // The odd one of the four: it returns NOTHING, because the host ends it
    // (`lifetime: "host-terminated"`). The child still holds a ledger entry so
    // the registration dies with the host rather than outliving it, but the
    // plugin is given no disposer — matching the in-process signature exactly.
    onShutdown: (...args) => {
      const handler = requireFunctionArgument(pluginId, "onShutdown", "handler", args[0]);
      const subscription: ChildSubscriptionHandle = subscribe(
        deps,
        "onShutdown",
        (subscriptionId) => [subscriptionId],
        () => {
          void (async () => {
            try {
              await handler();
            } catch (error) {
              deps.report("hostApi.onShutdown: the plugin's handler threw", {
                error: error instanceof Error ? error.message : String(error),
              });
            } finally {
              // The release is how the host learns the handler has finished —
              // it is the reply to a fire-and-forget notification. It runs even
              // when the handler threw, because a host that waits forever for a
              // plugin that has already failed is the hang this replaces.
              subscription.dispose();
            }
          })();
        },
      );
      return undefined;
    },
  };
}
