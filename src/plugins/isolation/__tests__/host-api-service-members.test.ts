/**
 * The service-reaching hostApi members, driven end to end across a real
 * dispatcher and a real child runtime.
 *
 * These nine hold every member §3.2 classified as NOT JSON-representable, so
 * what is under test is the marshalling itself: a `Response` that is a class
 * instance with a streaming body, a `RequestInit` that may carry a `Headers`, an
 * `AbortSignal` and a stream, an `AbortSignal` in `callLlm`'s options, a lease
 * with two closures in it, and a live worker handle with four methods.
 *
 * DRIVEN THROUGH THE CHILD'S OWN STUB, not by calling the handler directly. A
 * handler tested alone proves the host decodes what the test encoded, which is
 * a test of the test. Going through `child.hostApi.hostFetch(...)` proves the
 * child's encoder and the host's decoder agree, which is the only property that
 * matters at a boundary.
 *
 * The BYTE cases are deliberate rather than decorative. `Buffer` carries a
 * `toJSON()`, so a naive round trip succeeds into `{ type: "Buffer", data }` —
 * a different type that reads as success — and a text codec silently replaces
 * invalid UTF-8 with U+FFFD. Both failures pass a test that only checks
 * `res.ok`, so the bodies below carry a NUL, a lone continuation byte and a
 * 0xFF that no UTF-8 decoder can round-trip.
 */
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EffectBoundaryDeniedError } from "../../../permissions/effect-enforcement.js";
import type {
  PluginHostApi,
  PluginManifest,
  SpawnedPluginWorker,
} from "../../types.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
  createServiceHostApiPaths,
  type DelegatedWorkerConfinement,
} from "../host-api-dispatcher.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  PluginHostApiError,
  SERVICE_HOSTAPI_PATHS,
  WIRE_BYTES_MAX,
  type HostApiChannel,
  type HostApiNotification,
  type HostApiReply,
  type HostApiRequest,
  type WireHttpResponse,
  type WireRequestInit,
} from "../host-api-wire.js";
import {
  startPluginChildRuntime,
  type PluginChildRuntime,
} from "../plugin-child-runtime.js";

const PLUGIN_ID = "com.example.service";
const GENERATION = "gen-3";
const PLUGIN_ROOT = "/plugins/service";
const PLUGIN_DATA_DIR = "/plugins/service/data";
/**
 * A host-widened root, standing in for the kind of grant
 * `PLUGIN_ENVELOPE_GRANTS` produces (a host-owned directory under `~/.lvis`).
 *
 * READ-only, which is the shape `derivePluginChildEnvelope` produces for a
 * `hostDirectory` row: it pushes the directory into `read` alone, and a
 * `userChosenDirectory` value naming it back is refused by the entry
 * `ceilingSubtractions` carries for that row — one per `hostDirectory` row in
 * the table. NOT by the `lvisHome()` entry: a row is a lexical join onto the
 * home and the containment question is asked on the canonical form, so a
 * granted directory that links out of the home escapes that entry.
 * `confined-plugin-child.test.ts` drives the production derivation for that
 * half. This fixture is therefore the derivation's own output shape rather than
 * a convenient one, and what it exercises is the boundary that consumes it.
 */
const WIDENED_READ_ROOT = "/host/runtime";

/**
 * The child's own filesystem envelope — the same lists the ASRT wrap grants it.
 * A worker the plugin delegates is checked against exactly this.
 */
const CONFINEMENT: DelegatedWorkerConfinement = {
  read: [PLUGIN_ROOT, PLUGIN_DATA_DIR, WIDENED_READ_ROOT],
  write: [PLUGIN_DATA_DIR],
};

/** Bytes no UTF-8 round trip survives: a NUL, a lone continuation byte, 0xFF. */
const HOSTILE_BYTES = new Uint8Array([0x00, 0x80, 0xff, 0xfe, 0x41, 0xc3, 0x28]);

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Service",
  version: "1.0.0",
  entry: "dist/plugin.js",
  description: "an isolated plugin exercising the service-reaching members",
  tools: [],
};

/** A `SpawnedPluginWorker` whose three listener members are drivable from a test. */
function makeFakeWorker(): SpawnedPluginWorker & {
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly stopped: () => number;
} {
  const stdout: ((chunk: string) => void)[] = [];
  const stderr: ((chunk: string) => void)[] = [];
  const exit: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void)[] = [];
  let stops = 0;
  return {
    socketPath: "/run/worker.sock",
    pid: 4242,
    stop: () => {
      stops += 1;
    },
    onStdout: (listener) => void stdout.push(listener),
    onStderr: (listener) => void stderr.push(listener),
    onExit: (listener) => void exit.push(listener),
    emitStdout: (chunk) => stdout.forEach((listener) => listener(chunk)),
    emitStderr: (chunk) => stderr.forEach((listener) => listener(chunk)),
    emitExit: (code, signal) => exit.forEach((listener) => listener({ code, signal })),
    stopped: () => stops,
  };
}

interface ServiceHarness {
  readonly child: PluginChildRuntime;
  readonly host: HostApiDispatcher;
  readonly api: PluginHostApi;
  /** Every request the child put on the wire, in order. */
  readonly requests: HostApiRequest[];
  /** Every notification either side emitted, in order. */
  readonly notifications: HostApiNotification[];
  /** Every notification the HOST pushed at the child, in order. */
  readonly pushed: HostApiNotification[];
  /** Every reply the host produced, in order, so a handle id can be named. */
  readonly replies: HostApiReply[];
  /** Drop the child, as the host does on child exit. */
  readonly killChild: () => number;
}

/**
 * A real dispatcher wired to a real child over an in-memory channel.
 *
 * `hostApi` is the ONLY seam. Everything between the plugin's call and that
 * object is production code, which is what makes a failure here a failure of
 * the boundary rather than of a mock.
 */
