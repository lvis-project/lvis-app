/**
 * The plugin end of the boundary: what runs INSIDE a child process
 * (`docs/blueprints/plugin-process-isolation.md` §3.4, §5.2).
 *
 * It builds the hostApi stub, hands it to the plugin factory, and serves the
 * resulting instance as an MCP server over `StdioServerLoop` — the same
 * `PluginMcpServer` and the same projection the in-process loopback arm already
 * uses, over a different transport. That symmetry is the reason this is a
 * transport swap rather than a new protocol.
 *
 * TWO INJECTION POINTS, BOTH DELIBERATE.
 *
 * `loadFactory` is required rather than defaulting to `importPluginFactory`.
 * That helper lives in `runtime/plugin-loader.ts`, which imports
 * `runtime/sandbox.ts` → `plugins/storage.ts` → `electron`. A child is a plain
 * Node process where that import does not resolve, so reusing the helper as-is
 * would produce a child that cannot start — and copying its four lines here
 * would be the second copy of a function this repo has already been bitten by.
 * De-tangling `buildImportUrl` from the Electron-bound half of `sandbox.ts` is
 * the prerequisite for a real child entrypoint, and it is a change to a
 * heavily-shared module that does not belong in the same commit as this.
 *
 * `channel` is required for the same class of reason: the reverse channel has to
 * be multiplexed onto the stdio pipes that `StdioServerLoop` already owns, and
 * pinning that here would make every hostApi handler untestable without
 * spawning a subprocess.
 */
import type { Readable, Writable } from "node:stream";
import { StdioServerLoop } from "../../mcp/experimental/stdio-server-loop.js";
import {
  PluginMcpServer,
  type PluginToolDelegate,
} from "../../mcp/plugin-mcp-server.js";
import type { PluginUiResourceProvider } from "../../mcp/plugin-ui-resource-provider.js";
import { describeNonJson } from "../../shared/json-representable.js";
import { RAW_RESULT_META } from "../../mcp/protocol-constants.js";
import type {
  PluginHostApi,
  PluginManifest,
  PluginRuntimeContext,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import { createConfigSubscriptionChildMembers } from "./config-subscription-child.js";
import { createInteractionChildMembers } from "./host-api-interaction-child.js";
import { createStorageChildMembers } from "./host-api-storage-child.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  type HostApiPath,
} from "./host-api-path-contracts.js";
import {
  HOST_API_WIRE_VERSION,
  reconstructWireError,
  type HostApiChannel,
  type HostApiNotification,
} from "./host-api-wire.js";
import {
  SubscriptionLedger,
  type SubscriptionRelease,
} from "./subscription-ledger.js";
import { createServiceChildMembers } from "./host-api-service-child.js";

/**
 * The construction payload, which is `PluginRuntimeContext` minus the two
 * members that cannot cross: `log` is rebuilt from a notification and `hostApi`
 * is rebuilt from the channel. Everything else is already plain data.
 */
export interface PluginChildContext {
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly hostRoot: string;
  readonly pluginDataDir: string;
  /** The already-resolved config object, not the schema. */
  readonly config?: Record<string, unknown>;
  /** The incarnation this child serves. Stamped on every outbound message. */
  readonly generationId: string;
  /**
   * The installed-plugin ids as of construction.
   *
   * `getInstalledPluginIds` is synchronous, so §3.1 answers it from a
   * host-pushed snapshot; this is the first push. Later ones arrive as
   * `installed-plugins` notifications.
   */
  readonly installedPluginIds: readonly string[];
  /**
   * The allow-listed host preferences as of construction, split into `keys` and
   * `values` exactly as the `preference-snapshot` notification splits them.
   *
   * OPTIONAL, and the absence carries meaning rather than being a convenience:
   * `getAppPreference` is itself an OPTIONAL member of `PluginHostApi`, so "this
   * host publishes no preferences" and "this preference is unset" are two
   * different states that would both read as `undefined` at a plugin's call
   * site. Absent here means the first, and the child's member THROWS rather
   * than answering — merging the two would hand a plugin a wrong answer it has
   * no way to detect.
   */
  readonly appPreferences?: {
    readonly keys: readonly string[];
    readonly values: Record<string, unknown>;
  };
}

