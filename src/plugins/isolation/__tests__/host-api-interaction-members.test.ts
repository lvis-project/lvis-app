/**
 * The members that put something in front of the user, or decide whether an
 * action is permitted, driven END TO END: a real child runtime over paired
 * streams, a real dispatcher, a real envelope, and a fake `hostApi` standing in
 * for the host implementations.
 *
 * The distinction this file exists to hold is the one a data read does not have:
 *
 *   ANSWERED vs NOT DELIVERED. `agentApproval.request` resolving `"deny-once"`
 *   is a user who said no. A throw from the same call is a question the user
 *   never saw. If those two ever became the same value the plugin observes, a
 *   broken approval chain would look exactly like a cautious user — and the
 *   plugin would do the safe-looking wrong thing forever without a symptom.
 *   {@link outcomeOf} classifies every call into one of the two, and the tests
 *   assert the classification rather than the value, so a change that starts
 *   answering `"deny-once"` on a delivery failure fails here.
 */
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EffectBoundaryDeniedError } from "../../../permissions/effect-enforcement.js";
import type { PluginManifest } from "../../types.js";
import type {
  ApprovalChoice,
  AuthWindowCookie,
  ConversationTriggerResult,
  ConversationTriggerSpec,
  OpenAuthWindowFinalUrlResult,
  PluginHostApi,
} from "../../public-contract.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
  createInteractionHostApiPaths,
  type InteractionHostApi,
} from "../host-api-dispatcher.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  INTERACTION_HOSTAPI_PATHS,
  PluginHostApiError,
  isHostApiPath,
  type HostApiChannel,
  type HostApiWireErrorCode,
  type InteractionHostApiPath,
} from "../host-api-wire.js";
import { createInteractionChildMembers } from "../host-api-child.js";
import {
  startPluginChildRuntime,
  type PluginChildRuntime,
  type PluginFactoryLoader,
} from "../plugin-child-runtime.js";

const PLUGIN_ID = "com.example.interaction";
const GENERATION = "gen-3";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Interaction",
  version: "1.0.0",
  entry: "dist/plugin.js",
  description: "an isolated plugin exercising the user-facing hostApi members",
  tools: [],
};

const COOKIES: AuthWindowCookie[] = [
  { name: "SID", value: "abc", domain: "portal.example.com", secure: true },
];

/** What the fake host was asked to do, in the order it was asked. */
interface HostImplementations {
  openExternalUrl: (url: string) => Promise<void>;
  openAuthWindow: (options: unknown) => Promise<unknown>;
  openAuthPartitionViewer: (opts: {
    url: string;
    windowTitle?: string;
  }) => Promise<void>;
  clearAuthPartition: (partition: string) => Promise<void>;
  authRedirectOpen: () => Promise<{ handle: string; redirectUri: string }>;
  authRedirectWait: (opts: {
    handle: string;
    timeoutMs?: number;
  }) => Promise<Readonly<Record<string, string>>>;
  authRedirectClose: (opts: { handle: string }) => Promise<void>;
  pickFolders: () => Promise<{ canceled: boolean; folders: string[] }>;
  triggerConversation: (
    spec: ConversationTriggerSpec,
  ) => Promise<ConversationTriggerResult>;
  approvalRequest: (input: {
    toolName: string;
    args: unknown;
    reason: string;
    scope: string;
  }) => Promise<ApprovalChoice>;
  approvalRespond: (
    requestId: string,
    choice: ApprovalChoice,
    nonce?: string,
    hmac?: string,
  ) => Promise<void>;
}

