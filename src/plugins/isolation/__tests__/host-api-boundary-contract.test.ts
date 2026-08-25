/**
 * The boundary contract, held against the surface SOT.
 *
 * Two enumerations have to describe the same 36 members: the effect
 * classification (`HOSTAPI_EFFECT_BY_PATH`, which the completeness test already
 * ties to the REAL hostApi object) and the marshalling contract this work
 * introduces. If they drift, a member exists that the boundary has no decision
 * for — and the failure mode is a plugin that works in every test and misbehaves
 * in the field, because today each member is a direct function call that no test
 * was written to pin.
 */
import { describe, expect, it } from "vitest";
import {
  ENFORCEMENT_EXCLUSIONS,
  EffectBoundaryDeniedError,
  GATED_EFFECT_PATHS,
} from "../../../permissions/effect-enforcement.js";
import { HOSTAPI_EFFECT_BY_PATH } from "../../../permissions/effect-kind.js";
import { ManifestIntegrityError } from "../../../permissions/manifest-integrity.js";
import { PluginRuntimeDetachedOperationError } from "../../runtime/detached-operation.js";
import {
  PluginStorageEncryptionUnavailableError,
  PluginStorageError,
} from "../../public-contract.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  isHostApiPath,
  type HostApiPath,
} from "../host-api-wire.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
  childLocalHostApiPath,
  classifyHostApiError,
  defineHostApiPath,
  unimplementedHostApiPath,
  type HostApiCall,
  type HostApiPathStatus,
} from "../host-api-dispatcher.js";
import {
  HOST_API_WIRE_VERSION,
  HostApiBoundaryError,
  UNIVERSAL_WIRE_ERROR_CODES,
  WIRE_BYTES_MAX,
  decodeWireBinary,
  decodeWireBytes,
  encodeWireBytes,
  inactiveHostApiMessage,
  reconstructWireError,
  type ArgumentMarshalling,
  type ChildNotificationSink,
  type DisposerLifetime,
  type HostApiEnvelope,
  type HostApiRequest,
  type ResultMarshalling,
} from "../host-api-wire.js";
import {
  OUT_OF_PROCESS_PLUGIN_IDS,
  allPluginsAreOutOfProcess,
  isOutOfProcessPlugin,
} from "../out-of-process-plugins.js";

const PLUGIN_ID = "com.example.contract";
const GENERATION = "gen-1";

const silentSink: ChildNotificationSink = { deliver: () => {} };

/** The identity every message carries; the host checks all three of it. */
const ENVELOPE: HostApiEnvelope = {
  wire: HOST_API_WIRE_VERSION,
  pluginId: PLUGIN_ID,
  generationId: GENERATION,
};

function request(overrides: Partial<HostApiRequest> = {}): HostApiRequest {
  return {
    ...ENVELOPE,
    callId: "c1",
    path: "hasRoutineBySource",
    args: ["nightly"],
    ...overrides,
  } as HostApiRequest;
}

function dispatcher(
  options: Partial<ConstructorParameters<typeof HostApiDispatcher>[0]> = {},
): HostApiDispatcher {
  return new HostApiDispatcher({
    pluginId: PLUGIN_ID,
    generationId: GENERATION,
    isActive: () => true,
    notifications: silentSink,
    ...options,
  });
}

