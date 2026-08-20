/**
 * The host end of the reverse channel: one message off the wire becomes one
 * hostApi call, or a loud refusal
 * (`docs/blueprints/plugin-process-isolation.md` §2.2, §3).
 *
 * Everything the plugin can reach becomes a message the host services here.
 * `instrumentEffectsByPath` stops being "a wrapper we hope is total, guarded by
 * a completeness test" and becomes the only way in — but only if this file
 * refuses everything it does not recognise. So every failure mode below is a
 * throw with a code, never a default value and never a silent skip:
 *
 *   - a member with no handler yet          → `path-not-implemented`
 *   - a member the child should have answered locally → `path-not-dispatchable`
 *   - a member that does not exist          → `path-unknown`
 *   - a stale generation or a foreign plugin id → refused before dispatch
 *   - arguments or a result that would not survive JSON → refused, not coerced
 *
 * That last one applies `describeNonJson` — the same predicate
 * `LoopbackTransport` now uses on the host→plugin direction — to the direction
 * that transport does not carry. hostApi traffic never passes through it, so
 * without this check the reverse channel would be exactly the boundary §3.6
 * describes: one that looks like a wire and passes object references.
 *
 * HOST-SIDE ONLY. This imports the real host error classes to classify a throw
 * by identity rather than by matching its message; several of them reach
 * Electron through the approval gate, which is exactly why the child imports
 * `host-api-wire.ts` instead of this file.
 */
import { describeNonJson } from "../../shared/json-representable.js";
import { EffectBoundaryDeniedError } from "../../permissions/effect-enforcement.js";
import { ManifestIntegrityError } from "../../permissions/manifest-integrity.js";
import { PluginRuntimeDetachedOperationError } from "../runtime/detached-operation.js";
import {
  PluginStorageEncryptionUnavailableError,
  PluginStorageError,
} from "../public-contract.js";
import {
  HOST_API_WIRE_VERSION,
  HostApiBoundaryError,
  inactiveHostApiMessage,
  type ChildNotificationSink,
  type HostApiHandle,
  type HostApiNotification,
  type HostApiPathContract,
  type HostApiReply,
  type HostApiRequest,
  type HostApiWireError,
  type SubscriptionCloseReason,
} from "./host-api-wire.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  isHostApiPath,
  type ContractOf,
  type HostApiPath,
} from "./host-api-path-contracts.js";
import { SubscriptionLedger } from "./subscription-ledger.js";

/** One inbound invocation, after the envelope has been checked. */
export interface HostApiCall {
  readonly path: HostApiPath;
  readonly callId: string;
  readonly pluginId: string;
  readonly generationId: string;
  /** Positional arguments as they arrived — already JSON, marshalled per contract. */
  readonly args: readonly unknown[];
}

/** A live host-side registration, held for as long as the child holds its side. */
export interface HostSubscription {
  readonly path: HostApiPath;
  /** Undo the host-side registration. Runs exactly once. */
  readonly teardown: (reason: SubscriptionCloseReason) => void;
  /**
   * Whether the CHILD holds a matching registration a host-side revocation has
   * to reach.
   *
   * True for the registrations a member handed the plugin something for — a
   * subscription's handler, a worker handle, a key lease. False for an abort
   * channel: the id is the child's, but what is registered here is the host's
   * own `AbortController`, and telling the child that the controller behind a
   * settled call was disposed would be a message about host bookkeeping it has
   * no entry for.
   */
  readonly notifiesChild: boolean;
}

/**
 * What a lifetime-bearing handler is handed so it does not have to invent its
 * own bookkeeping. Six members need this; six implementations of it would be six
 * chances to leak.
 */
export interface SubscriptionScope {
  /** Register under the id the CHILD allocated (subscriptions). */
  adopt(subscriptionId: string, teardown: (reason: SubscriptionCloseReason) => void): void;
  /** Register under a host-allocated id and return it (worker handles, key leases). */
  open(teardown: (reason: SubscriptionCloseReason) => void): string;
  /** Push a payload to the child's handler for this registration. */
  deliver(subscriptionId: string, payload: unknown): void;
  /**
   * End one registration from the host side. A handler calls this when the work
   * it was tracking is over — the settled call behind an abort channel, the
   * exited worker behind a handle, a lease the host is taking back.
   *
   * Closes as `revoked`, which is the reason that reaches the child: a host
   * decision is the only one of the three the child cannot already know about.
   * That is what makes a lease the host drops stop being spendable in the
   * child, instead of a comment claiming it does.
   */
  release(subscriptionId: string): boolean;
  /**
   * The host end of an abort channel: the child sends an id where an
   * `AbortSignal` would have been, and the host holds the controller.
   *
   * Registered in the SAME ledger as every other lifetime, which is what makes
   * "the child died" abort the work in flight for it rather than leaving the
   * host fetching on behalf of a process that no longer exists. Three members
   * take a signal; without this each of their handlers would keep its own map.
   */
  abortChannel(subscriptionId: string): AbortSignal;
}

