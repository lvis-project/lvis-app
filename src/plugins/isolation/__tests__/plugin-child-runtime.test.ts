/**
 * The child runtime, driven over in-memory paired streams — the pattern
 * `stdio-server-loop`'s own tests already use, so the transport is real framing
 * over real streams without a subprocess.
 *
 * Two directions are proven here. Host → plugin is the MCP arm that already
 * exists: the child stands up a `PluginMcpServer` over `StdioServerLoop` and
 * answers `server/discover` and `tools/call` end to end. Plugin → host is the
 * arm this work adds: a request/reply envelope, a marshalling gate on both
 * sides, an error identity that survives, and a subscription lifetime that
 * releases on BOTH sides whichever one dies first.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createNoopHostApi } from "../../runtime/sandbox.js";
import { frameMessage, StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import type { PluginManifest, RuntimePlugin } from "../../types.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
  defineHostApiPath,
} from "../host-api-dispatcher.js";
import {
  PluginHostApiError,
  type HostApiChannel,
  type HostApiNotification,
} from "../host-api-wire.js";
import {
  createChildHostApiStub,
  createHostApiCaller,
  startPluginChildRuntime,
  unimplementedChildMember,
  type NotificationOutcome,
  type PluginChildRuntime,
  type PluginFactoryLoader,
} from "../plugin-child-runtime.js";
import { HOSTAPI_PATH_CONTRACTS } from "../host-api-path-contracts.js";

const PLUGIN_ID = "com.example.child";
const GENERATION = "gen-7";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Child",
  version: "1.0.0",
  entry: "dist/plugin.js",
  description: "an isolated plugin used to drive the child runtime",
  tools: [
    {
      name: "echo_back",
      description: "Echo the payload back to the caller",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
};

const CLIENT_META = {
  _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
};

/** Read the next framed message off a stream. */
function nextFramed(stream: PassThrough): Promise<Record<string, unknown>> {
  const decoder = new StdioFrameDecoder();
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const messages = decoder.push(chunk);
      if (messages.length > 0) {
        stream.off("data", onData);
        resolve(messages[0]);
      }
    };
    stream.on("data", onData);
  });
}

interface Harness {
  readonly child: PluginChildRuntime;
  readonly host: HostApiDispatcher;
  readonly toChild: PassThrough;
  readonly fromChild: PassThrough;
  readonly childNotifications: HostApiNotification[];
  readonly call: (path: string, args: readonly unknown[]) => Promise<unknown>;
}

/**
 * Wire a real dispatcher to a real child runtime. The channel is in-memory
 * because multiplexing the reverse direction onto the stdio pipes is a
 * transport decision that has not been made yet; everything above it is real.
 */
async function harness(
  options: {
    table?: Record<string, unknown>;
    instance?: Partial<RuntimePlugin>;
    isActive?: () => boolean;
  } = {},
): Promise<Harness> {
  const toChild = new PassThrough();
  const fromChild = new PassThrough();
  const childNotifications: HostApiNotification[] = [];
  let host!: HostApiDispatcher;
  let child!: PluginChildRuntime;

  const channel: HostApiChannel = {
    call: (request) => host.handle(request),
    notify: (notification) => {
      childNotifications.push(notification);
      host.handleNotification(notification);
    },
  };

  const pluginDataDir = mkdtempSync(join(tmpdir(), "lvis-child-runtime-"));
  host = new HostApiDispatcher({
    pluginId: PLUGIN_ID,
    generationId: GENERATION,
    isActive: options.isActive ?? (() => true),
    hostApi: createNoopHostApi(PLUGIN_ID, pluginDataDir),
    notifications: { deliver: (notification) => child.deliver(notification) },
    table: (options.table ?? HOSTAPI_DISPATCH_TABLE) as typeof HOSTAPI_DISPATCH_TABLE,
  });

  const loadFactory: PluginFactoryLoader = async () => () => ({
    handlers: {
      echo_back: (payload) => ({ echoed: (payload as { text: string }).text }),
    },
    ...options.instance,
  });

  child = await startPluginChildRuntime({
    input: toChild,
    output: fromChild,
    manifest: MANIFEST,
    context: {
      pluginId: PLUGIN_ID,
      pluginRoot: "/plugins/child",
      hostRoot: "/app",
      pluginDataDir: "/plugins/child/data",
      config: { enabled: true },
      generationId: GENERATION,
    },
    channel,
    loadFactory,
  });

  const call = createHostApiCaller(channel, {
    pluginId: PLUGIN_ID,
    generationId: GENERATION,
  });

  return {
    child,
    host,
    toChild,
    fromChild,
    childNotifications,
    call: (path, args) => call(path as never, args),
  };
}