function defaultImplementations(): HostImplementations {
  return {
    openExternalUrl: async () => {},
    openAuthWindow: async () => COOKIES,
    openAuthPartitionViewer: async () => {},
    clearAuthPartition: async () => {},
    authRedirectOpen: async () => ({
      handle: REDIRECT_HANDLE,
      redirectUri: "http://localhost:49152",
    }),
    authRedirectWait: async () => Object.freeze({ code: "auth-code", state: "xyz" }),
    authRedirectClose: async () => {},
    pickFolders: async () => ({ canceled: false, folders: ["/Users/probe/Documents"] }),
    triggerConversation: async (spec) => ({
      accepted: true,
      source: spec.source,
      eventId: "evt-1",
    }),
    approvalRequest: async () => "allow-once",
    approvalRespond: async () => {},
  };
}

interface Harness {
  readonly child: PluginChildRuntime;
  readonly host: HostApiDispatcher;
  /** The plugin's view of the hostApi — the stub, not the host object. */
  readonly hostApi: PluginHostApi;
  readonly impl: HostImplementations;
}

/**
 * A real child talking to a real dispatcher. The channel is in-memory because
 * multiplexing the reverse direction onto the stdio pipes is a transport
 * decision that has not been made; everything above it is production code.
 */
async function harness(
  overrides: Partial<HostImplementations> = {},
  options: { isActive?: () => boolean; bindPaths?: boolean } = {},
): Promise<Harness> {
  const impl = { ...defaultImplementations(), ...overrides };
  const hostSide: InteractionHostApi = {
    openExternalUrl: (url) => impl.openExternalUrl(url),
    openAuthWindow: ((options_: unknown) =>
      impl.openAuthWindow(options_)) as unknown as PluginHostApi["openAuthWindow"],
    openAuthPartitionViewer: (opts) => impl.openAuthPartitionViewer(opts),
    clearAuthPartition: (partition) => impl.clearAuthPartition(partition),
    authRedirect: {
      open: () => impl.authRedirectOpen(),
      wait: (opts) => impl.authRedirectWait(opts),
      close: (opts) => impl.authRedirectClose(opts),
    },
    pickFolders: () => impl.pickFolders(),
    triggerConversation: (spec) => impl.triggerConversation(spec),
    agentApproval: {
      request: (input) => impl.approvalRequest(input),
      respond: (requestId, choice, nonce, hmac) =>
        impl.approvalRespond(requestId, choice, nonce, hmac),
    },
  };

  let host!: HostApiDispatcher;
  let child!: PluginChildRuntime;
  const channel: HostApiChannel = {
    call: (request) => host.handle(request),
    notify: (notification) => host.handleNotification(notification),
  };

  host = new HostApiDispatcher({
    pluginId: PLUGIN_ID,
    generationId: GENERATION,
    isActive: options.isActive ?? (() => true),
    notifications: { deliver: (notification) => child.deliver(notification) },
    table:
      options.bindPaths === false
        ? HOSTAPI_DISPATCH_TABLE
        : { ...HOSTAPI_DISPATCH_TABLE, ...createInteractionHostApiPaths(hostSide) },
  });

  const loadFactory: PluginFactoryLoader = async () => () => ({ handlers: {} });
  child = await startPluginChildRuntime({
    input: new PassThrough(),
    output: new PassThrough(),
    manifest: MANIFEST,
    context: {
      pluginId: PLUGIN_ID,
      pluginRoot: "/plugins/interaction",
      hostRoot: "/app",
      pluginDataDir: "/plugins/interaction/data",
      installedPluginIds: [],
      generationId: GENERATION,
    },
    channel,
    loadFactory,
  });

  return { child, host, hostApi: child.hostApi, impl };
}

/**
 * The only two things a plugin can observe, named so a test asserts WHICH of
 * them happened rather than what the value was.
 */
type Outcome =
  | { readonly kind: "answered"; readonly value: unknown }
  | { readonly kind: "failed"; readonly code: HostApiWireErrorCode };

async function outcomeOf(work: Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: "answered", value: await work };
  } catch (error) {
    expect(error, "a failed hostApi call must carry a wire code").toBeInstanceOf(
      PluginHostApiError,
    );
    return { kind: "failed", code: (error as PluginHostApiError).code };
  }
}

