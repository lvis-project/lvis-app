/**
 * local-api dispatcher — #1409 C12 boundary proof.
 *
 * Asserts the three fail-closed guarantees of the external-surface seam:
 *   (1) a PUBLIC read channel dispatches to its C10 handler,
 *   (2) a `gesture:"required"` mutating channel (permission set-mode) is
 *       REJECTED for origin 'local-api' AND 'cli' with the gated error,
 *   (3) a non-public channel is rejected.
 *
 * These are the security proof that mutating gesture-gated channels are
 * un-invokable by api/cli in this commit.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createLocalApi,
  LOCAL_API_GESTURE_REQUIRED,
  LOCAL_API_CHANNEL_NOT_PUBLIC,
  LOCAL_API_ORIGIN_UNSUPPORTED,
  type LocalApiDeps,
  type ExternalMutationApprover,
} from "../local-api.js";
import type { ChatSendContext } from "../../ipc/handlers/chat.js";
import type { IpcDeps } from "../../ipc/types.js";
import {
  CHANNELS,
  PERMISSIONS,
  EXTERNAL_MUTATION_DENIED,
} from "../../contract/app-contract.js";

// Stub stream plumbing — no real webContents; `chat send` is not exercised here.
const chatSendContext: ChatSendContext = {
  sink: () => {},
  allocateStreamId: () => 1,
  trackStreamTurn: (factory) => factory(),
};

function makeDeps(overrides: Partial<Record<string, unknown>> = {}): LocalApiDeps {
  const ipc = {
    conversationLoop: {
      getSessionId: () => "session-1",
      permissionManager: { getMode: () => "acceptEdits" },
    },
    memoryManager: {
      listSessionsPage: () => [],
    },
    ...overrides,
  } as unknown as IpcDeps;
  return { ipc, chatSendContext };
}

describe("local-api dispatch — public read routing", () => {
  it("routes a public read channel (permission get-mode) to its handler", async () => {
    const getMode = vi.fn(() => "plan");
    const api = createLocalApi(
      makeDeps({ conversationLoop: { getSessionId: () => "s", permissionManager: { getMode } } }),
    );
    const result = await api.dispatch({ channel: PERMISSIONS.getMode, origin: "local-api" });
    expect(getMode).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: { mode: "plan" } });
  });

  it("routes chat sessions (read) to its handler", async () => {
    const listSessionsPage = vi.fn(() => []);
    const api = createLocalApi(
      makeDeps({
        conversationLoop: { getSessionId: () => "session-1", permissionManager: { getMode: () => "default" } },
        memoryManager: { listSessionsPage },
      }),
    );
    const result = await api.dispatch({ channel: CHANNELS.chat.sessions, origin: "local-api" });
    expect(listSessionsPage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: { current: "session-1", sessions: [] } });
  });
});

describe("local-api dispatch — gesture-gated mutating channels are blocked", () => {
  it("rejects permission set-mode for origin 'local-api' with the gated error", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({ channel: PERMISSIONS.setMode, args: { mode: "auto" }, origin: "local-api" });
    expect(result).toEqual({ ok: false, error: LOCAL_API_GESTURE_REQUIRED });
  });

  it("rejects permission set-mode for origin 'cli' with the gated error", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({ channel: PERMISSIONS.setMode, args: { mode: "auto" }, origin: "cli" });
    expect(result).toEqual({ ok: false, error: LOCAL_API_GESTURE_REQUIRED });
  });

  it("blocks every gesture:required channel for both external origins", async () => {
    const api = createLocalApi(makeDeps());
    const gated = [
      PERMISSIONS.setMode,
      PERMISSIONS.addRule,
      PERMISSIONS.removeRule,
      PERMISSIONS.policySet,
      PERMISSIONS.sandboxWindowsInstall,
    ];
    for (const channel of gated) {
      for (const origin of ["local-api", "cli"] as const) {
        const result = await api.dispatch({ channel, origin });
        expect(result, `${channel} @ ${origin}`).toEqual({ ok: false, error: LOCAL_API_GESTURE_REQUIRED });
      }
    }
  });
});

describe("local-api dispatch — non-public channels are rejected", () => {
  it("rejects a non-public channel (settings get)", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({ channel: CHANNELS.settings.get, origin: "local-api" });
    expect(result).toEqual({ ok: false, error: LOCAL_API_CHANNEL_NOT_PUBLIC });
  });

  it("rejects an unknown channel", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({ channel: "lvis:not:a:real:channel", origin: "local-api" });
    expect(result).toEqual({ ok: false, error: LOCAL_API_CHANNEL_NOT_PUBLIC });
  });
});

describe("local-api dispatch — origin is fail-closed", () => {
  it("rejects a smuggled non-external origin (bad cast)", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({
      channel: PERMISSIONS.getMode,
      // Simulate a JS call site bad-casting an unsupported origin.
      origin: "renderer" as unknown as "local-api",
    });
    expect(result).toEqual({ ok: false, error: LOCAL_API_ORIGIN_UNSUPPORTED });
  });
});

// ── #1409 approval-mediated external mutation ────────────────────────────────

/**
 * A fake main window whose `webContents.send` is a spy — lets a test assert the
 * post-apply broadcast was attempted without a real Electron window.
 */
