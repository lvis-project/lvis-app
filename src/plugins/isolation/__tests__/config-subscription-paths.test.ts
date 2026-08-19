/**
 * The config members and the four subscription members, driven across a real
 * dispatcher and a real child runtime.
 *
 * The four subscriptions are the hard part of this boundary and the assertions
 * say why: a lifetime with two owners has FOUR ways to end, and three of them
 * are deaths nobody calls a disposer for. So every one of them is exercised
 * against the COUNTS on both ledgers, not against behaviour that happens to
 * still work — a leaked subscription throws nothing, fails nothing, and keeps a
 * retired plugin's callbacks firing.
 */
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { PluginHostApi, PluginLifecycleEvent } from "../../types.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
  type HostApiPathHandler,
} from "../host-api-dispatcher.js";
import { HOSTAPI_PATH_CONTRACTS, type HostApiPath } from "../host-api-path-contracts.js";
import {
  HOST_API_WIRE_VERSION,
  type HostApiChannel,
  type HostApiNotification,
  type HostApiRequest,
} from "../host-api-wire.js";
import {
  createHostApiCaller,
  startPluginChildRuntime,
  type PluginChildRuntime,
  type PluginFactoryLoader,
} from "../plugin-child-runtime.js";
import {
  createConfigSubscriptionHostApiPaths,
  type ConfigSubscriptionHostApi,
} from "../config-subscription-host.js";
import {
  decodeConfigChange,
  decodeHostEvent,
  decodePluginLifecycle,
} from "../config-subscription-child.js";
import type { PluginManifest } from "../../types.js";

const PLUGIN_ID = "com.example.subscriber";
const GENERATION = "gen-11";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Subscriber",
  version: "1.0.0",
  entry: "dist/plugin.js",
  description: "a plugin that subscribes to everything the host offers",
  tools: [],
};

/** Let the un-awaited subscribe round trip settle before asserting on it. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A stand-in for the real per-incarnation hostApi.
 *
 * It records what was registered and hands back a working disposer, which is
 * all the handlers under test actually depend on — the permission assertion,
 * the restart policy and the self-event filter belong to the real object and
 * are deliberately NOT re-created here, because a copy of them in a test is a
 * second answer to a question the host already answers.
 */
function fakeHostApi() {
  const configListeners = new Map<string, Set<(value: unknown) => void>>();
  const eventListeners = new Map<string, Set<(data: unknown) => void>>();
  const lifecycleListeners = new Set<(event: PluginLifecycleEvent) => void>();
  const shutdownHandlers: Array<() => void | Promise<void>> = [];
  const written: Array<[string, unknown]> = [];
  let setRejection: Error | undefined;

  const add = <T>(registry: Map<string, Set<T>>, key: string, listener: T) => {
    const bucket = registry.get(key) ?? new Set<T>();
    bucket.add(listener);
    registry.set(key, bucket);
    return () => {
      bucket.delete(listener);
    };
  };

  const hostApi: ConfigSubscriptionHostApi = {
    config: {
      get: () => undefined,
      set: async (key, value) => {
        if (setRejection) throw setRejection;
        written.push([key, value]);
      },
      onChange: (key, callback) =>
        add(configListeners, key, callback as (value: unknown) => void),
    } as PluginHostApi["config"],
    onEvent: (eventType, handler) => add(eventListeners, eventType, handler),
    onPluginsChanged: (handler) => {
      lifecycleListeners.add(handler);
      return () => {
        lifecycleListeners.delete(handler);
      };
    },
    onShutdown: (handler) => {
      shutdownHandlers.push(handler);
    },
  };

  return {
    hostApi,
    written,
    rejectSet(error: Error) {
      setRejection = error;
    },
    configListenerCount: (key: string) => configListeners.get(key)?.size ?? 0,
    eventListenerCount: (type: string) => eventListeners.get(type)?.size ?? 0,
    lifecycleListenerCount: () => lifecycleListeners.size,
    emitConfigChange(key: string, value: unknown) {
      for (const listener of configListeners.get(key) ?? []) listener(value);
    },
    emitEvent(type: string, data: unknown) {
      for (const listener of eventListeners.get(type) ?? []) listener(data);
    },
    emitLifecycle(event: PluginLifecycleEvent) {
      for (const listener of lifecycleListeners) listener(event);
    },
    async runShutdown() {
      await Promise.all(shutdownHandlers.map((handler) => handler()));
    },
  };
}