/** What a handler may resolve with, derived from its declared `result` axis. */
type WireResultFor<C extends HostApiPathContract> = C["result"] extends "void"
  ? void
  : C["result"] extends "handle"
    ? HostApiHandle
    : C["result"] extends "child-local"
      ? never
      : unknown;

/**
 * The invoke signature a handler must have, DERIVED from its contract — which
 * is what stops four authors writing four differently-shaped handlers. A
 * `lifetime: "none"` member is not given a subscription scope it would have no
 * use for; a lifetime-bearing one cannot forget to take it.
 */
export type HostApiPathInvoke<C extends HostApiPathContract> =
  C["lifetime"] extends "none"
    ? (call: HostApiCall) => Promise<WireResultFor<C>>
    : (call: HostApiCall, scope: SubscriptionScope) => Promise<WireResultFor<C>>;

/** How complete one table entry is. Read by the contract test, not by the wire. */
export type HostApiPathStatus = "implemented" | "unimplemented" | "child-local";

/** One entry of the dispatch table. */
export interface HostApiPathHandler {
  readonly path: HostApiPath;
  readonly contract: HostApiPathContract;
  readonly status: HostApiPathStatus;
  invoke(call: HostApiCall, scope: SubscriptionScope): Promise<unknown>;
}

/**
 * Declare a handler for one member. The contract comes from the shared SOT, so
 * the handler cannot claim a marshalling the child does not expect, and
 * `invoke`'s signature is derived from that contract.
 */
export function defineHostApiPath<P extends HostApiPath>(
  path: P,
  invoke: HostApiPathInvoke<ContractOf<P>>,
): HostApiPathHandler {
  return {
    path,
    contract: HOSTAPI_PATH_CONTRACTS[path],
    status: "implemented",
    invoke: invoke as HostApiPathHandler["invoke"],
  };
}

/**
 * A member whose handler has not been written yet.
 *
 * It THROWS. A stub that resolved `undefined` would let a plugin read a missing
 * secret as "no secret", a missing preference as "unset", and a failed write as
 * a success — three silent wrong answers that no test would catch, because the
 * call succeeded.
 */
export function unimplementedHostApiPath(path: HostApiPath): HostApiPathHandler {
  return {
    path,
    contract: HOSTAPI_PATH_CONTRACTS[path],
    status: "unimplemented",
    invoke: () =>
      Promise.reject(
        new HostApiBoundaryError(
          "path-not-implemented",
          `[host-api-dispatcher] '${path}' has no handler`,
          { path },
        ),
      ),
  };
}

/** The members whose contract says the child answers without a round trip. */
type ChildLocalPath = {
  [P in HostApiPath]: ContractOf<P>["result"] extends "child-local" ? P : never;
}[HostApiPath];

/**
 * A member the child answers locally — from a pure computation or a host-pushed
 * snapshot. A request for one means the child stub is wrong, so it is refused
 * rather than serviced: servicing it would hide the divergence and make the
 * round-trip-free decision untrue in a way nothing would report.
 */
export function childLocalHostApiPath(path: ChildLocalPath): HostApiPathHandler {
  return {
    path,
    contract: HOSTAPI_PATH_CONTRACTS[path],
    status: "child-local",
    invoke: () =>
      Promise.reject(
        new HostApiBoundaryError(
          "path-not-dispatchable",
          `[host-api-dispatcher] '${path}' is answered in the child and must never be sent`,
          { path },
        ),
      ),
  };
}

/**
 * Every member, and who answers it.
 *
 * `Record<HostApiPath, …>` makes a MISSING member a compile error — a member
 * added to the contract SOT without an entry here cannot reach a build. The
 * other direction (a member in the effect SOT with no contract) is pinned by
 * the contract test.
 *
 * Filling one in is a one-line change: replace `unimplementedHostApiPath("x")`
 * with `defineHostApiPath("x", async (call) => …)`.
 */