/** How the child obtains the plugin's factory export. */
export type PluginFactoryLoader = (
  manifest: PluginManifest,
) => Promise<RuntimePluginFactory | undefined>;

/** One child-side registration: the plugin's callback and the member it serves. */
interface ChildSubscription {
  readonly path: HostApiPath;
  readonly handler: (payload: unknown) => void;
  /**
   * What to run when the HOST ends this registration, for the members that own
   * something the child must let go of — the key a lease closed over being the
   * one that matters. Absent for a registration whose only state is the handler
   * itself, which the ledger drops on its own.
   */
  readonly onRevoked?: () => void;
}

/** What `deliver` did, so a dropped notification is reported rather than silent. */
export type NotificationOutcome =
  | "delivered"
  | "closed"
  | "unknown-subscription";

export interface PluginChildRuntimeOptions {
  /** Framed JSON-RPC in (the child's stdin in production). */
  readonly input: Readable;
  /** Framed JSON-RPC out (the child's stdout in production). */
  readonly output: Writable;
  readonly manifest: PluginManifest;
  readonly context: PluginChildContext;
  readonly channel: HostApiChannel;
  readonly loadFactory: PluginFactoryLoader;
  /** Serves this plugin's declared `ui://` cards, when it declares any. */
  readonly uiResources?: PluginUiResourceProvider;
}

export interface PluginChildRuntime {
  readonly instance: RuntimePlugin;
  readonly hostApi: PluginHostApi;
  /** Live child-side registrations. Zero after {@link hostGone}. */
  readonly openSubscriptionCount: number;
  /**
   * Open a child-side registration under a CHILD-allocated id, and return the
   * disposer the plugin gets. The four subscription members share this rather
   * than each inventing a lifetime.
   */
  openSubscription(
    path: HostApiPath,
    handler: (payload: unknown) => void,
  ): { readonly subscriptionId: string; readonly dispose: () => void };
  /**
   * Open a child-side registration under a HOST-allocated id, and return the
   * disposer.
   *
   * The counterpart to {@link openSubscription}, and both exist because the two
   * lifetime-bearing shapes allocate their ids at opposite ends. A
   * `handler-registration` member (`onEvent`, `config.onChange`, …) is named by
   * the CHILD so no event can arrive before its handler is registered; a
   * `handle` member (`spawnWorker`, `resolveApiKey`) is named by the HOST,
   * because the host owns the resource and cannot be told what to call it.
   */
  adoptSubscription(
    path: HostApiPath,
    subscriptionId: string,
    handler: (payload: unknown) => void,
    /**
     * Run when the HOST revokes this registration, never when the child
     * disposes it and never when the host is simply gone. `resolveApiKey` uses
     * it to drop the credential it closed over: a lease the host has taken back
     * must stop being spendable in the child, and the child cannot learn that
     * from an event because a revoked registration delivers none.
     */
    onRevoked?: () => void,
  ): () => void;
  /**
   * The child end of an abort channel: hand over the `AbortSignal` an argument
   * carried, receive the id that crosses in its place.
   *
   * Shared rather than per-member for the same reason the subscription ledger
   * is: `hostFetch`, `callLlm` and `resolveApiKey` all take a signal, and three
   * private listener maps would be three chances to leave a listener attached
   * to a signal whose call ended.
   *
   * An ALREADY-aborted signal throws its own reason instead of opening a
   * channel — that is what the in-process call does, and opening a channel the
   * host would immediately be told to abort turns an instant rejection into a
   * round trip.
   */
  openAbortChannel(signal: AbortSignal): {
    readonly subscriptionId: string;
    readonly release: () => void;
  };
  /** Host → child notification. */
  deliver(notification: HostApiNotification): NotificationOutcome;
  /**
   * The host is gone. Every registration is dropped WITHOUT notifying, because
   * there is no longer anyone to notify — the case that turns a release into a
   * write on a closed pipe.
   */
  hostGone(): number;
}