interface Harness {
  readonly child: PluginChildRuntime;
  readonly host: HostApiDispatcher;
  readonly api: ReturnType<typeof fakeHostApi>;
  readonly hostApi: PluginHostApi;
  readonly notifications: HostApiNotification[];
  /** Every request that crossed. The only place a subscription id is observable. */
  readonly requests: HostApiRequest[];
  readonly call: (path: HostApiPath, args: readonly unknown[]) => Promise<unknown>;
}

/**
 * The id the child allocated for the registration `path` opened.
 *
 * The plugin never sees it — that is what `result: "handle"` means — so a test
 * playing the host's side has to read it where the host reads it: off the
 * subscribe request itself.
 */
function subscriptionIdOf(requests: HostApiRequest[], path: HostApiPath): string {
  const request = requests.find((candidate) => candidate.path === path);
  if (!request) throw new Error(`no '${path}' request crossed the wire`);
  return request.args[request.args.length - 1] as string;
}

async function harness(
  options: { config?: Record<string, unknown>; isActive?: () => boolean } = {},
): Promise<Harness> {
  const api = fakeHostApi();
  const notifications: HostApiNotification[] = [];
  const requests: HostApiRequest[] = [];
  let host!: HostApiDispatcher;
  let child!: PluginChildRuntime;

  const channel: HostApiChannel = {
    call: (request) => {
      requests.push(request);
      return host.handle(request);
    },
    notify: (notification) => {
      notifications.push(notification);
      host.handleNotification(notification);
    },
  };

  host = new HostApiDispatcher({
    pluginId: PLUGIN_ID,
    generationId: GENERATION,
    isActive: options.isActive ?? (() => true),
    notifications: { deliver: (notification) => child.deliver(notification) },
    table: {
      ...HOSTAPI_DISPATCH_TABLE,
      ...createConfigSubscriptionHostApiPaths(api.hostApi),
    } as Record<HostApiPath, HostApiPathHandler>,
  });

  const loadFactory: PluginFactoryLoader = async () => () => ({ handlers: {} });

  child = await startPluginChildRuntime({
    input: new PassThrough(),
    output: new PassThrough(),
    manifest: MANIFEST,
    context: {
      pluginId: PLUGIN_ID,
      pluginRoot: "/plugins/subscriber",
      hostRoot: "/app",
      pluginDataDir: "/plugins/subscriber/data",
      installedPluginIds: [],
      config: options.config ?? { theme: "dark" },
      generationId: GENERATION,
    },
    channel,
    loadFactory,
  });

  const call = createHostApiCaller(channel, {
    pluginId: PLUGIN_ID,
    generationId: GENERATION,
  });

  return { child, host, api, hostApi: child.hostApi, notifications, requests, call };
}

describe("config.get answers in the child, and is refused if it ever crosses", () => {
  it("declares the round-trip-free decision in its own contract", () => {
    const contract = HOSTAPI_PATH_CONTRACTS["config.get"];
    expect(contract.arguments).toBe("child-local");
    expect(contract.result).toBe("child-local");
    expect(contract.lifetime).toBe("none");
  });

  it("reads the snapshot pushed at construction", async () => {
    const { hostApi } = await harness({ config: { theme: "dark", retries: 3 } });
    expect(hostApi.config.get("theme")).toBe("dark");
    expect(hostApi.config.get("retries")).toBe(3);
  });

  it("answers an unset key as unset rather than throwing", async () => {
    const { hostApi } = await harness({ config: {} });
    expect(hostApi.config.get("missing")).toBeUndefined();
  });

  it("refuses a key that is not a string instead of reading it as unset", async () => {
    const { hostApi } = await harness();
    expect(() => (hostApi.config.get as (key: unknown) => unknown)(42)).toThrow(
      /'key' must be a string/u,
    );
  });

  it("is refused by the host if a child ever sends it", async () => {
    const { call } = await harness();
    await expect(call("config.get", ["theme"])).rejects.toMatchObject({
      code: "path-not-dispatchable",
    });
  });
});

