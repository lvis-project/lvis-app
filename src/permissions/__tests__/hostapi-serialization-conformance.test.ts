/**
 * hostapi-serialization-conformance.test.ts
 *
 * The plugin→host surface is currently a plain JavaScript object handed to a
 * factory that runs in the SAME heap as the host. Moving plugins behind a
 * process boundary (`docs/blueprints/plugin-process-isolation.md`) turns every
 * member of that object into a message, and a message is JSON. So each member
 * has to be one of exactly two things:
 *
 *   1. JSON-representable in BOTH directions — arguments in, return value out —
 *      and therefore crossable as-is; or
 *   2. NOT representable, and therefore owed an explicit decision about what
 *      goes on the wire instead (a handle id, a base64 payload, a child-local
 *      stub fed by notifications).
 *
 * This gate holds the second list. A member that is neither classified as
 * representable nor listed as owing a decision FAILS here — which is the whole
 * point: silently accepting an unclassified member would let the boundary be
 * designed against a surface that no longer matches the code, and the mismatch
 * would only surface as a runtime shape error inside a plugin much later.
 *
 * It deliberately walks the REAL hostApi built by the production factory, the
 * same object `hostapi-effect-completeness.test.ts` walks, so the effect SOT and
 * the marshalling SOT can be asserted to describe the SAME surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  readPluginRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
  appPrependOnceListener: vi.fn(),
  runtime: {
    // boot installs each loaded plugin's partition policy before starting any
    // of them, so the double needs the cheap half of startAll too.
    load: vi.fn(async () => {}),
    startAll: vi.fn(async () => {}),
    listToolNames: vi.fn(() => [] as string[]),
    listPluginIds: vi.fn(() => [] as string[]),
    listPluginManifests: vi.fn(() => [] as Array<{ pluginId: string; manifest: unknown }>,
    ),
    getPluginRoot: vi.fn((pluginId: string) => `/tmp/lvis-test/plugins/${pluginId}`,
    ),
    getPluginManifest: vi.fn(() => null),
    resolvePluginInstallId: vi.fn((pluginId: string) => pluginId),
    isPluginEnabled: vi.fn(() => true),
    getApprovedPluginAccess: vi.fn(() => undefined),
    registerDisposer: vi.fn(),
    resolveToolOwner: vi.fn((toolName: string) => `${toolName}-owner`),
    // Reached by the `onEvent` probe below, which subscribes for real.
    assertPluginEventAccess: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/lvis-test"),
    isPackaged: false,
    prependOnceListener: harness.appPrependOnceListener,
    once: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null),
  }),
  shell: { openExternal: vi.fn() },
}));

vi.mock("../../plugins/runtime.js", () => ({
  PluginRuntime: vi.fn().mockImplementation(function (
    this: unknown,
    options: Record<string, unknown>,
  ) {
    harness.capturedRuntimeOptions = options;
    return harness.runtime;
  }),
}));

vi.mock("../../plugins/dev-watcher.js", () => ({
  startPluginDevWatcher: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../../main/html-preview-partition.js", () => ({
  installPluginPartitionPolicy: vi.fn(),
}));

vi.mock("../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/lvis-test/plugins",
    registryPath: "/tmp/lvis-test/registry.json",
    cacheRoot: "/tmp/lvis-test/cache",
  })),
}));

vi.mock("../../plugins/registry.js", () => ({
  readPluginRegistry: harness.readPluginRegistry,
}));

import {
  base64DecodedLength,
  describeNonJson,
} from "../../shared/json-representable.js";
import { HOSTAPI_EFFECT_BY_PATH } from "../effect-kind.js";
import { buildRealHostApi, collectFunctionPaths } from "./real-host-api.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();

afterEach(async () => {
  await resources.cleanup();
});

/**
 * What a single hostApi member sends and receives, and whether that survives
 * JSON. `args` / `returns` record the shape the verdict rests on, so a reader
 * can check the verdict against the declaration instead of trusting it.
 */
interface MarshallingDecision {
  /** Do BOTH the arguments and the return value survive a JSON round-trip? */
  readonly jsonRepresentable: boolean;
  /** The argument shape the verdict rests on. */
  readonly args: string;
  /** The return shape the verdict rests on. */
  readonly returns: string;
  /**
   * Present when the declared shape is generically typed (`unknown`, `T`) and
   * therefore only JSON by contract, not by construction. Such a member crosses
   * as-is, but a plugin that puts a `Date` / `Map` / class instance in the
   * payload breaks at the wire, not here.
   */
  readonly contractualPayload?: true;
}