async function createServiceHarness(
  hostApi: Partial<PluginHostApi> = {},
  manifest: PluginManifest = MANIFEST,
): Promise<ServiceHarness> {
  const requests: HostApiRequest[] = [];
  const notifications: HostApiNotification[] = [];
  const pushed: HostApiNotification[] = [];
  const replies: HostApiReply[] = [];
  let host!: HostApiDispatcher;
  let child!: PluginChildRuntime;

  const channel: HostApiChannel = {
    call: async (request) => {
      requests.push(request);
      const reply = await host.handle(request);
      replies.push(reply);
      return reply;
    },
    notify: (notification) => {
      notifications.push(notification);
      host.handleNotification(notification);
    },
  };

  const api = hostApi as PluginHostApi;
  host = new HostApiDispatcher({
    pluginId: PLUGIN_ID,
    generationId: GENERATION,
    isActive: () => true,
    notifications: {
      deliver: (notification) => {
        pushed.push(notification);
        child.deliver(notification);
      },
    },
    // Bound entries composed OVER the shipped table, which stays unbound: a
    // static entry could never reach an incarnation's hostApi, so the binding
    // is a closure and the composition happens where the child is owned.
    table: {
      ...HOSTAPI_DISPATCH_TABLE,
      ...createServiceHostApiPaths(api, CONFINEMENT),
    },
  });

  child = await startPluginChildRuntime({
    input: new PassThrough(),
    output: new PassThrough(),
    manifest,
    context: {
      pluginId: PLUGIN_ID,
      pluginRoot: PLUGIN_ROOT,
      hostRoot: "/app",
      pluginDataDir: PLUGIN_DATA_DIR,
      userHome: "/Users/example",
      lvisHome: "/Users/example/.lvis",
      installedPluginIds: [],
      generationId: GENERATION,
    },
    channel,
    loadFactory: async () => () => ({ handlers: {} }),
  });

  return {
    child,
    host,
    api,
    requests,
    notifications,
    pushed,
    replies,
    killChild: () => host.childGone(),
  };
}

/** The wire form of one request's Nth argument. */
function wireArg<T>(harness: ServiceHarness, path: string, index: number): T {
  const request = harness.requests.find((candidate) => candidate.path === path);
  expect(request, `no '${path}' request was sent`).toBeDefined();
  return request!.args[index] as T;
}

/** Let queued microtasks and the notification hop settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The single log notification a fire-and-forget member emitted.
 *
 * Asserted as exactly one, because a failure reported twice and a failure
 * reported not at all are both wrong in the same way: the plugin's operator
 * cannot tell what actually happened from the log.
 */
function detachedLog(harness: ServiceHarness): { message: string; meta?: unknown } {
  const logs = harness.notifications.filter(
    (notification) => notification.kind === "log",
  );
  expect(logs).toHaveLength(1);
  return logs[0] as unknown as { message: string; meta?: unknown };
}

describe("this group implements exactly the members left after the other three", () => {
  it("binds every service-reaching member, and only against a real hostApi", () => {
    const bound = createServiceHostApiPaths({} as PluginHostApi, CONFINEMENT);
    expect(Object.keys(bound).sort()).toEqual([...SERVICE_HOSTAPI_PATHS].sort());
    for (const path of SERVICE_HOSTAPI_PATHS) {
      expect(bound[path].status).toBe("implemented");
      expect(bound[path].contract).toBe(HOSTAPI_PATH_CONTRACTS[path]);
      // The SHIPPED table stays unbound. A static entry cannot reach an
      // incarnation's hostApi, so publishing one here would be publishing a
      // handler that can only fail — and nothing routes out-of-process yet.
      expect(HOSTAPI_DISPATCH_TABLE[path].status).toBe("unimplemented");
    }
  });

  it("declares an abort-bearing member as lifetime-bearing", () => {
    // The three members that take an `AbortSignal` reach the shared abort
    // registry through `SubscriptionScope`, and only a lifetime-bearing member
    // is handed one. A `lifetime: "none"` here would not merely mislabel the
    // member — it would leave the handler with no way to open the channel its
    // `encoded` arguments promise, which is how a second registry gets written.
    for (const path of ["hostFetch", "callLlm", "resolveApiKey"] as const) {
      expect(HOSTAPI_PATH_CONTRACTS[path].lifetime, path).toBe("child-disposable");
      expect(HOSTAPI_PATH_CONTRACTS[path].arguments, path).toBe("encoded");
    }
  });
});

