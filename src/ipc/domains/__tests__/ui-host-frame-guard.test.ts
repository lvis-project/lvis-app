/**
 * UI-domain native context menus are host-renderer-only surfaces.
 *
 * `hostWindowForUiEvent` used to re-type the plugin-shell rejection by hand
 * instead of calling `validateHostRendererSender`, so a change to what counts
 * as a plugin frame landed in `gated.ts` and silently missed this domain.
 * These tests drive the registered IPC handlers, so they fail if the handler
 * stops consulting the shared guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invokeRegisteredHandlerWithEvent } from "../../../__tests__/test-helpers.js";

const ASSISTANT_CHANNEL = "lvis:ui:assistant-context-menu";
const NATIVE_CHANNEL = "lvis:ui:native-context-menu";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const popup = vi.fn();
const fakeWindow = { isDestroyed: () => false };

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => fakeWindow) },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup })) },
}));

vi.mock("../../../i18n/index.js", () => ({ t: (key: string) => key }));

/** An event whose frame URL and top-level URL are the same document. */
function uiEvent(frameUrl: string) {
  return {
    senderFrame: { url: frameUrl },
    sender: { getURL: () => frameUrl, isDestroyed: () => false, send: vi.fn() },
  };
}

const assistantPayload = {
  requestId: "req-1",
  x: 10,
  y: 20,
  personas: [{ id: "persona-1", name: "Default" }],
  activePersonaId: "persona-1",
};

const nativePayload = {
  requestId: "req-2",
  x: 10,
  y: 20,
  kind: "message",
  commands: ["message.copy"],
};

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerUiHandlers } = await import("../ui.js");
  registerUiHandlers({ auditLogger: { log: vi.fn() } } as never);
}

type Reply = { ok: boolean; error?: string };

function invoke(channel: string, frameUrl: string, payload: unknown): Reply {
  return invokeRegisteredHandlerWithEvent<Reply>(handlers, channel, uiEvent(frameUrl), payload);
}

describe("UI context-menu channels — host renderer frames only", () => {
  beforeEach(async () => {
    await setup();
  });

  it("refuses a plugin UI shell frame on both channels", () => {
    const shell = "file:///dist/src/plugin-ui-shell.html";
    expect(invoke(ASSISTANT_CHANNEL, shell, assistantPayload)).toEqual({
      ok: false,
      error: "unauthorized-frame",
    });
    expect(invoke(NATIVE_CHANNEL, shell, nativePayload)).toEqual({
      ok: false,
      error: "unauthorized-frame",
    });
    expect(popup).not.toHaveBeenCalled();
  });

  it("serves the host renderer even when its URL mentions the shell filename", () => {
    const hostLookalike = "file:///dist/src/index.html?next=plugin-ui-shell.html";
    expect(invoke(ASSISTANT_CHANNEL, hostLookalike, assistantPayload)).toEqual({ ok: true });
    expect(invoke(NATIVE_CHANNEL, hostLookalike, nativePayload)).toEqual({ ok: true });
    expect(popup).toHaveBeenCalledTimes(2);
  });

  it("serves the ordinary host renderer", () => {
    const host = "file:///dist/src/index.html";
    expect(invoke(ASSISTANT_CHANNEL, host, assistantPayload)).toEqual({ ok: true });
    expect(popup).toHaveBeenCalledTimes(1);
  });

  it("refuses a remote origin frame", () => {
    expect(invoke(ASSISTANT_CHANNEL, "https://evil.example.com/", assistantPayload)).toEqual({
      ok: false,
      error: "unauthorized-frame",
    });
    expect(popup).not.toHaveBeenCalled();
  });
});
