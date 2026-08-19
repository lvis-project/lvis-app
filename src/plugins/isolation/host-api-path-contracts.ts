/**
 * The boundary decision for every hostApi member, one entry per member
 * (`docs/blueprints/plugin-process-isolation.md` §3).
 *
 * This is the file four handler authors working in parallel read INSTEAD of
 * talking to each other. Each entry answers the same four questions in the same
 * order — arguments, result, lifetime, errors — so a handler's obligations are
 * legible before a line of it is written, and a handler that contradicts its
 * declaration does not compile (`defineHostApiPath` derives the invoke signature
 * from the contract).
 *
 * WHY THE KEYS ARE A LITERAL UNION. `as const satisfies` makes
 * {@link HostApiPath} the exact set of 36 members rather than `string`, so the
 * host dispatch table is `Record<HostApiPath, …>` and a MISSING handler is a
 * compile error. The complementary direction — a member added to
 * `HOSTAPI_EFFECT_BY_PATH` without a contract here — is not expressible in the
 * type system and is pinned by the contract test instead.
 *
 * Electron-free: the child imports this to know which members it may answer
 * locally and which need a round trip.
 */
import type { HostApiPathContract } from "./host-api-wire.js";

/**
 * Every hostApi member and how it crosses.
 *
 * Ordered to mirror `HOSTAPI_EFFECT_BY_PATH` in `permissions/effect-kind.ts`,
 * which is the surface SOT this table is asserted against.
 */