export const HOSTAPI_DISPATCH_TABLE: Record<HostApiPath, HostApiPathHandler> = {
  "storage.resolve": childLocalHostApiPath("storage.resolve"),
  "storage.read": unimplementedHostApiPath("storage.read"),
  "storage.readText": unimplementedHostApiPath("storage.readText"),
  "storage.readJson": unimplementedHostApiPath("storage.readJson"),
  "storage.list": unimplementedHostApiPath("storage.list"),
  "storage.exists": unimplementedHostApiPath("storage.exists"),
  "storage.write": unimplementedHostApiPath("storage.write"),
  "storage.writeJson": unimplementedHostApiPath("storage.writeJson"),
  "storage.rm": unimplementedHostApiPath("storage.rm"),
  "storage.mkdir": unimplementedHostApiPath("storage.mkdir"),
  "storage.writeEncrypted": unimplementedHostApiPath("storage.writeEncrypted"),
  "storage.readEncrypted": unimplementedHostApiPath("storage.readEncrypted"),
  "config.get": childLocalHostApiPath("config.get"),
  "config.set": unimplementedHostApiPath("config.set"),
  "config.onChange": unimplementedHostApiPath("config.onChange"),
  getSecret: unimplementedHostApiPath("getSecret"),
  getInstalledPluginIds: childLocalHostApiPath("getInstalledPluginIds"),
  hasRoutineBySource: unimplementedHostApiPath("hasRoutineBySource"),
  getAppPreference: childLocalHostApiPath("getAppPreference"),
  probePrivateHost: unimplementedHostApiPath("probePrivateHost"),
  resolveApiKey: unimplementedHostApiPath("resolveApiKey"),
  emitEvent: unimplementedHostApiPath("emitEvent"),
  onEvent: unimplementedHostApiPath("onEvent"),
  onPluginsChanged: unimplementedHostApiPath("onPluginsChanged"),
  onShutdown: unimplementedHostApiPath("onShutdown"),
  logEvent: unimplementedHostApiPath("logEvent"),
  callLlm: unimplementedHostApiPath("callLlm"),
  hostFetch: unimplementedHostApiPath("hostFetch"),
  spawnWorker: unimplementedHostApiPath("spawnWorker"),
  openExternalUrl: unimplementedHostApiPath("openExternalUrl"),
  openAuthWindow: unimplementedHostApiPath("openAuthWindow"),
  openAuthPartitionViewer: unimplementedHostApiPath("openAuthPartitionViewer"),
  clearAuthPartition: unimplementedHostApiPath("clearAuthPartition"),
  triggerConversation: unimplementedHostApiPath("triggerConversation"),
  "agentApproval.request": unimplementedHostApiPath("agentApproval.request"),
  "agentApproval.respond": unimplementedHostApiPath("agentApproval.respond"),
};

/**
 * Turn a thrown host error into the identity that crosses.
 *
 * By CLASS, never by message. The host distinguishes several of these by
 * identity today; a wire drops an `Error` to `{ message, stack }`, so the
 * identity has to be named explicitly on the way out or it is gone.
 */
