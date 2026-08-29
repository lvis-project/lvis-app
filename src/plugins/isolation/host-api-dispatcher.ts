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
 * ONE MODULE BECAUSE IT IS ONE TABLE. `HOSTAPI_DISPATCH_TABLE` names every
 * member of the contract SOT exactly once, and the handler factories below fill
 * entries in it. The factories used to sit in four sibling files split by
 * category — interaction, service, storage, config-and-subscription — but the
 * categories were a filing label, not a boundary: all four build
 * `HostApiPathHandler`s out of {@link defineHostApiPath}, all four are spread
 * over this one table in a single expression in `out-of-process-plugin.ts`, and
 * nothing else imports any of them. The split that IS real is host vs child,
 * because it is two processes.
 *
 * HOST-SIDE ONLY. This imports the real host error classes to classify a throw
 * by identity rather than by matching its message; several of them reach
 * Electron through the approval gate, which is exactly why the child imports
 * `host-api-wire.ts` instead of this file.
 */
import { isAbsolute } from "node:path";
import { describeNonJson } from "../../shared/json-representable.js";
import { EffectBoundaryDeniedError } from "../../permissions/effect-enforcement.js";
import { ManifestIntegrityError } from "../../permissions/manifest-integrity.js";
import { PluginRuntimeDetachedOperationError } from "../runtime/detached-operation.js";
import {
  PluginStorageEncryptionUnavailableError,
  PluginStorageError,
  type ApprovalChoice,
  type ConversationTriggerSpec,
  type PluginHostApi,
  type PluginWorkerSpec,
  type StorageEncoding,
  type AttachFloatingPanelRequest,
  type AudioCaptureRequest,
} from "../public-contract.js";
import { isResolvedPathWithin } from "../plugin-storage-containment.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  HOST_API_WIRE_VERSION,
  HostApiBoundaryError,
  decodeWireBytes,
  decodeWireRequestInit,
  encodeConfigChange,
  encodeWireBytes,
  encodeWireHttpResponse,
  inactiveHostApiMessage,
  isHostApiPath,
  type ChildNotificationSink,
  type ContractOf,
  type DispatchedConfigSubscriptionPath,
  type DispatchedStorageHostApiPath,
  type HostApiHandle,
  type HostApiNotification,
  type HostApiPath,
  type HostApiPathContract,
  type HostApiReply,
  type HostApiRequest,
  type HostApiWireError,
  type InteractionHostApiPath,
  type ServiceHostApiPath,
  type SubscriptionCloseReason,
  type WireApiKeyLease,
  type WireCallLlmOptions,
  type WireHttpResponse,
  type WireResolveApiKeyOptions,
  type WireWorkerHandle,
  type WireAudioCaptureEvent,
  type WireFloatingPanelEvent,
  type WireFloatingPanelHandle,
  type WireAudioCaptureHandle,
} from "./host-api-wire.js";
import { SubscriptionLedger } from "./subscription-ledger.js";
import { errorMessage } from "../../shared/error-message.js";

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
  resolveMappedDriveRoot: unimplementedHostApiPath("resolveMappedDriveRoot"),
  listAudioInputDevices: unimplementedHostApiPath("listAudioInputDevices"),
  startAudioCapture: unimplementedHostApiPath("startAudioCapture"),
  attachFloatingPanel: unimplementedHostApiPath("attachFloatingPanel"),
  resizeFloatingPanel: unimplementedHostApiPath("resizeFloatingPanel"),
  openExternalUrl: unimplementedHostApiPath("openExternalUrl"),
  openAuthWindow: unimplementedHostApiPath("openAuthWindow"),
  openAuthPartitionViewer: unimplementedHostApiPath("openAuthPartitionViewer"),
  clearAuthPartition: unimplementedHostApiPath("clearAuthPartition"),
  "authRedirect.open": unimplementedHostApiPath("authRedirect.open"),
  "authRedirect.wait": unimplementedHostApiPath("authRedirect.wait"),
  "authRedirect.close": unimplementedHostApiPath("authRedirect.close"),
  pickFolders: unimplementedHostApiPath("pickFolders"),
  getAuthPartitionCookies: unimplementedHostApiPath("getAuthPartitionCookies"),
  triggerConversation: unimplementedHostApiPath("triggerConversation"),
  "agentApproval.request": unimplementedHostApiPath("agentApproval.request"),
  "agentApproval.respond": unimplementedHostApiPath("agentApproval.respond"),
};

// ─────────────────────────────────────────────────────────────────────────
// Interaction handlers: what puts something in front of the user
// ─────────────────────────────────────────────────────────────────────────

/**
 * The members that put something in front of the USER, or decide whether an
 * action is permitted (`docs/blueprints/plugin-process-isolation.md` §3).
 *
 * Seven of the 36: `openExternalUrl`, `openAuthWindow`,
 * `openAuthPartitionViewer`, `clearAuthPartition`, `triggerConversation`, and
 * the `agentApproval` pair. They are grouped because their failure modes differ
 * from a data read in one specific way:
 *
 *   A REFUSAL IS AN ANSWER. `agentApproval.request` resolves `"deny-once"`;
 *   `triggerConversation` resolves `{ accepted: false, reason }`. Both are
 *   values the plugin is expected to branch on, and neither is an error.
 *   A call that could not be DELIVERED — the gate threw, the window service is
 *   gone, the incarnation is retired — must therefore reject, never resolve
 *   with a refusal the user never gave. Collapsing the two would let a broken
 *   host read as a user who said no, and nothing downstream could tell.
 *
 * WHY THESE HANDLERS CALL `hostApi` AND VALIDATE NOTHING THEMSELVES. Every one
 * of these members already validates its own arguments host-side, and that
 * validation IS the security decision: `openExternalUrl` runs `validateExternalUrl`
 * and the webView-preference routing, `openAuthWindow` enforces the
 * `external-auth-consumer` capability and the per-plugin partition allow-list,
 * `clearAuthPartition` enforces the same partition rule, `triggerConversation`
 * runs the overlay gate, and `agentApproval.*` verifies the issuer registry and
 * the approved scope grant. A boundary check in front of any of them would be a
 * SECOND, weaker copy of a rule that lives somewhere else — the exact drift
 * §3.6 warns about. The boundary's own obligations are the ones the dispatcher
 * already discharges for every path: the envelope, the generation, the JSON
 * gate on arguments and results.
 *
 * WHY A FACTORY RATHER THAN STATIC TABLE ENTRIES. A handler has to reach the
 * plugin's own `hostApi` — the instance the effect recorder and the effect gate
 * have already wrapped for THIS plugin incarnation. `HostApiCall` carries
 * identity and arguments, not host state, so the binding can only be a closure.
 * The dispatcher composes the bound entries over `HOSTAPI_DISPATCH_TABLE` with
 * object spread, which is the mechanism its own tests already use.
 *
 * HOST-SIDE ONLY. This module reaches Electron through the approval gate; the
 * child's half of these members is `host-api-child.ts`, which imports neither.
 */

/**
 * The subset of `hostApi` this group services.
 *
 * Narrowed rather than taking the whole surface so a handler cannot quietly
 * start calling a member that belongs to another group's contract.
 */
export type InteractionHostApi = Pick<
  PluginHostApi,
  | "openExternalUrl"
  | "openAuthWindow"
  | "openAuthPartitionViewer"
  | "clearAuthPartition"
  | "authRedirect"
  | "pickFolders"
  | "triggerConversation"
  | "agentApproval"