/**
 * Send one hostApi call and settle it the way an in-process call settles: a
 * value, or a throw whose identity survived the wire.
 *
 * Every child-side stub goes through this. A stub that built its own request
 * would be a second place the envelope is stamped, and the envelope is what the
 * host checks the generation against.
 */
export type HostApiCaller = (
  path: HostApiPath,
  args: readonly unknown[],
) => Promise<unknown>;

export function createHostApiCaller(
  channel: HostApiChannel,
  context: Pick<PluginChildContext, "pluginId" | "generationId">,
): HostApiCaller {
  let nextCallId = 0;
  return async (path, args) => {
    const nonJson = describeNonJson(args, `${path}(args)`);
    if (nonJson) {
      // Refused here rather than sent, so the plugin sees the failure at its own
      // call site with its own stack instead of a dispatcher rejection whose
      // stack points at the transport.
      throw new Error(
        `[plugin-child:${context.pluginId}] ${path}: argument cannot cross the boundary — ${nonJson}`,
      );
    }
    nextCallId += 1;
    const reply = await channel.call({
      wire: HOST_API_WIRE_VERSION,
      pluginId: context.pluginId,
      generationId: context.generationId,
      callId: `${context.pluginId}#${nextCallId}`,
      path,
      args,
    });
    if (reply.ok) return reply.value;
    throw reconstructWireError(reply.error);
  };
}

/**
 * Every member of the hostApi surface, present and throwing.
 *
 * Present, because a plugin reading `hostApi.getSecret` must find a function —
 * an absent member is a `TypeError` that says nothing about why. Throwing,
 * because a stub that resolved `undefined` would turn "not wired yet" into "no
 * secret", "no preference", "write succeeded". The nesting is derived from the
 * contract SOT, so a member added there appears here without a second edit.
 */
