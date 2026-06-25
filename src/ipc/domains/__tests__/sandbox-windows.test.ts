/**
 * Windows srt-win consent IPC handlers + the win32 sandboxCapability reconcile.
 *
 * Covers PR3 item 1 (sandboxWindowsStatus / sandboxWindowsInstall handler
 * shapes) and item 2's main-side half (win32 → available:true, network-only
 * confines). The live UAC/relogin/WFP behaviour is NOT CI-testable — these
 * tests mock ASRT's windows-sandbox-utils to assert the HANDLER contract: the
 * shapes returned for each group/WFP state, the {cancelled:true} pass-through,
 * and the sender-frame guard on the mutating install handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { UNAUTHORIZED_FRAME } from "../../gated.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };

// Mutable ASRT mock state — each test sets the desired group/WFP/install result.
const asrtState = vi.hoisted(() => ({
  groupState: "absent" as "absent" | "created-not-on-token" | "ready",
  wfpState: "absent" as "absent" | "installed",
  installResult: null as
    | { cancelled: true }
    | { group: { state: string }; wfp: { state: string } }
    | null,
  installCalls: [] as Array<{ proxyPortRange?: readonly [number, number] }>,
  instructions: "INSTRUCTIONS_TEXT",
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  getWindowsGroupStatus: vi.fn((_ref: unknown) => ({ state: asrtState.groupState })),
  getWindowsWfpStatus: vi.fn(() => ({ state: asrtState.wfpState, filters: 2 })),
  windowsInstallInstructions: vi.fn(
    (_ref: unknown, _sublayer: unknown, groupState: string) =>
      `${asrtState.instructions}:${groupState}`,
  ),
  installWindowsSandbox: vi.fn((opts?: { proxyPortRange?: readonly [number, number] }) => {
    asrtState.installCalls.push(opts ?? {});
    return asrtState.installResult;
  }),
  DEFAULT_WINDOWS_PROXY_PORT_RANGE: [60080, 60089] as readonly [number, number],
}));

// validateSender: the test seam — null event (trusted) returns true; a foreign
// frame object returns false so the UNAUTHORIZED_FRAME path is exercisable.
vi.mock("../../gated.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gated.js")>();
  return {
    ...actual,
    validateSender: vi.fn((e: unknown) => e === null),
    auditUnauthorized: vi.fn(),
  };
});

function invoke(channel: string, event: unknown, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(event, ...args);
}

function makeDeps() {
  return {
    conversationLoop: { permissionManager: { getMode: () => "default" } },
    approvalGate: {},
    auditLogger: { log: vi.fn() },
    toolRegistry: { setDenyRules: vi.fn() },
    settingsService: { get: vi.fn(() => ({ osToolSandbox: false })) },
    getAppWindows: vi.fn(() => []),
  };
}

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerPermissionsHandlers } = await import("../permissions.js");
  registerPermissionsHandlers(makeDeps() as never);
}

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  asrtState.groupState = "absent";
  asrtState.wfpState = "absent";
  asrtState.installResult = null;
  asrtState.installCalls = [];
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

describe("sandboxWindowsStatus", () => {
  it("returns a not-applicable shape off win32 (no ASRT call)", async () => {
    setPlatform("darwin");
    await setup();
    const result = await invoke(PERMISSIONS.sandboxWindowsStatus, null);
    expect(result).toEqual({
      applicable: false,
      groupState: null,
      wfpState: null,
      ready: false,
      instructions: "",
    });
  });

  it("created-not-on-token + WFP absent → ready:false with verbatim instructions", async () => {
    setPlatform("win32");
    asrtState.groupState = "created-not-on-token";
    asrtState.wfpState = "absent";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, null)) as Record<string, unknown>;
    expect(result.applicable).toBe(true);
    expect(result.groupState).toBe("created-not-on-token");
    expect(result.wfpState).toBe("absent");
    expect(result.ready).toBe(false);
    // Verbatim ASRT text, tailored to the observed group state.
    expect(result.instructions).toBe("INSTRUCTIONS_TEXT:created-not-on-token");
  });

  it("group ready + WFP installed → ready:true", async () => {
    setPlatform("win32");
    asrtState.groupState = "ready";
    asrtState.wfpState = "installed";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, null)) as Record<string, unknown>;
    expect(result.ready).toBe(true);
    expect(result.groupState).toBe("ready");
    expect(result.wfpState).toBe("installed");
  });

  it("group ready but WFP absent → ready:false (both conditions required)", async () => {
    setPlatform("win32");
    asrtState.groupState = "ready";
    asrtState.wfpState = "absent";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, null)) as Record<string, unknown>;
    expect(result.ready).toBe(false);
  });
});

describe("sandboxWindowsInstall", () => {
  it("rejects a foreign frame with UNAUTHORIZED_FRAME (sender guard)", async () => {
    setPlatform("win32");
    await setup();
    const foreignEvent = { senderFrame: { url: "https://evil.example" } };
    const result = await invoke(PERMISSIONS.sandboxWindowsInstall, foreignEvent, { intent: USER_INTENT });
    expect(result).toEqual(UNAUTHORIZED_FRAME);
  });

  it("rejects a submission without user-keyboard intent", async () => {
    setPlatform("win32");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, null, {})) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("user-keyboard-required");
  });

  it("returns {cancelled:true} when the user dismisses UAC (not an error)", async () => {
    setPlatform("win32");
    asrtState.installResult = { cancelled: true };
    await setup();
    const result = await invoke(PERMISSIONS.sandboxWindowsInstall, null, { intent: USER_INTENT });
    expect(result).toEqual({ cancelled: true });
    // The single UAC was attempted with the canonical proxy port range.
    expect(asrtState.installCalls).toHaveLength(1);
    expect(asrtState.installCalls[0].proxyPortRange).toEqual([60080, 60089]);
  });

  it("returns post-install group + WFP state on success", async () => {
    setPlatform("win32");
    asrtState.installResult = {
      group: { state: "created-not-on-token" },
      wfp: { state: "installed" },
    };
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, null, { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.groupState).toBe("created-not-on-token");
    expect(result.wfpState).toBe("installed");
    // Group not yet on token → still not ready until relogin.
    expect(result.ready).toBe(false);
  });

  it("reports ready:true when install lands group ready + WFP installed", async () => {
    setPlatform("win32");
    asrtState.installResult = {
      group: { state: "ready" },
      wfp: { state: "installed" },
    };
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, null, { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.ready).toBe(true);
  });

  it("refuses off win32 (not-applicable)", async () => {
    setPlatform("linux");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, null, { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-applicable");
  });
});

describe("sandboxCapability win32 reconcile", () => {
  it("reports win32 as available with network-only confines (matches boot SOT)", async () => {
    setPlatform("win32");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxCapability, null)) as {
      platform: string;
      available: boolean;
      kind: string;
      confines: { filesystem: boolean; process: boolean; network: boolean };
    };
    expect(result.platform).toBe("win32");
    expect(result.available).toBe(true);
    expect(result.kind).toBe("partial");
    // Network-only — the asymmetric relaxation seam: egress confined, FS not.
    expect(result.confines).toEqual({ filesystem: false, process: false, network: true });
  });

  it("still reports darwin as full-confine available", async () => {
    setPlatform("darwin");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxCapability, null)) as {
      available: boolean;
      kind: string;
      confines: { filesystem: boolean; process: boolean; network: boolean };
    };
    expect(result.available).toBe(true);
    expect(result.kind).toBe("full");
    expect(result.confines).toEqual({ filesystem: true, process: true, network: true });
  });
});
