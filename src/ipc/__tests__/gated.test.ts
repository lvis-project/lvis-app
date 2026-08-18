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
  validateHostRendererSender,
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

  // Electron nulls `senderFrame` once the sending frame is destroyed or
  // navigated away between `invoke` and handler execution, so an absent frame
  // is an unprovable sender — not a trusted one.
  it("refuses a missing senderFrame", () => {
    expect(validateSender(null)).toBe(false);
    expect(validateSender(undefined)).toBe(false);
    expect(validateSender({} as IpcMainInvokeEvent)).toBe(false);
    expect(validateSender({ senderFrame: null } as unknown as IpcMainInvokeEvent)).toBe(false);
  });

  it("refuses a present frame with an empty url", () => {
    expect(validateSender(ev(""))).toBe(false);
  });
});

describe("validateHostRendererSender", () => {
  it("accepts the host file renderer", () => {
    expect(validateHostRendererSender(ev("file:///Applications/Lvis.app/dist/index.html"))).toBe(true);
  });

  it("accepts dev server host renderer URLs", () => {
    expect(validateHostRendererSender(ev("http://localhost:5173/"))).toBe(true);
    expect(validateHostRendererSender(ev("http://127.0.0.1:5173/"))).toBe(true);
  });

  it("rejects plugin UI shell file frames", () => {
    expect(validateHostRendererSender(ev("file:///dist/src/plugin-ui-shell.html"))).toBe(false);
  });

  it("rejects arbitrary remote origins", () => {
    expect(validateHostRendererSender(ev("https://evil.example.com/"))).toBe(false);
  });

  it("rejects missing senderFrame for state-mutating host channels", () => {
    expect(validateHostRendererSender(null)).toBe(false);
    expect(validateHostRendererSender(undefined)).toBe(false);
    expect(validateHostRendererSender({} as IpcMainInvokeEvent)).toBe(false);
  });
});

// The shell predicate is one authority shared with `validatePluginFrame` and
// `shouldBlockGlobalWebviewNavigation`. These rows pin the exact shape the
// three guards agree on, so a looser spelling in any of them is a red test.
describe("plugin-shell frame predicate — agreement across guards", () => {
  const HOST_LOOKALIKE = "file:///dist/src/index.html?next=plugin-ui-shell.html";
  const REMOTE_LOOKALIKE = "https://evil.example.com/plugin-ui-shell.html";
  const SHELL = "file:///dist/src/plugin-ui-shell.html";
  const SHELL_MIXED_CASE = "file:///dist/src/Plugin-UI-Shell.HTML";
  const SHELL_SUFFIX_LOOKALIKE = "file:///dist/src/evil-plugin-ui-shell.html";

  it("treats a host file frame that merely mentions the shell name as the HOST renderer", () => {
    expect(validateHostRendererSender(ev(HOST_LOOKALIKE))).toBe(true);
    expect(validatePluginFrame(ev(HOST_LOOKALIKE))).toBe(false);
  });

  it("treats a remote page serving the shell filename as neither host nor plugin", () => {
    expect(validateHostRendererSender(ev(REMOTE_LOOKALIKE))).toBe(false);
    expect(validatePluginFrame(ev(REMOTE_LOOKALIKE))).toBe(false);
  });

  it("matches the real shell document, case-folded, on a /-anchored path segment", () => {
    expect(validatePluginFrame(ev(SHELL))).toBe(true);
    expect(validatePluginFrame(ev(SHELL_MIXED_CASE))).toBe(true);
    expect(validateHostRendererSender(ev(SHELL))).toBe(false);
    expect(validateHostRendererSender(ev(SHELL_MIXED_CASE))).toBe(false);
  });

  it("does not accept a filename that merely ENDS with the shell name", () => {
    expect(validatePluginFrame(ev(SHELL_SUFFIX_LOOKALIKE))).toBe(false);
    expect(validateHostRendererSender(ev(SHELL_SUFFIX_LOOKALIKE))).toBe(true);
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

  it("refuses a missing frame", () => {
    expect(validatePluginFrame(null)).toBe(false);
    expect(validatePluginFrame(undefined)).toBe(false);
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