describe("config.set crosses as plain JSON and comes back as nothing", () => {
  it("declares plain-json arguments and a void result", () => {
    const contract = HOSTAPI_PATH_CONTRACTS["config.set"];
    expect(contract.arguments).toBe("plain-json");
    expect(contract.result).toBe("void");
    expect(contract.lifetime).toBe("none");
    expect(contract.errors).toEqual([]);
  });

  it("reaches the host's own implementation with the plugin's key and value", async () => {
    const { hostApi, api } = await harness();
    await expect(hostApi.config.set("theme", "light")).resolves.toBeUndefined();
    expect(api.written).toEqual([["theme", "light"]]);
  });

  it("makes a plugin's own set-then-get see its own write", async () => {
    // The ordering the contract promises. `set` is awaited, so by the time it
    // resolves the child's snapshot must already carry the value.
    const { hostApi } = await harness({ config: { theme: "dark" } });
    await hostApi.config.set("theme", "light");
    expect(hostApi.config.get("theme")).toBe("light");
  });

  it("leaves the snapshot alone when the host refuses the write", async () => {
    // A rejected write readable through `config.get` would report a persisted
    // value that does not exist — the silent wrong answer the boundary exists
    // to prevent.
    const { hostApi, api } = await harness({ config: { theme: "dark" } });
    api.rejectSet(new Error("secret fields must be saved via hostApi.setSecret()"));
    await expect(hostApi.config.set("theme", "light")).rejects.toThrow(/setSecret/u);
    expect(hostApi.config.get("theme")).toBe("dark");
  });

  it("refuses a value that would not survive the wire, at the plugin's call site", async () => {
    const { hostApi, api } = await harness();
    await expect(hostApi.config.set("when", new Date("2020-01-01"))).rejects.toThrow(
      /cannot cross the boundary/u,
    );
    expect(api.written).toEqual([]);
  });

  it("refuses a malformed call off the wire rather than persisting a bad key", async () => {
    const { call, api } = await harness();
    for (const args of [[], ["only-a-key"], [42, "value"], ["k", "v", "extra"]]) {
      await expect(call("config.set", args)).rejects.toMatchObject({
        code: "argument-marshalling-rejected",
      });
    }
    expect(api.written).toEqual([]);
  });
});

/**
 * The three disposer-bearing members, driven through one table.
 *
 * They differ only in what they name and what their event carries; the lifetime
 * obligations are identical, so proving them once per member from one table is
 * what stops the third one quietly getting a weaker guarantee than the first.
 */
const DISPOSABLE = [
  {
    path: "config.onChange" as const,
    subscribe: (hostApi: PluginHostApi, sink: unknown[]) =>
      hostApi.config.onChange("theme", (value) => sink.push(value)),
    wireArgs: (subscriptionId: string) => ["theme", subscriptionId],
    fire: (api: ReturnType<typeof fakeHostApi>) => api.emitConfigChange("theme", "light"),
    expected: ["light"],
    hostListenerCount: (api: ReturnType<typeof fakeHostApi>) =>
      api.configListenerCount("theme"),
  },
  {
    path: "onEvent" as const,
    subscribe: (hostApi: PluginHostApi, sink: unknown[]) =>
      hostApi.onEvent("task.created", (data) => sink.push(data)),
    wireArgs: (subscriptionId: string) => ["task.created", subscriptionId],
    fire: (api: ReturnType<typeof fakeHostApi>) =>
      api.emitEvent("task.created", { taskId: "t1" }),
    expected: [{ taskId: "t1" }],
    hostListenerCount: (api: ReturnType<typeof fakeHostApi>) =>
      api.eventListenerCount("task.created"),
  },
  {
    path: "onPluginsChanged" as const,
    subscribe: (hostApi: PluginHostApi, sink: unknown[]) =>
      hostApi.onPluginsChanged((event) => sink.push(event)),
    wireArgs: (subscriptionId: string) => [subscriptionId],
    fire: (api: ReturnType<typeof fakeHostApi>) =>
      api.emitLifecycle({ type: "installed", pluginId: "com.other", source: "marketplace" }),
    expected: [{ type: "installed", pluginId: "com.other", source: "marketplace" }],
    hostListenerCount: (api: ReturnType<typeof fakeHostApi>) => api.lifecycleListenerCount(),
  },
];

