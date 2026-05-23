/**
 * broadcast-helpers tests — fan-out semantics on top of safe-send.
 *
 * Covers:
 *   - delivers the payload to every live window and returns the count.
 *   - skips null / destroyed windows (delegated to safe-send) without
 *     throwing.
 *   - one window's send race is swallowed, logged via the SafeSendLogger,
 *     and never blocks the others (per-window error path).
 *   - emits a single `info` audit row recording channel + delivered count
 *     when an auditLogger is supplied.
 *   - audit-logger throw never breaks the broadcast.
 */
import { describe, expect, it, vi } from "vitest";
import { fanOutToAllWindows } from "../broadcast-helpers.js";

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void };
}

function liveWindow(): FakeWindow {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

describe("fanOutToAllWindows", () => {
  it("delivers the payload to every live window and returns the count", () => {
    const w1 = liveWindow();
    const w2 = liveWindow();

    const delivered = fanOutToAllWindows([w1, w2] as never, "lvis:test", { x: 1 });

    expect(delivered).toBe(2);
    expect(w1.webContents.send).toHaveBeenCalledWith("lvis:test", { x: 1 });
    expect(w2.webContents.send).toHaveBeenCalledWith("lvis:test", { x: 1 });
  });

  it("skips null and destroyed windows without throwing", () => {
    const live = liveWindow();
    const destroyed: FakeWindow = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => true, send: vi.fn() },
    };

    const delivered = fanOutToAllWindows(
      [null, undefined, destroyed, live] as never,
      "lvis:test",
      undefined,
    );

    expect(delivered).toBe(1);
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
    expect(live.webContents.send).toHaveBeenCalledWith("lvis:test", undefined);
  });

  it("swallows a per-window send race, logs it, and keeps fanning out", () => {
    const logger = { warn: vi.fn() };
    const failing: FakeWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: () => {
          throw new TypeError("Object has been destroyed");
        },
      },
    };
    const ok = liveWindow();

    const delivered = fanOutToAllWindows([failing, ok] as never, "lvis:test", { x: 1 }, { logger });

    expect(delivered).toBe(1);
    expect(ok.webContents.send).toHaveBeenCalledWith("lvis:test", { x: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      { channel: "lvis:test", error: "Object has been destroyed" },
      "renderer IPC send skipped",
    );
  });

  it("emits one info audit row with channel + delivered count", () => {
    const auditLogger = { log: vi.fn() };
    const w1 = liveWindow();
    const w2 = liveWindow();

    fanOutToAllWindows([w1, w2] as never, "lvis:auth:logout-reset", undefined, {
      auditLogger,
    });

    expect(auditLogger.log).toHaveBeenCalledTimes(1);
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        sessionId: "ipc",
        input: "[broadcast] channel=lvis:auth:logout-reset delivered=2/2",
      }),
    );
  });

  it("uses the supplied auditSessionId", () => {
    const auditLogger = { log: vi.fn() };

    fanOutToAllWindows([liveWindow()] as never, "lvis:test", undefined, {
      auditLogger,
      auditSessionId: "auth",
    });

    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "auth" }),
    );
  });

  it("does not break the broadcast when the audit logger throws", () => {
    const auditLogger = {
      log: () => {
        throw new Error("audit sink down");
      },
    };
    const w1 = liveWindow();

    const delivered = fanOutToAllWindows([w1] as never, "lvis:test", { x: 1 }, { auditLogger });

    expect(delivered).toBe(1);
    expect(w1.webContents.send).toHaveBeenCalledWith("lvis:test", { x: 1 });
  });

  it("does not emit an audit row when no auditLogger is supplied", () => {
    // Smoke check that the demo.ts path (logger-less, audit-less) is a no-op
    // beyond the sends themselves.
    const w1 = liveWindow();
    const delivered = fanOutToAllWindows([w1] as never, "lvis:test", undefined);
    expect(delivered).toBe(1);
  });
});