/**
 * Every member of the REAL hostApi, with the marshalling verdict for each.
 *
 * Adding a hostApi member without adding it here fails this file. That is the
 * intended cost: the boundary design is checked against this table.
 */
const HOSTAPI_MARSHALLING: Record<string, MarshallingDecision> = {
  // ─── storage.* ────────────────────────────────────────────────────────────
  "storage.resolve": {
    jsonRepresentable: true,
    args: "...segments: string[]",
    returns: "string",
  },
  "storage.read": {
    jsonRepresentable: false,
    args: "relPath: string",
    returns:
      "Promise<Uint8Array> — a typed array, not a JSON value. The value actually delivered is a Node Buffer, whose toJSON() yields { type: 'Buffer', data: number[] }, so a naive round-trip does NOT throw — it silently changes the type",
  },
  "storage.readText": {
    jsonRepresentable: true,
    args: "relPath: string, encoding?: StorageEncoding (string union)",
    returns: "Promise<string>",
  },
  "storage.readJson": {
    jsonRepresentable: true,
    args: "relPath: string",
    returns: "Promise<T | null> — parsed from JSON on disk",
  },
  "storage.list": {
    jsonRepresentable: true,
    args: "relPath?: string",
    returns: "Promise<string[]>",
  },
  "storage.exists": {
    jsonRepresentable: true,
    args: "relPath: string",
    returns: "Promise<boolean>",
  },
  "storage.write": {
    jsonRepresentable: false,
    args: "relPath: string, data: string | Uint8Array — the Uint8Array branch is not a JSON value",
    returns: "Promise<void>",
  },
  "storage.writeJson": {
    jsonRepresentable: true,
    contractualPayload: true,
    args: "relPath: string, value: T, indent?: number",
    returns: "Promise<void>",
  },
  "storage.rm": {
    jsonRepresentable: true,
    args: "relPath: string, options?: { recursive?: boolean }",
    returns: "Promise<void>",
  },
  "storage.mkdir": {
    jsonRepresentable: true,
    args: "relPath: string",
    returns: "Promise<void>",
  },
  "storage.writeEncrypted": {
    jsonRepresentable: true,
    args: "relPath: string, plaintext: string",
    returns: "Promise<void>",
  },
  "storage.readEncrypted": {
    jsonRepresentable: true,
    args: "relPath: string",
    returns: "Promise<string>",
  },
  // ─── config.* ─────────────────────────────────────────────────────────────
  "config.get": {
    jsonRepresentable: true,
    contractualPayload: true,
    args: "key: string",
    returns: "T | undefined — a leaf of the resolved config object",
  },
  "config.set": {
    jsonRepresentable: true,
    contractualPayload: true,
    args: "key: string, value: T",
    returns: "Promise<void>",
  },
  "config.onChange": {
    jsonRepresentable: false,
    args: "key: string, callback: (value) => void — a function",
    returns: "() => void — an unsubscribe disposer, a function",
  },
  // ─── top level ────────────────────────────────────────────────────────────
  emitEvent: {
    jsonRepresentable: true,
    contractualPayload: true,
    args: "eventType: string, data?: unknown",
    returns: "void",
  },
  onEvent: {
    jsonRepresentable: false,
    args: "eventType: string, handler: (data) => void — a function",
    returns: "() => void — an unsubscribe disposer, a function",
  },
  getInstalledPluginIds: {
    jsonRepresentable: true,
    args: "()",
    returns: "string[]",
  },
  onPluginsChanged: {
    jsonRepresentable: false,
    args: "handler: (event: PluginLifecycleEvent) => void — a function",
    returns: "() => void — an unsubscribe disposer, a function",
  },
  getSecret: {
    jsonRepresentable: true,
    args: "key: string",
    returns: "string | null",
  },
  resolveApiKey: {
    jsonRepresentable: false,
    args: "opts: { purpose, vendor?, signal?: AbortSignal } — AbortSignal is not a JSON value",
    returns: "Promise<{ ok: true, bearer(): string, release(): void, … } | { ok: false, reason }> — two functions in the granted branch",
  },
  callLlm: {
    jsonRepresentable: false,
    args: "prompt: string, options?: { maxTokens?, systemPrompt?, signal?: AbortSignal } — AbortSignal is not a JSON value",
    returns: "Promise<string>",
  },
  hostFetch: {
    jsonRepresentable: false,
    args: "input: string | URL, init?: RequestInit — URL, Headers, AbortSignal, and a ReadableStream body are not JSON values",
    returns: "Promise<Response> — a class instance with a streaming body",
  },
  logEvent: {
    jsonRepresentable: true,
    contractualPayload: true,
    args: "level: 'info' | 'warn' | 'error', message: string, data?: unknown",
    returns: "void",
  },
  onShutdown: {
    jsonRepresentable: false,
    args: "handler: () => void | Promise<void> — a function",
    returns: "void",
  },
  spawnWorker: {
    jsonRepresentable: false,
    args: "spec: PluginWorkerSpec (plain data)",
    returns: "Promise<SpawnedPluginWorker> — live process control: stop / onStdout / onStderr / onExit are functions",
  },
  openAuthWindow: {
    jsonRepresentable: true,
    args: "options: OpenAuthWindowBaseOptions & { returnFinalUrl? } (plain data)",
    returns: "Promise<AuthWindowCookie[] | { cookies, finalUrl }>",
  },
  openAuthPartitionViewer: {
    jsonRepresentable: true,
    args: "opts: { url: string, windowTitle?: string }",
    returns: "Promise<void>",
  },
  clearAuthPartition: {
    jsonRepresentable: true,
    args: "partition: string",
    returns: "Promise<void>",
  },
  // The handle is a STRING that NAMES a host-owned listener, not a reference to
  // one. That is what makes this family crossable at all: the socket never
  // leaves the host, and the child holds nothing it could fail to dispose.
  "authRedirect.open": {
    jsonRepresentable: true,
    args: "()",
    returns: "Promise<{ handle: string, redirectUri: string }> — plain data",
  },
  "authRedirect.wait": {
    jsonRepresentable: true,
    args: "opts: { handle: string, timeoutMs?: number }",
    returns: "Promise<Readonly<Record<string, string>>> — the redirect's query parameters, plain data",
  },
  "authRedirect.close": {
    jsonRepresentable: true,
    args: "opts: { handle: string }",
    returns: "Promise<void>",
  },
  // Nothing crosses on the way in, and what comes back is the user's answer as
  // plain strings. No handle, no resource: the chooser is gone by the time the
  // call resolves.
  pickFolders: {
    jsonRepresentable: true,
    args: "()",
    returns: "Promise<{ canceled: boolean, folders: string[] }> — plain data",
  },
  // No arguments, an array of `{ deviceId, label }` out. Plain data both ways.
  listAudioInputDevices: {
    jsonRepresentable: true,
    args: "(none)",
    returns: "Promise<readonly AudioCaptureDevice[]> — plain data",
  },
  // Not JSON-representable for the same reason `spawnWorker` is not: the
  // answer is live control over a resource the host keeps owning. The PCM
  // itself does cross as JSON, base64-encoded, because the wire has no bytes —
  // a `Uint8Array` put through it arrives as an object with numeric keys,
  // which is not an error anywhere, just audio that decodes to noise.
  startAudioCapture: {
    jsonRepresentable: false,
    args: "request: AudioCaptureRequest (plain data)",
    returns: "Promise<AudioCaptureHandle> — live capture control: stop / onFrame / onEnd are functions",
  },
  attachFloatingPanel: {
    jsonRepresentable: false,
    args: "request: AttachFloatingPanelRequest (plain data)",
    returns:
      "Promise<FloatingPanelHandle> — live slot control: resize / detach / onDetached are functions",
  },
  // Names an EXISTING slot and answers with a number, so it crosses whole. It
  // exists as its own member precisely because the handle method above cannot:
  // the wire carries calls by path, and `resize` needs an answer back.
  resizeFloatingPanel: {
    jsonRepresentable: true,
    args: "panelId: string, height: number",
    returns: "Promise<number> — the height actually applied, after clamping",
  },
  // A drive letter in, a UNC string or `null` out. `null` is a real answer —
  // the drive is a local disk — so it must survive the wire distinctly from a
  // rejection, which is what a lookup that could not run produces.
  resolveMappedDriveRoot: {
    jsonRepresentable: true,
    args: "drive: string",
    returns: "Promise<string | null> — plain data",
  },
  getAuthPartitionCookies: {
    jsonRepresentable: true,
    args: "opts: { partitionSub: string, urls: string[] }",
    returns: "Promise<Array<{ url: string, cookies: AuthPartitionCookie[] }>> — plain data",
  },
  openExternalUrl: {
    jsonRepresentable: true,
    args: "url: string",
    returns: "Promise<void>",
  },
  probePrivateHost: {
    jsonRepresentable: true,
    args: "host: string, opts?: { timeoutMs?: number }",
    returns: "Promise<boolean>",
  },
  getAppPreference: {
    jsonRepresentable: true,
    contractualPayload: true,
    args: "key: string",
    returns: "T | undefined — an allow-listed host preference value",
  },
  triggerConversation: {
    jsonRepresentable: true,
    contractualPayload: true,
    args: "spec: ConversationTriggerSpec — plain data plus context?: Record<string, unknown>",
    returns: "Promise<ConversationTriggerResult> — plain data",
  },
  hasRoutineBySource: {
    jsonRepresentable: true,
    args: "source: string",
    returns: "Promise<boolean>",
  },
  // Text and a key across, a discriminated envelope back. Nothing in either
  // direction is a handle, so nothing has to survive the boundary but JSON.
  proposeWork: {
    jsonRepresentable: true,
    args: "input: WorkProposalInput",
    returns: "Promise<WorkProposalResult>",
  },
  withdrawWorkProposal: {
    jsonRepresentable: true,
    args: "kind: string, key: string",
    returns: "Promise<boolean>",
  },
  // ─── agentApproval.* ──────────────────────────────────────────────────────
  "agentApproval.request": {
    jsonRepresentable: true,
    contractualPayload: true,
    args: "input: { toolName: string, args: unknown, reason: string, scope: string }",
    returns: "Promise<ApprovalChoice> — a string union",
  },
  "agentApproval.respond": {
    jsonRepresentable: true,
    args: "requestId: string, choice: ApprovalChoice, nonce?: string, hmac?: string",
    returns: "Promise<void>",
  },
};