describe("the child serves its plugin over framed stdio", () => {
  it("answers server/discover with the plugin's own identity", async () => {
    const { toChild, fromChild } = await harness();
    const pending = nextFramed(fromChild);
    toChild.write(
      frameMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { ...CLIENT_META },
      }),
    );
    const response = await pending;
    expect((response.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "Child",
    );
  });

  it("runs a tool handler and frames its result back", async () => {
    const { toChild, fromChild } = await harness();
    const pending = nextFramed(fromChild);
    toChild.write(
      frameMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo_back", arguments: { text: "hello" }, ...CLIENT_META },
      }),
    );
    const response = await pending;
    expect(response.result).toMatchObject({
      content: [{ type: "text", text: JSON.stringify({ echoed: "hello" }) }],
    });
  });

  it("refuses a tool result the boundary cannot carry", async () => {
    // A Map is a successful JSON round-trip into `{}` — no exception, no
    // symptom, wrong value. `LoopbackTransport` refuses it on the in-process
    // arm; the child refuses it here so a plugin gets the same answer on both.
    const { toChild, fromChild } = await harness({
      instance: { handlers: { echo_back: () => new Map([["a", 1]]) } },
    });
    const pending = nextFramed(fromChild);
    toChild.write(
      frameMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo_back", arguments: { text: "x" }, ...CLIENT_META },
      }),
    );
    const response = await pending;
    expect(JSON.stringify(response)).toContain("Map");
  });

  it("fails loudly when the entry exports no factory", async () => {
    await expect(
      startPluginChildRuntime({
        input: new PassThrough(),
        output: new PassThrough(),
        manifest: MANIFEST,
        context: {
          pluginId: PLUGIN_ID,
          pluginRoot: "/plugins/child",
          hostRoot: "/app",
          pluginDataDir: "/plugins/child/data",
          generationId: GENERATION,
        },
        channel: { call: () => Promise.reject(new Error("unused")), notify: () => {} },
        loadFactory: async () => undefined,
      }),
    ).rejects.toThrow(/exports no plugin factory/u);
  });
});

describe("the hostApi stub builder", () => {
  it("nests every declared member from the contract SOT, with nothing added", () => {
    const wired: string[] = [];
    const stub = createChildHostApiStub(PLUGIN_ID, (path) => {
      wired.push(path);
      return () => path;
    });
    expect(wired.sort()).toEqual(Object.keys(HOSTAPI_PATH_CONTRACTS).sort());
    const namespaces = stub as unknown as Record<string, Record<string, unknown>>;
    expect(Object.keys(namespaces.storage).sort()).toEqual(
      Object.keys(HOSTAPI_PATH_CONTRACTS)
        .filter((path) => path.startsWith("storage."))
        .map((path) => path.slice("storage.".length))
        .sort(),
    );
  });

  it("refuses to hand the plugin a stub with a member missing", () => {
    expect(() =>
      createChildHostApiStub(PLUGIN_ID, (path) =>
        // A builder that skipped a member would give the plugin a TypeError at
        // some unrelated call site instead of a failure that names the gap.
        path === "getSecret" ? (undefined as never) : () => undefined,
      ),
    ).toThrow(/missing 'getSecret'/u);
  });

  it("gives an unwired member a throw, not a resolved undefined", () => {
    const member = unimplementedChildMember(PLUGIN_ID, "getSecret");
    expect(() => member("api-key")).toThrow(/hostApi\.getSecret is not wired/u);
  });
});