describe("getSecret crosses as plain data and leaves the gate host-side", () => {
  it("returns the host's answer, including the null a denied read produces", async () => {
    const getSecret = vi.fn(async (key: string) => (key === "granted" ? "s3cret" : null));
    const harness = await createServiceHarness({ getSecret });
    await expect(harness.child.hostApi.getSecret("granted")).resolves.toBe("s3cret");
    // A DENIED read is `null` from the gate, and it must arrive as `null` — not
    // as a throw the boundary invented, and not as `undefined`.
    await expect(harness.child.hostApi.getSecret("other")).resolves.toBeNull();
    expect(getSecret).toHaveBeenNthCalledWith(1, "granted");
    expect(getSecret).toHaveBeenNthCalledWith(2, "other");
  });

  it("does not re-decide the four-tier gate at the boundary", async () => {
    // The boundary adds a TYPE check and nothing else. A second allow-list here
    // would be a weaker copy of `runSecretGate` that the gate could drift from,
    // so a key the host grants must cross whatever it looks like.
    const getSecret = vi.fn(async () => "granted-anyway");
    const harness = await createServiceHarness({ getSecret });
    await expect(
      harness.child.hostApi.getSecret("some.other.plugin.apiKey"),
    ).resolves.toBe("granted-anyway");
  });

  it("refuses a key that is not a string", async () => {
    const getSecret = vi.fn(async () => null);
    const harness = await createServiceHarness({ getSecret });
    await expect(
      (harness.child.hostApi.getSecret as unknown as (k: unknown) => Promise<string>)(42),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(getSecret).not.toHaveBeenCalled();
  });
});

describe("hasRoutineBySource and probePrivateHost cross as plain data", () => {
  it("carries the boolean both members return", async () => {
    const harness = await createServiceHarness({
      hasRoutineBySource: vi.fn(async (source: string) => source.endsWith(":nightly")),
      probePrivateHost: vi.fn(async () => true),
    });
    await expect(
      harness.child.hostApi.hasRoutineBySource(`suggestion:${PLUGIN_ID}:nightly`),
    ).resolves.toBe(true);
    await expect(harness.child.hostApi.hasRoutineBySource("other")).resolves.toBe(false);
    await expect(harness.child.hostApi.probePrivateHost("intranet.corp")).resolves.toBe(
      true,
    );
  });

  it("carries the optional timeout and refuses a non-numeric one", async () => {
    const probePrivateHost = vi.fn(async () => false);
    const harness = await createServiceHarness({ probePrivateHost });
    await harness.child.hostApi.probePrivateHost("intranet.corp", { timeoutMs: 250 });
    expect(probePrivateHost).toHaveBeenCalledWith("intranet.corp", { timeoutMs: 250 });
    await expect(
      harness.child.hostApi.probePrivateHost("intranet.corp", {
        timeoutMs: "soon" as unknown as number,
      }),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
  });

  it("omits the options object entirely when the plugin omitted it", async () => {
    // `probePrivateHost(host)` and `probePrivateHost(host, undefined)` are the
    // same call in-process; they must stay the same call across the boundary.
    const probePrivateHost = vi.fn(async () => false);
    const harness = await createServiceHarness({ probePrivateHost });
    await harness.child.hostApi.probePrivateHost("intranet.corp");
    expect(probePrivateHost).toHaveBeenCalledWith("intranet.corp");
  });
});

describe("hostFetch carries bytes a text codec would corrupt", () => {
  it("reconstructs the body byte-for-byte, tagged base64 on the wire", async () => {
    const hostFetch = vi.fn(
      async () =>
        new Response(HOSTILE_BYTES, {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/octet-stream", "x-trace": "abc" },
        }),
    );
    const harness = await createServiceHarness({ hostFetch });
    const response = await harness.child.hostApi.hostFetch!("https://example.test/a");
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-trace")).toBe("abc");
    const received = new Uint8Array(await response.arrayBuffer());
    expect([...received]).toEqual([...HOSTILE_BYTES]);
  });

  it("does not let a Buffer body round-trip into { type: 'Buffer' }", async () => {
    // The trap the design names: `Buffer` has a `toJSON()`, so JSON does not
    // object — it succeeds into a DIFFERENT type. Asserting the reply's shape
    // is what distinguishes "the bytes arrived" from "an object that looks like
    // bytes arrived".
    let reply: unknown;
    const harness = await createServiceHarness({
      hostFetch: async () => new Response(Buffer.from(HOSTILE_BYTES)),
    });
    const original = harness.host.handle.bind(harness.host);
    vi.spyOn(harness.host, "handle").mockImplementation(async (request) => {
      const result = await original(request);
      if (result.ok) reply = result.value;
      return result;
    });
    const response = await harness.child.hostApi.hostFetch!("https://example.test/a");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...HOSTILE_BYTES]);
    const wire = reply as WireHttpResponse;
    expect(wire.body.encoding).toBe("base64");
    expect(wire.body).not.toHaveProperty("type");
    expect(Buffer.from(wire.body.data, "base64").equals(Buffer.from(HOSTILE_BYTES))).toBe(
      true,
    );
  });

  it("reduces init to JSON: headers as entries, body tagged, URL as a string", async () => {
    const hostFetch = vi.fn(async () => new Response(new Uint8Array(0)));
    const harness = await createServiceHarness({ hostFetch });
    await harness.child.hostApi.hostFetch!(new URL("https://example.test/b?q=1"), {
      method: "POST",
      headers: new Headers({ "x-a": "1" }),
      body: HOSTILE_BYTES,
      redirect: "error",
    });
    const wire = wireArg<WireRequestInit>(harness, "hostFetch", 1);
    expect(wireArg<string>(harness, "hostFetch", 0)).toBe("https://example.test/b?q=1");
    expect(wire.headers).toEqual([["x-a", "1"]]);
    expect(wire.body?.encoding).toBe("base64");
    expect(wire.method).toBe("POST");
    // The host must receive the object an in-process plugin would have passed.
    const [, init] = hostFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-a")).toBe("1");
    expect([...(init.body as Uint8Array)]).toEqual([...HOSTILE_BYTES]);
    expect(init.redirect).toBe("error");
  });

  it("keeps a text body text rather than re-encoding it as bytes", async () => {
    // A `utf8`-tagged body is a plugin sending TEXT, and `fetch` derives a
    // different default content-type for the two branches — so the tag has to
    // survive, not just the characters.
    const hostFetch = vi.fn(async () => new Response(new Uint8Array(0)));
    const harness = await createServiceHarness({ hostFetch });
    await harness.child.hostApi.hostFetch!("https://example.test/c", {
      method: "POST",
      body: '{"a":1}',
    });
    expect(wireArg<WireRequestInit>(harness, "hostFetch", 1).body).toEqual({
      encoding: "utf8",
      data: '{"a":1}',
    });
    expect(
      (hostFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body,
    ).toBe('{"a":1}');
  });

  it("refuses a stream body instead of quietly buffering it", async () => {
    const harness = await createServiceHarness({
      hostFetch: async () => new Response(new Uint8Array(0)),
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    await expect(
      harness.child.hostApi.hostFetch!("https://example.test/d", {
        method: "POST",
        body: stream,
      }),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
  });

  it("refuses an init field the boundary does not carry", async () => {
    const harness = await createServiceHarness({
      hostFetch: async () => new Response(new Uint8Array(0)),
    });
    await expect(
      harness.child.hostApi.hostFetch!("https://example.test/e", {
        window: null,
      } as RequestInit),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
  });

  it.each([204, 205, 304])(
    "reconstructs status %i without a platform TypeError",
    async (status) => {
      // Every null-body status, not just the familiar one: `new Response(body,
      // { status })` throws a `TypeError` for all three, so a rule that covered
      // only 204 would turn a 304 into a boundary crash.
      const harness = await createServiceHarness({
        hostFetch: async () => new Response(null, { status }),
      });
      const response = await harness.child.hostApi.hostFetch!("https://example.test/f");
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    },
  );

  it("still carries a body on a status that allows one", async () => {
    // The other half of the rule: a null-body list that swallowed 200 would
    // pass every test above while dropping every real response.
    const harness = await createServiceHarness({
      hostFetch: async () => new Response(new Uint8Array([7, 8, 9]), { status: 200 }),
    });
    const response = await harness.child.hostApi.hostFetch!("https://example.test/f2");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7, 8, 9]);
  });

  it("throws rather than truncates a body over the boundary ceiling", async () => {
    const harness = await createServiceHarness({
      hostFetch: async () =>
        new Response(new Uint8Array(8), {
          // Declared, so the refusal happens before a byte is read — which is
          // the only place the ceiling can prevent the allocation rather than
          // observe it.
          headers: { "content-length": String(WIRE_BYTES_MAX + 1) },
        }),
    });
    await expect(
      harness.child.hostApi.hostFetch!("https://example.test/g"),
    ).rejects.toMatchObject({ code: "payload-too-large" });
  });

  it("replies with the contract's effect-boundary-denied code", async () => {
    const harness = await createServiceHarness({
      hostFetch: async () => {
        throw new EffectBoundaryDeniedError(PLUGIN_ID, "hostFetch", "https://x.test", "denied");
      },
    });
    const error = await harness.child.hostApi
      .hostFetch!("https://example.test/h")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginHostApiError);
    expect(error).toMatchObject({
      code: "effect-boundary-denied",
      name: "EffectBoundaryDeniedError",
    });
    expect(HOSTAPI_PATH_CONTRACTS.hostFetch.errors).toContain("effect-boundary-denied");
  });

  it("answers path-not-implemented on a host build without the member", async () => {
    const harness = await createServiceHarness({});
    await expect(
      // Reached through the stub the child always presents: an ABSENT member is
      // a `TypeError` that says nothing, so the stub is total and the refusal
      // is the boundary's own.
      (harness.child.hostApi as unknown as { hostFetch: (u: string) => Promise<Response> })
        .hostFetch("https://example.test/i"),
    ).rejects.toMatchObject({ code: "path-not-implemented" });
  });

  it("aborts the host's fetch and releases the channel on both sides", async () => {
    let hostSignal: AbortSignal | undefined;
    const harness = await createServiceHarness({
      hostFetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          hostSignal = init?.signal ?? undefined;
          hostSignal?.addEventListener("abort", () => reject(hostSignal?.reason));
        }),
    });
    const controller = new AbortController();
    const pending = harness.child.hostApi.hostFetch!("https://example.test/j", {
      signal: controller.signal,
    });
    await settle();
    expect(hostSignal?.aborted).toBe(false);
    controller.abort(new Error("plugin gave up"));
    await expect(pending).rejects.toBeTruthy();
    // The proof: the abort reached the HOST's signal, not merely the child's
    // promise. A boundary that rejected locally would leave this false.
    expect(hostSignal?.aborted).toBe(true);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it("leaves no registration behind after a call that simply settles", async () => {
    const harness = await createServiceHarness({
      hostFetch: async () => new Response(new Uint8Array([1, 2, 3])),
    });
    const controller = new AbortController();
    await harness.child.hostApi.hostFetch!("https://example.test/k", {
      signal: controller.signal,
    });
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });
});

describe("callLlm carries plain data plus an abort channel", () => {
  it("returns the host's string and forwards the declared options", async () => {
    const callLlm = vi.fn(async () => "an answer");
    const harness = await createServiceHarness({ callLlm });
    await expect(
      harness.child.hostApi.callLlm("hello", { maxTokens: 32, systemPrompt: "be terse" }),
    ).resolves.toBe("an answer");
    expect(callLlm).toHaveBeenCalledWith("hello", {
      maxTokens: 32,
      systemPrompt: "be terse",
    });
  });

  it("replaces the signal with a channel id on the wire and a real signal at the host", async () => {
    let hostSignal: AbortSignal | undefined;
    const harness = await createServiceHarness({
      callLlm: async (_prompt, opts) => {
        hostSignal = opts?.signal;
        return "ok";
      },
    });
    const controller = new AbortController();
    await harness.child.hostApi.callLlm("hi", { signal: controller.signal });
    const wire = wireArg<{ signalChannelId?: string }>(harness, "callLlm", 1);
    expect(typeof wire.signalChannelId).toBe("string");
    // An `AbortSignal` cannot cross; what the host holds is its OWN controller,
    // wired to the id the child allocated.
    expect(hostSignal).toBeInstanceOf(AbortSignal);
    expect(hostSignal).not.toBe(controller.signal);
  });

  it("aborts the host's generation mid-call", async () => {
    let hostSignal: AbortSignal | undefined;
    const harness = await createServiceHarness({
      callLlm: (_prompt, opts) =>
        new Promise((_resolve, reject) => {
          hostSignal = opts?.signal;
          hostSignal?.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
    });
    const controller = new AbortController();
    const pending = harness.child.hostApi.callLlm("write an essay", {
      signal: controller.signal,
    });
    await settle();
    expect(hostSignal?.aborted).toBe(false);
    controller.abort();
    await expect(pending).rejects.toBeTruthy();
    expect(hostSignal?.aborted).toBe(true);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });

  it("rejects immediately on an already-aborted signal, without a round trip", async () => {
    const callLlm = vi.fn(async () => "never");
    const harness = await createServiceHarness({ callLlm });
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    await expect(
      harness.child.hostApi.callLlm("hi", { signal: controller.signal }),
    ).rejects.toThrow(/already gone/u);
    expect(callLlm).not.toHaveBeenCalled();
    expect(harness.requests).toHaveLength(0);
  });

  it("replies with the contract's effect-boundary-denied code", async () => {
    const harness = await createServiceHarness({
      callLlm: async () => {
        throw new EffectBoundaryDeniedError(PLUGIN_ID, "callLlm", undefined, "headless");
      },
    });
    await expect(harness.child.hostApi.callLlm("hi")).rejects.toMatchObject({
      code: "effect-boundary-denied",
    });
    expect(HOSTAPI_PATH_CONTRACTS.callLlm.errors).toContain("effect-boundary-denied");
  });
});

describe("resolveApiKey crosses as a lease, not as two closures", () => {
  it("synthesises bearer() and release() around the host's lease", async () => {
    const release = vi.fn();
    const harness = await createServiceHarness({
      resolveApiKey: async () => ({
        ok: true,
        vendor: "openai",
        baseUrl: "https://api.example.test",
        bearer: () => "sk-live",
        release,
      }),
    });
    const result = await harness.child.hostApi.resolveApiKey!({ purpose: "llm" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vendor).toBe("openai");
    expect(result.baseUrl).toBe("https://api.example.test");
    expect(result.bearer()).toBe("sk-live");
    expect(harness.host.openSubscriptionCount).toBe(1);

    result.release();
    await settle();
    // Both sides let go: the child dropped its copy and the host ran the lease's
    // own `release`, which is the two-sided lifetime the contract declares.
    expect(release).toHaveBeenCalledTimes(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
    expect(() => result.bearer()).toThrow(/already released/u);
  });

  it("carries a denial without opening a lease", async () => {
    const harness = await createServiceHarness({
      resolveApiKey: async () => ({ ok: false, reason: "not-whitelisted" }),
    });
    const result = await harness.child.hostApi.resolveApiKey!({ purpose: "stt" });
    expect(result).toEqual({ ok: false, reason: "not-whitelisted" });
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it("releases the host lease when the child dies holding it", async () => {
    const release = vi.fn();
    const harness = await createServiceHarness({
      resolveApiKey: async () => ({
        ok: true,
        vendor: "anthropic",
        bearer: () => "sk-live",
        release,
      }),
    });
    await harness.child.hostApi.resolveApiKey!({ purpose: "llm" });
    expect(harness.host.openSubscriptionCount).toBe(1);
    expect(harness.killChild()).toBe(1);
    // Case 2 of the four ways a two-sided lifetime ends: the child never
    // disposed, and the host must release anyway.
    expect(release).toHaveBeenCalledTimes(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });

  it("drops the credential when the child dies while the resolve is in flight", async () => {
    const release = vi.fn();
    let admit!: () => void;
    const harness = await createServiceHarness({
      resolveApiKey: () =>
        new Promise((resolve) => {
          admit = () =>
            resolve({ ok: true, vendor: "openai", bearer: () => "sk-live", release });
        }),
    });
    const pending = harness.child.hostApi.resolveApiKey!({ purpose: "llm" });
    await settle();
    // The child dies mid-resolve. The lease that arrives afterwards has nobody
    // to go to, so it must be released rather than replied with — otherwise the
    // host hands a live credential to a process that no longer exists.
    harness.killChild();
    admit();
    await expect(pending).rejects.toMatchObject({ code: "plugin-inactive" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });

  it("refuses a purpose the host does not define", async () => {
    const resolveApiKey = vi.fn();
    const harness = await createServiceHarness({ resolveApiKey });
    await expect(
      harness.child.hostApi.resolveApiKey!({
        purpose: "mining" as "llm",
      }),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("carries the signal as a channel id", async () => {
    let hostSignal: AbortSignal | undefined;
    const harness = await createServiceHarness({
      resolveApiKey: async (opts) => {
        hostSignal = opts.signal;
        return { ok: false, reason: "aborted" };
      },
    });
    const controller = new AbortController();
    await harness.child.hostApi.resolveApiKey!({ purpose: "llm", signal: controller.signal });
    expect(typeof wireArg<{ signalChannelId?: string }>(harness, "resolveApiKey", 0)
      .signalChannelId).toBe("string");
    expect(hostSignal).toBeInstanceOf(AbortSignal);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });
});

describe("spawnWorker crosses as an id, never as a live handle", () => {
  it("gives the plugin a handle whose methods are local", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/usr/bin/python3",
    });
    expect(handle.socketPath).toBe("/run/worker.sock");
    expect(handle.pid).toBe(4242);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
    handle.onStdout((chunk) => stdout.push(chunk));
    handle.onStderr((chunk) => stderr.push(chunk));
    handle.onExit((info) => exits.push(info));

    worker.emitStdout("indexed 3");
    worker.emitStderr("warn: slow");
    await settle();
    expect(stdout).toEqual(["indexed 3"]);
    expect(stderr).toEqual(["warn: slow"]);
  });

  it("sends the spec through unchanged and keeps the process host-side", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/usr/bin/python3",
      args: ["-u", "worker.py"],
      udsArgName: { env: "LVIS_CONTROL_SOCKET" },
    });
    expect(spawnWorker).toHaveBeenCalledWith({
      workerId: "indexer",
      command: "/usr/bin/python3",
      args: ["-u", "worker.py"],
      udsArgName: { env: "LVIS_CONTROL_SOCKET" },
    });
    // What the plugin received is an id and two scalars — nothing that could be
    // a `ChildProcess`, which is the security improvement over the in-process
    // handle rather than merely a port of it.
    const reply = await harness.host.handle(
      harness.requests.find((request) => request.path === "spawnWorker")!,
    );
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(Object.keys(reply.value as object).sort()).toEqual([
      "handleId",
      "pid",
      "socketPath",
    ]);
  });

  it("delivers exit once and releases both sides", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/bin/true",
    });
    const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
    handle.onExit((info) => exits.push(info));
    expect(harness.host.openSubscriptionCount).toBe(1);

    worker.emitExit(0, null);
    await settle();
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(harness.host.openSubscriptionCount).toBe(0);
    // BOTH sides, from ONE decision. The host owns the process, so it releases
    // its own entry and the `subscription-closed` that follows drops the
    // child's — rather than each side deciding separately that the worker is
    // gone.
    expect(harness.child.openSubscriptionCount).toBe(0);
    // A worker that already exited must NOT be stopped: `stop()` signals a pid,
    // and a reaped pid can belong to something else by then.
    expect(worker.stopped()).toBe(0);
  });

  it("stops the host-owned process when the plugin calls stop()", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/bin/true",
    });
    handle.stop();
    await settle();
    expect(worker.stopped()).toBe(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it("stops the process when the child dies still holding the handle", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    await harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" });
    expect(harness.killChild()).toBe(1);
    expect(worker.stopped()).toBe(1);
  });

  it("drops worker output produced after the handle was released", async () => {
    // A chunk arriving after the release is a routine race — the process is
    // still draining while `stop()` travels. `deliver` throws on an unknown
    // subscription, so without the guard that race becomes an exception thrown
    // inside a worker event listener, where nothing catches it.
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/bin/true",
    });
    const stdout: string[] = [];
    handle.onStdout((chunk) => stdout.push(chunk));
    handle.stop();
    await settle();
    expect(() => worker.emitStdout("late")).not.toThrow();
    await settle();
    expect(stdout).toEqual([]);
  });

  it("replies with the contract's effect-boundary-denied code", async () => {
    const harness = await createServiceHarness({
      spawnWorker: async () => {
        throw new EffectBoundaryDeniedError(PLUGIN_ID, "spawnWorker", "indexer", "denied");
      },
    });
    await expect(
      harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(HOSTAPI_PATH_CONTRACTS.spawnWorker.errors).toContain("effect-boundary-denied");
  });
});

describe("emitEvent keeps its synchronous throw and its host-side authority", () => {
  it("throws in the child, before any round trip, on an undeclared event", async () => {
    const emit = vi.fn();
    const harness = await createServiceHarness({ emitEvent: emit });
    // `audit.*` is a plugin-private namespace: nothing a plugin may emit.
    expect(() => harness.child.hostApi.emitEvent("audit.tampered")).toThrow(
      /not allowed to emit undeclared event/u,
    );
    expect(harness.requests).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("reaches the host — which re-decides and writes the denial audit", async () => {
    const emit = vi.fn();
    const harness = await createServiceHarness({ emitEvent: emit });
    expect(harness.child.hostApi.emitEvent("demo.ping", { n: 1 })).toBeUndefined();
    await settle();
    expect(emit).toHaveBeenCalledWith("demo.ping", { n: 1 });
  });

  it("reports a host refusal through the log channel instead of dropping it", async () => {
    // `emitEvent` returns `void`, so a host-side refusal lands after the
    // plugin's call has returned. Swallowing it would make a refused emit look
    // identical to an accepted one; leaving it unhandled would take the process
    // down.
    const harness = await createServiceHarness({
      emitEvent: () => {
        throw new Error("host says no");
      },
    });
    harness.child.hostApi.emitEvent("demo.ping");
    await settle();
    expect(detachedLog(harness)).toMatchObject({
      message: "hostApi.emitEvent failed after returning",
      meta: { error: "host says no" },
    });
  });
});

describe("a void-declared member that drifts is refused, not absorbed", () => {
  it("surfaces the dispatcher's void check when the host returns a value", async () => {
    // The handler RETURNS the host's value rather than awaiting and discarding
    // it. Discarding would make this check unreachable: the dispatcher would see
    // `undefined` from every void member no matter what the host did, and a
    // stub-vs-implementation drift would pass silently forever.
    const harness = await createServiceHarness({
      emitEvent: (() => "surprise") as unknown as PluginHostApi["emitEvent"],
    });
    harness.child.hostApi.emitEvent("demo.ping");
    await settle();
    expect(detachedLog(harness).meta).toMatchObject({
      error: expect.stringContaining("declares no result but returned one") as string,
    });
  });
});

describe("logEvent crosses as plain data", () => {
  it("forwards the level, message and data", async () => {
    const logEvent = vi.fn();
    const harness = await createServiceHarness({ logEvent });
    expect(harness.child.hostApi.logEvent("warn", "slow", { ms: 900 })).toBeUndefined();
    await settle();
    expect(logEvent).toHaveBeenCalledWith("warn", "slow", { ms: 900 });
  });

  it("refuses a level outside the declared three", async () => {
    const logEvent = vi.fn();
    const harness = await createServiceHarness({ logEvent });
    harness.child.hostApi.logEvent("trace" as "info", "noisy");
    await settle();
    expect(logEvent).not.toHaveBeenCalled();
    expect(detachedLog(harness).message).toBe("hostApi.logEvent failed after returning");
  });
});

/** The `handleId` the host allocated for the first call to `path`. */
function handleIdOf(harness: ServiceHarness, path: string): string {
  const index = harness.requests.findIndex((request) => request.path === path);
  expect(index, `no '${path}' request was sent`).toBeGreaterThanOrEqual(0);
  const reply = harness.replies[index];
  expect(reply?.ok, `'${path}' did not succeed`).toBe(true);
  return (reply as { value: { handleId: string } }).value.handleId;
}

/** Every `subscription-closed` the host pushed at the child. */
function closures(harness: ServiceHarness): { subscriptionId: string; reason: string }[] {
  return harness.pushed
    .filter((notification) => notification.kind === "subscription-closed")
    .map((notification) => {
      const closed = notification as unknown as { subscriptionId: string; reason: string };
      return { subscriptionId: closed.subscriptionId, reason: closed.reason };
    });
}

describe("a delegated worker cannot reach further than the plugin process itself", () => {
  it("passes grants that lie inside the child's own envelope straight through", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/usr/bin/python3",
      allowReadPaths: [`${PLUGIN_ROOT}/runtime`, PLUGIN_DATA_DIR],
      allowWritePaths: [`${PLUGIN_DATA_DIR}/index`],
    });
    expect(spawnWorker).toHaveBeenCalledWith({
      workerId: "indexer",
      command: "/usr/bin/python3",
      allowReadPaths: [`${PLUGIN_ROOT}/runtime`, PLUGIN_DATA_DIR],
      allowWritePaths: [`${PLUGIN_DATA_DIR}/index`],
    });
  });

  it("refuses a write grant outside the jail, and never reaches the supervisor", async () => {
    // The escape this check exists for: the child cannot write outside its data
    // directory, so it asks the host to spawn something that can. A refusal
    // that still spawned would be no refusal at all, which is why the spy is
    // asserted as well as the rejection.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "escape",
        command: "/bin/sh",
        allowWritePaths: ["/"],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a read grant outside every root the child holds", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "peek",
        command: "/usr/bin/python3",
        allowReadPaths: ["/etc"],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("admits a read grant inside a root the HOST widened the child with", async () => {
    // The composition claim, driven rather than asserted: the check reads the
    // envelope, so a root the host added to it is delegable with no change to
    // this file. Without the widening this exact grant is the refusal above.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: `${WIDENED_READ_ROOT}/venv/bin/python`,
      allowReadPaths: [`${WIDENED_READ_ROOT}/venv/bin/python`],
    });
    expect(spawnWorker).toHaveBeenCalledWith({
      workerId: "indexer",
      command: `${WIDENED_READ_ROOT}/venv/bin/python`,
      allowReadPaths: [`${WIDENED_READ_ROOT}/venv/bin/python`],
    });
  });

  it("does not let a widened READ root become writable through a worker", async () => {
    // The delegated half of the same rule the derivation enforces.
    // `derivePluginChildEnvelope` subtracts each `hostDirectory` row's own
    // resolved directory from the ceiling a `userChosenDirectory` value is
    // bounded by, so such a root cannot be in `write` in the first place —
    // `confined-plugin-child.test.ts` drives the production derivation for that
    // half, including the case where the granted directory links out of the
    // host's home. What THIS pins is the boundary that CONSUMES the two lists:
    // a host decision that the child may READ the provisioned runtime must not
    // hand it the ability to rewrite that runtime by asking the host to spawn a
    // worker that can. The fixture's `write` omits the widened root because the
    // derivation would too.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "rewrite-runtime",
        command: "/bin/sh",
        allowWritePaths: [`${WIDENED_READ_ROOT}/venv`],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("does not let the plugin's own runtime root become writable through a worker", async () => {
    // The delegated half of the ceiling. `PLUGIN_ROOT` is in `read` and its
    // `data` subdirectory is in `write`, which is the production shape — so a
    // grant naming a SIBLING of the data directory under that same root is the
    // one a string-prefix reading of "inside my envelope" would wave through.
    // What it names is the bundle the next load imports into the main process,
    // and a worker must not reach it merely because the plugin process may read
    // it. `derivePluginChildEnvelope` refuses to put such a path into `write` at
    // all; this pins the boundary that CONSUMES that list, so the refusal does
    // not rest on the derivation alone staying correct.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "rewrite-bundle",
        command: "/bin/sh",
        allowWritePaths: [`${PLUGIN_ROOT}/dist`],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a sibling of the widened root, not merely its string prefix", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "near-miss",
        command: "/usr/bin/python3",
        allowReadPaths: [`${WIDENED_READ_ROOT}-elsewhere`],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("compares what a grant MEANS, not what it says", async () => {
    // `<dataDir>/../..` starts with the data dir as a string and is not inside
    // it. A containment check that skipped the resolve would admit it.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "traverse",
        command: "/bin/sh",
        allowWritePaths: [`${PLUGIN_DATA_DIR}/../../../etc`],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a sibling directory whose name merely starts with the jail's", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "prefix",
        command: "/bin/sh",
        allowWritePaths: [`${PLUGIN_DATA_DIR}-elsewhere`],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a relative grant rather than resolving it against the host's cwd", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "relative",
        command: "/bin/sh",
        allowWritePaths: ["data"],
      }),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a spec field the boundary does not decode", async () => {
    // A spec that grows a grant-shaped field must FAIL here until this decodes
    // it. Passing an unknown field through unexamined is how a future grant
    // reaches the supervisor without ever meeting the envelope check.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "future",
        command: "/bin/sh",
        allowNetworkTo: ["*"],
      } as never),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a spec whose command is not a string", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({ workerId: "typed", command: 7 } as never),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });
});

describe("a host-side revocation reaches the child", () => {
  it("tells the child when the host releases a registration it still holds", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    await harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" });
    const handleId = handleIdOf(harness, "spawnWorker");
    expect(closures(harness)).toEqual([]);

    worker.emitExit(0, null);
    await settle();

    // `subscription-closed` had a receiver and no sender until this: the child
    // could act on it and nothing could produce it.
    expect(closures(harness)).toEqual([{ subscriptionId: handleId, reason: "revoked" }]);
  });

  it("does not echo a close the child asked for", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/bin/true",
    });
    handle.stop();
    await settle();
    expect(closures(harness)).toEqual([]);
  });

  it("does not write to a child that is already gone", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    await harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" });
    expect(harness.killChild()).toBe(1);
    await settle();
    expect(closures(harness)).toEqual([]);
  });

  it("says nothing about an abort channel, which the child has no entry for", async () => {
    const controller = new AbortController();
    const harness = await createServiceHarness({ callLlm: async () => "answered" });
    await harness.child.hostApi.callLlm("hello", { signal: controller.signal });
    await settle();
    // The call settled, so the host released its own controller — bookkeeping
    // the child registered nothing for, and a close it would report as an
    // unknown subscription.
    expect(closures(harness)).toEqual([]);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });

  it("refuses to cancel a subscription through the abort mechanism", async () => {
    // The two registration kinds share one ledger. Without the guard an `abort`
    // naming a worker handle would stop the worker through the cancellation
    // path — and would bounce a close back at the child that sent it.
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    await harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" });
    const handleId = handleIdOf(harness, "spawnWorker");
    harness.host.handleNotification({
      wire: 1,
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      kind: "abort",
      subscriptionId: handleId,
    });
    await settle();
    expect(harness.host.openSubscriptionCount).toBe(1);
    expect(worker.stopped()).toBe(0);
    expect(closures(harness)).toEqual([]);
  });
});

