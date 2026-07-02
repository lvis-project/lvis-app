/**
 * Windows srt-win consent IPC handlers + the win32 sandboxCapability reconcile.
 *
 * Covers sandboxWindowsStatus / sandboxWindowsInstall handler shapes and the
 * main-side win32 capability reconcile (fs+network partial confinement). The
 * live UAC/WFP behaviour is NOT CI-testable — these tests mock ASRT's Windows
 * API to assert the HANDLER contract: the shapes returned for each user/WFP
 * state, the {cancelled:true} pass-through,
 * and the sender-frame guard on the mutating install handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { UNAUTHORIZED_FRAME } from "../../gated.js";
import { setProcessPlatform } from "../../../testing/process-platform.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };

// Mutable ASRT mock state — each test sets the desired group/WFP/install result.
const asrtState = vi.hoisted(() => ({
  userStatus: {} as {
    provisioned?: boolean;
    sid?: string;
    groupExists?: boolean;
    inBuiltinUsers?: boolean;
    inSandboxGroup?: boolean;
    hiddenFromLogon?: boolean;
    credPresent?: boolean;
  },
  wfpState: "absent" as "absent" | "installed" | "cannot-read",
  installResult: null as
    | { cancelled: true }
    | {
        user: {
          provisioned?: boolean;
          sid?: string;
          groupExists?: boolean;
          inBuiltinUsers?: boolean;
          inSandboxGroup?: boolean;
          hiddenFromLogon?: boolean;
          credPresent?: boolean;
        };
        wfp: { state: string };
      }
    | null,
  installCalls: [] as Array<{ proxyPortRange?: readonly [number, number] }>,
  verifyCalls: [] as Array<{ proxyPortRange?: readonly [number, number] }>,
  verifyRejects: false,
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
  getWindowsSandboxUserStatus: vi.fn(() => asrtState.userStatus),
  getWindowsWfpStatus: vi.fn(() => ({ state: asrtState.wfpState, filters: 2 })),
  windowsInstallInstructions: vi.fn((_sublayer?: string) => asrtState.instructions),
  verifyWindowsWfpEgress: vi.fn((opts?: { proxyPortRange?: readonly [number, number] }) => {
    asrtState.verifyCalls.push(opts ?? {});
    if (asrtState.verifyRejects) {
      throw new Error("WFP egress verification failed");
    }
    return Promise.resolve({ target: "127.0.0.1:49152", stderr: "BLOCKED" });
  }),
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

beforeEach(() => {
  asrtState.userStatus = {};
  asrtState.wfpState = "absent";
  asrtState.installResult = null;
  asrtState.installCalls = [];
  asrtState.verifyCalls = [];
  asrtState.verifyRejects = false;
});

afterEach(() => {
  setProcessPlatform(ORIGINAL_PLATFORM);
});

function readyUserStatus(): typeof asrtState.userStatus {
  return {
    provisioned: true,
    sid: "S-1-5-21-1",
    groupExists: true,
    inBuiltinUsers: true,
    inSandboxGroup: true,
    hiddenFromLogon: true,
    credPresent: true,
  };
}

describe("sandboxWindowsStatus", () => {
  it("returns a not-applicable shape off win32 (no ASRT call)", async () => {
    setProcessPlatform("darwin");
    await setup();
    const result = await invoke(PERMISSIONS.sandboxWindowsStatus, null);
    expect(result).toEqual({
      applicable: false,
      userState: null,
      wfpState: null,
      ready: false,
      instructions: "",
    });
  });

  it("incomplete user + WFP absent → ready:false with verbatim instructions", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = { provisioned: true, sid: "S-1-5-21-1" };
    asrtState.wfpState = "absent";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, null)) as Record<string, unknown>;
    expect(result.applicable).toBe(true);
    expect(result.userState).toBe("incomplete");
    expect(result.wfpState).toBe("absent");
    expect(result.ready).toBe(false);
    expect(result.instructions).toBe("INSTRUCTIONS_TEXT");
  });

  it("user ready + WFP installed → ready:true", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = readyUserStatus();
    asrtState.wfpState = "installed";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, null)) as Record<string, unknown>;
    expect(result.ready).toBe(true);
    expect(result.userState).toBe("ready");
    expect(result.wfpState).toBe("installed");
  });

  it("user ready but WFP absent → ready:false (both conditions required)", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = readyUserStatus();
    asrtState.wfpState = "absent";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, null)) as Record<string, unknown>;
    expect(result.ready).toBe(false);
  });

  it("WFP cannot-read is surfaced and treated as ready when verifier proves egress is blocked", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = readyUserStatus();
    asrtState.wfpState = "cannot-read";
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, null)) as Record<string, unknown>;
    expect(result.wfpState).toBe("cannot-read");
    expect(result.ready).toBe(true);
    expect(asrtState.verifyCalls).toHaveLength(1);
    expect(asrtState.verifyCalls[0].proxyPortRange).toEqual([60080, 60089]);
  });

  it("WFP cannot-read fails closed when behavioral verification fails", async () => {
    setProcessPlatform("win32");
    asrtState.userStatus = readyUserStatus();
    asrtState.wfpState = "cannot-read";
    asrtState.verifyRejects = true;
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsStatus, null)) as Record<string, unknown>;
    expect(result.wfpState).toBe("cannot-read");
    expect(result.ready).toBe(false);
    expect(asrtState.verifyCalls).toHaveLength(1);
  });
});

describe("sandboxWindowsInstall", () => {
  it("rejects a foreign frame with UNAUTHORIZED_FRAME (sender guard)", async () => {
    setProcessPlatform("win32");
    await setup();
    const foreignEvent = { senderFrame: { url: "https://evil.example" } };
    const result = await invoke(PERMISSIONS.sandboxWindowsInstall, foreignEvent, { intent: USER_INTENT });
    expect(result).toEqual(UNAUTHORIZED_FRAME);
  });

  it("rejects a submission without user-keyboard intent", async () => {
    setProcessPlatform("win32");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, null, {})) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("user-keyboard-required");
  });

  it("returns {cancelled:true} when the user dismisses UAC (not an error)", async () => {
    setProcessPlatform("win32");
    asrtState.installResult = { cancelled: true };
    await setup();
    const result = await invoke(PERMISSIONS.sandboxWindowsInstall, null, { intent: USER_INTENT });
    expect(result).toEqual({ cancelled: true });
    // The single UAC was attempted with the canonical proxy port range.
    expect(asrtState.installCalls).toHaveLength(1);
    expect(asrtState.installCalls[0].proxyPortRange).toEqual([60080, 60089]);
  });

  it("returns post-install user + WFP state on success", async () => {
    setProcessPlatform("win32");
    asrtState.installResult = {
      user: { provisioned: true, sid: "S-1-5-21-1" },
      wfp: { state: "installed" },
    };
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, null, { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.userState).toBe("incomplete");
    expect(result.wfpState).toBe("installed");
    expect(result.ready).toBe(false);
  });

  it("reports ready:true when install lands user ready + WFP installed", async () => {
    setProcessPlatform("win32");
    asrtState.installResult = {
      user: readyUserStatus(),
      wfp: { state: "installed" },
    };
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, null, { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.ready).toBe(true);
  });

  it("reports ready:true when install returns WFP cannot-read but verifier proves egress is blocked", async () => {
    setProcessPlatform("win32");
    asrtState.installResult = {
      user: readyUserStatus(),
      wfp: { state: "cannot-read" },
    };
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, null, { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.wfpState).toBe("cannot-read");
    expect(result.ready).toBe(true);
    expect(asrtState.verifyCalls).toHaveLength(1);
    expect(asrtState.verifyCalls[0].proxyPortRange).toEqual([60080, 60089]);
  });

  it("refuses off win32 (not-applicable)", async () => {
    setProcessPlatform("linux");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxWindowsInstall, null, { intent: USER_INTENT })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-applicable");
  });
});

describe("sandboxCapability win32 reconcile", () => {
  it("reports win32 as available with fs+network partial confines (matches boot SOT)", async () => {
    setProcessPlatform("win32");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxCapability, null)) as {
      platform: string;
      available: boolean;
      kind: string;
      potentialReason: string;
      runtime: { available: boolean; kind: string; reason: string };
      confines: { filesystem: boolean; process: boolean; network: boolean };
    };
    expect(result.platform).toBe("win32");
    expect(result.available).toBe(true);
    expect(result.kind).toBe("partial");
    expect(result.potentialReason).toContain("srt-win");
    expect(result.runtime.available).toBe(false);
    expect(result.runtime.kind).toBe("none");
    expect(result.runtime.reason).toContain("no OS sandbox configured");
    // Partial — fs + egress confined, process not confined.
    expect(result.confines).toEqual({ filesystem: true, process: false, network: true });
  });

  it("still reports darwin as full-confine available", async () => {
    setProcessPlatform("darwin");
    await setup();
    const result = (await invoke(PERMISSIONS.sandboxCapability, null)) as {
      available: boolean;
      kind: string;
      potentialReason: string;
      confines: { filesystem: boolean; process: boolean; network: boolean };
    };
    expect(result.available).toBe(true);
    expect(result.kind).toBe("full");
    expect(result.potentialReason).toContain("Seatbelt");
    expect(result.confines).toEqual({ filesystem: true, process: true, network: true });
  });

  it("reports active runtime separately from platform potential when ASRT is registered", async () => {
    setProcessPlatform("linux");
    const { setActiveSandboxCapability, __resetActiveSandboxCapabilityForTest } =
      await import("../../../permissions/sandbox-capability.js");
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT runtime registered at boot",
      confines: { filesystem: true, process: true, network: true },
    });
    try {
      await setup();
      const result = (await invoke(PERMISSIONS.sandboxCapability, null)) as {
        available: boolean;
        kind: string;
        runtime: { available: boolean; kind: string; reason: string };
      };
      expect(result.available).toBe(true);
      expect(result.kind).toBe("full");
      expect(result.runtime).toEqual({
        available: true,
        kind: "full",
        reason: "ASRT runtime registered at boot",
      });
    } finally {
      __resetActiveSandboxCapabilityForTest();
    }
  });
});
