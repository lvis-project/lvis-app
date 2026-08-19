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
 * and which ERROR IDENTITIES it may reply with — and 36 members × 4 axes is 144
 * chances to change behaviour that no existing test notices, because today each
 * one is a function call nothing was written to pin. Making all four fields
 * REQUIRED means a member cannot be declared with an axis left undecided: the
 * omission is a type error, not a runtime surprise in the field.
 *
 * ELECTRON-FREE BY CONSTRUCTION. Everything here is imported by the child, and
 * the child is a plain Node process where `import("electron")` yields nothing.
 * The host-side classification of a thrown host error into a wire error lives in
 * `host-api-dispatcher.ts` instead, because recognising `EffectBoundaryDeniedError`
 * or `ManifestIntegrityViolation` means importing modules that reach Electron
 * through the approval gate.
 */
import { base64DecodedLength } from "../../shared/json-representable.js";
import type { HostApiPath } from "./host-api-path-contracts.js";

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
  /** host → child: the host ended a subscription (plugin retired, host shutting down). */
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
