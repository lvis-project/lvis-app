/**
 * The wire contract between the host and a plugin running in its own process
 * (`docs/blueprints/plugin-process-isolation.md` §2, §3).
 *
 * Today `hostApi` is a plain object handed to a factory in the SAME heap, so
 * every member is a direct call and NOTHING pins its shape. Behind a process
 * boundary each member becomes a message, and a message is JSON. This module is
 * the vocabulary that makes that translation checkable BEFORE any single member
 * is implemented.
 *
 * The load-bearing type is {@link HostApiPathContract}. §3 decided four
 * independent things for every member — how its ARGUMENTS reach the host, how
 * its RETURN reaches the child, whether the call creates a two-sided LIFETIME,
 * and which ERROR IDENTITIES it may reply with — and 38 members × 4 axes is 152
 * chances to change behaviour that no existing test notices, because today each
 * one is a function call nothing was written to pin. Making all four fields
 * REQUIRED means a member cannot be declared with an axis left undecided: the
 * omission is a type error, not a runtime surprise in the field.
 *
 * ONE MODULE BECAUSE BOTH PROCESSES NEED ALL OF IT. Alongside the envelope and
 * the error taxonomy this holds the contract table itself, the partition of
 * paths each handler group carries, and the payload shapes that stand in for
 * values JSON cannot carry. Those were three sibling files, but none of them is
 * host-only or child-only — a declaration either side could not import would be
 * two hand-matched literals instead of one checkable contract, which is the
 * failure this module exists to prevent.
 *
 * ELECTRON-FREE BY CONSTRUCTION. Everything here is imported by the child, and
 * the child is a plain Node process where `import("electron")` yields nothing.
 * The host-side classification of a thrown host error into a wire error lives in
 * `host-api-dispatcher.ts` instead, because recognising `EffectBoundaryDeniedError`
 * or `ManifestIntegrityError` means importing modules that reach Electron
 * through the approval gate.
 */
import {
  base64DecodedLength,
  describeNonJson,
} from "../../shared/json-representable.js";
import type { PluginLifecycleEvent } from "../public-contract.js";

/**
 * Wire format revision. A child built against a different revision is rejected
 * at the dispatcher rather than parsed optimistically — a mixed-revision pair
 * cannot be made safe by guessing which fields it meant.
 */
export const HOST_API_WIRE_VERSION = 1;

/**
 * Identity every message carries. `pluginId` and `generationId` are checked by
 * the host on EVERY inbound message: the child is told which incarnation it
 * serves, and a message naming a different one is refused. This is the wire form
 * of the `withPinnedGeneration` lease that today is a host-side closure the
 * plugin shares a heap with (§2.4).
 */
export interface HostApiEnvelope {
  readonly wire: typeof HOST_API_WIRE_VERSION;
  readonly pluginId: string;
  readonly generationId: string;
}

/** One `hostApi.<path>(...args)` invocation travelling child → host. */
export interface HostApiRequest extends HostApiEnvelope {
  /** Correlates the reply. Allocated by the child; opaque to the host. */
  readonly callId: string;
  readonly path: HostApiPath;
  /** Positional arguments, ALREADY marshalled per the path's contract. */
  readonly args: readonly unknown[];
}

/** The settled outcome of a {@link HostApiRequest}, travelling host → child. */
export type HostApiReply =
  | {
      readonly wire: typeof HOST_API_WIRE_VERSION;
      readonly callId: string;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly wire: typeof HOST_API_WIRE_VERSION;
      readonly callId: string;
      readonly ok: false;
      readonly error: HostApiWireError;
    };

/**
 * Why a subscription ended. The distinction is not cosmetic: `disposed` means
 * the child let go and the host must be told, `peer-gone` means the other side
 * is already unreachable and telling it would be a message into a closed pipe.
 * Collapsing the two is how a two-sided lifetime turns into a ping-pong loop or
 * a write-after-close.
 */
export type SubscriptionCloseReason = "disposed" | "peer-gone" | "revoked";

/**
 * Fire-and-forget traffic in both directions. Notifications carry no `callId`
 * and are never awaited; anything that needs an answer is a {@link HostApiRequest}.
 */
export type HostApiNotification =
  /** host → child: an event for a subscription the child opened. */
  | (HostApiEnvelope & {
      readonly kind: "subscription-event";
      readonly subscriptionId: string;
      readonly payload: unknown;
    })
  /**
   * host → child: the host ended a subscription the child still holds.
   *
   * Sent for exactly one of the three close reasons — `revoked`, the one the
   * HOST decided. `disposed` came from the child and echoing it back would be a
   * ping-pong; `peer-gone` means the pipe is already closed and sending would
   * be a write on it. The single sender is the dispatcher's own release path,
   * which owns the envelope, rather than each lifetime-bearing handler stamping
   * its own.
   */
  | (HostApiEnvelope & {
      readonly kind: "subscription-closed";
      readonly subscriptionId: string;
      readonly reason: SubscriptionCloseReason;
    })
  /** child → host: the plugin called its disposer; release the host side. */
  | (HostApiEnvelope & {
      readonly kind: "subscription-release";
      readonly subscriptionId: string;
    })
  /**
   * child → host: cancel the work behind an abort channel.
   *
   * An `AbortSignal` cannot cross, so the child sends an id and the host holds
   * the `AbortController`. Three members carry one (`hostFetch`, `callLlm`,
   * `resolveApiKey`), which is why it is a shared mechanism and not three.
   */
  | (HostApiEnvelope & {
      readonly kind: "abort";
      readonly subscriptionId: string;
    })
  /** child → host: `context.log`, which is a host closure today (§3.4). */
  | (HostApiEnvelope & {
      readonly kind: "log";
      readonly message: string;
      readonly meta?: unknown;
    })
  /**
   * host → child: the installed-plugin set changed.
   *
   * `getInstalledPluginIds` is synchronous and a process boundary is not, so
   * §3.1 answers it with a host-pushed snapshot rather than a round trip. The
   * push is a NOTIFICATION and not a subscription because the child holds no
   * handler for it: the snapshot is read by a member, and the member has to
   * answer whether or not the plugin ever subscribed to `onPluginsChanged`.
   */
  | (HostApiEnvelope & {
      readonly kind: "installed-plugins";
      readonly pluginIds: readonly string[];
    })
  /**
   * host → child: the plugin's resolved config changed.
   *
   * `config.get` is synchronous, so §3.1 answers it from a host-pushed snapshot
   * — and a snapshot is only correct while something re-pushes it. The
   * construction push seeds the child's copy; this is every push after it, and
   * without it a value the user edits in Settings would be answered by the
   * child with whatever it held when the plugin started, forever, with nothing
   * anywhere reporting the divergence.
   *
   * TWO FIELDS, NOT ONE OBJECT, because "the key is unset" has to survive.
   * `config.get` answers `undefined` for a cleared key, and `undefined` is not
   * a JSON value: a plain record would simply lose the property and the child
   * would keep the stale value it was supposed to drop. So `keys` carries the
   * full key set the host resolves and `values` carries only the ones that have
   * a value — a key present in `keys` and absent from `values` is unset, and
   * the child deletes it.
   *
   * The push covers the keys the HOST can enumerate (the plugin's config
   * schema, its manifest config, and the construction snapshot). A key a plugin
   * invents at runtime through `config.set` is not among them and is not
   * re-pushed: the child already wrote it locally when its own `config.set`
   * resolved, and the host's settings surface is schema-driven, so nothing else
   * can change it. That is the limit of this member, stated rather than left to
   * be discovered.
   */
  | (HostApiEnvelope & {
      readonly kind: "config-snapshot";
      readonly keys: readonly string[];
      readonly values: Record<string, unknown>;
    })
  /**
   * host → child: an allow-listed HOST preference now reads differently.
   *
   * The sibling of `config-snapshot`, for the other config value a plugin
   * reads. `getAppPreference` is synchronous too, so §3.1 answers it from a
   * host-pushed snapshot as well — and until this notification existed there
   * was nothing to re-push FROM, which is why the child left that one member
   * unwired rather than answering with a value frozen at plugin start.
   * `ms-graph` reads `webView.preferredFlow` at CALL time, so a construction
   * snapshot with no re-push would answer it wrong by construction.
   *
   * TWO FIELDS, NOT ONE OBJECT, for the same reason `config-snapshot` splits
   * them: the reader answers `undefined` for an unset preference, and
   * `undefined` is not a JSON value. A plain record would simply lose the
   * property and the child would keep the value it was supposed to drop. So
   * `keys` carries the full allowlist and `values` only the keys that have one
   * — a key in `keys` and absent from `values` is unset, and the child deletes
   * it.
   *
   * The key set is the HOST's allowlist
   * (`boot/steps/plugin-runtime/app-preference.ts`); nothing a plugin sends can
   * widen what it is told.
   */
  | (HostApiEnvelope & {
      readonly kind: "preference-snapshot";
      readonly keys: readonly string[];
      readonly values: Record<string, unknown>;
    });