/** Invoke one member through the child stub with the given positional args. */
function invoke(
  hostApi: PluginHostApi,
  path: InteractionHostApiPath,
  args: readonly unknown[],
): Promise<unknown> {
  const surface = hostApi as unknown as Record<string, unknown>;
  const [head, leaf] = path.split(".");
  const member = (
    leaf === undefined
      ? surface[head]
      : (surface[head] as Record<string, unknown>)[leaf]
  ) as (...callArgs: unknown[]) => Promise<unknown>;
  return member(...args);
}

/** Representative arguments for each member, used by the table-driven checks. */
const REDIRECT_HANDLE = "8f1c2e5a-0000-4000-8000-aaaaaaaaaaaa";

const SAMPLE_ARGS: Record<InteractionHostApiPath, readonly unknown[]> = {
  openExternalUrl: ["https://docs.example.com/help"],
  openAuthWindow: [
    {
      url: "https://idp.example.com/saml",
      completionUrlPatterns: ["https://portal.example.com/"],
      cookieHosts: ["portal.example.com"],
      timeoutMs: 30_000,
    },
  ],
  openAuthPartitionViewer: [
    { url: "https://portal.example.com/inbox", windowTitle: "Portal" },
  ],
  clearAuthPartition: [`persist:plugin-auth:${PLUGIN_ID}`],
  "authRedirect.open": [],
  "authRedirect.wait": [{ handle: REDIRECT_HANDLE }],
  "authRedirect.close": [{ handle: REDIRECT_HANDLE }],
  // Takes nothing: the user's answer is the whole payload, in one direction.
  pickFolders: [],
  triggerConversation: [
    {
      prompt: "Meeting starts in 5 minutes",
      source: "overlay:meeting-detection",
      dedupeKey: "meeting-42",
    },
  ],
  "agentApproval.request": [
    { toolName: "portal_write", args: { id: 7 }, reason: "sync", scope: "portal" },
  ],
  "agentApproval.respond": ["req-1", "allow-once", "nonce-1", "hmac-1"],
};

describe("the group carries exactly the members whose refusal is an answer", () => {
  it("names eleven paths, every one a declared hostApi member", () => {
    expect([...INTERACTION_HOSTAPI_PATHS]).toEqual([
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
    ]);
    for (const path of INTERACTION_HOSTAPI_PATHS) {
      expect(isHostApiPath(path), path).toBe(true);
    }
  });

  it("relays them because their CONTRACT says plain JSON, not because it assumed so", () => {
    // The relay in the child does no encoding. That is only correct while every
    // one of these declares `plain-json` in and `plain-json`/`void` out, so the
    // claim is asserted against the SOT rather than restated.
    for (const path of INTERACTION_HOSTAPI_PATHS) {
      const contract = HOSTAPI_PATH_CONTRACTS[path];
      expect(contract.arguments, path).toBe("plain-json");
      expect(["plain-json", "void"], path).toContain(contract.result);
      expect(contract.lifetime, path).toBe("none");
    }
  });

  it("refuses to build a relay for a member whose contract stopped being plain JSON", () => {
    // Tamper-equivalent, held permanently: swap in a contract that declares an
    // encoded argument and the stub builder must refuse rather than quietly
    // send the argument unencoded.
    const original = HOSTAPI_PATH_CONTRACTS.clearAuthPartition;
    const contracts = HOSTAPI_PATH_CONTRACTS as unknown as Record<
      string,
      { arguments: string; result: string; lifetime: string; errors: string[] }
    >;
    contracts.clearAuthPartition = {
      arguments: "encoded",
      result: "void",
      lifetime: "none",
      errors: [],
    };
    try {
      expect(() =>
        createInteractionChildMembers(async () => undefined),
      ).toThrow(/'clearAuthPartition' no longer crosses as plain JSON/u);
    } finally {
      contracts.clearAuthPartition = original as unknown as (typeof contracts)[string];
    }
  });

  it("binds one handler per member, keyed to that member's own contract", () => {
    const handlers = createInteractionHostApiPaths({
      openExternalUrl: async () => {},
      openAuthWindow: (async () => COOKIES) as unknown as PluginHostApi["openAuthWindow"],
      openAuthPartitionViewer: async () => {},
      clearAuthPartition: async () => {},
      authRedirect: {
        open: async () => ({ handle: REDIRECT_HANDLE, redirectUri: "http://localhost:49152" }),
        wait: async () => Object.freeze({ code: "auth-code" }),
        close: async () => {},
      },
      pickFolders: async () => ({ canceled: true, folders: [] }),
      triggerConversation: async () => ({ accepted: true, source: "overlay:x" }),
      agentApproval: {
        request: async () => "allow-once",
        respond: async () => {},
      },
    });
    expect(Object.keys(handlers).sort()).toEqual([...INTERACTION_HOSTAPI_PATHS].sort());
    for (const path of INTERACTION_HOSTAPI_PATHS) {
      expect(handlers[path].path).toBe(path);
      expect(handlers[path].status).toBe("implemented");
      expect(handlers[path].contract).toBe(HOSTAPI_PATH_CONTRACTS[path]);
    }
  });

  it("leaves the shipped table unbound, so nothing is implemented by accident", async () => {
    // The routing SOT is empty and the default table has no plugin instance to
    // bind to. Every one of the seven reached without the binding must refuse,
    // not answer — a handler published into the shipped table would be one that
    // opens a window or asks for an approval on behalf of nobody in particular.
    const { hostApi } = await harness({}, { bindPaths: false });
    for (const path of INTERACTION_HOSTAPI_PATHS) {
      expect(
        await outcomeOf(invoke(hostApi, path, SAMPLE_ARGS[path])),
        path,
      ).toEqual({ kind: "failed", code: "path-not-implemented" });
    }
  });
});