>;

/**
 * `openAuthWindow` is TWO overloads over ONE implementation, and which applies
 * is decided by `returnFinalUrl` inside the host — `AuthWindowCookie[]` for the
 * cookie form, `{ cookies, finalUrl }` for the other. Both are plain JSON, so
 * the boundary carries whichever the host produced. Picking the branch here
 * would put a second copy of that decision on the wire, where it could disagree
 * with the host's.
 */
type OverloadedOpenAuthWindow = (options: unknown) => Promise<unknown>;

/**
 * Bind this group's handlers to one plugin incarnation's `hostApi`.
 *
 * Composed over the dispatch table by the caller that owns the child, so the
 * table keeps naming every member exactly once and an unbound member keeps its
 * throwing default.
 */
export function createInteractionHostApiPaths(
  hostApi: InteractionHostApi,
): Record<InteractionHostApiPath, HostApiPathHandler> {
  // The four `void`-declared members RETURN the host's promise rather than
  // awaiting and discarding it. Discarding would also discard a host that
  // started resolving a value, and the dispatcher's void check — the one thing
  // that catches the child's stub and the host's implementation disagreeing
  // about a member — would never see it. A drift is refused, not absorbed.
  return {
    // The host decides in-app window vs system browser from the live webView
    // preference and rejects a non-http(s) scheme; the child learns only that
    // it resolved, or which error it was.
    openExternalUrl: defineHostApiPath("openExternalUrl", (call) =>
      hostApi.openExternalUrl(call.args[0] as string),
    ),
    openAuthWindow: defineHostApiPath("openAuthWindow", async (call) => {
      const openAuthWindow = hostApi.openAuthWindow as unknown as OverloadedOpenAuthWindow;
      // `.call` keeps the receiver, because the instance handed here may be a
      // recorder/gate wrapper whose members are not free functions.
      return await openAuthWindow.call(hostApi, call.args[0]);
    }),
    openAuthPartitionViewer: defineHostApiPath("openAuthPartitionViewer", (call) =>
      hostApi.openAuthPartitionViewer(
        call.args[0] as { url: string; windowTitle?: string },
      ),
    ),
    clearAuthPartition: defineHostApiPath("clearAuthPartition", (call) =>
      hostApi.clearAuthPartition(call.args[0] as string),
    ),
    // No owner argument crosses in either direction. The host binds the owner
    // from the incarnation this group was composed over, so a child that made
    // one up would be naming a field nobody reads.
    "authRedirect.open": defineHostApiPath("authRedirect.open", async () =>
      await hostApi.authRedirect.open(),
    ),
    // Blocks until the user finishes signing in, or until the host's own
    // timeout. No boundary deadline for the same reason `agentApproval.request`
    // has none: a call abandoned here would leave a bound port in the host with
    // nobody left to close it.
    "authRedirect.wait": defineHostApiPath("authRedirect.wait", async (call) =>
      await hostApi.authRedirect.wait(
        call.args[0] as { handle: string; timeoutMs?: number },
      ),
    ),
    "authRedirect.close": defineHostApiPath("authRedirect.close", (call) =>
      hostApi.authRedirect.close(call.args[0] as { handle: string }),
    ),
    // Blocks until the user answers the chooser, with no boundary deadline: a
    // dialog the user has not dismissed is not a stall, and abandoning the call
    // would leave a modal on screen that nobody is waiting for.
    pickFolders: defineHostApiPath("pickFolders", async () => await hostApi.pickFolders()),
    // `{ accepted: false, reason }` is a RESULT, not an error — the plugin is
    // documented to branch on `accepted`. A throw from here means the trigger
    // never reached the overlay at all.
    triggerConversation: defineHostApiPath("triggerConversation", async (call) =>
      hostApi.triggerConversation(call.args[0] as ConversationTriggerSpec),
    ),
    // Blocks on a human, for as long as the human takes. The boundary imposes
    // no call timeout of its own precisely so it cannot abandon a gate entry
    // that is still pending in the host (§7.5) — the gate's own timeout is the
    // only deadline, and it resolves `deny-once` as a VALUE.
    "agentApproval.request": defineHostApiPath(
      "agentApproval.request",
      async (call) =>
        hostApi.agentApproval.request(
          call.args[0] as {
            toolName: string;
            args: unknown;
            reason: string;
            scope: string;
          },
        ),
    ),
    // Four positional arguments, the last two optional. `nonce` and `hmac` are
    // gate-issued strings echoed back verbatim; they survive JSON unchanged,
    // which is what lets the gate's confused-deputy check still work from a
    // different process.
    "agentApproval.respond": defineHostApiPath("agentApproval.respond", (call) =>
      hostApi.agentApproval.respond(
        call.args[0] as string,
        call.args[1] as ApprovalChoice,
        call.args[2] as string | undefined,
        call.args[3] as string | undefined,
      ),
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Service handlers: what reaches a host service
// ─────────────────────────────────────────────────────────────────────────

/**
 * The host handlers for the hostApi members that reach a host SERVICE
 * (`docs/blueprints/plugin-process-isolation.md` §3.1, §3.2).
 *
 * Ten members: network egress (`hostFetch`, `probePrivateHost`), the LLM
 * provider (`callLlm`), credentials (`getSecret`, `resolveApiKey`), the worker
 * supervisor (`spawnWorker`), the event bus (`emitEvent`), the audit log
 * (`logEvent`), the routine store (`hasRoutineBySource`) and the Windows
 * drive-mapping lookup (`resolveMappedDriveRoot`). Between them they
 * hold every member §3.2 classified as not JSON-representable, which is why the
 * marshalling work concentrates here.
 *
 * EVERY HANDLER CALLS THROUGH THE BOUND `hostApi`. That object is the
 * incarnation's own hostApi — effect-instrumented, effect-boundary-enforced,
 * liveness-bound — so the four-tier secret gate, the egress allow-list, the SSRF
 * resolution, the emit-denial audit and the worker's `pluginId` binding all run
 * exactly where they already run. Reaching past it to `runSecretGate` or
 * `net.fetch` would make the boundary a SECOND decision point for questions that
 * already have an authority, and a second decision point is a weaker one the
 * moment the two drift.
 *
 * WHY A FACTORY RATHER THAN STATIC TABLE ENTRIES. A handler has to reach THIS
 * incarnation's `hostApi`, and `HostApiCall` carries identity and arguments, not
 * host state — so the binding can only be a closure. The caller that owns the
 * child composes the bound entries over `HOSTAPI_DISPATCH_TABLE` by object
 * spread; the shipped table stays unbound, which is correct while nothing routes
 * out-of-process, and an unbound member keeps its throwing default.
 *
 * NOTHING HERE IS SHARED MACHINERY. The envelope, the call-id allocator, the
 * generation check, the JSON gate, the byte codec, the size cap, the abort
 * registry, the subscription ledger and the error taxonomy are all the
 * foundation's, and these handlers consume them. What IS local is the
 * per-member argument shape — and those live in `host-api-wire.ts` because the
 * child needs the same declarations.
 *
 * HOST-SIDE ONLY. The child's half is `host-api-child.ts`, which imports neither
 * this module nor Electron.
 */

/**
 * The subset of `hostApi` this group services.
 *
 * Narrowed rather than taking the whole surface so a handler cannot quietly
 * start calling a member that belongs to another group's contract.
 */
export type ServiceHostApi = Pick<
  PluginHostApi,
  | "getSecret"
  | "getAuthPartitionCookies"
  | "hasRoutineBySource"
  | "probePrivateHost"
  | "resolveApiKey"
  | "emitEvent"
  | "logEvent"
  | "callLlm"
  | "hostFetch"
  | "spawnWorker"
  | "resolveMappedDriveRoot"
  | "listAudioInputDevices"
  | "startAudioCapture"
  | "attachFloatingPanel"
  | "resizeFloatingPanel"
>;

/**
 * How far a worker the CHILD asked for may reach.
 *
 * The child runs under an ASRT wrap whose filesystem grants are exactly these
 * two lists (`out-of-process-plugin.ts` derives them and hands the SAME object
 * to the wrap and to this check), and `PluginWorkerSpec` lets the caller name
 * its own `allowReadPaths` and `allowWritePaths`. In one heap those two facts
 * never met: the plugin and the worker supervisor were the same trust domain.
 * Across the boundary they are not, and a child that can ask the host to spawn
 * `/bin/sh` with `allowWritePaths: ["/"]` has escaped its jail by asking
 * someone else to hold the door — the confinement would be a property of one
 * process rather than of the plugin.
 *
 * So the envelope crosses with the binding, and a delegated worker's grants are
 * checked against it. Confinement composes: what the plugin cannot reach
 * itself, it cannot obtain by delegation.
 *
 * TWO LISTS RATHER THAN TWO NAMED DIRECTORIES. The pair used to be
 * `{ pluginRoot, pluginDataDir }`, which made the envelope's SIZE a constant of
 * the type: there was no way for the host to decide that one plugin's child
 * reaches further, so a plugin whose legitimate work lives outside those two
 * directories could not be isolated at all. Widening is a host decision
 * (`PLUGIN_ENVELOPE_GRANTS`), and it belongs in the value, not in a second
 * check bolted onto the delegation path — widen the child and the delegated
 * worker composes with no further change, because both lists come from one
 * derivation.
 */
export interface DelegatedWorkerConfinement {
  /**
   * Every root the child may read.
   *
   * `derivePluginChildEnvelope` maintains it as a superset of {@link write} —
   * it pushes each admitted `userChosenDirectory` into both lists — and NOTHING
   * ENFORCES THAT, here or at runtime. It is relied on where a read grant is
   * argued from a write grant, and deliberately NOT relied on where the
   * consequence of it failing would be silent: `spawnConfinedPluginChild`
   * materialises both lists rather than `read` alone, precisely so a write-only
   * root that slipped past the invariant is still created before the wrap.
   */
  readonly read: readonly string[];
  /**
   * Every root the child may write.
   *
   * Every root this envelope GRANTS for writing, rather than every root the
   * child can reach: ASRT merges its own default write paths into every wrap
   * (`out-of-process-plugins.ts`, axis 6), and no grant here subtracts from
   * them. What matters for a delegated worker is that this list is the boundary
   * its `allowWritePaths` are checked against, and it is the same list the
   * plugin child's own wrap carries.
   */
  readonly write: readonly string[];
}

/** The purposes `resolveApiKey` accepts. Anything else is refused, not coerced. */
const RESOLVE_API_KEY_PURPOSES = ["llm", "stt", "embedding", "vision"] as const;
/** The vendors `resolveApiKey` accepts, when one is named at all. */
const RESOLVE_API_KEY_VENDORS = [
  "openai",
  "azure-openai",
  "vertex",
  "anthropic",
] as const;
/** The levels `logEvent` accepts. */
const LOG_EVENT_LEVELS = ["info", "warn", "error"] as const;

type ResolveApiKeyPurpose = (typeof RESOLVE_API_KEY_PURPOSES)[number];
type ResolveApiKeyVendor = (typeof RESOLVE_API_KEY_VENDORS)[number];
type LogEventLevel = (typeof LOG_EVENT_LEVELS)[number];

function rejectArgument(path: HostApiPath, detail: string): never {
  throw new HostApiBoundaryError(
    "argument-marshalling-rejected",
    `[host-api-dispatcher] '${path}': ${detail}`,
    { path },
  );
}

/**
 * Read a positional argument the contract declares as a string.
 *
 * The dispatcher has already proved the arguments survive JSON; it has NOT
 * proved they are the ones the member takes. A `getSecret(42)` would otherwise
 * reach the gate as a non-string key and be answered by whatever the gate's
 * string handling happens to do with a number.
 */
function requireString(call: HostApiCall, index: number, name: string): string {
  const value = call.args[index];
  if (typeof value !== "string") {
    rejectArgument(call.path, `${name} must be a string`);
  }
  return value;
}

/**
 * Resolve an OPTIONAL hostApi member, or refuse the call.
 *
 * `hostFetch`, `resolveApiKey` and `spawnWorker` are `?`-optional on
 * `PluginHostApi` because older host builds predate them. On a build without
 * one, the honest answer is the boundary's "this host has no implementation",
 * not a `TypeError` from calling `undefined` — a plugin branching on
 * `typeof hostApi.hostFetch === "function"` in-process must get the same
 * verdict through the boundary.
 */
function requireMember<T>(path: HostApiPath, member: T | undefined, name: string): T {
  if (typeof member !== "function") {
    throw new HostApiBoundaryError(
      "path-not-implemented",
      `[host-api-dispatcher] '${path}': this host build has no '${name}'`,
      { path },
    );
  }
  return member;
}

/** Read a positional argument the contract declares as a plain object. */
function requireRecord(
  call: HostApiCall,
  index: number,
  name: string,
): Record<string, unknown> {
  const value = call.args[index];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    rejectArgument(call.path, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Open the host end of the abort channel an argument named, if it named one.
 *
 * Returns the channel id so the caller can release it when the call settles.
 * A channel left open would outlive its call in the ledger and be aborted only
 * when the child dies, which is a leak that looks like nothing until a
 * long-lived plugin has made a few thousand calls.
 */
function openDeclaredAbortChannel(
  call: HostApiCall,
  scope: SubscriptionScope,
  channelId: unknown,
  name: string,
): { readonly signal?: AbortSignal; readonly channelId?: string } {
  if (channelId === undefined) return {};
  if (typeof channelId !== "string" || channelId.length === 0) {
    rejectArgument(call.path, `${name} must be a non-empty channel id`);
  }
  return { signal: scope.abortChannel(channelId), channelId };
}

// ───────────────────────────────────────────────────────────────────────────
// Credentials.
// ───────────────────────────────────────────────────────────────────────────

/**
 * `getSecret(key) → Promise<string | null>`.
 *
 * The whole handler is a marshalling shim, and that is the point: the four-tier
 * gate, the audit vocabulary, the counter cardinality guard and the
 * endpoint-URL value check all stay in the host implementation. The boundary
 * adds a TYPE check on `key` and nothing else — a second allow-list here would
 * be a weaker copy of `runSecretGate` that the gate could drift away from.
 */
function getSecretPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("getSecret", async (call) =>
    hostApi.getSecret(requireString(call, 0, "key")),
  );
}

/**
 * `resolveApiKey(opts) → { ok, vendor, bearer(), baseUrl?, release() }`.
 *
 * Two functions in the return value, so what crosses is the lease: `bearer()`
 * becomes the key the child closes over, and `release()` becomes the
 * subscription the child ends. `bindApiKeyResult` (host-api-factory) has
 * already wrapped the result so `bearer()` re-checks liveness and `release()`
 * is idempotent and registered with the incarnation — this handler reads the
 * key through that wrapper rather than around it.
 *
 * The lease is opened BEFORE the resolve so a child that dies mid-resolve still
 * has a registration to release; `closed` catches the case where that release
 * ran while the resolve was in flight, and drops the credential the host was
 * about to hand to a process that no longer exists.
 */
/**
 * `getAuthPartitionCookies(opts) → Array<{ url, cookies }>`.
 *
 * A credential READ, which is why it sits beside `getSecret` rather than with
 * the members that put something in front of the user: it prompts nobody and
 * refuses nobody, so it has no "the user said no" answer to distinguish from a
 * delivery failure. As with `getSecret`, the scoping that bounds it — own
 * partition only, intersected with the manifest allow-list — stays in the host
 * implementation; the boundary adds a shape check and nothing else.
 */
function getAuthPartitionCookiesPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("getAuthPartitionCookies", async (call) =>
    hostApi.getAuthPartitionCookies(
      call.args[0] as { partitionSub: string; urls: string[] },
    ),
  );
}

function resolveApiKeyPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("resolveApiKey", async (call, scope) => {
    // Presence-checked, then called through the object: a detached reference
    // would lose the hostApi proxy as its receiver, and the proxy is where the
    // liveness and effect wrappers live.
    requireMember(call.path, hostApi.resolveApiKey, "resolveApiKey");
    const wire = requireRecord(call, 0, "opts") as unknown as WireResolveApiKeyOptions;
    const purpose = wire.purpose;
    if (!RESOLVE_API_KEY_PURPOSES.includes(purpose as ResolveApiKeyPurpose)) {
      rejectArgument(call.path, `unknown purpose '${String(purpose)}'`);
    }
    const vendor = wire.vendor;
    if (
      vendor !== undefined
      && !RESOLVE_API_KEY_VENDORS.includes(vendor as ResolveApiKeyVendor)
    ) {
      rejectArgument(call.path, `unknown vendor '${String(vendor)}'`);
    }
    const abort = openDeclaredAbortChannel(call, scope, wire.signalChannelId, "signalChannelId");

    let lease: { release: () => void } | undefined;
    let closed = false;
    const handleId = scope.open(() => {
      closed = true;
      lease?.release();
    });
    try {
      const result = await hostApi.resolveApiKey!({
        purpose,
        ...(vendor !== undefined ? { vendor } : {}),
        ...(abort.signal ? { signal: abort.signal } : {}),
      });
      if (!result.ok) {
        // A denied resolve owns nothing, so the registration ends immediately.
        // The id still crosses because a `handle` result is pinned to
        // `{ handleId: string }` and a settled call has to name itself.
        scope.release(handleId);
        return { handleId, ok: false, reason: result.reason } satisfies WireApiKeyLease;
      }
      if (closed) {
        result.release();
        throw new HostApiBoundaryError(
          "plugin-inactive",
          `[host-api-dispatcher] '${call.path}': the child released the lease before it resolved`,
          { path: call.path },
        );
      }
      lease = result;
      return {
        handleId,
        ok: true,
        vendor: result.vendor,
        ...(result.baseUrl !== undefined ? { baseUrl: result.baseUrl } : {}),
        key: result.bearer(),
      } satisfies WireApiKeyLease;
    } catch (error) {
      scope.release(handleId);
      throw error;
    } finally {
      if (abort.channelId) scope.release(abort.channelId);
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Network and LLM.
// ───────────────────────────────────────────────────────────────────────────

/**
 * `hostFetch(input, init) → Response`.
 *
 * Neither direction crosses as itself. `init` arrives already reduced (headers
 * as entries, body as tagged bytes, signal as a channel id) and is rebuilt into
 * a real `RequestInit` so the host implementation sees exactly the object an
 * in-process plugin would have passed — including the `method` the verb
 * snapshot reads, which is now a parsed JSON primitive rather than a getter the
 * plugin could make stateful.
 *
 * The `Response` is drained under the boundary's ceiling and re-encoded through
 * the shared byte codec. Text would corrupt it: a body carrying invalid UTF-8,
 * a NUL, or high bytes survives base64 and does not survive a `text()` round
 * trip, and the corruption reads as success.
 */
function hostFetchPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("hostFetch", async (call, scope) => {
    requireMember(call.path, hostApi.hostFetch, "hostFetch");
    const input = requireString(call, 0, "input");
    const channels: string[] = [];
    const init = decodeWireRequestInit(
      call.args[1],
      (channelId) => {
        channels.push(channelId);
        return scope.abortChannel(channelId);
      },
      `${call.path}(init)`,
    );
    try {
      const response = await hostApi.hostFetch!(input, init);
      // Drained INSIDE the try, before the channel is released: releasing first
      // aborts the controller, and an abort between the headers and the body
      // would truncate a response the call already succeeded at.
      return (await encodeWireHttpResponse(
        response,
        `${call.path}(result)`,
      )) satisfies WireHttpResponse;
    } finally {
      for (const channelId of channels) scope.release(channelId);
    }
  });
}

/**
 * `callLlm(prompt, options) → Promise<string>`.
 *
 * Plain data apart from `options.signal`, which arrives as a channel id and
 * becomes the host's own `AbortController`. The `abort` notification the child
 * sends closes that registration, and the ledger's teardown aborts the
 * controller — so a cancel in the plugin reaches the provider call rather than
 * merely rejecting the child's promise.
 */
function callLlmPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("callLlm", async (call, scope) => {
    const prompt = requireString(call, 0, "prompt");
    const raw = call.args[1];
    if (raw !== undefined && raw !== null && typeof raw !== "object") {
      rejectArgument(call.path, "options must be an object");
    }
    const wire = (raw ?? {}) as WireCallLlmOptions;
    const abort = openDeclaredAbortChannel(call, scope, wire.signalChannelId, "signalChannelId");
    try {
      return await hostApi.callLlm(prompt, {
        ...(wire.maxTokens !== undefined ? { maxTokens: wire.maxTokens } : {}),
        ...(wire.systemPrompt !== undefined ? { systemPrompt: wire.systemPrompt } : {}),
        ...(abort.signal ? { signal: abort.signal } : {}),
      });
    } finally {
      if (abort.channelId) scope.release(abort.channelId);
    }
  });
}

/** `probePrivateHost(host, opts?) → Promise<boolean>`. Plain data both ways. */
/**
 * `resolveMappedDriveRoot(drive) → Promise<string | null>`. Plain data both ways.
 *
 * The argument is coerced to a string and handed on WITHOUT a shape check here:
 * the host implementation validates the drive letter itself, and a second
 * validator in front of it would be a place for the two to disagree about what
 * a drive letter is.
 */
/** `listAudioInputDevices() → AudioCaptureDevice[]`. No arguments, plain data back. */
function listAudioInputDevicesPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("listAudioInputDevices", async () => hostApi.listAudioInputDevices());
}

/**
 * `startAudioCapture(request) → AudioCaptureHandle`.
 *
 * The same shape as `spawnWorker` and for the same reason: the host owns the
 * resource and must keep owning it. What crosses is
 * `{ handleId, captureId, opened }`; `stop()` becomes the release of that
 * registration, and `onFrame`/`onEnd` become host notifications the child fans
 * out to child-local listeners.
 *
 * WHY NOT THE EVENT BUS. Frames are addressed to the ONE plugin that started
 * the capture. `emitHostEvent` broadcasts to every installed plugin, so
 * delivering audio that way would hand all of them the microphone — the reason
 * a streaming capability that looks event-shaped is a handle here.
 *
 * The host listeners are registered EAGERLY, before this returns, because
 * audio produced between the start and the plugin's first `onFrame` call would
 * otherwise be lost, and the round trip makes that window far wider than it is
 * in-process.
 */
function startAudioCapturePath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("startAudioCapture", async (call, scope) => {
    const capture = await hostApi.startAudioCapture(call.args[0] as AudioCaptureRequest);

    let ended = false;
    let live = true;
    const handleId = scope.open(() => {
      live = false;
      // A capture that already ended must not be stopped again: `stop()` is
      // idempotent on this side, but releasing twice is not.
      if (!ended) void capture.stop();
    });
    // Guarded at the push rather than at the end: `deliver` throws on an
    // unknown subscription, and a frame arriving after the handle was released
    // would turn a routine race into an exception inside a listener.
    const push = (payload: WireAudioCaptureEvent): void => {
      if (live) scope.deliver(handleId, payload);
    };
    capture.onFrame((frame) => {
      push({
        kind: "frame",
        seq: frame.seq,
        // Base64 because the wire is JSON. A `Uint8Array` put through it
        // arrives as an object with numeric keys — not an error anywhere, just
        // audio that decodes to noise.
        pcm: Buffer.from(frame.pcm).toString("base64"),
        peak: frame.peak,
      });
    });
    capture.onEnd((end) => {
      ended = true;
      push({ kind: "end", reason: end.reason, ...(end.detail === undefined ? {} : { detail: end.detail }) });
      // The capture is over, so the registration has nothing left to own.
      // Released here rather than left for `childGone` so a plugin that records
      // repeatedly does not accumulate host-side entries.
      scope.release(handleId);
    });

    return {
      handleId,
      captureId: capture.captureId,
      opened: capture.opened,
    } satisfies WireAudioCaptureHandle;
  });
}

function attachFloatingPanelPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("attachFloatingPanel", async (call, scope) => {
    const panel = await hostApi.attachFloatingPanel(
      call.args[0] as AttachFloatingPanelRequest,
    );

    let detached = false;
    let live = true;
    const handleId = scope.open(() => {
      live = false;
      // Releasing the handle IS the child's detach — the wire carries no
      // per-handle call channel, so `detach()` on the child side disposes the
      // subscription and this callback is what that means on the host side.
      // Guarded because a slot that already went away must not be detached
      // twice: `detach` is idempotent on the dock, but releasing is not.
      if (!detached) void panel.detach();
    });

    panel.onDetached((reason) => {
      detached = true;
      // Guarded at the push rather than at the end: `deliver` throws on an
      // unknown subscription, and a detach arriving after the handle was
      // released would turn a routine race into an exception in a listener.
      if (live) scope.deliver(handleId, { kind: "detached", reason } satisfies WireFloatingPanelEvent);
      // The slot is gone, so the registration has nothing left to own.
      // Released here rather than left for `childGone` so a plugin that
      // attaches repeatedly does not accumulate host-side entries.
      scope.release(handleId);
    });

    return {
      handleId,
      panelId: panel.panelId,
      height: panel.height,
    } satisfies WireFloatingPanelHandle;
  });
}

function resizeFloatingPanelPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("resizeFloatingPanel", async (call) =>
    hostApi.resizeFloatingPanel(String(call.args[0]), Number(call.args[1])),
  );
}

function resolveMappedDriveRootPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("resolveMappedDriveRoot", async (call) =>
    hostApi.resolveMappedDriveRoot(String(call.args[0])),
  );
}

function probePrivateHostPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("probePrivateHost", async (call) => {
    const host = requireString(call, 0, "host");
    const raw = call.args[1];
    if (raw === undefined || raw === null) return hostApi.probePrivateHost(host);
    const opts = requireRecord(call, 1, "opts");
    const timeoutMs = opts.timeoutMs;
    if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
      rejectArgument(call.path, "opts.timeoutMs must be a number");
    }
    return hostApi.probePrivateHost(host, {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Worker supervision.
// ───────────────────────────────────────────────────────────────────────────

/** Read an optional `readonly string[]` field off the child-supplied spec. */
function optionalStringList(
  call: HostApiCall,
  spec: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = spec[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    rejectArgument(call.path, `spec.${field} must be an array of strings`);
  }
  return value as readonly string[];
}

/**
 * Check one delegated grant list against the child's own envelope.
 *
 * Both sides are resolved first, so `<dataDir>/../../etc` is compared as what
 * it means rather than as what it says — and so an envelope root the host wrote
 * in one form is compared against a grant written in another. Resolving only
 * the grant left that asymmetry: on Win32 a POSIX-shaped root never prefixes a
 * drive-anchored target, so every delegable grant read as an escape. What is
 * deliberately NOT done here is a
 * `realpath` walk: the grant may name a directory the worker is about to
 * create, so the path need not exist. A symlink planted inside the data dir
 * therefore still points wherever it points — the residual is the worker
 * supervisor's own to close, and stating it is better than a check that reads
 * as if it covered it.
 */
function assertGrantsWithinEnvelope(
  call: HostApiCall,
  field: string,
  granted: readonly string[] | undefined,
  envelope: readonly string[],
): void {
  for (const path of granted ?? []) {
    if (!isAbsolute(path)) {
      rejectArgument(call.path, `spec.${field} entry '${path}' must be an absolute path`);
    }
    if (envelope.some((root) => isResolvedPathWithin(root, path))) continue;
    throw new HostApiBoundaryError(
      "effect-boundary-denied",
      `[host-api-dispatcher] '${call.path}': spec.${field} entry '${path}' `
        + `is outside the plugin's own confinement — a delegated worker cannot be `
        + `granted a path the plugin process itself may not reach`,
      { path: call.path, field, granted: path, envelope: [...envelope] },
    );
  }
}

/**
 * Take a `PluginWorkerSpec` off the wire.
 *
 * Every other member in this file type-checks its arguments before handing them
 * on; this one used to cast a bare record straight into the spec, which put
 * child-controlled JSON into `spawn()`'s `command` with nothing in between. The
 * fields are checked because the boundary is where a malformed message is a
 * malformed message, and an unknown field is REFUSED rather than dropped — a
 * spec that gains a grant-shaped field must fail here until this decodes it,
 * not pass it through unexamined.
 */
function decodeWorkerSpec(
  call: HostApiCall,
  confinement: DelegatedWorkerConfinement,
): PluginWorkerSpec {
  const spec = requireRecord(call, 0, "spec");
  const known = new Set([
    "workerId",
    "command",
    "args",
    "env",
    "allowReadPaths",
    "allowWritePaths",
    "udsArgName",
  ]);
  for (const field of Object.keys(spec)) {
    if (!known.has(field)) rejectArgument(call.path, `spec has unknown field '${field}'`);
  }
  const workerId = spec.workerId;
  const command = spec.command;
  if (typeof workerId !== "string") rejectArgument(call.path, "spec.workerId must be a string");
  if (typeof command !== "string") rejectArgument(call.path, "spec.command must be a string");
  const args = optionalStringList(call, spec, "args");
  const allowReadPaths = optionalStringList(call, spec, "allowReadPaths");
  const allowWritePaths = optionalStringList(call, spec, "allowWritePaths");
  const env = spec.env;
  if (
    env !== undefined
    && (env === null || typeof env !== "object" || Array.isArray(env)
      || Object.values(env).some((value) => value !== undefined && typeof value !== "string"))
  ) {
    rejectArgument(call.path, "spec.env must be a record of strings");
  }
  const udsArgName = spec.udsArgName;
  if (
    udsArgName !== undefined
    && typeof udsArgName !== "string"
    && !(
      typeof udsArgName === "object"
      && udsArgName !== null
      && typeof (udsArgName as { env?: unknown }).env === "string"
    )
  ) {
    rejectArgument(call.path, "spec.udsArgName must be a string or { env: string }");
  }
  // The child's OWN ASRT grant set, member for member — not a restatement of
  // it. `spawnConfinedPluginChild` wraps the child with these very arrays, the
  // only addition being the throwaway sandbox HOME, which belongs to the host
  // process and is deliberately absent here because it is not the plugin's to
  // hand on. So there is no second policy to drift away from the jail, and a
  // host decision that widens the child widens what it may delegate in the same
  // edit rather than leaving a second list behind.
  assertGrantsWithinEnvelope(call, "allowReadPaths", allowReadPaths, confinement.read);
  assertGrantsWithinEnvelope(call, "allowWritePaths", allowWritePaths, confinement.write);
  return {
    workerId,
    command,
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env: env as Record<string, string | undefined> } : {}),
    ...(allowReadPaths !== undefined ? { allowReadPaths } : {}),
    ...(allowWritePaths !== undefined ? { allowWritePaths } : {}),
    ...(udsArgName !== undefined
      ? { udsArgName: udsArgName as PluginWorkerSpec["udsArgName"] }
      : {}),
  };
}

/**
 * `spawnWorker(spec) → SpawnedPluginWorker`.
 *
 * A handle with four methods, none of which cross. The host keeps owning the
 * process — it must: the sandbox grant machinery, the wrapped-worker registry,
 * the Windows holder-PID ACL lifecycle and the managed-child registry all live
 * in main, and a grandchild spawned by the plugin's own process would sit
 * outside every grant keyed to a host-allocated path.
 *
 * What crosses is `{ handleId, socketPath, pid }`. `stop()` becomes the release
 * of that registration; `onStdout` / `onStderr` / `onExit` become host
 * notifications the child fans out to child-local listeners.
 *
 * The three host listeners are registered EAGERLY rather than on the child's
 * first subscribe, because output produced between the spawn and the plugin's
 * first `onStdout` call would otherwise be lost — in-process it is lost the same
 * way, but here the round trip makes the window far wider.
 *
 * WHAT THE GRANT CHECK DOES AND DOES NOT COVER. It bounds the worker's
 * filesystem grants by the child's own, so delegation cannot widen the jail.
 * `command` is deliberately NOT constrained: the worker executes under those
 * grants plus the shared deny floor, so naming a different binary reaches
 * nothing the grants do not already allow, and requiring the command to sit
 * inside the envelope would refuse a PATH-resolved runtime without closing
 * anything. `env` is likewise the plugin's to choose — it reaches the worker,
 * which is the plugin's own process either way.
 */
function spawnWorkerPath(
  hostApi: ServiceHostApi,
  confinement: DelegatedWorkerConfinement,
): HostApiPathHandler {
  return defineHostApiPath("spawnWorker", async (call, scope) => {
    requireMember(call.path, hostApi.spawnWorker, "spawnWorker");
    const spec = decodeWorkerSpec(call, confinement);
    const worker = await hostApi.spawnWorker!(spec);

    let exited = false;
    let live = true;
    const handleId = scope.open(() => {
      live = false;
      // A worker that already exited must not be stopped: `stop()` signals a pid,
      // and a pid that has been reaped can belong to something else by then.
      if (!exited) worker.stop();
    });
    // Pushes stop at the release, not at the exit: `deliver` throws on an unknown
    // subscription, and a chunk arriving after the handle was released would turn
    // a routine race into an exception inside an event listener.
    const push = (payload: unknown): void => {
      if (live) scope.deliver(handleId, payload);
    };
    worker.onStdout((chunk) => push({ kind: "stdout", chunk }));
    worker.onStderr((chunk) => push({ kind: "stderr", chunk }));
    worker.onExit((info) => {
      exited = true;
      push({ kind: "exit", code: info.code, signal: info.signal });
      // The process is gone, so the registration has nothing left to own. Released
      // here rather than left for `childGone` so a plugin that spawns and lets
      // workers die does not accumulate host-side entries.
      scope.release(handleId);
    });
    return {
      handleId,
      socketPath: worker.socketPath,
      pid: worker.pid,
    } satisfies WireWorkerHandle;
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Event bus, audit log, routine store.
// ───────────────────────────────────────────────────────────────────────────

/**
 * `emitEvent(type, data?) → void`.
 *
 * The child stub has already run its own `canEmitEvent` check so the plugin
 * still sees a SYNCHRONOUS throw on a denied event. This is the authoritative
 * one: it re-decides from the host's manifest and writes the denial audit. Both
 * run, and neither is a degraded substitute — the host check is the control, the
 * child check only preserves the contract's timing.
 *
 * The host's return value is RETURNED, not awaited and discarded. Both these
 * members are declared `void`, and the dispatcher's void check is the one thing
 * that catches the child's stub and the host's implementation disagreeing about
 * a member — a handler that swallowed the value would make that check
 * unreachable, so a drift would be absorbed instead of refused.
 */
function emitEventPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("emitEvent", async (call) =>
    hostApi.emitEvent(requireString(call, 0, "eventType"), call.args[1]),
  );
}

/** `logEvent(level, message, data?) → void`. Returns the host's value, as above. */
function logEventPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("logEvent", async (call) => {
    const level = requireString(call, 0, "level");
    if (!LOG_EVENT_LEVELS.includes(level as LogEventLevel)) {
      rejectArgument(call.path, `unknown level '${level}'`);
    }
    return hostApi.logEvent(
      level as LogEventLevel,
      requireString(call, 1, "message"),
      call.args[2],
    );
  });
}

/**
 * `hasRoutineBySource(source) → Promise<boolean>`.
 *
 * The `suggestion:<callerPluginId>:` prefix rule is enforced by the host
 * implementation, which knows the caller's id from the incarnation it was built
 * for. Re-checking it here would need the boundary to learn the same rule, and
 * two copies of a least-privilege prefix is one copy too many.
 */
function hasRoutineBySourcePath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("hasRoutineBySource", async (call) =>
    hostApi.hasRoutineBySource(requireString(call, 0, "source")),
  );
}

/**
 * Bind this group's handlers to one plugin incarnation's `hostApi`.
 *
 * Composed over the dispatch table by the caller that owns the child, so the
 * table keeps naming every member exactly once and an unbound member keeps its
 * throwing default.
 */
export function createServiceHostApiPaths(
  hostApi: ServiceHostApi,
  /**
   * The child's own filesystem envelope, so a worker it delegates cannot be
   * granted more than the child holds. Required rather than optional: an
   * omitted envelope would silently mean "unbounded", which is the exact
   * default this exists to remove.
   */
  confinement: DelegatedWorkerConfinement,
): Record<ServiceHostApiPath, HostApiPathHandler> {
  return {
    getSecret: getSecretPath(hostApi),
    getAuthPartitionCookies: getAuthPartitionCookiesPath(hostApi),
    hasRoutineBySource: hasRoutineBySourcePath(hostApi),
    probePrivateHost: probePrivateHostPath(hostApi),
    resolveApiKey: resolveApiKeyPath(hostApi),
    emitEvent: emitEventPath(hostApi),
    logEvent: logEventPath(hostApi),
    callLlm: callLlmPath(hostApi),
    hostFetch: hostFetchPath(hostApi),
    spawnWorker: spawnWorkerPath(hostApi, confinement),
    resolveMappedDriveRoot: resolveMappedDriveRootPath(hostApi),
    listAudioInputDevices: listAudioInputDevicesPath(hostApi),
    startAudioCapture: startAudioCapturePath(hostApi),
    attachFloatingPanel: attachFloatingPanelPath(hostApi),
    resizeFloatingPanel: resizeFloatingPanelPath(hostApi),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Storage handlers: `hostApi.storage.*`
// ─────────────────────────────────────────────────────────────────────────

/**
 * The host end of `hostApi.storage.*`: eleven dispatchable members, one shape
 * (`docs/blueprints/plugin-process-isolation.md` §3.2).
 *
 * The twelfth, `storage.resolve`, is not here — its contract says `child-local`
 * and the dispatcher refuses it, so the child's copy of the lexical join
 * (`plugin-storage-containment.ts`) is the whole implementation.
 *
 * WHY THE GROUP IS WRITTEN TOGETHER. read/write × raw/text/json/encrypted is
 * the most symmetric corner of the surface, and the asymmetries in it are all
 * deliberate: exactly one member re-encodes its RESULT (`read`, because bytes
 * are not JSON), exactly one re-encodes its ARGUMENTS (`write`, same reason in
 * the other direction), and exactly two can fail for a reason unrelated to the
 * file (`writeEncrypted` / `readEncrypted`, when the OS keychain is not there).
 * Every other member is plain JSON in and plain JSON out. Written apart, those
 * four exceptions would be four independent judgement calls.
 *
 * WHY A FACTORY RATHER THAN STATIC TABLE ENTRIES. A handler has to reach the
 * plugin incarnation's own `PluginStorage` — the instance rooted at THIS
 * plugin's `pluginDataDir`, canonicalised at construction, and wrapped by the
 * effect recorder. `HostApiCall` carries identity and arguments, not host
 * state, so the binding can only be a closure. The caller composes the bound
 * entries over `HOSTAPI_DISPATCH_TABLE` with object spread; the shipped table
 * stays unbound, which is what stops a storage read being serviced on behalf of
 * no plugin in particular.
 *
 * ARGUMENT VALIDATION IS A BOUNDARY CONCERN, NOT A STORAGE ONE. `args` arrives
 * from the least-trusted process in the system, so each member checks its own
 * positional arguments against its declared signature and refuses a mismatch
 * with `argument-marshalling-rejected`. This is not a second copy of a host
 * rule: the containment decision — absolute paths, `..`, symlink escape — stays
 * entirely inside `PluginStorage.guard`, and nothing here anticipates it.
 * Stated deviation: in-process, a non-string `relPath` reaches `guard()` and
 * comes back as a `PluginStorageError`; across the boundary it is refused here
 * instead, because a message whose arguments do not match the member's
 * signature is a malformed message. A plugin passing the argument its own types
 * declare never sees the difference.
 *
 * Nothing here catches. A refused path, a missing file, a denied effect and an
 * unavailable keychain all propagate as the host classes they already are;
 * `classifyHostApiError` maps each to the code the member's contract lists.
 * There is no default value and no silent skip anywhere in this file.
 *
 * HOST-SIDE ONLY. This module reaches Electron through the approval gate; the
 * child's half of these members is `host-api-child.ts`, which imports neither.
 */

/**
 * The subset of `hostApi` this group services.
 *
 * Narrowed rather than taking the whole surface so a handler cannot quietly
 * start calling a member that belongs to another group's contract.
 */
export type StorageHostApi = Pick<PluginHostApi, "storage">;

/**
 * Every `StorageEncoding`, as a runtime membership test.
 *
 * `Record<StorageEncoding, true>` rather than an array: adding a member to the
 * union without adding it here is a COMPILE error, so the set cannot drift
 * behind the type it is guarding. Unvalidated, a child-chosen encoding reaches
 * `readFile`/`writeFile` and comes back as an opaque `host-internal` throw;
 * validated, it is the boundary refusal it actually is.
 */
const STORAGE_ENCODINGS: Record<StorageEncoding, true> = {
  "utf-8": true,
  utf8: true,
  ascii: true,
  base64: true,
  base64url: true,
  hex: true,
  latin1: true,
  binary: true,
};

function reject(call: HostApiCall, index: number, expected: string): never {
  throw new HostApiBoundaryError(
    "argument-marshalling-rejected",
    `[host-api-dispatcher] '${call.path}' argument ${index} must be ${expected}`,
    { path: call.path, index },
  );
}

/** A required positional argument the member declares as `string`. */
function stringArg(call: HostApiCall, index: number): string {
  const value = call.args[index];
  if (typeof value !== "string") reject(call, index, "a string");
  return value;
}

/**
 * A positional argument the member declares OPTIONAL.
 *
 * Absent means absent: `describeNonJson` refuses `undefined` inside an array,
 * so an unsupplied trailing argument arrives as a shorter `args` — never as an
 * explicit `undefined` element.
 */
function optionalStringArg(call: HostApiCall, index: number): string | undefined {
  const value = call.args[index];
  if (value === undefined) return undefined;
  if (typeof value !== "string") reject(call, index, "a string when present");
  return value;
}

function optionalEncodingArg(
  call: HostApiCall,
  index: number,
): StorageEncoding | undefined {
  const value = optionalStringArg(call, index);
  if (value === undefined) return undefined;
  // `Object.hasOwn`, not `in`: the value is child-supplied and
  // `"toString" in STORAGE_ENCODINGS` is true.
  if (!Object.hasOwn(STORAGE_ENCODINGS, value)) {
    reject(call, index, `one of ${Object.keys(STORAGE_ENCODINGS).join(", ")}`);
  }
  return value as StorageEncoding;
}

function optionalIndentArg(call: HostApiCall, index: number): number | undefined {
  const value = call.args[index];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    reject(call, index, "a non-negative integer when present");
  }
  return value;
}

/** `rm`'s only option today. An unknown key is refused rather than ignored. */
function optionalRemoveOptionsArg(
  call: HostApiCall,
  index: number,
): { recursive?: boolean } | undefined {
  const value = call.args[index];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject(call, index, "an options object when present");
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "recursive" || typeof item !== "boolean") {
      reject(call, index, "an options object with only a boolean 'recursive'");
    }
  }
  return value as { recursive?: boolean };
}