/**
 * The members that CANNOT cross as JSON and therefore owe the boundary an
 * explicit representation. Pinned literally, not derived, so that flipping a
 * member's verdict in the table above is a deliberate two-place edit reviewed
 * as a contract change — never a silent one.
 *
 * `docs/blueprints/plugin-process-isolation.md` §3.1/§3.2 carry the decided
 * representation for each of these.
 */
const REQUIRES_DECIDED_REPRESENTATION: readonly string[] = [
  "callLlm",
  "config.onChange",
  "hostFetch",
  "onEvent",
  "onPluginsChanged",
  "onShutdown",
  "resolveApiKey",
  "spawnWorker",
  "startAudioCapture",
  "attachFloatingPanel",
  "storage.read",
  "storage.write",
];

describe("hostApi marshalling — the surface a process boundary must carry", () => {
  beforeEach(() => {
    harness.readPluginRegistry.mockReset();
    harness.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [] });
  });

  it("every member of the REAL hostApi carries a marshalling decision", async () => {
    const hostApi = await buildRealHostApi(
      harness,
      resources.makeTmpDir("lvis-hostapi-marshalling-"),
    );
    const paths: string[] = [];
    const nonPlainNamespaces: string[] = [];
    collectFunctionPaths(hostApi, "", paths, nonPlainNamespaces);

    // Sanity: the traversal actually found the surface, so an enumeration that
    // silently returns nothing cannot pass this file.
    expect(paths.length).toBeGreaterThan(20);
    expect(nonPlainNamespaces).toEqual([]);

    const undecided = paths.filter((p) => !(p in HOSTAPI_MARSHALLING));
    expect(
      undecided,
      `hostApi member(s) with no marshalling decision — classify each in HOSTAPI_MARSHALLING (this file), and if a member's arguments or return value cannot cross as JSON, add it to REQUIRES_DECIDED_REPRESENTATION and decide its wire representation in docs/blueprints/plugin-process-isolation.md: ${undecided.join(", ")}`,
    ).toEqual([]);

    const stale = Object.keys(HOSTAPI_MARSHALLING).filter(
      (p) => !paths.includes(p),
    );
    expect(
      stale,
      `HOSTAPI_MARSHALLING classifies member(s) the real hostApi does not expose — delete them so the boundary is not designed around a member that cannot be implemented: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("the effect SOT and the marshalling table describe the SAME surface", async () => {
    const hostApi = await buildRealHostApi(
      harness,
      resources.makeTmpDir("lvis-hostapi-marshalling-"),
    );
    const paths: string[] = [];
    const nonPlainNamespaces: string[] = [];
    collectFunctionPaths(hostApi, "", paths, nonPlainNamespaces);

    // The completeness test asserts effect-SOT ⊇ real surface. This asserts the
    // other direction — effect-SOT ⊆ real surface — which is the check that was
    // missing when `callTool` sat in the effect SOT while being neither on
    // `PluginHostApi` nor built by `createHostApi`. Without it, the boundary
    // contract inflates by members nothing can implement.
    const phantom = Object.keys(HOSTAPI_EFFECT_BY_PATH).filter(
      (p) => !paths.includes(p),
    );
    expect(
      phantom,
      `HOSTAPI_EFFECT_BY_PATH classifies path(s) absent from the real hostApi — remove them, or wire the method: ${phantom.join(", ")}`,
    ).toEqual([]);

    expect(Object.keys(HOSTAPI_MARSHALLING).sort()).toEqual(
      Object.keys(HOSTAPI_EFFECT_BY_PATH).sort(),
    );
  });

  it("the members owing a decided wire representation are exactly the pinned set", () => {
    const notRepresentable = Object.entries(HOSTAPI_MARSHALLING)
      .filter(([, decision]) => !decision.jsonRepresentable)
      .map(([path]) => path)
      .sort();
    expect(notRepresentable).toEqual([...REQUIRES_DECIDED_REPRESENTATION].sort());

    // Each one must say WHY in the shape it declares — an empty justification
    // would make the list unauditable.
    for (const path of REQUIRES_DECIDED_REPRESENTATION) {
      const decision = HOSTAPI_MARSHALLING[path];
      expect(decision, `${path} is pinned but unclassified`).toBeDefined();
      expect(`${decision.args} ${decision.returns}`.length).toBeGreaterThan(20);
    }
  });

  it("the JSON predicate rejects the shapes a wire silently changes", () => {
    expect(describeNonJson({ a: 1, b: ["x", null], c: { d: true } }, "v")).toBeNull();
    expect(describeNonJson("plain", "v")).toBeNull();
    expect(describeNonJson(undefined, "v")).toBeNull();

    expect(describeNonJson(new Date(), "v")).toContain("Date");
    expect(describeNonJson(new Map(), "v")).toContain("Map");
    expect(describeNonJson(new Set(), "v")).toContain("Set");
    expect(describeNonJson(new URL("https://example.com"), "v")).toContain("URL");
    expect(describeNonJson(new Uint8Array([1]), "v")).toContain("Uint8Array");
    expect(describeNonJson(new Response(""), "v")).toContain("Response");
    expect(describeNonJson({ nested: { fn: () => {} } }, "v")).toContain("function");
    expect(describeNonJson([{ when: new Date() }], "v")).toContain("Date");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeNonJson(cyclic, "v")).toContain("cycle");
  });

  it("the base64 size rule bounds a payload before it is decoded", () => {
    // The rule the MCP app download parser and the plugin process boundary now
    // share. Padding is the whole subtlety: ignoring it over-reports by up to
    // two bytes per payload, which is a cap that means something slightly
    // different in each place that reimplements it.
    expect(base64DecodedLength("")).toBe(0);
    expect(base64DecodedLength(Buffer.from("a").toString("base64"))).toBe(1); // "YQ=="
    expect(base64DecodedLength(Buffer.from("ab").toString("base64"))).toBe(2); // "YWI="
    expect(base64DecodedLength(Buffer.from("abc").toString("base64"))).toBe(3); // "YWJj"

    // An UPPER bound, never an undercount: `Buffer.from(…, "base64")` drops
    // characters outside the alphabet, so the decoded length can only shrink.
    for (const text of ["", "a", "ab", "abc", "abcd", "x".repeat(1000)]) {
      const encoded = Buffer.from(text).toString("base64");
      expect(base64DecodedLength(encoded)).toBe(Buffer.byteLength(text));
      expect(
        base64DecodedLength(`${encoded}\n`),
        "whitespace must not make the estimate an undercount",
      ).toBeGreaterThanOrEqual(Buffer.from(`${encoded}\n`, "base64").byteLength);
    }
  });

  it("the disposer-returning subscriptions really do hand back a function", async () => {
    const hostApi = await buildRealHostApi(
      harness,
      resources.makeTmpDir("lvis-hostapi-marshalling-"),
    );
    const disposers = [
      hostApi.onEvent("surface-probe:event", () => {}),
      hostApi.onPluginsChanged(() => {}),
      hostApi.config.onChange("surface-probe-key", () => {}),
    ];
    for (const disposer of disposers) {
      expect(typeof disposer).toBe("function");
      expect(describeNonJson(disposer, "disposer")).toContain("function");
      disposer();
    }
  });

  it("storage.read really does hand back bytes, not a JSON value", async () => {
    const hostApi = await buildRealHostApi(
      harness,
      resources.makeTmpDir("lvis-hostapi-marshalling-"),
    );
    await hostApi.storage.write("surface-probe.bin", "payload");
    const bytes = await hostApi.storage.read("surface-probe.bin");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(describeNonJson(bytes, "storage.read()")).not.toBeNull();

    // The declared return is `Uint8Array`; what arrives is a Node `Buffer`. That
    // matters for the wire: `Buffer` carries a `toJSON()` and so round-trips
    // WITHOUT throwing, into `{ type: "Buffer", data: number[] }` — a different
    // type that reads as success. Any encoding decided for this member has to be
    // explicit rather than relying on JSON noticing.
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(JSON.parse(JSON.stringify(bytes))).toEqual({
      type: "Buffer",
      data: [...Buffer.from("payload")],
    });
  });

  it("the members classified representable really do return JSON values", async () => {
    const hostApi = await buildRealHostApi(
      harness,
      resources.makeTmpDir("lvis-hostapi-marshalling-"),
    );
    await hostApi.storage.writeJson("surface-probe.json", { ok: true });

    const observed: Array<[string, unknown]> = [
      ["storage.resolve", hostApi.storage.resolve("a", "b")],
      ["storage.list", await hostApi.storage.list()],
      ["storage.exists", await hostApi.storage.exists("surface-probe.json")],
      ["storage.readJson", await hostApi.storage.readJson("surface-probe.json")],
      ["storage.readText", await hostApi.storage.readText("surface-probe.json")],
      ["getInstalledPluginIds", hostApi.getInstalledPluginIds()],
      ["getSecret", await hostApi.getSecret("surface-probe-secret")],
      ["config.get", hostApi.config.get("surface-probe-key")],
      ["hasRoutineBySource", await hostApi.hasRoutineBySource("surface-probe")],
      [
        "proposeWork",
        await hostApi.proposeWork({
          kind: "surface-probe",
          key: "surface-probe",
          title: "surface probe",
          summary: "surface probe",
          state: "surface probe",
          taskBrief: "surface probe",
        }),
      ],
      ["withdrawWorkProposal", await hostApi.withdrawWorkProposal("surface-probe", "surface-probe")],
    ];

    for (const [path, value] of observed) {
      expect(
        HOSTAPI_MARSHALLING[path].jsonRepresentable,
        `${path} is probed as representable but classified otherwise`,
      ).toBe(true);
      expect(describeNonJson(value, `${path}()`)).toBeNull();
    }
  });

  it("getSecret answers asynchronously, because a synchronous answer cannot cross a process", async () => {
    // Not a style preference. `SharedArrayBuffer` + `Atomics.wait` shares
    // memory between THREADS, not processes, so there is no mechanism that
    // makes a synchronous cross-process call work — and pushing a snapshot of
    // the secrets into the child up front is the opposite of what the gate is
    // for. The signature is the part that has to survive the boundary; the
    // host implementation is still synchronous inside.
    //
    // Reverting it would compile everywhere `await` is already written, since
    // `await` on a plain value yields that value. This is what notices.
    const hostApi = await buildRealHostApi(
      harness,
      resources.makeTmpDir("lvis-hostapi-getsecret-"),
    );
    const returned = hostApi.getSecret("surface-probe-secret");
    expect(returned).toBeInstanceOf(Promise);
    await expect(returned).resolves.toBeNull();
  });
});