describe("the marshalling contract covers exactly the classified hostApi surface", () => {
  it("declares one contract per effect-SOT member, and no others", () => {
    expect(Object.keys(HOSTAPI_PATH_CONTRACTS).sort()).toEqual(
      Object.keys(HOSTAPI_EFFECT_BY_PATH).sort(),
    );
  });

  it("counts the surface from the SOT rather than from the design prose", () => {
    // The design says 36. It is right today only because the `callTool` drift it
    // named has since been closed; asserting the SOT's own size is what keeps
    // the number honest when the surface next changes.
    expect(Object.keys(HOSTAPI_PATH_CONTRACTS)).toHaveLength(
      Object.keys(HOSTAPI_EFFECT_BY_PATH).length,
    );
  });

  it("gives every member a dispatch-table entry keyed to its own contract", () => {
    for (const path of Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]) {
      const handler = HOSTAPI_DISPATCH_TABLE[path];
      expect(handler, `no dispatch entry for '${path}'`).toBeDefined();
      expect(handler.path).toBe(path);
      expect(handler.contract).toBe(HOSTAPI_PATH_CONTRACTS[path]);
    }
    expect(Object.keys(HOSTAPI_DISPATCH_TABLE).sort()).toEqual(
      Object.keys(HOSTAPI_PATH_CONTRACTS).sort(),
    );
  });

  it("answers all four axes for every member", () => {
    for (const [path, contract] of Object.entries(HOSTAPI_PATH_CONTRACTS)) {
      expect(contract.arguments, path).toBeTruthy();
      expect(contract.result, path).toBeTruthy();
      expect(contract.lifetime, path).toBeTruthy();
      expect(Array.isArray(contract.errors), path).toBe(true);
    }
  });

  it("uses every value each axis's vocabulary offers", () => {
    // A vocabulary member nothing declares is either a decision that was
    // dropped or a word that means nothing — both worth knowing about. The
    // annotations are the other half of the check: a declared value outside its
    // union is a compile error here, not a silently accepted string.
    const argumentValues: ArgumentMarshalling[] = [
      "plain-json",
      "encoded",
      "handler-registration",
      "child-local",
    ];
    const resultValues: ResultMarshalling[] = [
      "plain-json",
      "void",
      "encoded",
      "handle",
      "child-local",
    ];
    const lifetimeValues: DisposerLifetime[] = [
      "none",
      "child-disposable",
      "host-terminated",
    ];
    const contracts = Object.values(HOSTAPI_PATH_CONTRACTS);
    expect([...new Set(contracts.map((c) => c.arguments))].sort()).toEqual(
      [...argumentValues].sort(),
    );
    expect([...new Set(contracts.map((c) => c.result))].sort()).toEqual(
      [...resultValues].sort(),
    );
    expect([...new Set(contracts.map((c) => c.lifetime))].sort()).toEqual(
      [...lifetimeValues].sort(),
    );
  });

  it("starts with every dispatchable member unimplemented", () => {
    // The routing SOT is empty, so nothing calls these yet. Recording the
    // starting state means a handler landing later is visible as a diff in this
    // count rather than as an untracked change of behaviour.
    const byStatus = new Map<HostApiPathStatus, string[]>();
    for (const handler of Object.values(HOSTAPI_DISPATCH_TABLE)) {
      byStatus.set(handler.status, [
        ...(byStatus.get(handler.status) ?? []),
        handler.path,
      ]);
    }
    expect(byStatus.get("implemented")).toBeUndefined();
    expect(byStatus.get("child-local")).toHaveLength(4);
    expect(byStatus.get("unimplemented")).toHaveLength(
      Object.keys(HOSTAPI_PATH_CONTRACTS).length - 4,
    );
  });

  it("builds the same handler shape however an entry is declared", () => {
    const unimplemented = unimplementedHostApiPath("getSecret");
    const childLocal = childLocalHostApiPath("config.get");
    const implemented = defineHostApiPath("getSecret", async () => "k");
    for (const handler of [unimplemented, childLocal, implemented]) {
      expect(Object.keys(handler).sort()).toEqual([
        "contract",
        "invoke",
        "path",
        "status",
      ]);
    }
    expect(unimplemented.status).toBe("unimplemented");
    expect(childLocal.status).toBe("child-local");
    expect(implemented.status).toBe("implemented");
  });

  it("hands a handler the invocation identity it needs to audit the call", async () => {
    let seen: HostApiCall | undefined;
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      hasRoutineBySource: defineHostApiPath("hasRoutineBySource", async (call) => {
        seen = call;
        return true;
      }),
    };
    await dispatcher({ table }).handle(request());
    expect(seen).toEqual({
      path: "hasRoutineBySource",
      callId: "c1",
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      args: ["nightly"],
    });
  });

  it("marks a member child-local in the table exactly when its contract says so", () => {
    const contractSaysLocal = Object.entries(HOSTAPI_PATH_CONTRACTS)
      .filter(([, contract]) => contract.result === "child-local")
      .map(([path]) => path)
      .sort();
    const tableSaysLocal = Object.values(HOSTAPI_DISPATCH_TABLE)
      .filter((handler) => handler.status === "child-local")
      .map((handler) => handler.path)
      .sort();
    expect(tableSaysLocal).toEqual(contractSaysLocal);
    // Named literally: these four are the round-trip-free members, and the count
    // moving is a design change, not a refactor.
    expect(contractSaysLocal).toEqual([
      "config.get",
      "getAppPreference",
      "getInstalledPluginIds",
      "storage.resolve",
    ]);
  });

  it("declares effect-boundary denial exactly where the gate can actually fire", () => {
    // Derived from the enforcement SOT, not hand-listed: a future async write
    // chokepoint joins GATED_EFFECT_PATHS automatically, and this test then
    // fails until its contract admits the error the gate will throw at it.
    const canDeny = new Set<string>(GATED_EFFECT_PATHS);
    // hostFetch is excluded from the generic wrapper because it self-gates
    // INLINE from its own verb snapshot — excluded from the wrapper, not ungated.
    expect(ENFORCEMENT_EXCLUSIONS.has("hostFetch")).toBe(true);
    canDeny.add("hostFetch");

    const declared = Object.entries(HOSTAPI_PATH_CONTRACTS)
      .filter(([, contract]) =>
        (contract.errors as readonly string[]).includes("effect-boundary-denied"),
      )
      .map(([path]) => path)
      .sort();
    expect(declared).toEqual([...canDeny].sort());
  });

  it("never re-declares an error the boundary itself always produces", () => {
    for (const [path, contract] of Object.entries(HOSTAPI_PATH_CONTRACTS)) {
      for (const code of contract.errors) {
        expect(
          UNIVERSAL_WIRE_ERROR_CODES,
          `'${path}' lists '${code}', which every path can already reply with`,
        ).not.toContain(code);
      }
    }
  });

  it("recognises a wire path and refuses anything else", () => {
    expect(isHostApiPath("getSecret")).toBe(true);
    expect(isHostApiPath("callTool")).toBe(false);
    expect(isHostApiPath(42)).toBe(false);
    // Inherited members are not hostApi members. The path arrives from the
    // least-trusted process in the system, and an `in` check admits every one
    // of these — after which the table lookup returns something off
    // `Object.prototype` rather than a handler.
    for (const inherited of ["__proto__", "constructor", "toString", "valueOf"]) {
      expect(isHostApiPath(inherited), inherited).toBe(false);
    }
  });
});