/**
 * Bind this group's handlers to one plugin incarnation's `hostApi`.
 *
 * Composed over the dispatch table by the caller that owns the child, so the
 * table keeps naming every member exactly once and an unbound member keeps its
 * throwing default.
 */
export function createStorageHostApiPaths(
  hostApi: StorageHostApi,
): Record<DispatchedStorageHostApiPath, HostApiPathHandler> {
  // The five `void`-declared members RETURN the host's promise rather than
  // awaiting and discarding it. Discarding would also discard a host that
  // started resolving a value, and the dispatcher's void check — the one thing
  // that catches the child's stub and the host's implementation disagreeing
  // about a member — would never see it. A drift is refused, not absorbed.
  return {
    /**
     * The one member whose RESULT is re-encoded.
     *
     * It declares `Uint8Array` and delivers a Node `Buffer`, and `Buffer`
     * carries a `toJSON()`: a naive round trip does not throw, it SUCCEEDS into
     * `{ type: "Buffer", data: number[] }` — a different type that reads as a
     * successful read. Tagging the bytes as base64 is what keeps bytes bytes.
     */
    "storage.read": defineHostApiPath("storage.read", async (call) =>
      encodeWireBytes(
        await hostApi.storage.read(stringArg(call, 0)),
        `${call.path}(result)`,
      ),
    ),

    "storage.readText": defineHostApiPath("storage.readText", (call) =>
      hostApi.storage.readText(stringArg(call, 0), optionalEncodingArg(call, 1)),
    ),

    // Resolves `null` for a missing file — the member's declared answer, not a
    // fallback the boundary invented.
    "storage.readJson": defineHostApiPath("storage.readJson", (call) =>
      hostApi.storage.readJson(stringArg(call, 0)),
    ),

    "storage.list": defineHostApiPath("storage.list", (call) =>
      hostApi.storage.list(optionalStringArg(call, 0)),
    ),

    "storage.exists": defineHostApiPath("storage.exists", (call) =>
      hostApi.storage.exists(stringArg(call, 0)),
    ),

    /**
     * The one member whose ARGUMENTS are re-encoded.
     *
     * `data` is `string | Uint8Array`, and the tag is what keeps the two
     * branches apart: without it a base64 STRING the plugin meant to write
     * verbatim is indistinguishable from bytes the child encoded, and the file
     * lands decoded. The separate `encoding` argument is orthogonal — it says
     * how the host should interpret a string it was given, not how the string
     * crossed.
     */
    "storage.write": defineHostApiPath("storage.write", (call) => {
      const relPath = stringArg(call, 0);
      const data = decodeWireBytes(call.args[1], `${call.path}(data)`);
      return hostApi.storage.write(relPath, data, optionalEncodingArg(call, 2));
    }),

    "storage.writeJson": defineHostApiPath("storage.writeJson", (call) => {
      const relPath = stringArg(call, 0);
      // An omitted value is not `undefined`-the-value: `JSON.stringify`
      // produces nothing for it and the write would fail deep inside `fs`.
      if (call.args.length < 2) reject(call, 1, "present");
      return hostApi.storage.writeJson(relPath, call.args[1], optionalIndentArg(call, 2));
    }),

    "storage.rm": defineHostApiPath("storage.rm", (call) => {
      const relPath = stringArg(call, 0);
      return hostApi.storage.rm(relPath, optionalRemoveOptionsArg(call, 1));
    }),

    "storage.mkdir": defineHostApiPath("storage.mkdir", (call) =>
      hostApi.storage.mkdir(stringArg(call, 0)),
    ),

    /**
     * Fails closed on a missing OS keychain with
     * `plugin-storage-encryption-unavailable`, which is a DIFFERENT answer from
     * a missing file: nothing was written, and the plaintext never reached the
     * disk.
     */
    "storage.writeEncrypted": defineHostApiPath("storage.writeEncrypted", (call) => {
      const relPath = stringArg(call, 0);
      return hostApi.storage.writeEncrypted(relPath, stringArg(call, 1));
    }),

    "storage.readEncrypted": defineHostApiPath("storage.readEncrypted", (call) =>
      hostApi.storage.readEncrypted(stringArg(call, 0)),
    ),
  };
}


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
 * child, `peer-gone` means there is nobody to write to, and `revoked` is the
 * host's own decision. That third one IS sent, and it is sent from the
 * dispatcher's release path — the one place that already owns the envelope —
 * rather than from six handlers each stamping their own. Nothing in this group
 * writes a notification; `SubscriptionScope.release` is the whole interface to
 * it.
 */

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
      `[host-api-dispatcher] '${call.path}': ${name} must be a string`,
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
      `[host-api-dispatcher] '${call.path}': expected ${arity} arguments, received ${call.args.length}`,
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
export function createConfigSubscriptionHostApiPaths(
  hostApi: ConfigSubscriptionHostApi,
): Record<DispatchedConfigSubscriptionPath, HostApiPathHandler> {
  return {
    "config.set": defineHostApiPath("config.set", async (call) => {
      requireArity(call, 2);
      const key = stringArgument(call, 0, "key");
      // RETURNED, not awaited-and-discarded. `await` here would resolve
      // `undefined` whatever the host produced, which quietly disables the
      // dispatcher's own check that a `void` member returned nothing — the one
      // thing between a drifted host implementation and a child stub that
      // silently ignores its result. The value itself is whatever the plugin
      // passed; the dispatcher has already proven it survives JSON, and the
      // schema decision belongs to the host implementation, not here.
      return hostApi.config.set(key, call.args[1]);
    }),

    "config.onChange": defineHostApiPath("config.onChange", async (call, scope) => {
      requireArity(call, 2);
      const key = stringArgument(call, 0, "key");
      const subscriptionId = stringArgument(call, 1, "subscriptionId");
      const unsubscribe = hostApi.config.onChange(key, (value) => {
        // ENCODED, not spread. `SECRET_REDACTED_SENTINEL` is a Symbol and
        // `JSON.stringify` drops a symbol-valued property, so `{ key, value }`
        // would reach the child as `{ key }` — read there as "cleared" — and
        // the plugin would never learn its secret changed. The encoder lives
        // beside the decoder so the two halves cannot drift.
        scope.deliver(subscriptionId, encodeConfigChange(key, value));
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
      // Returned for the same reason `config.set` is: this member declares no
      // result, and a handler that discarded the host's is a handler the
      // void-drift check can never fire on.
      return hostApi.onShutdown(async () => {
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
    message: errorMessage(error),
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
  /**
   * Where the child's `context.log` goes.
   *
   * Required, not optional. The in-process arm writes these straight to the
   * host logger, and for a long time this arm dropped them on the floor: the
   * child emitted a `log` notification, the wire declared it, and
   * {@link HostApiDispatcher.handleNotification} handled only the two
   * registration-ending kinds. Every `context.log` from every out-of-process
   * plugin went nowhere, which is how a plugin whose worker failed to start on
   * every boot could ship — it was forwarding the worker's stderr into a sink
   * that did not exist. A dispatcher with nowhere to put a log line must not be
   * constructible.
   */
  readonly log: (message: string, meta?: unknown) => void;
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
   * Child → host notifications.
   *
   * Two of them end a registration and go through the same ledger — an abort is
   * not a second mechanism, it is a close whose teardown happens to cancel. The
   * third, `log`, ends nothing: it is the child's `context.log` arriving, and it
   * is forwarded to the sink the owner supplied.
   */
  handleNotification(notification: HostApiNotification): void {
    if (notification.kind === "log") {
      // The message is the plugin's own text, passed through unchanged so an
      // isolated plugin's log line reads the same as an in-process one. Only
      // the attribution is the host's to add, and the owner does that.
      this.options.log(notification.message, notification.meta);
      return;
    }
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
