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
} from "../local-api.js";
import type { ChatSendContext } from "../../ipc/handlers/chat.js";
import type { IpcDeps } from "../../ipc/types.js";
import { CHANNELS, PERMISSIONS } from "../../contract/app-contract.js";

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