describe("the routing set names the isolated plugins and nothing else", () => {
  it("carries exactly the reviewed ids, and no configuration can widen it", () => {
    // Named exactly. A test asserting only "non-empty" would stay green if a
    // plugin were routed out-of-process without its own e2e evidence — and the
    // whole point of a per-plugin SOT is that each addition is a reviewed,
    // visible decision.
    expect([...OUT_OF_PROCESS_PLUGIN_IDS]).toEqual([
      "work-assistant",
      "ms-graph",
      "local-indexer",
      "meeting",
    ]);
    expect(isOutOfProcessPlugin("work-assistant")).toBe(true);
    expect(isOutOfProcessPlugin("ms-graph")).toBe(true);
    expect(isOutOfProcessPlugin("local-indexer")).toBe(true);
    // `meeting` joined them: its last axis was a floating window it built
    // itself out of `BrowserWindow`/`ipcMain`/`screen`/`session`, reached
    // through a `require` whose specifier lived in a variable. It takes a slot
    // in the host's dock now and resolves `electron` by no path at all.
    expect(isOutOfProcessPlugin("meeting")).toBe(true);
    // The ONE first-party id the SOT still names in prose as REFUSED, and its
    // reason differs in KIND from anything the four above had to fix: it is
    // not missing a host API. It ships code written to run where the boundary
    // does not reach — function bodies compiled inside an authenticated page.
    // Asserted by id so the prose and the set cannot drift apart: the prose is
    // the only record of WHY, and a set that quietly gained it would leave
    // that record describing something untrue.
    expect(isOutOfProcessPlugin("ep-api")).toBe(false);
    expect(Object.isFrozen(OUT_OF_PROCESS_PLUGIN_IDS)).toBe(true);
  });

  it("reports the in-process loader as still needed while any plugin is in-process", () => {
    expect(allPluginsAreOutOfProcess(["ep-api"])).toBe(false);
    expect(allPluginsAreOutOfProcess(["work-assistant", "ep-api"])).toBe(false);
    expect(allPluginsAreOutOfProcess(["work-assistant"])).toBe(true);
    expect(allPluginsAreOutOfProcess(["work-assistant", "ms-graph", "local-indexer", "meeting"])).toBe(true);
    // An empty install list is not "all isolated" — it is no evidence either way.
    expect(allPluginsAreOutOfProcess([])).toBe(false);
  });
});