describe.each(DISPOSABLE)(
  "$path holds a lifetime that releases on both sides",
  ({ path, subscribe, wireArgs, fire, expected, hostListenerCount }) => {
    async function subscribed() {
      const wired = await harness();
      const received: unknown[] = [];
      const dispose = subscribe(wired.hostApi, received);
      await flush();
      expect(wired.child.openSubscriptionCount).toBe(1);
      expect(wired.host.openSubscriptionCount).toBe(1);
      expect(hostListenerCount(wired.api)).toBe(1);
      return { ...wired, received, dispose };
    }

    it("declares a handler registration, a handle, and a child-held lifetime", () => {
      const contract = HOSTAPI_PATH_CONTRACTS[path];
      expect(contract.arguments).toBe("handler-registration");
      expect(contract.result).toBe("handle");
      expect(contract.lifetime).toBe("child-disposable");
      expect(contract.errors).toEqual([]);
    });

    it("returns a disposer synchronously, the way the in-process contract does", async () => {
      const { dispose } = await subscribed();
      expect(typeof dispose).toBe("function");
    });

    it("replies with the child-allocated id as the handle", async () => {
      const { call, child } = await harness();
      const subscription = child.openSubscription(path, () => {});
      await expect(call(path, wireArgs(subscription.subscriptionId))).resolves.toEqual({
        handleId: subscription.subscriptionId,
      });
    });

    it("refuses a malformed registration off the wire", async () => {
      const { call, api } = await harness();
      const arity = wireArgs("s1").length;
      const malformed = [
        [],
        wireArgs("s1").slice(0, arity - 1),
        [...wireArgs("s1"), "extra"],
        wireArgs("s1").map(() => 42),
      ];
      for (const args of malformed) {
        await expect(call(path, args), JSON.stringify(args)).rejects.toMatchObject({
          code: "argument-marshalling-rejected",
        });
      }
      // Nothing was wired on the host either — a refusal that still subscribed
      // would leak a listener for a registration no ledger names.
      expect(hostListenerCount(api)).toBe(0);
    });

    it("carries the host's payload to the plugin's handler", async () => {
      const { api, received } = await subscribed();
      fire(api);
      expect(received).toEqual(expected);
    });

    it("undoes its host registration when the ledger refuses the id", async () => {
      const { call, child, api } = await harness();
      const subscription = child.openSubscription(path, () => {});
      await call(path, wireArgs(subscription.subscriptionId));
      // A second registration under the same id is refused by the ledger — a
      // silent overwrite would drop a release. The handler must take its own
      // host subscription back off the bus rather than leaving a listener that
      // no ledger entry can ever release.
      await expect(call(path, wireArgs(subscription.subscriptionId))).rejects.toThrow();
      expect(hostListenerCount(api)).toBe(1);
    });

    it("releases BOTH sides when the plugin disposes", async () => {
      const { child, host, api, dispose, notifications } = await subscribed();
      dispose();
      expect(child.openSubscriptionCount).toBe(0);
      expect(host.openSubscriptionCount).toBe(0);
      expect(hostListenerCount(api)).toBe(0);
      expect(notifications.at(-1)).toMatchObject({ kind: "subscription-release" });
      // Idempotent: a plugin that disposes twice does not release twice.
      dispose();
      expect(host.openSubscriptionCount).toBe(0);
    });

    it("stops delivering to the plugin once it has disposed", async () => {
      const { api, received, dispose } = await subscribed();
      dispose();
      fire(api);
      expect(received).toEqual([]);
    });

    it("releases the HOST side when the child dies without disposing", async () => {
      const { host, api } = await subscribed();
      expect(host.childGone()).toBe(1);
      expect(host.openSubscriptionCount).toBe(0);
      // The real leak: the host is still wired to its own bus on behalf of a
      // process that no longer exists.
      expect(hostListenerCount(api)).toBe(0);
    });

    it("releases the CHILD side when the host dies, without writing to a dead pipe", async () => {
      const { child, notifications } = await subscribed();
      const before = notifications.length;
      expect(child.hostGone()).toBe(1);
      expect(child.openSubscriptionCount).toBe(0);
      expect(notifications).toHaveLength(before);
    });

    it("drops the child side when the host revokes, and does not echo back", async () => {
      // The plugin is still holding a live disposer at this point. A revoke it
      // is not told about leaves it holding a closure over the whole plugin
      // instance for a registration the host has already forgotten.
      const { child, notifications, requests, received, api, dispose } = await subscribed();
      const before = notifications.length;
      expect(
        child.deliver({
          wire: HOST_API_WIRE_VERSION,
          pluginId: PLUGIN_ID,
          generationId: GENERATION,
          kind: "subscription-closed",
          subscriptionId: subscriptionIdOf(requests, path),
          reason: "revoked",
        }),
      ).toBe("closed");
      expect(child.openSubscriptionCount).toBe(0);
      // No release travels back: the host already knows, and answering a
      // close with a close is the ping-pong the reason exists to prevent.
      expect(notifications).toHaveLength(before);
      fire(api);
      expect(received).toEqual([]);
      // The disposer the plugin still holds is now inert rather than a second
      // release for a registration that is already gone.
      dispose();
      expect(notifications).toHaveLength(before);
    });
  },
);