describe("a revoked key lease stops being spendable in the child", () => {
  it("drops the child's copy when the host takes the lease back", async () => {
    const release = vi.fn();
    const harness = await createServiceHarness({
      resolveApiKey: async () => ({
        ok: true as const,
        vendor: "openai" as const,
        bearer: () => "sk-live-credential",
        release,
      }),
    });
    const lease = await harness.child.hostApi.resolveApiKey!({ purpose: "llm" });
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    expect(lease.bearer()).toBe("sk-live-credential");

    const handleId = handleIdOf(harness, "resolveApiKey");
    harness.child.deliver({
      wire: 1,
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      kind: "subscription-closed",
      subscriptionId: handleId,
      reason: "revoked",
    });

    // The credential is a mutable closure variable precisely so this can drop
    // it. Before the sender existed the child held it until the process ended.
    expect(() => lease.bearer()).toThrow(/lease already released/);
  });
});

describe("startAudioCapture crosses as an id, and the PCM survives the wire", () => {
  /** A capture whose frames and end the test decides. */
  function makeFakeCapture(opened = { microphone: true, systemAudio: true }) {
    const frames: ((frame: { seq: number; pcm: Uint8Array; peak: number }) => void)[] = [];
    const ends: ((end: { reason: string; detail?: string }) => void)[] = [];
    const stop = vi.fn(async () => {});
    return {
      captureId: "capture-1",
      opened,
      stop,
      onFrame: (listener: (frame: { seq: number; pcm: Uint8Array; peak: number }) => void) => {
        frames.push(listener);
        return () => {};
      },
      onEnd: (listener: (end: { reason: string; detail?: string }) => void) => {
        ends.push(listener);
        return () => {};
      },
      emitFrame: (frame: { seq: number; pcm: Uint8Array; peak: number }) => {
        for (const listener of frames) listener(frame);
      },
      emitEnd: (end: { reason: string; detail?: string }) => {
        for (const listener of ends) listener(end);
      },
    };
  }

  it("delivers bytes no text codec could round-trip", async () => {
    const capture = makeFakeCapture();
    const harness = await createServiceHarness({
      startAudioCapture: async () => capture,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.startAudioCapture({
      sampleRate: 16_000,
      frameMs: 200,
      microphone: true,
      systemAudio: true,
    });

    const got: Uint8Array[] = [];
    handle.onFrame((frame) => got.push(frame.pcm));
    // A NUL, a lone continuation byte and a 0xFF — none of which survive a
    // text codec, which is exactly the mistake a `res.ok`-shaped test misses.
    // Silence in int16 is 0x0000, so a codec that mangles NUL mangles silence.
    const pcm = new Uint8Array([0x00, 0x00, 0x80, 0xff, 0xfe, 0x7f]);
    capture.emitFrame({ seq: 0, pcm, peak: 0.5 });
    await settle();

    expect(got).toHaveLength(1);
    expect(Array.from(got[0]!)).toEqual(Array.from(pcm));
  });

  it("carries seq and peak alongside the bytes", async () => {
    const capture = makeFakeCapture();
    const harness = await createServiceHarness({
      startAudioCapture: async () => capture,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.startAudioCapture({
      sampleRate: 16_000, frameMs: 200, microphone: true, systemAudio: false,
    });
    const seen: { seq: number; peak: number }[] = [];
    handle.onFrame(({ seq, peak }) => seen.push({ seq, peak }));

    capture.emitFrame({ seq: 7, pcm: new Uint8Array([1, 2]), peak: 0.25 });
    await settle();

    // `seq` is what lets a plugin notice it lost audio; a frame that arrives
    // without it looks exactly like one that did not.
    expect(seen).toEqual([{ seq: 7, peak: 0.25 }]);
  });

  it("reports what actually opened, and hands over an id rather than the capture", async () => {
    const capture = makeFakeCapture({ microphone: true, systemAudio: false });
    const harness = await createServiceHarness({
      startAudioCapture: async () => capture,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.startAudioCapture({
      sampleRate: 16_000, frameMs: 200, microphone: true, systemAudio: true,
    });

    // Asked for both, got one, and the plugin can see the difference.
    expect(handle.opened).toEqual({ microphone: true, systemAudio: false });

    const reply = await harness.host.handle(
      harness.requests.find((request) => request.path === "startAudioCapture")!,
    );
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    // Nothing that could be a live capture — no MediaStream, no AudioContext,
    // no function. The same property `spawnWorker` has.
    expect(Object.keys(reply.value as object).sort()).toEqual([
      "captureId",
      "handleId",
      "opened",
    ]);
  });

  it("delivers the end once, with the reason the host gave", async () => {
    const capture = makeFakeCapture();
    const harness = await createServiceHarness({
      startAudioCapture: async () => capture,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.startAudioCapture({
      sampleRate: 16_000, frameMs: 200, microphone: true, systemAudio: false,
    });
    const ends: { reason: string; detail?: string }[] = [];
    handle.onEnd((end) => ends.push(end));

    capture.emitEnd({ reason: "sources-lost", detail: "microphone track ended" });
    await settle();

    // A plugin finalising its recording here needs to know WHY: a lost source
    // is a truncated meeting, and a `stopped` is not.
    expect(ends).toEqual([{ reason: "sources-lost", detail: "microphone track ended" }]);
  });
});

describe("attachFloatingPanel crosses as a receipt, and the detach reason survives", () => {
  /** A dock slot whose detach the test decides. */
  function makeFakePanel(height = 180) {
    const listeners: ((reason: string) => void)[] = [];
    const detach = vi.fn(async () => {});
    const resize = vi.fn(async (next: number) => Math.min(next, 300));
    return {
      panelId: "panel-1",
      height,
      detach,
      resize,
      onDetached: (listener: (reason: string) => void) => { listeners.push(listener); },
      fire: (reason: string) => { for (const listener of listeners) listener(reason); },
      listenerCount: () => listeners.length,
    };
  }

  it("hands over an id rather than the panel", async () => {
    const panel = makeFakePanel();
    const harness = await createServiceHarness({
      attachFloatingPanel: async () => panel,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.attachFloatingPanel({
      extensionId: "some-card",
      height: 240,
    });

    // The height the DOCK applied, not the one asked for. A plugin that reads
    // back its own request cannot tell it was clamped.
    expect(handle.height).toBe(180);

    const reply = await harness.host.handle(
      harness.requests.find((request) => request.path === "attachFloatingPanel")!,
    );
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    // Nothing that could be a live panel — the same property `spawnWorker` and
    // `startAudioCapture` have.
    for (const value of Object.values(reply.value as Record<string, unknown>)) {
      expect(typeof value).not.toBe("function");
    }
  });

  it("resizes through its own path and returns what the host applied", async () => {
    const panel = makeFakePanel();
    const harness = await createServiceHarness({
      attachFloatingPanel: async () => panel,
      resizeFloatingPanel: async (_id: string, next: number) => Math.min(next, 300),
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.attachFloatingPanel({ extensionId: "some-card" });

    // A handle's METHOD cannot cross on its own — the wire carries calls by
    // path — so resize is its own addressable member and this is the proof it
    // is wired to one.
    expect(await handle.resize(900)).toBe(300);
    expect(handle.height).toBe(300);
    expect(harness.requests.some((request) => request.path === "resizeFloatingPanel")).toBe(true);
  });

  it("detaches the host-side slot when the child releases its receipt", async () => {
    const panel = makeFakePanel();
    const harness = await createServiceHarness({
      attachFloatingPanel: async () => panel,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.attachFloatingPanel({ extensionId: "some-card" });

    await handle.detach();
    await settle();

    // Releasing the subscription IS the detach. Without this the child's
    // `detach()` would resolve while the slot stayed on the user's screen
    // forever, and nothing would report it.
    expect(panel.detach).toHaveBeenCalledTimes(1);
  });

  it("delivers the reason the host gave, once", async () => {
    const panel = makeFakePanel();
    const harness = await createServiceHarness({
      attachFloatingPanel: async () => panel,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.attachFloatingPanel({ extensionId: "some-card" });
    const reasons: string[] = [];
    handle.onDetached((reason) => reasons.push(reason));

    panel.fire("user-closed");
    panel.fire("user-closed");
    await settle();

    expect(reasons).toEqual(["user-closed"]);
  });

  it("tells a late subscriber the real reason, not a fabricated one", async () => {
    // THE NARROW ONE, and the reason it matters more than its width.
    //
    // A plugin subscribes in the same turn its attach resolves in, so the gap
    // is a microtask. But `"requested"` is the one value that means "the
    // plugin asked for this", and the child had the true reason one closure
    // away while answering with that constant. A recorder told `"requested"`
    // after the USER closed the dock concludes the teardown was its own, skips
    // its orphan handling, and leaves a recording running with nothing on
    // screen driving it.
    const panel = makeFakePanel();
    const harness = await createServiceHarness({
      attachFloatingPanel: async () => panel,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.attachFloatingPanel({ extensionId: "some-card" });

    panel.fire("renderer-gone");
    await settle();

    const late: string[] = [];
    handle.onDetached((reason) => late.push(reason));
    expect(late).toEqual(["renderer-gone"]);
  });
});