describe("the dispatcher refuses rather than defaults", () => {
  it("fails a member whose handler has not been written", async () => {
    const reply = await dispatcher().handle(request({ path: "getSecret" }));
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("path-not-implemented");
  });

  it("fails a member the child was supposed to answer locally", async () => {
    const reply = await dispatcher().handle(request({ path: "config.get" }));
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("path-not-dispatchable");
  });

  it("fails a member that does not exist", async () => {
    const reply = await dispatcher().handle(
      request({ path: "callTool" as HostApiPath }),
    );
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("path-unknown");
  });

  it("refuses a stale generation, a foreign plugin id, and a foreign wire", async () => {
    const codes = await Promise.all(
      [
        request({ generationId: "gen-0" }),
        request({ pluginId: "com.example.other" }),
        request({ wire: 99 as typeof HOST_API_WIRE_VERSION }),
      ].map(async (candidate) => {
        const reply = await dispatcher().handle(candidate);
        return reply.ok ? "ok" : reply.error.code;
      }),
    );
    expect(codes).toEqual([
      "generation-mismatch",
      "plugin-mismatch",
      "wire-version-mismatch",
    ]);
  });

  it("reproduces the in-process inactive-incarnation message byte for byte", async () => {
    const reply = await dispatcher({ isActive: () => false }).handle(request());
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("plugin-inactive");
    expect(reply.error.message).toBe(
      `[plugin:${PLUGIN_ID}] hostApi.hasRoutineBySource: plugin instance is no longer active`,
    );
    expect(reply.error.message).toBe(
      inactiveHostApiMessage(PLUGIN_ID, "hostApi.hasRoutineBySource"),
    );
  });

  it("refuses an argument that would not survive the wire", async () => {
    const reply = await dispatcher().handle(
      request({ args: [new Date("2020-01-01")] }),
    );
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("argument-marshalling-rejected");
    expect(reply.error.message).toContain("Date");
  });

  it("refuses a RESULT that would not survive the wire", async () => {
    // The check §3.6 shows the in-process loopback does not perform: it passes
    // `response.result` across by reference, so a Map is received as a Map today.
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      hasRoutineBySource: defineHostApiPath(
        "hasRoutineBySource",
        async () => new Map([["a", 1]]),
      ),
    };
    const reply = await dispatcher({ table }).handle(request());
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("result-marshalling-rejected");
    expect(reply.error.message).toContain("Map");
  });

  it("refuses a void-declared member that returned a value", async () => {
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      logEvent: defineHostApiPath("logEvent", async () =>
        // The contract says nothing comes back; returning something means the
        // child's stub and the host's handler disagree about the member.
        "surprise" as unknown as void,
      ),
    };
    const reply = await dispatcher({ table }).handle(
      request({ path: "logEvent", args: ["info", "hi"] }),
    );
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe("result-marshalling-rejected");
  });

  it("carries a value back when the handler is wired", async () => {
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      hasRoutineBySource: defineHostApiPath(
        "hasRoutineBySource",
        async (call) => call.args[0] === "nightly",
      ),
    };
    const reply = await dispatcher({ table }).handle(request());
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value).toBe(true);
  });
});

