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
 * ELECTRON-FREE, and it has to be: the child imports this module to build its
 * stubs, and the child is a plain Node process. The host half lives in
 * `host-api-service-paths.ts`, which reaches Electron through the hostApi object
 * it calls.
 *
 * WHY A THIRD MODULE rather than putting these next to either handler. A shape
 * defined beside the host handler could not be imported by the child, and a
 * shape defined beside the child stub would make the host import child code to
 * learn its own reply format. One shared vocabulary is what makes "the host
 * encodes and the child decodes" checkable — both sides compile against the same
 * declaration instead of two hand-matched literals.
 */
import {
  HostApiBoundaryError,
  WIRE_BYTES_MAX,
  decodeWireBinary,
  decodeWireBytes,
  encodeWireBytes,
  type WireBytes,
} from "./host-api-wire.js";

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
 * `redirect` is carried even though the host pins it to `"error"`: refusing to
 * carry it would turn an explicit `redirect: "error"` from a careful plugin into
 * a marshalling failure.
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
    `[host-api-service-payloads] ${label}: ${byteLength} bytes exceeds the ${WIRE_BYTES_MAX}-byte boundary limit`,
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
      `[host-api-service-payloads] ${label}: not a drained response`,
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
        `[host-api-service-payloads] ${label}: init field '${key}' does not cross the boundary`,
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
    `[host-api-service-payloads] ${label}: a ${body.constructor?.name ?? "stream"} body does not cross the boundary`,
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
      `[host-api-service-payloads] ${label}: init is not an object`,
    );
  }
  const wire = value as WireRequestInit & Record<string, unknown>;
  const allowed = new Set<string>([...WIRE_REQUEST_INIT_FIELDS, "signalChannelId"]);
  for (const key of Object.keys(wire)) {
    if (key === "signal" || !allowed.has(key)) {
      throw new HostApiBoundaryError(
        "argument-marshalling-rejected",
        `[host-api-service-payloads] ${label}: init field '${key}' does not cross the boundary`,
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

/** Child side: read a worker push, refusing anything that is not one. */
export function asWireWorkerEvent(payload: unknown, label: string): WireWorkerEvent {
  const event = payload as WireWorkerEvent | null;
  if (event === null || typeof event !== "object") {
    throw new HostApiBoundaryError(
      "result-marshalling-rejected",
      `[host-api-service-payloads] ${label}: not a worker event`,
    );
  }
  if (event.kind === "stdout" || event.kind === "stderr") {
    if (typeof event.chunk !== "string") {
      throw new HostApiBoundaryError(
        "result-marshalling-rejected",
        `[host-api-service-payloads] ${label}: ${event.kind} carries no chunk`,
      );
    }
    return event;
  }
  if (event.kind === "exit") return event;
  throw new HostApiBoundaryError(
    "result-marshalling-rejected",
    `[host-api-service-payloads] ${label}: unknown worker event kind`,
  );
}