// ───────────────────────────────────────────────────────────────────────────
// The four axes §3 decided, one per member.
// ───────────────────────────────────────────────────────────────────────────

/**
 * How a member's ARGUMENTS reach the host.
 *
 * - `plain-json` — they cross unchanged, and the dispatcher REJECTS a request
 *   whose arguments would not survive a JSON round-trip. A `Date` or a `Buffer`
 *   round-trips successfully into a different type, so "did stringify throw" is
 *   not the question being asked (see `describeNonJson`).
 * - `encoded` — the child re-shapes them first: base64 for bytes, `[k, v][]` for
 *   `Headers`, an abort-channel id for an `AbortSignal`. The host decodes.
 * - `handler-registration` — one argument is a FUNCTION. It never crosses; the
 *   child keeps it and a subscription id crosses instead.
 * - `child-local` — the call never leaves the child (§3.1). Declared so the axis
 *   is answered rather than absent.
 */
export type ArgumentMarshalling =
  | "plain-json"
  | "encoded"
  | "handler-registration"
  | "child-local";

/**
 * How a member's RETURN reaches the child.
 *
 * - `plain-json` — crosses unchanged, and the dispatcher rejects a return value
 *   that would not survive the round-trip. `LoopbackTransport` now applies the
 *   same rule to the host→plugin direction, so this is that rule extended to
 *   the direction it does not carry: hostApi traffic is not MCP traffic and
 *   never passes through that transport.
 * - `void` — nothing comes back.
 * - `encoded` — the child reconstructs a non-clonable value (a `Response`, a
 *   `Uint8Array`) from a JSON body.
 * - `handle` — the reply is an opaque id and the child synthesises a LOCAL stub
 *   around it. The plugin holds the id; the host keeps owning the resource.
 * - `child-local` — no round trip: the child computes the answer, or reads a
 *   host-pushed snapshot.
 */
export type ResultMarshalling =
  | "plain-json"
  | "void"
  | "encoded"
  | "handle"
  | "child-local";

/**
 * Whether the call creates state that OUTLIVES the reply, and who may end it.
 *
 * §9 names the subscription members as the worst of this work for exactly this
 * reason: a lifetime with two owners leaks unless both deaths are handled. See
 * `subscription-ledger.ts` for the mechanism that closes it once for all of them.
 *
 * - `none` — the reply settles the call and nothing survives it.
 * - `child-disposable` — the child holds a disposer. The host must ALSO release
 *   when the child dies without calling it.
 * - `host-terminated` — the host decides when it ends and tells the child.
 */
export type DisposerLifetime = "none" | "child-disposable" | "host-terminated";

/**
 * The complete boundary decision for ONE hostApi member. Every field is
 * required: a member declared with an axis missing does not compile, which is
 * the point — four separate authors implementing four handlers in parallel
 * cannot each silently skip a different axis.
 */
export interface HostApiPathContract {
  readonly arguments: ArgumentMarshalling;
  readonly result: ResultMarshalling;
  readonly lifetime: DisposerLifetime;
  /**
   * The error identities this member may reply with, beyond
   * {@link UNIVERSAL_WIRE_ERROR_CODES}. Closed at the type level so a handler
   * cannot invent a code the child has no reconstructor for.
   */
  readonly errors: readonly HostApiWireErrorCode[];
}