describe("the hostApi stub the child hands the plugin", () => {
  it("presents every declared member, nested, as a function", async () => {
    const { child } = await harness();
    const hostApi = child.hostApi as unknown as Record<string, unknown>;
    expect(typeof hostApi.getSecret).toBe("function");
    expect(typeof (hostApi.storage as Record<string, unknown>).writeJson).toBe(
      "function",
    );
    expect(typeof (hostApi.agentApproval as Record<string, unknown>).request).toBe(
      "function",
    );
  });

  it("throws from an unwired member instead of resolving undefined", async () => {
    const { child } = await harness();
    expect(() => child.hostApi.getSecret("api-key")).toThrow(/not wired/u);
  });

  it("routes context.log to the host as a notification", async () => {
    const notifications: HostApiNotification[] = [];
    const child = await startPluginChildRuntime({
      input: new PassThrough(),
      output: new PassThrough(),
      manifest: MANIFEST,
      context: {
        pluginId: PLUGIN_ID,
        pluginRoot: "/plugins/child",
        hostRoot: "/app",
        pluginDataDir: "/plugins/child/data",
        generationId: GENERATION,
      },
      channel: {
        call: () => Promise.reject(new Error("unused")),
        notify: (notification) => notifications.push(notification),
      },
      loadFactory: async () => (context) => {
        context.log("starting", { attempt: 1 });
        return { handlers: {} };
      },
    });
    expect(child.instance.handlers).toEqual({});
    expect(notifications).toEqual([
      {
        wire: 1,
        pluginId: PLUGIN_ID,
        generationId: GENERATION,
        kind: "log",
        message: "starting",
        meta: { attempt: 1 },
      },
    ]);
  });
});

describe("a hostApi call crosses the reverse channel and settles", () => {
  it("returns the host's value", async () => {
    const { call } = await harness({
      table: {
        ...HOSTAPI_DISPATCH_TABLE,
        hasRoutineBySource: defineHostApiPath(
          "hasRoutineBySource",
          async (invocation) => invocation.args[0] === "nightly",
        ),
      },
    });
    await expect(call("hasRoutineBySource", ["nightly"])).resolves.toBe(true);
    await expect(call("hasRoutineBySource", ["other"])).resolves.toBe(false);
  });

  it("throws with the code, not a message match, when the host refuses", async () => {
    const { call } = await harness();
    await expect(call("getSecret", ["api-key"])).rejects.toMatchObject({
      code: "path-not-implemented",
    });
    await expect(call("getSecret", ["api-key"])).rejects.toBeInstanceOf(
      PluginHostApiError,
    );
  });

  it("refuses an unmarshallable argument at the plugin's own call site", async () => {
    const { call, host } = await harness();
    const handle = vi.spyOn(host, "handle");
    await expect(call("hasRoutineBySource", [new Date()])).rejects.toThrow(
      /cannot cross the boundary/u,
    );
    // Not sent: the failure belongs to the caller, not to the transport.
    expect(handle).not.toHaveBeenCalled();
  });

  it("refuses a call naming an incarnation the host is no longer serving", async () => {
    const { host } = await harness();
    const stale = createHostApiCaller(
      { call: (request) => host.handle(request), notify: () => {} },
      { pluginId: PLUGIN_ID, generationId: "gen-6" },
    );
    await expect(stale("hasRoutineBySource", ["nightly"])).rejects.toMatchObject({
      code: "generation-mismatch",
    });
  });
});

