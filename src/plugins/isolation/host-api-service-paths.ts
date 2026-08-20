/**
 * The host handlers for the hostApi members that reach a host SERVICE
 * (`docs/blueprints/plugin-process-isolation.md` §3.1, §3.2).
 *
 * Nine members: network egress (`hostFetch`, `probePrivateHost`), the LLM
 * provider (`callLlm`), credentials (`getSecret`, `resolveApiKey`), the worker
 * supervisor (`spawnWorker`), the event bus (`emitEvent`), the audit log
 * (`logEvent`) and the routine store (`hasRoutineBySource`). Between them they
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
 * per-member argument shape — and those live in `host-api-service-payloads.ts`
 * because the child needs the same declarations.
 *
 * HOST-SIDE ONLY. The child's half is `host-api-service-child.ts`, which imports
 * neither this module nor the dispatcher.
 */
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { PluginHostApi, PluginWorkerSpec } from "../public-contract.js";
import { isPathWithin } from "../plugin-storage-containment.js";
import {
  defineHostApiPath,
  type HostApiCall,
  type HostApiPathHandler,
  type SubscriptionScope,
} from "./host-api-dispatcher.js";
import type { HostApiPath } from "./host-api-path-contracts.js";
import { HostApiBoundaryError } from "./host-api-wire.js";
import type { ServiceHostApiPath } from "./host-api-service-child.js";
import {
  decodeWireRequestInit,
  encodeWireHttpResponse,
  type WireApiKeyLease,
  type WireCallLlmOptions,
  type WireHttpResponse,
  type WireResolveApiKeyOptions,
  type WireWorkerHandle,
} from "./host-api-service-payloads.js";

/**
 * The subset of `hostApi` this group services.
 *
 * Narrowed rather than taking the whole surface so a handler cannot quietly
 * start calling a member that belongs to another group's contract.
 */
export type ServiceHostApi = Pick<
  PluginHostApi,
  | "getSecret"
  | "hasRoutineBySource"
  | "probePrivateHost"
  | "resolveApiKey"
  | "emitEvent"
  | "logEvent"
  | "callLlm"
  | "hostFetch"
  | "spawnWorker"
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
   * Every root this pair GRANTS for writing, rather than every root the child
   * can reach: ASRT merges its own default write paths into every wrap
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
    `[host-api-service-paths] '${path}': ${detail}`,
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
      `[host-api-service-paths] '${path}': this host build has no '${name}'`,
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
          `[host-api-service-paths] '${call.path}': the child released the lease before it resolved`,
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
 * `resolvePath` first, so `<dataDir>/../../etc` is compared as what it means
 * rather than as what it says. What is deliberately NOT done here is a
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
    const target = resolvePath(path);
    if (envelope.some((root) => isPathWithin(root, target))) continue;
    throw new HostApiBoundaryError(
      "effect-boundary-denied",
      `[host-api-service-paths] '${call.path}': spec.${field} entry '${path}' `
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
    hasRoutineBySource: hasRoutineBySourcePath(hostApi),
    probePrivateHost: probePrivateHostPath(hostApi),
    resolveApiKey: resolveApiKeyPath(hostApi),
    emitEvent: emitEventPath(hostApi),
    logEvent: logEventPath(hostApi),
    callLlm: callLlmPath(hostApi),
    hostFetch: hostFetchPath(hostApi),
    spawnWorker: spawnWorkerPath(hostApi, confinement),
  };
}