/** The reply body for a `handle`-returning member: an id, never a live object. */
export interface HostApiHandle {
  readonly handleId: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Error identity (§3.3).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The closed set of error identities that may cross the boundary.
 *
 * An `Error` degrades to `{ message, stack }` on a wire, and the host today
 * distinguishes several by CLASS. A code is what survives, and it is strictly
 * better than what §3.3 was trying to avoid: no consumer ever has to match on a
 * message string, and adding a code is a deliberate edit in one union that both
 * sides compile against.
 */
export type HostApiWireErrorCode =
  // ── Boundary-level refusals. The call never reached a host implementation.
  | "wire-version-mismatch"
  | "plugin-mismatch"
  | "generation-mismatch"
  | "plugin-inactive"
  | "path-unknown"
  | "path-not-dispatchable"
  | "path-not-implemented"
  | "argument-marshalling-rejected"
  | "result-marshalling-rejected"
  | "payload-too-large"
  | "subscription-unknown"
  // ── Host decisions the plugin is expected to branch on.
  | "effect-boundary-denied"
  | "manifest-integrity-violation"
  | "detached-operation"
  | "plugin-storage"
  | "plugin-storage-encryption-unavailable"
  // ── Anything the host threw that is none of the above. Deliberately last and
  //    deliberately opaque: a host internal is not a contract.
  | "host-internal";

/**
 * Codes any path may reply with, because they are produced by the boundary
 * itself before (or instead of) reaching the path's implementation. A path's
 * `errors` list names only what its OWN implementation can raise.
 */
export const UNIVERSAL_WIRE_ERROR_CODES: readonly HostApiWireErrorCode[] = [
  "wire-version-mismatch",
  "plugin-mismatch",
  "generation-mismatch",
  "plugin-inactive",
  "path-unknown",
  "path-not-dispatchable",
  "path-not-implemented",
  "argument-marshalling-rejected",
  "result-marshalling-rejected",
  "payload-too-large",
  "host-internal",
];

/**
 * A coded refusal raised by the boundary itself, on EITHER side.
 *
 * It lives here rather than with the dispatcher because the child raises the
 * same codes the host does — a payload the child refuses to encode and a
 * payload the host refuses to decode are the same failure seen from two ends,
 * and giving them two error types would mean two ways to report one thing.
 */
export class HostApiBoundaryError extends Error {
  readonly code: HostApiWireErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: HostApiWireErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HostApiBoundaryError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A host error in transit. `name` carries the host class's own name because
 * `public-contract.ts` documents `name` as the matcher for consumers "across
 * realm boundaries" — a process boundary being the strongest such boundary.
 * `detail` is a JSON bag of the class's own non-secret fields.
 */
export interface HostApiWireError {
  readonly code: HostApiWireErrorCode;
  readonly name: string;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * What a plugin catches when a hostApi call fails in an isolated child.
 *
 * DELIBERATE DEVIATION from §3.3's "the child stub reconstructs the matching
 * error class", stated rather than hidden. Two reasons, and the design predates
 * both being verifiable:
 *
 *  1. Every host error class §3.3 names except the storage pair lives in a
 *     module that reaches Electron through the approval gate. A child that
 *     imported them to reconstruct them would not start.
 *  2. `instanceof` does not survive a process boundary anyway. The class the
 *     child would build is a DIFFERENT class from the host's with the same
 *     name, so the check a plugin author writes would silently be a name check
 *     wearing an `instanceof` costume.
 *
 * So the identity that crosses is the CODE — a closed union both sides compile
 * against — with the host's `name` preserved for the string-matching contract
 * `public-contract.ts` already publishes. Nothing is reconstructed by matching a
 * message.
 */
export class PluginHostApiError extends Error {
  readonly code: HostApiWireErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(wire: HostApiWireError) {
    super(wire.message);
    this.name = wire.name;
    this.code = wire.code;
    this.detail = wire.detail;
  }
}

/** Rebuild the throwable a failed reply represents. Child side. */
export function reconstructWireError(wire: HostApiWireError): PluginHostApiError {
  return new PluginHostApiError(wire);
}

/**
 * The message `assertActiveHostApi` throws in-process today
 * (`host-api-factory.ts`). Pinned here so the isolated path reproduces it
 * byte-for-byte instead of inventing a second wording for the same condition.
 */
export function inactiveHostApiMessage(pluginId: string, memberPath: string): string {
  return `[plugin:${pluginId}] ${memberPath}: plugin instance is no longer active`;
}

// ───────────────────────────────────────────────────────────────────────────
// The transports the two sides talk through.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The child's half of the reverse channel: how a hostApi stub reaches the host.
 *
 * Deliberately NOT tied to stdio. The host→plugin direction already has a
 * transport (`StdioServerLoop` + `PluginMcpServer`); multiplexing the reverse
 * direction onto the same pipes is a transport concern, and pinning it here
 * would make every hostApi handler untestable without a subprocess.
 */
export interface HostApiChannel {
  call(request: HostApiRequest): Promise<HostApiReply>;
  notify(notification: HostApiNotification): void;
}

/** The host's half: where host-originated notifications go. */
export interface ChildNotificationSink {
  deliver(notification: HostApiNotification): void;
}

// ───────────────────────────────────────────────────────────────────────────
// Byte payloads (§3.2). One codec, because three members carry bytes.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hard ceiling on ONE byte payload crossing the boundary, in decoded bytes.
 *
 * Exceeding it THROWS. It never truncates, because a truncated read is a
 * successful call that returned the wrong file, and nothing downstream can tell
 * the difference. Base64 inflates the encoded form by 4/3, so the framed
 * message is up to ~21 MB — bounded, and bounded is the requirement.
 */
export const WIRE_BYTES_MAX = 16 * 1024 * 1024;

/**
 * Bytes or text on the wire, with the encoding stated rather than inferred.
 *
 * The tag is load-bearing. `storage.write` takes `string | Uint8Array`, and
 * without a tag a base64 STRING the plugin meant to write verbatim is
 * indistinguishable from bytes the child encoded — so the file lands decoded.
 * Nothing in JSON objects to that; the tag is what makes the two branches
 * different values instead of the same one.
 */
export interface WireBytes {
  readonly encoding: "utf8" | "base64";
  readonly data: string;
}

/** Put `string | Uint8Array` on the wire with its branch preserved. */
export function encodeWireBytes(
  value: string | Uint8Array,
  label: string,
): WireBytes {
  if (typeof value === "string") {
    assertWithinWireBytesMax(Buffer.byteLength(value, "utf8"), label);
    return { encoding: "utf8", data: value };
  }
  assertWithinWireBytesMax(value.byteLength, label);
  return { encoding: "base64", data: Buffer.from(value).toString("base64") };
}

/** Take `string | Uint8Array` off the wire, with the branch it was sent as. */
export function decodeWireBytes(
  value: unknown,
  label: string,
): string | Uint8Array {
  const wire = asWireBytes(value, label);
  if (wire.encoding === "utf8") {
    assertWithinWireBytesMax(Buffer.byteLength(wire.data, "utf8"), label);
    return wire.data;
  }
  // Bounded BEFORE decoding, which is the only place the bound can prevent the
  // allocation rather than observe it.
  assertWithinWireBytesMax(base64DecodedLength(wire.data), label);
  const bytes = Buffer.from(wire.data, "base64");
  // `Buffer.from(…, "base64")` is LENIENT — it drops characters outside the
  // alphabet — so the pre-decode figure is an upper bound, not the answer.
  assertWithinWireBytesMax(bytes.byteLength, label);
  return new Uint8Array(bytes);
}

/** Take bytes off the wire from a member DECLARED to deliver bytes. */
export function decodeWireBinary(value: unknown, label: string): Uint8Array {
  const decoded = decodeWireBytes(value, label);
  if (typeof decoded === "string") {
    throw new HostApiBoundaryError(
      "result-marshalling-rejected",
      `[host-api-wire] ${label}: expected bytes, received utf8-tagged text`,
    );
  }
  return decoded;
}

function asWireBytes(value: unknown, label: string): WireBytes {
  const candidate = value as WireBytes | null;
  if (
    candidate === null
    || typeof candidate !== "object"
    || typeof candidate.data !== "string"
    || (candidate.encoding !== "utf8" && candidate.encoding !== "base64")
  ) {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[host-api-wire] ${label}: not a tagged byte payload`,
    );
  }
  return candidate;
}

function assertWithinWireBytesMax(byteLength: number, label: string): void {
  if (byteLength <= WIRE_BYTES_MAX) return;
  throw new HostApiBoundaryError(
    "payload-too-large",
    `[host-api-wire] ${label}: ${byteLength} bytes exceeds the ${WIRE_BYTES_MAX}-byte boundary limit`,
    { byteLength, limit: WIRE_BYTES_MAX },
  );
}


// ─────────────────────────────────────────────────────────────────────────
// The path SOT: one entry per hostApi member
// ─────────────────────────────────────────────────────────────────────────

/**
 * The boundary decision for every hostApi member, one entry per member
 * (`docs/blueprints/plugin-process-isolation.md` §3).
 *
 * This is the table four handler authors working in parallel read INSTEAD of
 * talking to each other. Each entry answers the same four questions in the same
 * order — arguments, result, lifetime, errors — so a handler's obligations are
 * legible before a line of it is written, and a handler that contradicts its
 * declaration does not compile (`defineHostApiPath` derives the invoke signature
 * from the contract).
 *
 * WHY THE KEYS ARE A LITERAL UNION. `as const satisfies` makes
 * {@link HostApiPath} the exact set of 38 members rather than `string`, so the
 * host dispatch table is `Record<HostApiPath, …>` and a MISSING handler is a
 * compile error. The complementary direction — a member added to
 * `HOSTAPI_EFFECT_BY_PATH` without a contract here — is not expressible in the
 * type system and is pinned by the contract test instead.
 *
 * The child reads it to know which members it may answer locally and which need
 * a round trip.
 */

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
  // Text and a key out, a discriminated envelope back. Nothing executable
  // crosses, and nothing outlives the call — the proposal the host stores is
  // reachable afterwards only through the board, never through a handle.
  proposeWork: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  withdrawWorkProposal: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
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
  //
  // `child-disposable` because of that signal, not because of the return. The
  // abort channel IS a registration: the child allocates its id and holds the
  // release, the host holds the `AbortController`, and a child that dies
  // mid-call leaves the host generating for nobody unless the host releases it
  // too — the definition of a two-sided lifetime. Declaring `none` here would
  // also deny the handler the shared abort registry (`SubscriptionScope` is
  // handed only to lifetime-bearing members), which is what would push a
  // handler into inventing a second one.
  callLlm: {
    arguments: "encoded",
    result: "plain-json",
    lifetime: "child-disposable",
    errors: ["effect-boundary-denied"],
  },
  // Both directions non-representable. `init` may carry `Headers`, an
  // `AbortSignal` and a `ReadableStream` body; a stream body is REJECTED with a
  // typed error rather than silently buffered. The reply is
  // `{ status, statusText, headers, body }` under an explicit maximum —
  // exceeding it throws, never truncates. `body` is the SHARED tagged byte
  // payload (`WireBytes`), so the one codec three members already share carries
  // this one too. Streaming responses stop streaming,
  // and that loss is the decision, not an oversight.
  // `child-disposable` for the same reason as `callLlm`: `init.signal` becomes
  // an abort channel the child opens and the host must release when the child
  // dies, or the host keeps an egress in flight on behalf of a process that no
  // longer exists.
  hostFetch: {
    arguments: "encoded",
    result: "encoded",
    lifetime: "child-disposable",
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
  // The host-owned loopback redirect catcher. `handle` is the only state that
  // crosses, and it is a NAME rather than a resource: the child cannot act on
  // it except by handing it back to one of these three members, each of which
  // re-checks that the calling plugin is its owner. That is why `lifetime` is
  // "none" and not "child-disposable" — nothing on the child side needs
  // disposing, because nothing on the child side holds anything.
  "authRedirect.open": {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  // A read of what already arrived, so no mutating-effect verdict applies —
  // the same reasoning `getAuthPartitionCookies` carries. Its bound is the
  // host's ownership check plus the timeout, neither of which is a boundary
  // denial.
  "authRedirect.wait": {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: [],
  },
  "authRedirect.close": {
    arguments: "plain-json",
    result: "void",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  // The folder chooser. Takes nothing and returns paths, so the only thing
  // crossing is the user's answer. `errors` is empty for the same reason
  // `authRedirect.wait` has none: the effect is a READ (the picked directory
  // was already readable — the child's read confinement is deny-only), so no
  // mutating-effect verdict applies. Its bounds are the user's dismissal and
  // the one-chooser-per-plugin refusal, neither of which is a boundary denial.
  pickFolders: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: [],
  },
  // A drive letter in, a UNC string or `null` out. Plain data both ways, and
  // the only caller-influenced value never reaches a shell: the host validates
  // the letter and owns the command. `errors` is empty because the two
  // outcomes that cross are both ANSWERS — a UNC root, or `null` for a local
  // disk. A lookup that could not run rejects, and a rejection is not a
  // boundary verdict.
  resolveMappedDriveRoot: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: [],
  },
  listAudioInputDevices: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: [],
  },
  // A handle for the same reason `spawnWorker` is one: the host owns the
  // resource and has to keep owning it, and the frames are addressed to the
  // ONE plugin that asked. Delivering them on the event bus instead would hand
  // every installed plugin the microphone, because that bus broadcasts.
  startAudioCapture: {
    arguments: "plain-json",
    result: "handle",
    lifetime: "child-disposable",
    // Opening a microphone is a WRITE in the effect SOT, so the gate can fire
    // on it and the denial has to be a verdict the child can tell apart from
    // a capture that simply failed to start.
    errors: ["effect-boundary-denied"],
  },
  // A handle for the same reason the two above are: the host owns the window
  // and has to keep owning it, and a detach is addressed to the ONE plugin
  // whose card went away. On the event bus every installed plugin would hear
  // that another one's recorder had closed.
  // Plain JSON both ways: a panel id in, the applied height out. It names an
  // existing handle rather than creating one, so it opens no lifetime of its
  // own.
  resizeFloatingPanel: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    errors: ["effect-boundary-denied"],
  },
  attachFloatingPanel: {
    arguments: "plain-json",
    result: "handle",
    lifetime: "child-disposable",
    // Putting a surface on top of every other application is a WRITE in the
    // effect SOT, so the gate can fire on it, and the denial has to be a
    // verdict the child can tell apart from a dock that was simply full.
    errors: ["effect-boundary-denied"],
  },
  // The gated read-back of the host-held session cookies. Values cross the
  // boundary by design — that is what the caller needs to inject a session
  // into a separate browser context — so the host, not the child, decides
  // which cookies are in the answer (own partition ∩ declared allow-list).
  getAuthPartitionCookies: {
    arguments: "plain-json",
    result: "plain-json",
    lifetime: "none",
    // A READ of the host's own jar: it mutates nothing, so the mutating-effect
    // gate cannot fire and there is no denial for the boundary to carry. What
    // bounds it is the host's own scoping (own partition ∩ declared allow-list)
    // plus the capability gate, neither of which is an effect-boundary verdict.
    errors: [],
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


// ─────────────────────────────────────────────────────────────────────────
// The path partitions each handler group carries
// ─────────────────────────────────────────────────────────────────────────

/** The members the interaction handler group carries. */
export const INTERACTION_HOSTAPI_PATHS = [
  "openExternalUrl",
  "openAuthWindow",
  "openAuthPartitionViewer",
  "clearAuthPartition",
  "authRedirect.open",
  "authRedirect.wait",
  "authRedirect.close",
  "pickFolders",
  "triggerConversation",
  "agentApproval.request",
  "agentApproval.respond",
] as const satisfies readonly HostApiPath[];

/** One of the eleven. */
export type InteractionHostApiPath = (typeof INTERACTION_HOSTAPI_PATHS)[number];

/** The members the service handler group carries. */
export const SERVICE_HOSTAPI_PATHS = [
  "getSecret",
  "getAuthPartitionCookies",
  "hasRoutineBySource",
  "proposeWork",
  "withdrawWorkProposal",
  "probePrivateHost",
  "resolveApiKey",
  "emitEvent",
  "logEvent",
  "callLlm",
  "hostFetch",
  "spawnWorker",
  "resolveMappedDriveRoot",
  "listAudioInputDevices",
  "startAudioCapture",
  "attachFloatingPanel",
  "resizeFloatingPanel",
] as const satisfies readonly HostApiPath[];

/** One of the seventeen. */
export type ServiceHostApiPath = (typeof SERVICE_HOSTAPI_PATHS)[number];


/** The members the storage handler group carries. */
export const STORAGE_HOSTAPI_PATHS = [
  "storage.resolve",
  "storage.read",
  "storage.readText",
  "storage.readJson",
  "storage.list",
  "storage.exists",
  "storage.write",
  "storage.writeJson",
  "storage.rm",
  "storage.mkdir",
  "storage.writeEncrypted",
  "storage.readEncrypted",
] as const satisfies readonly HostApiPath[];

/** One of the twelve. */
export type StorageHostApiPath = (typeof STORAGE_HOSTAPI_PATHS)[number];

/**
 * The eleven that reach the host. `storage.resolve` is excluded by NAME here
 * and by its `child-local` contract at the dispatcher; the dispatcher's own
 * child-local test is what keeps the two statements from disagreeing.
 */
export type DispatchedStorageHostApiPath = Exclude<
  StorageHostApiPath,
  "storage.resolve"
>;

// ─────────────────────────────────────────────────────────────────────────
// The config and subscription members' shared vocabulary
// ─────────────────────────────────────────────────────────────────────────

/** The members the config-and-subscription handler group carries. */
export type ConfigSubscriptionPath =
  | "config.get"
  | "config.set"
  | "config.onChange"
  | "onEvent"
  | "onPluginsChanged"
  | "onShutdown";

/**
 * The five that reach the host. `config.get` is excluded by NAME here and by
 * its `child-local` contract at the dispatcher; servicing it would make the
 * round-trip-free decision untrue in a way nothing would report.
 */
export type DispatchedConfigSubscriptionPath = Exclude<
  ConfigSubscriptionPath,
  "config.get"
>;

/**
 * The value `config.onChange` delivers when a `format: "secret"` field changed.
 *
 * DECLARED HERE, and the location is the decision. It used to live in
 * `plugins/config-change-bus.ts`, which builds a pino logger at module load —
 * pino writes to fd 1 directly, and fd 1 in a plugin child is the framed
 * protocol, so importing that module into a child would put a stdout writer
 * beside the wire. This module is the one both halves already reach: it is
 * Electron-free, the child imports it to decode, the host handler imports it to
 * encode, and the bus re-exports it so the emit site keeps the import it has.
 *
 * A unique Symbol makes `value === SECRET_REDACTED_SENTINEL` an identity check
 * that cannot be produced by a cleartext value, the way the `"[REDACTED]"`
 * string it replaced could. `Symbol.for` rather than `Symbol` so the identity is
 * a process-wide registry entry: a plugin bundled apart from the host — and,
 * since the boundary, one running in a DIFFERENT process — resolves the same
 * symbol from the same key.
 */
export const SECRET_REDACTED_SENTINEL: unique symbol = Symbol.for(
  "lvis.config.secret.redacted",
);

/** The wire field that says "this change was a secret's". */
const SECRET_REDACTED_WIRE_FIELD = "secretRedacted";

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
      `[host-api-wire] ${label}: event payload is not an object`,
    );
  }
  return payload as Record<string, unknown>;
}

/**
 * Put a `config.onChange` event ON the wire.
 *
 * THE SENTINEL NEEDS A WIRE FORM OF ITS OWN. `SECRET_REDACTED_SENTINEL` is a
 * Symbol, and `JSON.stringify` drops a symbol-valued property entirely — so a
 * plain `{ key, value }` would reach an isolated plugin as `{ key }`, its
 * callback would receive `undefined`, and `undefined` on this member means "the
 * key was cleared". The documented `value === SECRET_REDACTED_SENTINEL` check
 * would then never match and the plugin would never reload its secret, with
 * nothing failing anywhere. So the sentinel crosses as a FLAG beside the key,
 * and the decoder turns the flag back into the symbol.
 *
 * The flag is a sibling of `key` rather than the value itself: a plugin whose
 * cleartext value happens to be `{ secretRedacted: true }` sends that under
 * `value`, where it cannot be mistaken for this.
 *
 * Every other value is REFUSED unless it survives JSON. The sentinel is one
 * instance of a general hazard — a function, a bigint or a second symbol
 * vanishes the same way — and the boundary's own rule for arguments and results
 * is that a value which would not round-trip is rejected rather than silently
 * changed.
 *
 * WHERE THE THROW LANDS, precisely. It is raised inside the callback the host
 * registered with `config.onChange`, and that member
 * (`boot/steps/plugin-runtime/host-api-factory.ts`) wraps the callback in
 * `HostApiGenerationScope.wrapListener`, which catches it and logs. NOT the
 * change bus's per-listener try/catch: what the bus holds is the WRAPPER, and
 * the wrapper returns normally while the callback runs asynchronously behind
 * it, so the bus's catch is not on this path at all. (It is on the path only
 * for a host with no generation scope, which is a partial hostApi assembled in
 * a test — every host the app builds has one.) Either way the delivery is
 * dropped and reported, and the plugin receives nothing rather than a payload
 * it would read as "cleared".
 */
export function encodeConfigChange(key: string, value: unknown): Record<string, unknown> {
  if (value === SECRET_REDACTED_SENTINEL) {
    return { key, [SECRET_REDACTED_WIRE_FIELD]: true };
  }
  const nonJson = describeNonJson(value, "config.onChange(value)");
  if (nonJson) {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[host-api-wire] config.onChange: value cannot cross the boundary — ${nonJson}`,
      { key },
    );
  }
  return { key, value };
}

/** Take a `config.onChange` event off the wire. */
export function decodeConfigChange(payload: unknown): ConfigChangeEvent {
  const record = asEventRecord(payload, "config.onChange");
  const { key } = record;
  if (typeof key !== "string") {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[host-api-wire] config.onChange: event names no key`,
    );
  }
  if (Object.hasOwn(record, SECRET_REDACTED_WIRE_FIELD)) {
    // Strict on BOTH halves. A flag that is not exactly `true`, or one arriving
    // together with a value, means the two sides disagree about this payload —
    // and the wrong reading of either is "the key was cleared", the one answer
    // this member must never invent.
    if (record[SECRET_REDACTED_WIRE_FIELD] !== true || Object.hasOwn(record, "value")) {
      throw new HostApiBoundaryError(
        "argument-marshalling-rejected",
        `[host-api-wire] config.onChange: malformed secret marker for key '${key}'`,
      );
    }
    return { key, value: SECRET_REDACTED_SENTINEL };
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
      `[host-api-wire] onPluginsChanged: event carries no discriminant`,
    );
  }
  return { event };
}

// ─────────────────────────────────────────────────────────────────────────
// Service-member payloads: the shapes that replace values JSON cannot carry
// ─────────────────────────────────────────────────────────────────────────

/**
 * The wire shapes for the hostApi members that reach a host SERVICE — network
 * egress, the LLM provider, the secret gate, the worker supervisor, the event
 * bus, the audit log and the routine store
 * (`docs/blueprints/plugin-process-isolation.md` §3.1, §3.2).
 *
 * These are the members §3.2 names as NOT JSON-representable, so both sides need
 * the same vocabulary for what replaces the values that cannot cross: a
 * `Response` becomes {@link WireHttpResponse}, a `RequestInit` becomes
 * {@link WireRequestInit}, an `AbortSignal` becomes an abort-channel id, and a
 * live worker handle becomes an id plus a stream of {@link WireWorkerEvent}.
 *
 * ELECTRON-FREE, and it has to be: the child imports these to build its stubs,
 * and the child is a plain Node process. The host half lives in
 * `host-api-dispatcher.ts`, which reaches Electron through the hostApi object it
 * calls.
 *
 * WHY THEY LIVE HERE rather than next to either handler. A shape defined beside
 * the host handler could not be imported by the child, and a shape defined
 * beside the child stub would make the host import child code to learn its own
 * reply format. One shared vocabulary is what makes "the host encodes and the
 * child decodes" checkable — both sides compile against the same declaration
 * instead of two hand-matched literals.
 */

// ───────────────────────────────────────────────────────────────────────────
// hostFetch (§3.2)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The `RequestInit` fields that cross, and the ONLY ones.
 *
 * An unknown field is REFUSED rather than dropped (see
 * {@link decodeWireRequestInit}). Dropping it silently would let a plugin send
 * an init the host never applies and read the resulting behaviour as the one it
 * asked for — the failure mode `hostFetch` can least afford, because the field
 * a plugin most wants to smuggle past the host is one that changes where the
 * request goes.
 *
 * `redirect` is the plugin's POLICY, not the transport's mode: the host's hop
 * loop reads it — throw (`"error"`, the default), hand back the 3xx
 * (`"manual"`), or follow with the full egress gate re-run per hop
 * (`"follow"`) — and the transport underneath is always told `"manual"`.
 * Dropping it here would silently demote every policy to the default.
 */
const WIRE_REQUEST_INIT_FIELDS = [
  "method",
  "headers",
  "body",
  "signal",
  "cache",
  "credentials",
  "integrity",
  "keepalive",
  "mode",
  "redirect",
  "referrer",
  "referrerPolicy",
] as const;

/** A `RequestInit` reduced to JSON, with the two live members replaced. */
export interface WireRequestInit {
  readonly method?: string;
  /** `Headers` flattened to entries; the form `new Headers()` accepts back. */
  readonly headers?: readonly (readonly [string, string])[];
  /** Tagged so a base64 STRING body is not decoded into the bytes it spells. */
  readonly body?: WireBytes;
  /** The id the child allocated where an `AbortSignal` would have been. */
  readonly signalChannelId?: string;
  readonly cache?: string;
  readonly credentials?: string;
  readonly integrity?: string;
  readonly keepalive?: boolean;
  readonly mode?: string;
  readonly redirect?: string;
  readonly referrer?: string;
  readonly referrerPolicy?: string;
}

/** A drained `Response`. The body is bytes, never text — see {@link readResponseBytesBounded}. */
export interface WireHttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: WireBytes;
}

/**
 * Statuses the `Response` constructor refuses to pair with a body.
 *
 * Reconstructing one of these with an empty `Uint8Array` throws a `TypeError`
 * from the platform, so the child passes `null` instead. This is the HTTP
 * null-body rule, not a special case invented here.
 *
 * The informational statuses (1xx) are absent deliberately rather than
 * forgotten: `fetch` never surfaces them as a `Response`, and the constructor
 * refuses any status below 200 outright — so listing them would suggest this
 * set makes them reconstructable when nothing could.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/** Whether a reconstructed `Response` for `status` may carry a body at all. */
function statusAllowsBody(status: number): boolean {
  return !NULL_BODY_STATUSES.has(status);
}

/**
 * Read a response body into bytes under the boundary's own ceiling.
 *
 * BOUNDED WHILE READING, not after. `response.arrayBuffer()` allocates the whole
 * remote-controlled body before any check could run, so the ceiling would
 * observe the allocation rather than prevent it. `content-length` is checked
 * first because it can refuse before a single byte is read, and the running
 * total is checked anyway because `content-length` is a claim, not a fact.
 *
 * Exceeding the ceiling THROWS. A truncated body is a successful call that
 * returned a different document, and nothing downstream can tell.
 *
 * Not `readResponseTextLimited` (`engine/llm/model-list.ts`): that one is
 * private, decodes to TEXT — which is exactly the corruption this member has to
 * avoid — and throws a `ModelListError` the boundary has no code for.
 */
async function readResponseBytesBounded(
  response: Response,
  label: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > WIRE_BYTES_MAX) {
    throw tooLarge(declared, label);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > WIRE_BYTES_MAX) throw tooLarge(total, label);
      chunks.push(value);
    }
  } finally {
    // Releasing the lock unconditionally covers the throw above: the ceiling
    // refusal leaves a half-read stream, and a stream left locked keeps the
    // socket alive for a call that already failed.
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function tooLarge(byteLength: number, label: string): HostApiBoundaryError {
  return new HostApiBoundaryError(
    "payload-too-large",
    `[host-api-wire] ${label}: ${byteLength} bytes exceeds the ${WIRE_BYTES_MAX}-byte boundary limit`,
    { byteLength, limit: WIRE_BYTES_MAX },
  );
}

/** Host side: turn the `Response` the host obtained into its wire form. */
export async function encodeWireHttpResponse(
  response: Response,
  label: string,
): Promise<WireHttpResponse> {
  const bytes = await readResponseBytesBounded(response, label);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()].map(([key, value]) => [key, value] as const),
    // The shared codec, not a local `toString("base64")`: the tag is what stops
    // the child writing the base64 TEXT where the bytes belong.
    body: encodeWireBytes(bytes, `${label}(body)`),
  };
}

/** Child side: rebuild a real `Response` from the wire form. */
export function decodeWireHttpResponse(value: unknown, label: string): Response {
  const wire = value as WireHttpResponse | null;
  if (
    wire === null
    || typeof wire !== "object"
    || typeof wire.status !== "number"
    || typeof wire.statusText !== "string"
    || !Array.isArray(wire.headers)
  ) {
    throw new HostApiBoundaryError(
      "result-marshalling-rejected",
      `[host-api-wire] ${label}: not a drained response`,
    );
  }
  const bytes = decodeWireBinary(wire.body, `${label}(body)`);
  // Copied into a plain `ArrayBuffer` rather than handed over as-is: the decoded
  // view's buffer type is `ArrayBufferLike`, which `BodyInit` does not accept,
  // and the copy is also what stops the reconstructed body aliasing the decode
  // buffer.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Response(statusAllowsBody(wire.status) ? buffer : null, {
    status: wire.status,
    statusText: wire.statusText,
    headers: wire.headers.map(([key, headerValue]) => [key, headerValue]),
  });
}

/**
 * Child side: reduce `input` and `init` to the wire form.
 *
 * `openAbortChannel` is passed rather than imported so this stays a pure
 * function of its arguments — the ledger that owns abort channels lives in the
 * child runtime, and reaching it from here would make every payload test need a
 * runtime.
 */
export function encodeWireRequestInit(
  init: RequestInit | undefined,
  openAbortChannel: (signal: AbortSignal) => string,
  label: string,
): WireRequestInit | undefined {
  if (init === undefined) return undefined;
  const allowed = new Set<string>(WIRE_REQUEST_INIT_FIELDS);
  for (const key of Object.keys(init)) {
    if (!allowed.has(key)) {
      throw new HostApiBoundaryError(
        "argument-marshalling-rejected",
        `[host-api-wire] ${label}: init field '${key}' does not cross the boundary`,
        { field: key },
      );
    }
  }
  const wire: Record<string, unknown> = {};
  for (const key of WIRE_REQUEST_INIT_FIELDS) {
    if (key === "headers" || key === "body" || key === "signal") continue;
    const value = (init as Record<string, unknown>)[key];
    if (value !== undefined) wire[key] = value;
  }
  if (init.headers !== undefined) {
    wire.headers = [...new Headers(init.headers).entries()].map(
      ([key, value]) => [key, value] as const,
    );
  }
  if (init.body !== undefined && init.body !== null) {
    wire.body = encodeWireBytes(asWireBody(init.body, label), `${label}(body)`);
  }
  if (init.signal) wire.signalChannelId = openAbortChannel(init.signal);
  return wire as WireRequestInit;
}

/**
 * A request body reduced to the two branches the wire carries.
 *
 * A `ReadableStream` is REFUSED, per §3.2: buffering it would turn a streaming
 * upload into a bounded one without the caller ever learning, and the bound is
 * the part the caller would have needed to know about.
 */
function asWireBody(body: BodyInit, label: string): string | Uint8Array {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new HostApiBoundaryError(
    "argument-marshalling-rejected",
    `[host-api-wire] ${label}: a ${body.constructor?.name ?? "stream"} body does not cross the boundary`,
  );
}

/**
 * Host side: rebuild the `RequestInit` the in-process plugin would have passed.
 *
 * `abortChannel` resolves an id back to the host-held signal, so the abort the
 * child asks for reaches the fetch the host actually issued.
 */
export function decodeWireRequestInit(
  value: unknown,
  abortChannel: (channelId: string) => AbortSignal,
  label: string,
): RequestInit | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[host-api-wire] ${label}: init is not an object`,
    );
  }
  const wire = value as WireRequestInit & Record<string, unknown>;
  const allowed = new Set<string>([...WIRE_REQUEST_INIT_FIELDS, "signalChannelId"]);
  for (const key of Object.keys(wire)) {
    if (key === "signal" || !allowed.has(key)) {
      throw new HostApiBoundaryError(
        "argument-marshalling-rejected",
        `[host-api-wire] ${label}: init field '${key}' does not cross the boundary`,
        { field: key },
      );
    }
  }
  const init: Record<string, unknown> = {};
  for (const key of WIRE_REQUEST_INIT_FIELDS) {
    if (key === "headers" || key === "body" || key === "signal") continue;
    const field = wire[key];
    if (field !== undefined) init[key] = field;
  }
  if (wire.headers !== undefined) init.headers = new Headers(wire.headers.map(([k, v]) => [k, v]));
  // `decodeWireBytes`, not `decodeWireBinary`: a `utf8`-tagged body is a plugin
  // sending TEXT, and re-encoding it to bytes would be right only by accident —
  // `fetch` derives a different default `content-type` from the two branches.
  if (wire.body !== undefined) init.body = decodeWireBytes(wire.body, `${label}(body)`);
  if (wire.signalChannelId !== undefined) init.signal = abortChannel(wire.signalChannelId);
  return init as RequestInit;
}

// ───────────────────────────────────────────────────────────────────────────
// callLlm / resolveApiKey (§3.2)
// ───────────────────────────────────────────────────────────────────────────

/** `callLlm`'s options with the `AbortSignal` replaced by its channel id. */
export interface WireCallLlmOptions {
  readonly maxTokens?: number;
  readonly systemPrompt?: string;
  readonly signalChannelId?: string;
}

/** `resolveApiKey`'s options with the `AbortSignal` replaced by its channel id. */
export interface WireResolveApiKeyOptions {
  readonly purpose: "llm" | "stt" | "embedding" | "vision";
  readonly vendor?: "openai" | "azure-openai" | "vertex" | "anthropic";
  readonly signalChannelId?: string;
}

/**
 * The reply behind the `handle` `resolveApiKey` declares.
 *
 * `handleId` names the LEASE, and it is present on both branches: the dispatcher
 * pins `handle` results to `{ handleId: string }`, and a denied resolve is still
 * a settled call that has to name itself. On the denied branch the host has
 * already closed the lease, so the id identifies the call and owns nothing.
 *
 * `key` is the raw credential. It crosses because the child stub's `bearer()`
 * has to return it — isolation does not shrink what a GRANTED plugin holds
 * (§3.2), it shrinks what an ungranted one can reach, and the gate that decides
 * granted runs host-side before this shape exists.
 */
export type WireApiKeyLease =
  | {
      readonly handleId: string;
      readonly ok: true;
      readonly vendor: string;
      readonly baseUrl?: string;
      readonly key: string;
    }
  | {
      readonly handleId: string;
      readonly ok: false;
      readonly reason: string;
    };

// ───────────────────────────────────────────────────────────────────────────
// spawnWorker (§3.2)
// ───────────────────────────────────────────────────────────────────────────

/** The reply behind the `handle` `spawnWorker` declares. The process stays host-side. */
export interface WireWorkerHandle {
  readonly handleId: string;
  readonly socketPath: string | null;
  readonly pid: number | undefined;
}

/** One host→child push for a live worker, keyed by the worker's `handleId`. */
export type WireWorkerEvent =
  | { readonly kind: "stdout"; readonly chunk: string }
  | { readonly kind: "stderr"; readonly chunk: string }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: string | null;
    };

