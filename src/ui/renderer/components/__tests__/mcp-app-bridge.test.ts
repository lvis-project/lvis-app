import { describe, it, expect, vi, beforeEach } from "vitest";

// Replace the real ext-apps `AppBridge` with a fake that records the capabilities it
// was constructed with and which handlers were present at `connect()` time. This lets
// us assert the two structural invariants of the wiring seam without standing up a real
// transport/handshake: (1) capabilities are DERIVED from the active handler set, and
// (2) every handler is registered BEFORE connect().
//
// Defined via `vi.hoisted` because the `vi.mock` factory below is hoisted above normal
// top-level declarations — a plain `class` would be in its temporal dead zone.
const { FakeAppBridge } = vi.hoisted(() => {
  class FakeAppBridge {
    capabilities: Record<string, unknown>;
    hostContext: unknown;
    onsandboxready?: unknown;
    onreadresource?: unknown;
    connectCalled = false;
    handlersAtConnect: Record<string, boolean> = {};

    constructor(
      _client: unknown,
      _hostInfo: unknown,
      capabilities: Record<string, unknown>,
      options: { hostContext?: unknown },
    ) {
      this.capabilities = capabilities;
      this.hostContext = options?.hostContext;
    }

    sendSandboxResourceReady(): void {}

    connect(_transport: unknown): Promise<void> {
      this.connectCalled = true;
      this.handlersAtConnect = {
        onsandboxready: typeof this.onsandboxready === "function",
        onreadresource: typeof this.onreadresource === "function",
      };
      return Promise.resolve();
    }
  }
  return { FakeAppBridge };
});

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({ AppBridge: FakeAppBridge }));

import { createMcpAppBridge } from "../mcp-app-bridge.js";

type FakeBridge = InstanceType<typeof FakeAppBridge>;

const fakeEl = { send: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };

function build() {
  return createMcpAppBridge({ serverId: "s1" }, "<html><body>card</body></html>", fakeEl as never, {});
}

beforeEach(() => {
  fakeEl.send.mockClear();
});

describe("createMcpAppBridge — capabilities are derived from the single active-handler set", () => {
  it("advertises exactly the capabilities whose handlers are wired (serverResources), nothing else", () => {
    const { bridge } = build();
    // onreadresource → serverResources. The sandbox handler advertises nothing. No
    // serverTools / message / downloadFile leak in — a capability without a wired
    // handler would be a latent, silent bug.
    expect((bridge as unknown as FakeBridge).capabilities).toEqual({ serverResources: {} });
  });
});

describe("createMcpAppBridge — every handler registers before connect()", () => {
  it("has all handlers present at the moment connect() is called", () => {
    const { bridge } = build();
    const fake = bridge as unknown as FakeBridge;

    expect(fake.connectCalled).toBe(true);
    expect(fake.handlersAtConnect).toEqual({ onsandboxready: true, onreadresource: true });
  });

  it("returns a bridge with each handler wired as a function", () => {
    const { bridge } = build();
    const fake = bridge as unknown as FakeBridge;
    expect(typeof fake.onsandboxready).toBe("function");
    expect(typeof fake.onreadresource).toBe("function");
  });
});