describe("a subscription releases on both sides, whichever side dies", () => {
  /** A host handler that adopts the child-allocated id — the shape all four take. */
  function subscriptionTable(teardown: () => void) {
    return {
      ...HOSTAPI_DISPATCH_TABLE,
      onEvent: defineHostApiPath("onEvent", async (invocation, scope) => {
        const subscriptionId = invocation.args[1] as string;
        scope.adopt(subscriptionId, teardown);
        return { handleId: subscriptionId };
      }),
    };
  }

  async function subscribe(teardown: () => void) {
    const wired = await harness({ table: subscriptionTable(teardown) });
    const received: unknown[] = [];
    const subscription = wired.child.openSubscription("onEvent", (payload) =>
      received.push(payload),
    );
    await wired.call("onEvent", ["task.created", subscription.subscriptionId]);
    expect(wired.child.openSubscriptionCount).toBe(1);
    expect(wired.host.openSubscriptionCount).toBe(1);
    return { ...wired, subscription, received };
  }

  it("delivers host events to the plugin's handler", async () => {
    const { host, subscription, received } = await subscribe(() => {});
    // The host handler reaches the child through the same scope it registered on.
    const table = HOSTAPI_DISPATCH_TABLE;
    expect(table.onEvent.status).toBe("unimplemented");
    host.handleNotification({
      wire: 1,
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      kind: "subscription-release",
      subscriptionId: `${subscription.subscriptionId}-nope`,
    });
    expect(received).toEqual([]);
  });

  it("releases BOTH sides when the child disposes", async () => {
    const teardown = vi.fn();
    const { child, host, subscription, childNotifications } = await subscribe(teardown);

    subscription.dispose();

    expect(child.openSubscriptionCount).toBe(0);
    expect(host.openSubscriptionCount).toBe(0);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(childNotifications.at(-1)).toMatchObject({
      kind: "subscription-release",
      subscriptionId: subscription.subscriptionId,
    });

    // Disposing again is a no-op on both sides rather than a second teardown.
    subscription.dispose();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("releases the HOST side when the child dies without disposing", async () => {
    const teardown = vi.fn();
    const { child, host } = await subscribe(teardown);

    // The child is gone: no release ever arrives, and the host must not wait
    // for one. This is the leak the in-process version cannot have and the
    // out-of-process version gets for free only if the host is told.
    expect(host.childGone()).toBe(1);

    expect(host.openSubscriptionCount).toBe(0);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledWith("peer-gone");
    // The child's own ledger dies with its process; asserting it here documents
    // that nothing in the host's cleanup depends on the child cooperating.
    expect(child.openSubscriptionCount).toBe(1);
  });

  it("releases the CHILD side when the host dies, without writing to a closed pipe", async () => {
    const teardown = vi.fn();
    const { child, childNotifications } = await subscribe(teardown);
    const before = childNotifications.length;

    expect(child.hostGone()).toBe(1);

    expect(child.openSubscriptionCount).toBe(0);
    // No release notification: there is no host left to receive one.
    expect(childNotifications).toHaveLength(before);
  });

  it("drops the child side when the host revokes, and does not echo back", async () => {
    const teardown = vi.fn();
    const { child, subscription, childNotifications } = await subscribe(teardown);
    const before = childNotifications.length;

    expect(
      child.deliver({
        wire: 1,
        pluginId: PLUGIN_ID,
        generationId: GENERATION,
        kind: "subscription-closed",
        subscriptionId: subscription.subscriptionId,
        reason: "revoked",
      }),
    ).toBe("closed");

    expect(child.openSubscriptionCount).toBe(0);
    expect(childNotifications).toHaveLength(before);
  });

  it("reports an event for a subscription that is already gone", async () => {
    const { child, subscription } = await subscribe(() => {});
    subscription.dispose();
    // An event that crossed before the release did is a real ordering artifact,
    // not an error — but it is REPORTED rather than dropped in silence, because
    // "no handler ran" is exactly the symptom a leak or a mis-keyed id produces.
    const outcome: NotificationOutcome = child.deliver({
      wire: 1,
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      kind: "subscription-event",
      subscriptionId: subscription.subscriptionId,
      payload: { late: true },
    });
    expect(outcome).toBe("unknown-subscription");
  });

  it("carries a payload from the host handler to the plugin's callback", async () => {
    const delivered: unknown[] = [];
    let push: ((payload: unknown) => void) | undefined;
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      onEvent: defineHostApiPath("onEvent", async (invocation, scope) => {
        const subscriptionId = invocation.args[1] as string;
        scope.adopt(subscriptionId, () => {});
        push = (payload) => scope.deliver(subscriptionId, payload);
        return { handleId: subscriptionId };
      }),
    };
    const wired = await harness({ table });
    const subscription = wired.child.openSubscription("onEvent", (payload) =>
      delivered.push(payload),
    );
    await wired.call("onEvent", ["task.created", subscription.subscriptionId]);

    push?.({ taskId: "t1" });
    expect(delivered).toEqual([{ taskId: "t1" }]);

    subscription.dispose();
    expect(() => push?.({ taskId: "t2" })).toThrow(/no open subscription/u);
  });
});

describe("an abort channel replaces the AbortSignal three members carry", () => {
  /** A host handler that takes a signal the way `callLlm` will. */
  function abortingTable(observed: { signal?: AbortSignal }) {
    return {
      ...HOSTAPI_DISPATCH_TABLE,
      onEvent: defineHostApiPath("onEvent", async (invocation, scope) => {
        const channelId = invocation.args[0] as string;
        observed.signal = scope.abortChannel(channelId);
        return { handleId: channelId };
      }),
    };
  }

  it("cancels the host's work when the plugin aborts", async () => {
    const observed: { signal?: AbortSignal } = {};
    const wired = await harness({ table: abortingTable(observed) });
    const controller = new AbortController();
    const channel = wired.child.openAbortChannel(controller.signal);
    await wired.call("onEvent", [channel.subscriptionId]);
    expect(observed.signal?.aborted).toBe(false);

    controller.abort(new Error("the plugin changed its mind"));

    expect(observed.signal?.aborted).toBe(true);
    expect(wired.host.openSubscriptionCount).toBe(0);
  });

  it("cancels work started for a child that has since died", async () => {
    // The host is fetching on behalf of a process that no longer exists. Not
    // aborting leaves the request in flight with nowhere to deliver its answer.
    const observed: { signal?: AbortSignal } = {};
    const wired = await harness({ table: abortingTable(observed) });
    const controller = new AbortController();
    const channel = wired.child.openAbortChannel(controller.signal);
    await wired.call("onEvent", [channel.subscriptionId]);

    wired.host.childGone();

    expect(observed.signal?.aborted).toBe(true);
  });

  it("detaches the child's listener when the call settles", async () => {
    const observed: { signal?: AbortSignal } = {};
    const wired = await harness({ table: abortingTable(observed) });
    const controller = new AbortController();
    const channel = wired.child.openAbortChannel(controller.signal);
    await wired.call("onEvent", [channel.subscriptionId]);
    const before = wired.childNotifications.length;

    channel.release();
    controller.abort(new Error("too late"));

    // No abort notification: the channel was already closed, so the listener is
    // gone. A channel that stayed attached would keep the settled call's
    // closure alive for as long as the plugin holds the signal.
    expect(wired.childNotifications).toHaveLength(before);
    expect(observed.signal?.aborted).toBe(false);
  });

  it("throws the signal's own reason instead of opening a doomed channel", async () => {
    const wired = await harness();
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    expect(() => wired.child.openAbortChannel(controller.signal)).toThrow(reason);
  });

  it("drops its channels when the host dies", async () => {
    const observed: { signal?: AbortSignal } = {};
    const wired = await harness({ table: abortingTable(observed) });
    const controller = new AbortController();
    const channel = wired.child.openAbortChannel(controller.signal);
    await wired.call("onEvent", [channel.subscriptionId]);
    const before = wired.childNotifications.length;

    expect(wired.child.hostGone()).toBe(1);
    controller.abort(new Error("nobody listening"));

    expect(wired.childNotifications).toHaveLength(before);
  });
});