describe("onShutdown is the subscription the HOST ends", () => {
  it("declares a handler registration, no result, and a host-terminated lifetime", () => {
    const contract = HOSTAPI_PATH_CONTRACTS.onShutdown;
    expect(contract.arguments).toBe("handler-registration");
    expect(contract.result).toBe("void");
    expect(contract.lifetime).toBe("host-terminated");
    expect(contract.errors).toEqual([]);
  });

  it("returns nothing to the plugin, because the plugin cannot end it", async () => {
    const { hostApi } = await harness();
    expect(hostApi.onShutdown(() => {})).toBeUndefined();
    await flush();
  });

  it("replies with nothing on the wire, matching its void result", async () => {
    const { call, child } = await harness();
    const subscription = child.openSubscription("onShutdown", () => {});
    await expect(call("onShutdown", [subscription.subscriptionId])).resolves
      .toBeUndefined();
  });

  it("runs the plugin's handler and makes the host WAIT for it to finish", async () => {
    const { hostApi, api, host, child } = await harness();
    const order: string[] = [];
    let release!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    hostApi.onShutdown(async () => {
      order.push("plugin-started");
      await handlerFinished;
      order.push("plugin-finished");
    });
    await flush();
    expect(host.openSubscriptionCount).toBe(1);

    let hostReturned = false;
    const shutdown = api.runShutdown().then(() => {
      hostReturned = true;
      order.push("host-returned");
    });
    await flush();
    // The host is blocked on a notification it cannot await directly; the
    // registration IS the wait, and the child's release is the reply.
    expect(order).toEqual(["plugin-started"]);
    expect(hostReturned).toBe(false);

    release();
    await shutdown;
    expect(order).toEqual(["plugin-started", "plugin-finished", "host-returned"]);
    // Both ledgers are clear afterwards: the release the child sent closed the
    // host side, and disposing closed its own.
    expect(host.openSubscriptionCount).toBe(0);
    expect(child.openSubscriptionCount).toBe(0);
  });

  it("stops waiting when the plugin's handler throws, instead of hanging forever", async () => {
    const { hostApi, api, host } = await harness();
    hostApi.onShutdown(() => Promise.reject(new Error("teardown failed")));
    await flush();
    await expect(api.runShutdown()).resolves.toBeUndefined();
    expect(host.openSubscriptionCount).toBe(0);
  });

  it("stops waiting when the child died before shutdown ran", async () => {
    const { hostApi, api, host } = await harness();
    hostApi.onShutdown(() => {});
    await flush();
    expect(host.childGone()).toBe(1);
    // No registration is left to deliver to. A handler that fired anyway would
    // throw `subscription-unknown` into the host's shutdown loop.
    await expect(api.runShutdown()).resolves.toBeUndefined();
  });

  it("releases the CHILD side when the host dies, without writing to a dead pipe", async () => {
    const { hostApi, child, notifications } = await harness();
    hostApi.onShutdown(() => {});
    await flush();
    const before = notifications.length;
    expect(child.hostGone()).toBe(1);
    expect(child.openSubscriptionCount).toBe(0);
    expect(notifications).toHaveLength(before);
  });

  it("refuses a malformed registration off the wire", async () => {
    const { call } = await harness();
    for (const args of [[], [42], ["a", "b"]]) {
      await expect(call("onShutdown", args)).rejects.toMatchObject({
        code: "argument-marshalling-rejected",
      });
    }
  });
});

