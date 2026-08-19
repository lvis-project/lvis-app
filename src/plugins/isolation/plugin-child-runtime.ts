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
import type {
  PluginHostApi,
  PluginManifest,
  PluginRuntimeContext,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
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
}

/** How the child obtains the plugin's factory export. */
export type PluginFactoryLoader = (
  manifest: PluginManifest,
) => Promise<RuntimePluginFactory | undefined>;

/** One child-side registration: the plugin's callback and the member it serves. */
interface ChildSubscription {
  readonly path: HostApiPath;
  readonly handler: (payload: unknown) => void;
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
  const hostApi = createChildHostApiStub(pluginId, (path) =>
    unimplementedChildMember(pluginId, path),
  );

  const runtimeContext: PluginRuntimeContext = {
    pluginId,
    pluginRoot: context.pluginRoot,
    hostRoot: context.hostRoot,
    pluginDataDir: context.pluginDataDir,
    config: context.config,
    log: (message, meta) => {
      channel.notify({
        wire: HOST_API_WIRE_VERSION,
        pluginId,
        generationId: context.generationId,
        kind: "log",
        message,
        meta,
      });
    },
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
    const value = await handler(args);
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
    };
  };

  const server = new PluginMcpServer(manifest, delegate, options.uiResources);
  new StdioServerLoop(options.input, options.output, server).start();

  const releaseChildSubscription: SubscriptionRelease<ChildSubscription> = (
    _subscription,
    reason,
    subscriptionId,
  ) => {
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

  return {
    instance,
    hostApi,
    get openSubscriptionCount() {
      return subscriptions.openCount;
    },
    openSubscription(path, handler) {
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
    },
    openAbortChannel(signal) {
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
    },
    deliver(notification) {
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