/** What `startAudioCapture` puts on the wire in place of the handle. */
export interface WireAudioCaptureHandle {
  readonly handleId: string;
  readonly captureId: string;
  readonly opened: { readonly microphone: boolean; readonly systemAudio: boolean };
}

/**
 * One host→child push for a live capture, keyed by the capture's `handleId`.
 *
 * `pcm` is base64 rather than bytes because this wire is JSON and JSON has no
 * bytes. A `Uint8Array` sent through it arrives as an object with numeric
 * keys — which is not an error anywhere, just audio that decodes to noise.
 */
export type WireAudioCaptureEvent =
  | { readonly kind: "frame"; readonly seq: number; readonly pcm: string; readonly peak: number }
  | { readonly kind: "end"; readonly reason: string; readonly detail?: string };

/** What `attachFloatingPanel` puts on the wire in place of the handle. */
export interface WireFloatingPanelHandle {
  readonly handleId: string;
  readonly panelId: string;
  /** What the host actually applied, after clamping. */
  readonly height: number;
}

/**
 * One host-to-child push for a live dock slot.
 *
 * Only one kind, because a slot has one thing to say: it went away, and why.
 * A union of one is still a union — a second kind (a user-driven resize, say)
 * would arrive as a new member rather than as an unlabelled payload.
 */