describe("a subscribe the host refuses does not leave the plugin holding a live disposer", () => {
  it("drops the child registration and reports the refusal", async () => {
    // The subscribe round trip is not awaited — it cannot be, because the
    // in-process contract returns synchronously — so a refusal has no caller to
    // throw to. Silence here would give the plugin a disposer for a
    // subscription that exists on neither side, which looks exactly like a
    // working subscription for an event that never fires.
    const { hostApi, child, host, api, notifications } = await harness({
      isActive: () => false,
    });
    const dispose = hostApi.onEvent("task.created", () => {});
    expect(typeof dispose).toBe("function");
    await flush();

    expect(child.openSubscriptionCount).toBe(0);
    expect(host.openSubscriptionCount).toBe(0);
    expect(api.eventListenerCount("task.created")).toBe(0);
    const reported = notifications.filter((n) => n.kind === "log");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      kind: "log",
      message: "hostApi.onEvent: the host refused the subscription",
    });
  });

  it("reports every member of the group, not just the one that was tested", async () => {
    const { hostApi, child, notifications } = await harness({ isActive: () => false });
    hostApi.config.onChange("theme", () => {});
    hostApi.onPluginsChanged(() => {});
    hostApi.onShutdown(() => {});
    await flush();
    expect(child.openSubscriptionCount).toBe(0);
    expect(
      notifications.flatMap((n) => (n.kind === "log" ? [n.message] : [])).sort(),
    ).toEqual([
      "hostApi.config.onChange: the host refused the subscription",
      "hostApi.onPluginsChanged: the host refused the subscription",
      "hostApi.onShutdown: the host refused the subscription",
    ]);
  });
});

describe("the config snapshot the child answers from stays current", () => {
  it("moves the snapshot before the plugin's own onChange callback runs", async () => {
    // A callback that reads `config.get(key)` must see the value it was just
    // handed. Refreshing after the callback would show it the value it
    // replaced, and nothing about that reads as an error.
    const { hostApi, api } = await harness({ config: { theme: "dark" } });
    const seen: unknown[] = [];
    hostApi.config.onChange("theme", () => seen.push(hostApi.config.get("theme")));
    await flush();
    api.emitConfigChange("theme", "light");
    expect(seen).toEqual(["light"]);
    expect(hostApi.config.get("theme")).toBe("light");
  });

  it("carries a cleared key through as unset rather than as a missing event", async () => {
    const { hostApi, api } = await harness({ config: { theme: "dark" } });
    const seen: unknown[] = [];
    hostApi.config.onChange("theme", (value) => seen.push(value));
    await flush();
    api.emitConfigChange("theme", undefined);
    expect(seen).toEqual([undefined]);
    expect(hostApi.config.get("theme")).toBeUndefined();
  });
});

describe("the payload codecs both sides share", () => {
  it("keeps a cleared config key distinguishable from a missing payload", () => {
    expect(decodeConfigChange({ key: "theme", value: undefined })).toEqual({
      key: "theme",
      value: undefined,
    });
    expect(decodeConfigChange(JSON.parse(JSON.stringify({ key: "theme" })))).toEqual({
      key: "theme",
      value: undefined,
    });
  });

  it("refuses a payload the two sides disagree about", () => {
    for (const bad of [null, "raw", 7, [], {}]) {
      expect(() => decodeConfigChange(bad), String(bad)).toThrow(
        /event payload is not an object|names no key/u,
      );
    }
    expect(() => decodeHostEvent(null)).toThrow(/not an object/u);
    expect(() => decodePluginLifecycle({})).toThrow(/no discriminant/u);
    expect(() => decodePluginLifecycle({ event: { pluginId: "x" } })).toThrow(
      /no discriminant/u,
    );
  });

  it("carries an event payload of undefined without inventing one", () => {
    expect(decodeHostEvent({}).data).toBeUndefined();
    expect(decodeHostEvent({ data: { taskId: "t1" } }).data).toEqual({ taskId: "t1" });
  });
});