describe("arguments reach the host exactly as the plugin passed them", () => {
  for (const path of INTERACTION_HOSTAPI_PATHS) {
    it(`carries '${path}' arguments verbatim`, async () => {
      const seen: unknown[][] = [];
      const record = async (...args: unknown[]) => {
        seen.push(args);
        return path === "agentApproval.request"
          ? ("allow-once" as ApprovalChoice)
          : path === "triggerConversation"
            ? { accepted: true, source: "overlay:meeting-detection" }
            : path === "openAuthWindow"
              ? COOKIES
              : undefined;
      };
      const { hostApi } = await harness({
        openExternalUrl: record as HostImplementations["openExternalUrl"],
        openAuthWindow: record as HostImplementations["openAuthWindow"],
        openAuthPartitionViewer:
          record as unknown as HostImplementations["openAuthPartitionViewer"],
        clearAuthPartition: record as HostImplementations["clearAuthPartition"],
        authRedirectOpen: record as unknown as HostImplementations["authRedirectOpen"],
        authRedirectWait: record as unknown as HostImplementations["authRedirectWait"],
        authRedirectClose: record as unknown as HostImplementations["authRedirectClose"],
        pickFolders: record as unknown as HostImplementations["pickFolders"],
        triggerConversation:
          record as unknown as HostImplementations["triggerConversation"],
        approvalRequest: record as unknown as HostImplementations["approvalRequest"],
        approvalRespond: record as unknown as HostImplementations["approvalRespond"],
      });
      await invoke(hostApi, path, SAMPLE_ARGS[path]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual([...SAMPLE_ARGS[path]]);
    });
  }

  it("does not re-validate a URL the host is the one to judge", async () => {
    // `openExternalUrl` is validated host-side (`validateExternalUrl` + the
    // webView routing). A boundary pre-check would be a second, weaker copy, so
    // the proof is that a URL the host WOULD reject still arrives at the host —
    // and that the host's rejection is what the plugin sees.
    const openExternalUrl = vi.fn(async (url: string) => {
      if (!url.startsWith("https:")) throw new Error(`refused scheme: ${url}`);
    });
    const { hostApi } = await harness({ openExternalUrl });
    const outcome = await outcomeOf(
      invoke(hostApi, "openExternalUrl", ["javascript:alert(1)"]),
    );
    expect(openExternalUrl).toHaveBeenCalledWith("javascript:alert(1)");
    expect(outcome.kind).toBe("failed");
  });

  it("passes an omitted optional argument as omitted, not as a value", async () => {
    // `agentApproval.respond` takes nonce/hmac only when the gate issued them.
    // Substituting anything for an absent one would hand the gate a
    // confused-deputy field the plugin never received.
    const approvalRespond = vi.fn(async () => {});
    const { hostApi } = await harness({ approvalRespond });
    await invoke(hostApi, "agentApproval.respond", ["req-9", "deny-once"]);
    expect(approvalRespond).toHaveBeenCalledWith(
      "req-9",
      "deny-once",
      undefined,
      undefined,
    );
  });
});

describe("results come back in the shape each contract declares", () => {
  it("returns the cookie jar for the cookie form of openAuthWindow", async () => {
    const { hostApi } = await harness();
    await expect(
      invoke(hostApi, "openAuthWindow", SAMPLE_ARGS.openAuthWindow),
    ).resolves.toEqual(COOKIES);
  });

  it("returns the final-url shape when the plugin asked for it", async () => {
    // Two overloads over one implementation. The boundary must carry whichever
    // the HOST produced; deciding the branch on the wire would be a second copy
    // of a rule that lives in the host.
    const answer: OpenAuthWindowFinalUrlResult = {
      cookies: COOKIES,
      finalUrl: "https://portal.example.com/landing",
    };
    const { hostApi } = await harness({ openAuthWindow: async () => answer });
    await expect(
      invoke(hostApi, "openAuthWindow", [
        { ...(SAMPLE_ARGS.openAuthWindow[0] as object), returnFinalUrl: true },
      ]),
    ).resolves.toEqual(answer);
  });

  it("returns the trigger verdict object whole", async () => {
    const verdict: ConversationTriggerResult = {
      accepted: true,
      source: "overlay:meeting-detection",
      eventId: "evt-9",
    };
    const { hostApi } = await harness({ triggerConversation: async () => verdict });
    await expect(
      invoke(hostApi, "triggerConversation", SAMPLE_ARGS.triggerConversation),
    ).resolves.toEqual(verdict);
  });

  it("resolves undefined for every member declared void", async () => {
    const { hostApi } = await harness();
    for (const path of INTERACTION_HOSTAPI_PATHS) {
      if (HOSTAPI_PATH_CONTRACTS[path].result !== "void") continue;
      await expect(invoke(hostApi, path, SAMPLE_ARGS[path]), path).resolves.toBeUndefined();
    }
  });

  it("refuses a void-declared member whose host implementation answered something", async () => {
    // The contract says nothing comes back. A host that starts returning a value
    // means the child's stub and the host's handler disagree about the member,
    // and the disagreement has to be loud rather than dropped on the floor.
    const { hostApi } = await harness({
      clearAuthPartition: (async () => "wiped") as unknown as HostImplementations["clearAuthPartition"],
    });
    const outcome = await outcomeOf(
      invoke(hostApi, "clearAuthPartition", SAMPLE_ARGS.clearAuthPartition),
    );
    expect(outcome).toEqual({ kind: "failed", code: "result-marshalling-rejected" });
  });
});

describe("every error identity each contract lists survives the wire", () => {
  const gated = INTERACTION_HOSTAPI_PATHS.filter((path) =>
    (HOSTAPI_PATH_CONTRACTS[path].errors as readonly string[]).includes(
      "effect-boundary-denied",
    ),
  );

  it("declares the gate on eight of the ten, and exempts the two reads", () => {
    expect([...gated]).toEqual([
      "openExternalUrl",
      "openAuthWindow",
      "openAuthPartitionViewer",
      "clearAuthPartition",
      "authRedirect.open",
      "authRedirect.close",
      "triggerConversation",
      "agentApproval.request",
    ]);
    // `agentApproval.respond` resolves host-owned approval machinery; gating it
    // with that same machinery would be circular, so its contract lists nothing.
    expect(HOSTAPI_PATH_CONTRACTS["agentApproval.respond"].errors).toEqual([]);
    // `authRedirect.wait` mutates nothing — it reports what already arrived at
    // a listener the OPEN already answered for. A mutating-effect gate cannot
    // fire on it, so a denial is not among its error identities.
    expect(HOSTAPI_PATH_CONTRACTS["authRedirect.wait"].errors).toEqual([]);
  });

  for (const path of gated) {
    it(`carries an effect-boundary denial from '${path}' as its own code`, async () => {
      const denied = async () => {
        throw new EffectBoundaryDeniedError(PLUGIN_ID, path, "target", "denied");
      };
      const { hostApi } = await harness({
        openExternalUrl: denied,
        openAuthWindow: denied,
        openAuthPartitionViewer: denied,
        clearAuthPartition: denied,
        authRedirectOpen: denied as unknown as HostImplementations["authRedirectOpen"],
        authRedirectClose: denied as unknown as HostImplementations["authRedirectClose"],
        triggerConversation: denied as unknown as HostImplementations["triggerConversation"],
        approvalRequest: denied as unknown as HostImplementations["approvalRequest"],
      });
      const outcome = await outcomeOf(invoke(hostApi, path, SAMPLE_ARGS[path]));
      expect(outcome).toEqual({ kind: "failed", code: "effect-boundary-denied" });
    });
  }

  it("keeps a host internal opaque rather than inventing a code for it", async () => {
    // `agentApproval.respond`'s contract lists no member error, so an issuer or
    // scope violation is a host internal on the wire — deliberately opaque,
    // because a host internal is not a contract.
    const { hostApi } = await harness({
      approvalRespond: async () => {
        throw new Error("approval origin mismatch");
      },
    });
    const outcome = await outcomeOf(
      invoke(hostApi, "agentApproval.respond", SAMPLE_ARGS["agentApproval.respond"]),
    );
    expect(outcome).toEqual({ kind: "failed", code: "host-internal" });
  });

  it("refuses a retired incarnation before the host implementation is reached", async () => {
    const approvalRequest = vi.fn(async () => "allow-once" as ApprovalChoice);
    const { hostApi } = await harness({ approvalRequest }, { isActive: () => false });
    const outcome = await outcomeOf(
      invoke(hostApi, "agentApproval.request", SAMPLE_ARGS["agentApproval.request"]),
    );
    expect(outcome).toEqual({ kind: "failed", code: "plugin-inactive" });
    expect(approvalRequest).not.toHaveBeenCalled();
  });
});

describe("a refusal and a lost question are never the same observation", () => {
  const DENIALS: ApprovalChoice[] = ["deny-once", "deny-always"];
  const ALLOWS: ApprovalChoice[] = ["allow-once", "allow-session", "allow-always"];

  for (const choice of [...DENIALS, ...ALLOWS]) {
    it(`delivers '${choice}' to the plugin as a value`, async () => {
      const { hostApi } = await harness({ approvalRequest: async () => choice });
      const outcome = await outcomeOf(
        invoke(hostApi, "agentApproval.request", SAMPLE_ARGS["agentApproval.request"]),
      );
      expect(outcome).toEqual({ kind: "answered", value: choice });
    });
  }

  it("never turns a failure to deliver the question into a denial", async () => {
    // The defect this whole group is shaped around: a plugin that cannot tell
    // "the user said no" from "the user was never asked" will treat a broken
    // approval chain as a permanent, silent no.
    const failures: Array<[string, () => Promise<never>]> = [
      [
        "the effect gate refused the call",
        async () => {
          throw new EffectBoundaryDeniedError(
            PLUGIN_ID,
            "agentApproval.request",
            "portal",
            "denied",
          );
        },
      ],
      [
        "the gate itself threw",
        async () => {
          throw new Error("approval gate unavailable");
        },
      ],
    ];
    for (const [label, thrower] of failures) {
      const { hostApi } = await harness({
        approvalRequest: thrower as unknown as HostImplementations["approvalRequest"],
      });
      const outcome = await outcomeOf(
        invoke(hostApi, "agentApproval.request", SAMPLE_ARGS["agentApproval.request"]),
      );
      expect(outcome.kind, label).toBe("failed");
      // Not merely "failed": the plugin must never have been handed a choice.
      expect(outcome, label).not.toHaveProperty("value");
    }
  });

  it("keeps the two outcome kinds disjoint across every approval answer", async () => {
    const kinds = new Set<string>();
    for (const choice of [...DENIALS, ...ALLOWS]) {
      const { hostApi } = await harness({ approvalRequest: async () => choice });
      kinds.add(
        (
          await outcomeOf(
            invoke(hostApi, "agentApproval.request", SAMPLE_ARGS["agentApproval.request"]),
          )
        ).kind,
      );
    }
    const { hostApi } = await harness({
      approvalRequest: async () => {
        throw new Error("gate down");
      },
    });
    kinds.add(
      (
        await outcomeOf(
          invoke(hostApi, "agentApproval.request", SAMPLE_ARGS["agentApproval.request"]),
        )
      ).kind,
    );
    expect([...kinds].sort()).toEqual(["answered", "failed"]);
  });

  it("delivers an overlay refusal as a result and a broken overlay as an error", async () => {
    const refused: ConversationTriggerResult = {
      accepted: false,
      reason: "capability_denied",
      source: "overlay:meeting-detection",
    };
    const answered = await harness({ triggerConversation: async () => refused });
    expect(
      await outcomeOf(
        invoke(answered.hostApi, "triggerConversation", SAMPLE_ARGS.triggerConversation),
      ),
    ).toEqual({ kind: "answered", value: refused });

    const broken = await harness({
      triggerConversation: async () => {
        throw new Error("overlay window is gone");
      },
    });
    const outcome = await outcomeOf(
      invoke(broken.hostApi, "triggerConversation", SAMPLE_ARGS.triggerConversation),
    );
    expect(outcome).toEqual({ kind: "failed", code: "host-internal" });
  });
});

describe("an approval that blocks on a human", () => {
  it("waits as long as the person does, and still delivers their answer", async () => {
    // §7.5: the boundary imposes NO call timeout of its own. A deadline here
    // would abandon a gate entry that is still pending in the host — the plugin
    // would give up while the modal is still on screen, and the answer the user
    // eventually gave would have nowhere to arrive.
    //
    // Fake timers are what make that testable rather than asserted: a deadline
    // of ANY length fires while the clock is advanced, so a boundary that grew
    // one turns this red instead of passing because the test happened to
    // release the human faster than the timeout.
    vi.useFakeTimers();
    try {
      let release!: (choice: ApprovalChoice) => void;
      const pending = new Promise<ApprovalChoice>((resolve) => {
        release = resolve;
      });
      const { hostApi, host } = await harness({ approvalRequest: () => pending });

      const inFlight = invoke(
        hostApi,
        "agentApproval.request",
        SAMPLE_ARGS["agentApproval.request"],
      );
      let settled = false;
      const observed = inFlight.then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );
      // Well past the gate's own five-minute user wait, which is the only
      // deadline this call is allowed to have.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled, "the call must still be waiting on the human").toBe(false);

      release("deny-once");
      expect(await outcomeOf(observed)).toEqual({
        kind: "answered",
        value: "deny-once",
      });
      // A blocking call must not have opened a lifetime on either side; the
      // reply settles it, and a leaked registration would outlive the modal.
      expect(host.openSubscriptionCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