export function createChildHostApiStub(
  pluginId: string,
  member: (path: HostApiPath) => (...args: unknown[]) => unknown,
): PluginHostApi {
  const root: Record<string, unknown> = {};
  for (const path of Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]) {
    const segments = path.split(".");
    const leaf = segments.pop() as string;
    let cursor = root;
    for (const segment of segments) {
      cursor[segment] ??= {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[leaf] = member(path);
  }
  assertStubIsTotal(pluginId, root);
  // Backed by the assertion above: every declared member resolves to a
  // function, which is the only claim `PluginHostApi` makes structurally.
  return root as unknown as PluginHostApi;
}

/** The stub a member with no child-side implementation yet gets. */
export function unimplementedChildMember(
  pluginId: string,
  path: HostApiPath,
): (...args: unknown[]) => never {
  return () => {
    throw new Error(
      `[plugin-child:${pluginId}] hostApi.${path} is not wired to the boundary yet`,
    );
  };
}

function assertStubIsTotal(pluginId: string, root: Record<string, unknown>): void {
  for (const path of Object.keys(HOSTAPI_PATH_CONTRACTS)) {
    const resolved = path
      .split(".")
      .reduce<unknown>(
        (cursor, segment) =>
          cursor === null || typeof cursor !== "object"
            ? undefined
            : (cursor as Record<string, unknown>)[segment],
        root,
      );
    if (typeof resolved !== "function") {
      throw new Error(
        `[plugin-child:${pluginId}] hostApi stub is missing '${path}'`,
      );
    }
  }
}

/**
 * Stand the plugin up in this process and start serving.
 *
 * The tool delegate is the child's half of §3.5: a result that would not survive
 * JSON is refused HERE, at the plugin that produced it, rather than arriving at
 * the host as a shape the host cannot explain. `LoopbackTransport` refuses the
 * same shapes on the in-process arm; refusing them here too means a plugin gets
 * one answer about its own return value rather than one answer per transport.
 */
export async function startPluginChildRuntime(
  options: PluginChildRuntimeOptions,
): Promise<PluginChildRuntime> {
  const { manifest, context, channel } = options;
  const { pluginId } = context;

  const subscriptions = new SubscriptionLedger<ChildSubscription>(
    `plugin-child:${pluginId}`,
  );
  // A second instance of the SAME primitive, not a second primitive: an abort
  // channel is a registration with a different teardown, and keeping it in its
  // own ledger stops an abort id colliding with a subscription id.
  const abortChannels = new SubscriptionLedger<{ readonly detach: () => void }>(
    `plugin-child:${pluginId}:abort`,
  );
  const log = (message: string, meta?: unknown): void => {
    channel.notify({
      wire: HOST_API_WIRE_VERSION,
      pluginId,
      generationId: context.generationId,
      kind: "log",
      message,
      meta,
    });
  };
  const releaseChildSubscription: SubscriptionRelease<ChildSubscription> = (
    subscription,
    reason,
    subscriptionId,
  ) => {
    // A host revocation is the one close the MEMBER has to act on: the ledger
    // dropping the entry releases the handler, but not whatever the stub closed
    // over on the plugin's behalf.
    if (reason === "revoked") subscription.onRevoked?.();
    // Only a child-initiated dispose owes the host a message. `revoked` came
    // FROM the host and `peer-gone` means there is no host to tell.
    if (reason !== "disposed") return;
    channel.notify({
      wire: HOST_API_WIRE_VERSION,
      pluginId,
      generationId: context.generationId,
      kind: "subscription-release",
      subscriptionId,
    });
  };
  const openSubscription = (
    path: HostApiPath,
    handler: (payload: unknown) => void,
  ) => {
    const subscriptionId = subscriptions.open(
      { path, handler },
      releaseChildSubscription,
    );
    return {
      subscriptionId,
      dispose: () => {
        subscriptions.close(subscriptionId, "disposed");
      },
    };
  };
  const adoptSubscription = (
    path: HostApiPath,
    subscriptionId: string,
    handler: (payload: unknown) => void,
    onRevoked?: () => void,
  ) => {
    subscriptions.adopt(
      subscriptionId,
      { path, handler, ...(onRevoked ? { onRevoked } : {}) },
      releaseChildSubscription,
    );
    return () => {
      subscriptions.close(subscriptionId, "disposed");
    };
  };
  const openAbortChannel = (signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason;
    let subscriptionId = "";
    const onAbort = () => {
      channel.notify({
        wire: HOST_API_WIRE_VERSION,
        pluginId,
        generationId: context.generationId,
        kind: "abort",
        subscriptionId,
      });
      abortChannels.close(subscriptionId, "disposed");
    };
    subscriptionId = abortChannels.open(
      { detach: () => signal.removeEventListener("abort", onAbort) },
      (entry) => entry.detach(),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    return {
      subscriptionId,
      release: () => {
        abortChannels.close(subscriptionId, "disposed");
      },
    };
  };
  const caller = createHostApiCaller(channel, context);
  /**
   * The child's copy of the resolved config.
   *
   * Seeded from the construction push and never re-read from `context`, so
   * `config.get` answers from one place. `ctx.config` keeps pointing at the
   * construction object the in-process contract gives it — a plugin that
   * captured it sees exactly what it sees today.
   */
  const config: Record<string, unknown> = { ...(context.config ?? {}) };
  /**
   * The child's copy of the installed-plugin set, and the member that reads it.
   *
   * It lives here rather than in one of the four bound groups because it
   * belongs to none of them: there is no host handler to bind: the contract
   * says `child-local`, and the dispatcher REFUSES the path if it is ever sent.
   * A group factory for a member with no dispatched half would be a factory
   * that binds nothing.
   *
   * A COPY is returned per call. Handing out the array itself would let a
   * plugin mutate the snapshot the next `getInstalledPluginIds` reads, which
   * the in-process member — a fresh array from the registry each time — cannot
   * do.
   */
  let installedPluginIds: readonly string[] = [...context.installedPluginIds];
  /**
   * The child's copy of the allow-listed host preferences, or `undefined` when
   * this host publishes none.
   *
   * MUTATED IN PLACE by `preference-snapshot`, never rebound, for the same
   * reason `config` is: the member below closes over it.
   */
  const appPreferences: Record<string, unknown> | undefined = context.appPreferences
    ? { ...context.appPreferences.values }
    : undefined;
  /**
   * The wired members, composed group by group. One spread per group keeps four
   * parallel authors out of each other's lines; a member no group claims still
   * throws rather than resolving `undefined`.
   */
  const members: Partial<Record<HostApiPath, (...args: unknown[]) => unknown>> = {
    ...createInteractionChildMembers(caller),
    ...createServiceChildMembers({
      pluginId,
      manifest,
      call: caller,
      openAbortChannel,
      adoptSubscription,
      report: log,
    }),
    ...createConfigSubscriptionChildMembers({
      pluginId,
      call: caller,
      openSubscription,
      config,
      report: log,
    }),
    ...createStorageChildMembers(caller, context),
    getInstalledPluginIds: () => [...installedPluginIds],
    /**
     * `getAppPreference`, answered from the host-pushed preference snapshot.
     *
     * It used to be the one member with no child half, and the reason was
     * sound: §3.1 answers a synchronous member from a snapshot, a snapshot is
     * only correct while something re-pushes it, and `hostApi` had no
     * preference-change signal to re-push from — so the member would have
     * answered with the value the preference held when the plugin started,
     * forever. `ms-graph` reads `webView.preferredFlow` at CALL time, so that
     * is precisely the wrong answer it would have received.
     *
     * The missing half is now `subscribeAppPreferenceChange`
     * (`plugins/config-change-bus.ts`), which the host end of every child
     * subscribes to; each announcement re-pushes this snapshot, and the host
     * pushes once more as soon as the construct reply lands so the value read
     * for the construct params cannot be left behind by a change that raced it
     * (`out-of-process-plugin.ts`).
     *
     * A key OFF the host allowlist answers `undefined`, which is what the
     * in-process reader answers for it too — the allowlist is `keys`, and a
     * denied key is simply not in the snapshot. The one thing the child cannot
     * reproduce is the host reader's warn-once-per-denied-key line, which is
     * host-side observability and not part of the answer.
     *
     * NOT AN ANSWER THE HOST CAN MAKE: this member throwing when nothing was
     * seeded. `host-api-factory.ts` always defines `getAppPreference`, so every
     * child the app builds is seeded; the throw exists because the member is
     * OPTIONAL on `PluginHostApi` and a partial hostApi can therefore omit it.
     */
    getAppPreference: (...args) => {
      if (!appPreferences) {
        throw new Error(
          `[plugin-child:${pluginId}] hostApi.getAppPreference: this host published no `
            + `preference snapshot, so 'unset' and 'unavailable' cannot be told apart`,
        );
      }
      const key = args[0];
      // `Object.hasOwn`, not a bare index. The snapshot is a plain object, so
      // `appPreferences["toString"]` would answer with `Object.prototype`'s
      // member — a FUNCTION where the host reader, which tests the key against
      // the allowlist, answers `undefined`. Non-string keys answer `undefined`
      // for the same reason: no allow-listed key can be reached by one, so the
      // two ends agree on the value.
      return typeof key === "string" && Object.hasOwn(appPreferences, key)
        ? appPreferences[key]
        : undefined;
    },
  };
  const hostApi = createChildHostApiStub(
    pluginId,
    (path) => members[path] ?? unimplementedChildMember(pluginId, path),
  );

  const runtimeContext: PluginRuntimeContext = {
    pluginId,
    pluginRoot: context.pluginRoot,
    hostRoot: context.hostRoot,
    pluginDataDir: context.pluginDataDir,
    config: context.config,
    log,
    hostApi,
  };

  const factory = await options.loadFactory(manifest);
  if (!factory) {
    throw new Error(
      `[plugin-child:${pluginId}] entry '${manifest.entry}' exports no plugin factory`,
    );
  }
  const instance = await factory(runtimeContext);

  const delegate: PluginToolDelegate = async (name, args) => {
    const handler = instance.handlers[name];
    if (!handler) {
      throw new Error(`[plugin-child:${pluginId}] tool '${name}' has no handler`);
    }
    // `{}` becomes NO payload, which is the convention the in-process delegate
    // already applies (`plugin-runtime-delegate.ts`) because some plugins
    // distinguish an absent payload from an empty object. MCP has no way to
    // carry "absent" — `tools/call` params are an object — so the two arms have
    // to agree on where the conversion happens, and this is that place on the
    // isolated arm.
    const value = await handler(Object.keys(args).length > 0 ? args : undefined);
    const nonJson = describeNonJson(value, `${name}(result)`);
    if (nonJson) {
      throw new Error(
        `[plugin-child:${pluginId}] tool '${name}' returned a value the boundary cannot carry — ${nonJson}`,
      );
    }
    return {
      content: [
        {
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value ?? null),
        },
      ],
      // The text branch is LOSSY and cannot be the only carrier: a plugin
      // returning the string `'{"a":1}'` and one returning the object `{a:1}`
      // produce identical text, so a host reading only `content[0].text` would
      // have to guess which it was. `_meta` carries the value itself — the same
      // key, for the same reason, as the in-process delegate. It is safe to put
      // here because `describeNonJson` above has already proven it survives.
      _meta: { [RAW_RESULT_META]: value },
    };
  };

  const server = new PluginMcpServer(manifest, delegate, options.uiResources);
  new StdioServerLoop(options.input, options.output, server).start();

  return {
    instance,
    hostApi,
    get openSubscriptionCount() {
      return subscriptions.openCount;
    },
    openSubscription,
    adoptSubscription,
    openAbortChannel,
    deliver(notification) {
      if (notification.kind === "installed-plugins") {
        installedPluginIds = [...notification.pluginIds];
        return "delivered";
      }
      if (notification.kind === "config-snapshot") {
        // MUTATED IN PLACE, never rebound: `createConfigSubscriptionChildMembers`
        // captured this object, so a fresh one would leave `config.get` reading
        // the record the construction push seeded and nothing would report it.
        //
        // Only the keys the push ENUMERATES are touched. A key the plugin set
        // itself and the host cannot enumerate keeps the value the child wrote
        // when its own `config.set` resolved, instead of being erased by a
        // snapshot that never knew about it.
        for (const key of notification.keys) {
          if (Object.hasOwn(notification.values, key)) {
            config[key] = notification.values[key];
          } else {
            // Absent from `values` means unset, which is what `config.get`
            // answers `undefined` for. Deleted rather than assigned
            // `undefined` so `Object.keys(config)` stays the truth.
            delete config[key];
          }
        }
        return "delivered";
      }
      if (notification.kind === "preference-snapshot") {
        // Reported as a DROP through the outcome the union already has for
        // "this named something I do not hold". A host that pushes preferences
        // to a child it never seeded would otherwise leave `getAppPreference`
        // throwing while the pushes looked like they landed: the member reads
        // the seeded object, and there is no seeded object to move.
        //
        // The production host cannot reach it — `out-of-process-plugin.ts`
        // pushes only when it seeded, and it always seeds because
        // `host-api-factory.ts` always implements the reader. It is the same
        // defensive pair as the member's throw above, kept because the two
        // halves are wired by separate objects in tests.
        if (!appPreferences) return "unknown-subscription";
        // MUTATED IN PLACE for the same reason `config-snapshot` is: the member
        // above captured this object.
        for (const key of notification.keys) {
          if (Object.hasOwn(notification.values, key)) {
            appPreferences[key] = notification.values[key];
          } else {
            // Absent from `values` means unset, which is what the reader
            // answers `undefined` for. `delete` rather than assigning
            // `undefined` mirrors the `config-snapshot` handler above; through
            // this member the two are indistinguishable, so this is hygiene
            // rather than a behaviour anything can observe.
            delete appPreferences[key];
          }
        }
        return "delivered";
      }
      if (notification.kind === "subscription-closed") {
        return subscriptions.close(notification.subscriptionId, notification.reason)
          ? "closed"
          : "unknown-subscription";
      }
      if (notification.kind !== "subscription-event") return "unknown-subscription";
      const subscription = subscriptions.get(notification.subscriptionId);
      if (!subscription) return "unknown-subscription";
      subscription.handler(notification.payload);
      return "delivered";
    },
    hostGone() {
      return subscriptions.end("peer-gone") + abortChannels.end("peer-gone");
    },
  };
}