export type WireFloatingPanelEvent = {
  readonly kind: "detached";
  readonly reason: string;
};

/** Child side: read a dock push, refusing anything that is not one. */
export function asWireFloatingPanelEvent(payload: unknown, label: string): WireFloatingPanelEvent {
  const event = payload as WireFloatingPanelEvent | null;
  if (event === null || typeof event !== "object") {
    throw new HostApiBoundaryError(
      "result-marshalling-rejected",
      `[host-api-wire] ${label}: not a dock event`,
    );
  }
  if (event.kind !== "detached" || typeof event.reason !== "string") {
    throw new HostApiBoundaryError(
      "result-marshalling-rejected",
      `[host-api-wire] ${label}: unknown dock event`,
    );
  }
  return event;
}

/** Child side: read a capture push, refusing anything that is not one. */
export function asWireAudioCaptureEvent(payload: unknown, label: string): WireAudioCaptureEvent {
  const event = payload as WireAudioCaptureEvent | null;
  if (event === null || typeof event !== "object") {
    throw new HostApiBoundaryError(
      "result-marshalling-rejected",
      `[host-api-wire] ${label}: not a capture event`,
    );
  }
  if (event.kind === "frame") {
    if (typeof event.pcm !== "string" || typeof event.seq !== "number" || typeof event.peak !== "number") {
      throw new HostApiBoundaryError(
        "result-marshalling-rejected",
        `[host-api-wire] ${label}: frame is missing seq, pcm or peak`,
      );
    }
    return event;
  }
  if (event.kind === "end") {
    if (typeof event.reason !== "string") {
      throw new HostApiBoundaryError(
        "result-marshalling-rejected",
        `[host-api-wire] ${label}: end carries no reason`,
      );
    }
    return event;
  }
  throw new HostApiBoundaryError(
    "result-marshalling-rejected",
    `[host-api-wire] ${label}: unknown capture event kind`,
  );
}

/** Child side: read a worker push, refusing anything that is not one. */
export function asWireWorkerEvent(payload: unknown, label: string): WireWorkerEvent {
  const event = payload as WireWorkerEvent | null;
  if (event === null || typeof event !== "object") {
    throw new HostApiBoundaryError(
      "result-marshalling-rejected",
      `[host-api-wire] ${label}: not a worker event`,
    );
  }
  if (event.kind === "stdout" || event.kind === "stderr") {
    if (typeof event.chunk !== "string") {
      throw new HostApiBoundaryError(
        "result-marshalling-rejected",
        `[host-api-wire] ${label}: ${event.kind} carries no chunk`,
      );
    }
    return event;
  }
  if (event.kind === "exit") return event;
  throw new HostApiBoundaryError(
    "result-marshalling-rejected",
    `[host-api-wire] ${label}: unknown worker event kind`,
  );
}