describe("error identity survives the wire by code, never by message", () => {
  it("classifies each host error class the boundary carries", () => {
    const cases: Array<[unknown, string]> = [
      [
        new EffectBoundaryDeniedError(PLUGIN_ID, "storage.write", "notes", "denied"),
        "effect-boundary-denied",
      ],
      [
        new ManifestIntegrityError(PLUGIN_ID, "tool_x", "writeFileSync"),
        "manifest-integrity-violation",
      ],
      [
        new PluginRuntimeDetachedOperationError(
          new Error("ceiling fired"),
          Promise.resolve(),
        ),
        "detached-operation",
      ],
      [
        new PluginStorageEncryptionUnavailableError(PLUGIN_ID),
        "plugin-storage-encryption-unavailable",
      ],
      [new PluginStorageError("escapes the root", PLUGIN_ID, "../x"), "plugin-storage"],
      [new HostApiBoundaryError("subscription-unknown", "gone"), "subscription-unknown"],
      [new RangeError("something else entirely"), "host-internal"],
    ];
    for (const [error, code] of cases) {
      expect(classifyHostApiError(error).code, String(error)).toBe(code);
    }
  });

  it("preserves the class name the SDK contract tells plugins to match on", () => {
    const wire = classifyHostApiError(
      new PluginStorageError("escapes the root", PLUGIN_ID, "../x"),
    );
    const rebuilt = reconstructWireError(wire);
    expect(rebuilt.name).toBe("PluginStorageError");
    expect(rebuilt.code).toBe("plugin-storage");
    expect(rebuilt.message).toBe(
      new PluginStorageError("escapes the root", PLUGIN_ID, "../x").message,
    );
    expect(rebuilt.detail).toEqual({ pluginId: PLUGIN_ID, attemptedPath: "../x" });
  });

  it("carries the effect-gate's own fields so a plugin can act on the denial", () => {
    const wire = classifyHostApiError(
      new EffectBoundaryDeniedError(PLUGIN_ID, "storage.write", "notes", "headless"),
    );
    expect(wire.detail).toEqual({
      pluginId: PLUGIN_ID,
      methodPath: "storage.write",
      target: "notes",
      reason: "headless",
    });
    expect(reconstructWireError(wire)).toBeInstanceOf(Error);
  });

  it("keeps a detached operation's settlement promise host-side", () => {
    const wire = classifyHostApiError(
      new PluginRuntimeDetachedOperationError(new Error("boom"), Promise.resolve(1)),
    );
    expect(wire.detail).toBeUndefined();
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });
});

describe("the shared byte codec, which three members would otherwise each write", () => {
  it("keeps text and bytes distinguishable, which is the point of the tag", () => {
    // A plugin writing the literal string "aGk=" and a plugin writing the bytes
    // "hi" produce the same characters. Without the tag the file lands decoded
    // in one of those two cases and nothing reports it.
    const asText = encodeWireBytes("aGk=", "storage.write(data)");
    const asBytes = encodeWireBytes(new Uint8Array([104, 105]), "storage.write(data)");
    expect(asText).toEqual({ encoding: "utf8", data: "aGk=" });
    expect(asBytes).toEqual({ encoding: "base64", data: "aGk=" });
    expect(decodeWireBytes(asText, "x")).toBe("aGk=");
    expect(decodeWireBytes(asBytes, "x")).toEqual(new Uint8Array([104, 105]));
  });

  it("round-trips bytes that are not valid text", () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 13]);
    const decoded = decodeWireBinary(encodeWireBytes(bytes, "storage.read()"), "x");
    expect(decoded).toEqual(bytes);
  });

  it("survives the JSON hop it exists to survive", () => {
    const wire = encodeWireBytes(new Uint8Array([1, 2, 3]), "storage.read()");
    const rehydrated = JSON.parse(JSON.stringify(wire)) as unknown;
    expect(decodeWireBinary(rehydrated, "x")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("throws over the cap rather than truncating, in both directions", () => {
    const oversized = new Uint8Array(WIRE_BYTES_MAX + 1);
    expect(() => encodeWireBytes(oversized, "storage.write(data)")).toThrow(
      HostApiBoundaryError,
    );
    try {
      encodeWireBytes(oversized, "storage.write(data)");
    } catch (error) {
      expect((error as HostApiBoundaryError).code).toBe("payload-too-large");
    }
    // A truncating codec would return a shorter file and report success — the
    // caller cannot tell that from a file that really is that short.
    expect(() =>
      decodeWireBytes(
        { encoding: "base64", data: "A".repeat(WIRE_BYTES_MAX * 2) },
        "storage.read()",
      ),
    ).toThrow(/exceeds/u);
  });

  it("refuses a payload that is not tagged at all", () => {
    for (const bad of [null, "raw", { data: "aGk=" }, { encoding: "hex", data: "6869" }]) {
      expect(() => decodeWireBytes(bad, "storage.write(data)"), String(bad)).toThrow(
        /not a tagged byte payload/u,
      );
    }
  });

  it("refuses text where a member declared it delivers bytes", () => {
    expect(() => decodeWireBinary({ encoding: "utf8", data: "hi" }, "storage.read()"))
      .toThrow(/expected bytes/u);
  });
});
