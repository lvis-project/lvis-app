/**
 * Unit tests for gated.ts — validateSender, UNAUTHORIZED_FRAME,
 * auditUnauthorized, validatePluginFrame.
 *
 * These primitives were extracted from ipc-bridge.ts; this test file ensures
 * they retain the same semantics in their new home.
 */
import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import type { IpcMainInvokeEvent } from "electron";
import {
  validateSender,
  UNAUTHORIZED_FRAME,
  auditUnauthorized,
  validatePluginFrame,
} from "../gated.js";

function ev(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url } } as unknown as IpcMainInvokeEvent;
}

describe("validateSender", () => {
  it("accepts file:// renderer", () => {
    expect(validateSender(ev("file:///Applications/Lvis.app/dist/index.html"))).toBe(true);
  });

  it("accepts http://localhost (dev server)", () => {
    expect(validateSender(ev("http://localhost:5173/"))).toBe(true);
  });

  it("accepts http://127.0.0.1 (dev server)", () => {
    expect(validateSender(ev("http://127.0.0.1:5173/"))).toBe(true);
  });

  it("rejects attacker host that starts with 'localhost'", () => {
    expect(validateSender(ev("http://localhost.attacker.com/"))).toBe(false);
  });

  it("rejects arbitrary remote origin", () => {
    expect(validateSender(ev("https://evil.example.com/"))).toBe(false);
  });

  it("rejects malformed URL", () => {
    expect(validateSender(ev("not-a-url"))).toBe(false);
  });

  it("treats missing senderFrame as trusted (unit-test ergonomics)", () => {
    expect(validateSender(null)).toBe(true);
    expect(validateSender(undefined)).toBe(true);
    expect(validateSender({} as IpcMainInvokeEvent)).toBe(true);
  });
});

describe("UNAUTHORIZED_FRAME", () => {
  it("has ok=false and error='unauthorized-frame'", () => {
    expect(UNAUTHORIZED_FRAME).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("auditUnauthorized", () => {
  it("calls auditLogger.log with warn type and channel/frameUrl", () => {
    const mockLogger = { log: vi.fn() };
    const event = ev("https://evil.example.com/") as IpcMainInvokeEvent;
    auditUnauthorized(mockLogger as never, "lvis:test:channel", event);
    expect(mockLogger.log).toHaveBeenCalledOnce();
    const call = mockLogger.log.mock.calls[0][0] as Record<string, unknown>;
    expect(call.type).toBe("warn");
    expect(call.sessionId).toBe("ipc-guard");
    const parsed = JSON.parse(call.input as string);
    expect(parsed.channel).toBe("lvis:test:channel");
    expect(parsed.frameUrl).toBe("https://evil.example.com/");
  });

  // Issue #471 — auditUnauthorized is the single shared call site for ~50
  // IPC handlers, so the redact lands everywhere a frame URL is captured.
  it("redacts the user's home directory in file:// frame URLs", () => {
    const mockLogger = { log: vi.fn() };
    const home = os.homedir();
    const event = ev(`file://${home}/Documents/lvis-project/lvis-app/dist/src/plugin-ui-shell.html`) as IpcMainInvokeEvent;
    auditUnauthorized(mockLogger as never, "lvis:test:channel", event);
    const parsed = JSON.parse(
      mockLogger.log.mock.calls[0][0].input as string,
    );
    expect(parsed.frameUrl).toBe("file://<home>/Documents/lvis-project/lvis-app/dist/src/plugin-ui-shell.html");
    expect(parsed.frameUrl).not.toContain(home);
  });
});

describe("validatePluginFrame", () => {
  it("accepts plugin-ui-shell.html", () => {
    expect(validatePluginFrame(ev("file:///plugins/slug/plugin-ui-shell.html"))).toBe(true);
  });

  it("rejects non-shell file URLs", () => {
    expect(validatePluginFrame(ev("file:///plugins/slug/index.html"))).toBe(false);
  });

  it("rejects http:// URLs", () => {
    expect(validatePluginFrame(ev("http://localhost:5173/"))).toBe(false);
  });

  it("treats missing frame as trusted (unit-test ergonomics)", () => {
    expect(validatePluginFrame(null)).toBe(true);
    expect(validatePluginFrame(undefined)).toBe(true);
  });
});

describe("gated() integration — unauthorized path returns UNAUTHORIZED_FRAME", () => {
  it("handler is NOT called when sender is unauthorized", async () => {
    // Simulate what domain files do: check validateSender, return UNAUTHORIZED_FRAME
    const handler = vi.fn(async () => ({ ok: true }));
    const event = ev("https://evil.example.com/") as IpcMainInvokeEvent;

    // Inline pattern (same as domain files use)
    const result = !validateSender(event) ? UNAUTHORIZED_FRAME : await handler(event);

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual(UNAUTHORIZED_FRAME);
  });

  it("handler IS called when sender is authorized", async () => {
    const handler = vi.fn(async () => ({ ok: true, data: "hello" }));
    const event = ev("file:///dist/index.html") as IpcMainInvokeEvent;

    const result = !validateSender(event) ? UNAUTHORIZED_FRAME : await handler(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, data: "hello" });
  });
});