describe("the group binds to one incarnation and claims exactly its own members", () => {
  it("services every member of the group except the child-local one", async () => {
    const api = fakeHostApi();
    const paths = Object.keys(createConfigSubscriptionHostApiPaths(api.hostApi)).sort();
    expect(paths).toEqual([
      "config.onChange",
      "config.set",
      "onEvent",
      "onPluginsChanged",
      "onShutdown",
    ]);
  });

  it("keys every handler to the contract SOT rather than to a local copy", () => {
    const api = fakeHostApi();
    const handlers = createConfigSubscriptionHostApiPaths(api.hostApi);
    for (const [path, handler] of Object.entries(handlers)) {
      expect(handler.path).toBe(path);
      expect(handler.contract).toBe(HOSTAPI_PATH_CONTRACTS[path as HostApiPath]);
      expect(handler.status).toBe("implemented");
    }
  });

  it("leaves the shipped table unbound, because a module constant has no incarnation", () => {
    // Publishing a bound handler into `HOSTAPI_DISPATCH_TABLE` would be a
    // handler that names no plugin: `config.set` writes SOMEONE's settings and
    // `onEvent` asserts SOMEONE's event access. Nothing routes out-of-process
    // yet, and the shipped table staying unbound is what says so.
    expect(HOSTAPI_DISPATCH_TABLE["config.get"].status).toBe("child-local");
    for (const path of [
      "config.set",
      "config.onChange",
      "onEvent",
      "onPluginsChanged",
      "onShutdown",
    ] as const) {
      expect(HOSTAPI_DISPATCH_TABLE[path].status, path).toBe("unimplemented");
    }
  });

  it("reports a host that drifts into returning a value from a void member", async () => {
    // The check exists on the dispatcher; a handler that awaited the host's
    // promise and resolved `undefined` of its own accord would make it
    // unreachable, and the drift would reach the child's stub unannounced.
    const drifted = {
      config: {
        get: () => undefined,
        set: async () => "persisted" as unknown as void,
        onChange: () => () => {},
      } as PluginHostApi["config"],
      onEvent: () => () => {},
      onPluginsChanged: () => () => {},
      onShutdown: (() => () => {}) as unknown as PluginHostApi["onShutdown"],
    } satisfies ConfigSubscriptionHostApi;
    const host = new HostApiDispatcher({
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      isActive: () => true,
      notifications: { deliver: () => {} },
      table: {
        ...HOSTAPI_DISPATCH_TABLE,
        ...createConfigSubscriptionHostApiPaths(drifted),
      } as Record<HostApiPath, HostApiPathHandler>,
    });
    const envelope = {
      wire: HOST_API_WIRE_VERSION,
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
    } as const;
    for (const [path, args] of [
      ["config.set", ["theme", "light"]],
      ["onShutdown", ["s1"]],
    ] as const) {
      const reply = await host.handle({ ...envelope, callId: "c1", path, args });
      expect(reply.ok, path).toBe(false);
      if (reply.ok) continue;
      expect(reply.error.code, path).toBe("result-marshalling-rejected");
    }
  });

  it("binds each dispatcher to its own hostApi, not to a module singleton", async () => {
    const first = fakeHostApi();
    const second = fakeHostApi();
    const spy = vi.spyOn(second.hostApi.config, "set");
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      ...createConfigSubscriptionHostApiPaths(first.hostApi),
    } as Record<HostApiPath, HostApiPathHandler>;
    const host = new HostApiDispatcher({
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      isActive: () => true,
      notifications: { deliver: () => {} },
      table,
    });
    const reply = await host.handle({
      wire: HOST_API_WIRE_VERSION,
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      callId: "c1",
      path: "config.set",
      args: ["theme", "light"],
    });
    expect(reply.ok).toBe(true);
    expect(first.written).toEqual([["theme", "light"]]);
    expect(spy).not.toHaveBeenCalled();
  });
});