export const HOSTAPI_PATH_CONTRACTS = {
  // ─── storage.* ────────────────────────────────────────────────────────────
  // A pure lexical join under `pluginDataDir`, which the child already holds.
  // Answering it in the child costs no round trip; the traversal rejection is
  // the host's to enforce at every method that actually touches the disk, so
  // the child's answer cannot become the security decision.
  "storage.resolve": {
    arguments: "child-local",
    result: "child-local",
    lifetime: "none",
    errors: [],
  },
  // Declares `Uint8Array`, delivers a Node `Buffer`, and `Buffer` has a
  // `toJSON()` — so a naive round trip SUCCEEDS into `{ type, data }`, a
  // different type that reads as success. The encoding has to be explicit
  // precisely because JSON will not object.
  "storage.read": {
    arguments: "plain-json",
    result: "encoded",
    lifetime: "none",
    errors: ["plugin-storage"],
  },
  "storage.readText": {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["plugin-storage"],
  },
  "storage.readJson": {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["plugin-storage"],
  },
  "storage.list": {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["plugin-storage"],
  },
  "storage.exists": {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["plugin-storage"],
  },
  // `data: string | Uint8Array` — the bytes branch needs a tagged encoding, and
  // the tag is what stops a base64 string being written as text.
  "storage.write": {
    arguments: "encoded",
    result: "void",
    lifetime: "none",
    errors: ["plugin-storage", "effect-boundary-denied"],
  },
  "storage.writeJson": {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: ["plugin-storage", "effect-boundary-denied"],
  },
  "storage.rm": {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: ["plugin-storage", "effect-boundary-denied"],
  },
  "storage.mkdir": {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: ["plugin-storage", "effect-boundary-denied"],
  },
  "storage.writeEncrypted": {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: [
      "plugin-storage",
      "plugin-storage-encryption-unavailable",
      "effect-boundary-denied",
    ],
  },
  "storage.readEncrypted": {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["plugin-storage", "plugin-storage-encryption-unavailable"],
  },
  // ─── config.* ─────────────────────────────────────────────────────────────
  // Synchronous, and a process boundary is not. The resolved config object is
  // pushed at construction and re-pushed on every change, so the child reads a
  // local copy. Ordering obligation on the handler author: the push is emitted
  // BEFORE the `config.set` reply, so a plugin that sets-then-gets sees its own
  // write.
  "config.get": {
    arguments: "child-local",
    result: "child-local",
    lifetime: "none",
    errors: [],
  },
  "config.set": {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: [],
  },
  "config.onChange": {
    arguments: "handler-registration",
    result: "handle",
    lifetime: "child-disposable",
    errors: [],
  },
  // ─── top level ────────────────────────────────────────────────────────────
  // Cannot be snapshot-pushed: shipping secrets into the child eagerly is the
  // opposite of the goal, and the secret gate is a per-call decision.
  getSecret: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: [],
  },
  getInstalledPluginIds: {
    arguments: "child-local",
    result: "child-local",
    lifetime: "none",
    errors: [],
  },
  hasRoutineBySource: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: [],
  },
  getAppPreference: {
    arguments: "child-local",
    result: "child-local",
    lifetime: "none",
    errors: [],
  },
  probePrivateHost: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: [],
  },
  // `opts.signal` becomes an abort-channel id; the reply is
  // `{ ok, vendor, baseUrl?, key, leaseId }` and the child synthesises
  // `bearer()` / `release()` around it. `release()` drops the child's copy AND
  // sends the release, so the host can unwire its own.
  resolveApiKey: {
    arguments: "encoded",
    result: "handle",
    lifetime: "child-disposable",
    errors: [],
  },
  // Fire-and-forget on the wire, but it throws SYNCHRONOUSLY today on a denied
  // event. The host pushes the plugin's declared emittable set at construction
  // so the child stub can preserve that throw; the host re-checks
  // authoritatively and writes the denial audit. Both run — the host check is
  // the control, the child check only preserves the contract's timing.
  emitEvent: {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: [],
  },
  onEvent: {
    arguments: "handler-registration",
    result: "handle",
    lifetime: "child-disposable",
    errors: [],
  },
  onPluginsChanged: {
    arguments: "handler-registration",
    result: "handle",
    lifetime: "child-disposable",
    errors: [],
  },
  // The odd one of the four subscriptions: the HOST ends it. The host sends a
  // shutdown request and awaits the reply before terminating, bounded by the
  // lifecycle timeout, then SIGTERM → SIGKILL. That bound is new and is an
  // improvement — today a plugin can hang shutdown forever.
  onShutdown: {
    arguments: "handler-registration",
    result: "void",
    lifetime: "host-terminated",
    errors: [],
  },
  logEvent: {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: [],
  },
  // `options.signal` is an `AbortSignal` → abort-channel id. The return is a
  // plain string, which is why counting non-representable members by return
  // value alone missed this one.
  callLlm: {
    arguments: "encoded",
    result: "plain-json",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  // Both directions non-representable. `init` may carry `Headers`, an
  // `AbortSignal` and a `ReadableStream` body; a stream body is REJECTED with a
  // typed error rather than silently buffered. The reply is
  // `{ status, statusText, headers, bodyBase64 }` under an explicit maximum —
  // exceeding it throws, never truncates. Streaming responses stop streaming,
  // and that loss is the decision, not an oversight.
  hostFetch: {
    arguments: "encoded",
    result: "encoded",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  // The host KEEPS OWNING the worker process — the sandbox grant machinery, the
  // wrapped-worker registry, the Windows holder-PID ACL lifecycle and the
  // managed-child registry all live in main. The child receives
  // `{ workerHandleId, socketPath, pid }` and registers child-local
  // stdout/stderr/exit listeners fed by host notifications. The isolated plugin
  // must NOT be permitted to spawn its own worker: a grandchild would sit
  // outside the grants keyed to host-allocated paths.
  spawnWorker: {
    arguments: "plain-json",
    result: "handle",
    lifetime: "child-disposable",
    errors: ["effect-boundary-denied"],
  },
  openExternalUrl: {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  openAuthWindow: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  openAuthPartitionViewer: {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  clearAuthPartition: {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  triggerConversation: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  // ─── agentApproval.* ──────────────────────────────────────────────────────
  // Blocks on a human. The child waits on a round trip that may take minutes,
  // so the handler author owns the interaction between a slow approval and the
  // child's own call timeout — a child timeout must not leave the host gate
  // pending (§7.5).
  "agentApproval.request": {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  "agentApproval.respond": {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: [],
  },
} as const satisfies Record<string, HostApiPathContract>;

/** The exact set of hostApi members the boundary carries. */
export type HostApiPath = keyof typeof HOSTAPI_PATH_CONTRACTS;

/** The contract for one member, narrowed to that member's literal declaration. */
export type ContractOf<P extends HostApiPath> = (typeof HOSTAPI_PATH_CONTRACTS)[P];

/**
 * Runtime membership test for a path arriving off the wire.
 *
 * `Object.hasOwn`, not `in`: the path is attacker-controlled input from the
 * least-trusted process in the system, and `"__proto__" in HOSTAPI_PATH_CONTRACTS`
 * is `true`. An `in` check would admit `__proto__`, `constructor` and `toString`
 * as hostApi members, and the dispatch-table lookup that follows would then hand
 * back something off `Object.prototype` instead of a handler.
 */
export function isHostApiPath(value: unknown): value is HostApiPath {
  return typeof value === "string" && Object.hasOwn(HOSTAPI_PATH_CONTRACTS, value);
}