export function classifyHostApiError(error: unknown): HostApiWireError {
  if (error instanceof HostApiBoundaryError) {
    return {
      code: error.code,
      name: error.name,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
    };
  }
  if (error instanceof EffectBoundaryDeniedError) {
    return {
      code: "effect-boundary-denied",
      name: error.name,
      message: error.message,
      detail: {
        pluginId: error.pluginId,
        methodPath: error.methodPath,
        target: error.target ?? null,
        reason: error.reason,
      },
    };
  }
  if (error instanceof ManifestIntegrityError) {
    return {
      code: "manifest-integrity-violation",
      name: error.name,
      message: error.message,
      detail: {
        pluginId: error.pluginId,
        toolName: error.toolName,
        attemptedMethod: error.attemptedMethod,
      },
    };
  }
  if (error instanceof PluginRuntimeDetachedOperationError) {
    // `settlement` is a live promise and stays host-side; the child learns the
    // call was detached, which is all it can act on.
    return {
      code: "detached-operation",
      name: error.name,
      message: error.message,
    };
  }
  if (error instanceof PluginStorageEncryptionUnavailableError) {
    return {
      code: "plugin-storage-encryption-unavailable",
      name: error.name,
      message: error.message,
      detail: { pluginId: error.pluginId },
    };
  }
  if (error instanceof PluginStorageError) {
    return {
      code: "plugin-storage",
      name: error.name,
      message: error.message,
      detail: { pluginId: error.pluginId, attemptedPath: error.attemptedPath },
    };
  }
  return {
    code: "host-internal",
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export interface HostApiDispatcherOptions {
  readonly pluginId: string;
  /** The incarnation the child was told to serve. A mismatch is refused. */
  readonly generationId: string;
  /**
   * The host-side liveness check the in-process `enforceActiveHostApi` proxy
   * performs today. Strictly stronger here: the child cannot reach around it,
   * because it is on the other side of a pipe.
   */
  readonly isActive: () => boolean;
  /** Where host-originated notifications go. */
  readonly notifications: ChildNotificationSink;
  /** Injectable so a handler can be exercised without the whole table. */
  readonly table?: Record<HostApiPath, HostApiPathHandler>;
}

/** Services one child's reverse channel for the life of one plugin incarnation. */
export class HostApiDispatcher {
  private readonly table: Record<HostApiPath, HostApiPathHandler>;
  private readonly subscriptions = new SubscriptionLedger<HostSubscription>(
    "host-api-dispatcher",
  );

  constructor(private readonly options: HostApiDispatcherOptions) {
    this.table = options.table ?? HOSTAPI_DISPATCH_TABLE;
  }

  /** Live host-side registrations. Zero after {@link childGone}. */
  get openSubscriptionCount(): number {
    return this.subscriptions.openCount;
  }

  async handle(request: HostApiRequest): Promise<HostApiReply> {
    const callId = typeof request.callId === "string" ? request.callId : "";
    try {
      const handler = this.resolve(request);
      const call: HostApiCall = {
        path: handler.path,
        callId,
        pluginId: request.pluginId,
        generationId: request.generationId,
        args: request.args,
      };
      const value = await handler.invoke(call, this.scopeFor(handler.path));
      return {
        wire: HOST_API_WIRE_VERSION,
        callId,
        ok: true,
        value: this.checkResult(handler, value),
      };
    } catch (error) {
      return {
        wire: HOST_API_WIRE_VERSION,
        callId,
        ok: false,
        error: classifyHostApiError(error),
      };
    }
  }

  /**
   * Child → host notifications. Both of the ones the boundary itself owns end a
   * registration, and both go through the same ledger — an abort is not a
   * second mechanism, it is a close whose teardown happens to cancel.
   */
  handleNotification(notification: HostApiNotification): void {
    if (notification.kind === "subscription-release") {
      // `disposed` rather than `peer-gone`: the child is alive and has already
      // dropped its side, so the host teardown must not send anything back.
      this.subscriptions.close(notification.subscriptionId, "disposed");
      return;
    }
    if (notification.kind === "abort") {
      // Only an abort channel may be closed this way. The two registration
      // kinds share one ledger, so without this an `abort` naming a
      // subscription id would cancel a worker handle or a key lease through the
      // cancellation mechanism — and, now that a host-side close is a message,
      // would bounce a `subscription-closed` back at the child that asked for
      // it. An id that names no abort channel is left alone.
      if (this.subscriptions.get(notification.subscriptionId)?.notifiesChild !== false) {
        return;
      }
      this.subscriptions.close(notification.subscriptionId, "revoked");
    }
  }

  /**
   * The child is gone. Every host-side registration it opened is released,
   * including the ones it never disposed — case 2 of the four ways a two-sided
   * lifetime ends.
   */
  childGone(): number {
    return this.subscriptions.end("peer-gone");
  }

  private resolve(request: HostApiRequest): HostApiPathHandler {
    if (request.wire !== HOST_API_WIRE_VERSION) {
      throw new HostApiBoundaryError(
        "wire-version-mismatch",
        `[host-api-dispatcher] wire ${String(request.wire)} != ${HOST_API_WIRE_VERSION}`,
      );
    }
    if (request.pluginId !== this.options.pluginId) {
      throw new HostApiBoundaryError(
        "plugin-mismatch",
        `[host-api-dispatcher] request names plugin '${String(request.pluginId)}'`,
      );
    }
    if (request.generationId !== this.options.generationId) {
      throw new HostApiBoundaryError(
        "generation-mismatch",
        `[host-api-dispatcher] request names generation '${String(request.generationId)}'`,
      );
    }
    if (!isHostApiPath(request.path)) {
      throw new HostApiBoundaryError(
        "path-unknown",
        `[host-api-dispatcher] '${String(request.path)}' is not a hostApi member`,
      );
    }
    if (!this.options.isActive()) {
      throw new HostApiBoundaryError(
        "plugin-inactive",
        inactiveHostApiMessage(this.options.pluginId, `hostApi.${request.path}`),
      );
    }
    if (!Array.isArray(request.args)) {
      throw new HostApiBoundaryError(
        "argument-marshalling-rejected",
        `[host-api-dispatcher] '${request.path}': args is not an array`,
      );
    }
    const nonJson = describeNonJson(request.args, `${request.path}(args)`);
    if (nonJson) {
      throw new HostApiBoundaryError(
        "argument-marshalling-rejected",
        `[host-api-dispatcher] ${nonJson}`,
      );
    }
    return this.table[request.path];
  }

  /**
   * Everything leaving here has to be a JSON value, whatever the contract's
   * `result` axis calls it — `encoded` and `handle` are JSON bodies too. `void`
   * and `handle` additionally have a pinned SHAPE, so a handler cannot quietly
   * return a payload the child's stub will not understand.
   */
  private checkResult(handler: HostApiPathHandler, value: unknown): unknown {
    const { result } = handler.contract;
    if (result === "void") {
      if (value !== undefined) {
        throw new HostApiBoundaryError(
          "result-marshalling-rejected",
          `[host-api-dispatcher] '${handler.path}' declares no result but returned one`,
        );
      }
      return undefined;
    }
    if (result === "handle" && !isHandle(value)) {
      throw new HostApiBoundaryError(
        "result-marshalling-rejected",
        `[host-api-dispatcher] '${handler.path}' must resolve { handleId: string }`,
      );
    }
    const nonJson = describeNonJson(value, `${handler.path}(result)`);
    if (nonJson) {
      throw new HostApiBoundaryError(
        "result-marshalling-rejected",
        `[host-api-dispatcher] ${nonJson}`,
      );
    }
    return value;
  }

  private scopeFor(path: HostApiPath): SubscriptionScope {
    const envelope = {
      wire: HOST_API_WIRE_VERSION,
      pluginId: this.options.pluginId,
      generationId: this.options.generationId,
    } as const;
    /**
     * The one place a host-side close becomes a message to the child.
     *
     * `subscription-closed` was a notification the child could RECEIVE and
     * nothing could SEND, which made the child stubs that act on it — the key
     * lease dropping its copy, a handle letting go of its listeners — controls
     * that only looked like controls. It belongs here rather than in the six
     * lifetime-bearing handlers because this is where the envelope already is,
     * and six senders would be six chances to send the wrong reason.
     *
     * Exactly one reason crosses. `disposed` came FROM the child, so echoing it
     * is a ping-pong; `peer-gone` means the pipe is already closed, so sending
     * is a write on it. `revoked` is the host's own decision and is the only
     * one the child cannot otherwise learn.
     */
    const release = (
      subscription: HostSubscription,
      reason: SubscriptionCloseReason,
      subscriptionId: string,
    ) => {
      subscription.teardown(reason);
      if (reason !== "revoked" || !subscription.notifiesChild) return;
      this.options.notifications.deliver({
        ...envelope,
        kind: "subscription-closed",
        subscriptionId,
        reason,
      });
    };
    return {
      adopt: (subscriptionId, teardown) => {
        this.subscriptions.adopt(
          subscriptionId,
          { path, teardown, notifiesChild: true },
          release,
        );
      },
      open: (teardown) =>
        this.subscriptions.open({ path, teardown, notifiesChild: true }, release),
      release: (subscriptionId) => this.subscriptions.close(subscriptionId, "revoked"),
      abortChannel: (subscriptionId) => {
        const controller = new AbortController();
        this.subscriptions.adopt(
          subscriptionId,
          {
            path,
            notifiesChild: false,
            // Aborting on EVERY reason is deliberate. `revoked` is the child
            // asking for it; `peer-gone` is the child dying, and work started
            // for a dead child has no one to return to; `disposed` is the call
            // settling, where abort is a no-op. Distinguishing them would add a
            // branch whose only effect is to leave one case un-cancelled.
            teardown: (reason) =>
              controller.abort(
                new HostApiBoundaryError(
                  "subscription-unknown",
                  `[host-api-dispatcher] '${path}' aborted: ${reason}`,
                ),
              ),
          },
          release,
        );
        return controller.signal;
      },
      deliver: (subscriptionId, payload) => {
        if (!this.subscriptions.get(subscriptionId)) {
          throw new HostApiBoundaryError(
            "subscription-unknown",
            `[host-api-dispatcher] no open subscription '${subscriptionId}'`,
          );
        }
        this.options.notifications.deliver({
          ...envelope,
          kind: "subscription-event",
          subscriptionId,
          payload,
        });
      },
    };
  }
}

function isHandle(value: unknown): value is HostApiHandle {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as HostApiHandle).handleId === "string"
  );
}