function makeFakeWindow() {
  const send = vi.fn();
  return {
    send,
    win: {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
    },
  };
}

/**
 * Deps sufficient for `handleSetPermissionMode` to run end-to-end: a permission
 * manager (getMode + setModePersist for durable), an audit logger whose chain is
 * ready, and a main window for the mode-changed broadcast. `approvalGate` is
 * present but its `requestAndWait` is a spy that MUST NOT be called on the
 * approved external path (the widened bypass skips the second modal).
 */
function makeMutationDeps(
  approver: ExternalMutationApprover | undefined,
  fakeWin: ReturnType<typeof makeFakeWindow>,
): LocalApiDeps {
  let mode = "default";
  const setModePersist = vi.fn(async (next: string) => {
    mode = next;
  });
  const gateRequestAndWait = vi.fn(async () => ({ requestId: "x", choice: "allow-once" as const }));
  const appendPermissionAuditEntry = vi.fn(async () => undefined);
  const ipc = {
    conversationLoop: {
      getSessionId: () => "s",
      permissionManager: {
        getMode: () => mode,
        setMode: (next: string) => {
          mode = next;
        },
        setModePersist,
      },
    },
    approvalGate: { requestAndWait: gateRequestAndWait },
    auditLogger: {
      isPermissionAuditChainReady: () => true,
      appendPermissionAuditEntry,
    },
    getMainWindow: () => fakeWin.win,
  } as unknown as IpcDeps;
  return { ipc, chatSendContext, externalMutationApprover: approver };
}

describe("local-api dispatch — external mutation default posture (no approver)", () => {
  it("set-mode is still rejected 'gesture-required-origin-unsupported' when NO approver is wired", async () => {
    // Byte-identical to the pre-#1409 default — verified against the same code.
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "local-api",
    });
    expect(result).toEqual({ ok: false, error: LOCAL_API_GESTURE_REQUIRED });
  });
});

describe("local-api dispatch — external mutation with approver wired", () => {
  it("approver returns false → external-mutation-denied (mode NOT changed)", async () => {
    const fakeWin = makeFakeWindow();
    const approver = vi.fn(async () => false);
    const deps = makeMutationDeps(approver, fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "local-api",
    });

    expect(result).toEqual({ ok: false, error: EXTERNAL_MUTATION_DENIED });
    expect(approver).toHaveBeenCalledWith({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "local-api",
    });
    // Denied → the mutating handler never ran → no broadcast.
    expect(fakeWin.send).not.toHaveBeenCalled();
  });

  it("approver throws → external-mutation-denied (fail-closed, no mutation)", async () => {
    const fakeWin = makeFakeWindow();
    const approver = vi.fn(async () => {
      throw new Error("gate blew up");
    });
    const deps = makeMutationDeps(approver, fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "cli",
    });

    expect(result).toEqual({ ok: false, error: EXTERNAL_MUTATION_DENIED });
    expect(fakeWin.send).not.toHaveBeenCalled();
  });

  it("approver returns true → routes to handleSetPermissionMode (mode applied + broadcast attempted) and returns ok", async () => {
    const fakeWin = makeFakeWindow();
    const approver = vi.fn(async () => true);
    const deps = makeMutationDeps(approver, fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "local-api",
    });

    // The mutating handler ran and applied the durable mode change...
    expect(result).toEqual({ ok: true, data: { ok: true, mode: "auto" } });
    // ...persisting the mode and attempting the mode-changed broadcast.
    expect(fakeWin.send).toHaveBeenCalledWith(PERMISSIONS.modeChanged, { mode: "auto" });
    // No SECOND in-app modal: the widened bypass means the handler's own
    // approval-gate ask was skipped (the ApprovalGate consent already happened).
    expect((deps.ipc.approvalGate as unknown as { requestAndWait: ReturnType<typeof vi.fn> }).requestAndWait)
      .not.toHaveBeenCalled();
  });

  it("a gesture channel NOT in the external-mutation allowlist (policy set) is STILL gesture-required even with an approver", async () => {
    const fakeWin = makeFakeWindow();
    const approver = vi.fn(async () => true);
    const deps = makeMutationDeps(approver, fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.policySet,
      args: { some: "payload" },
      origin: "local-api",
    });

    expect(result).toEqual({ ok: false, error: LOCAL_API_GESTURE_REQUIRED });
    // The approver was never consulted for a non-allowlisted channel.
    expect(approver).not.toHaveBeenCalled();
  });
});
