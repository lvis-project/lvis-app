/**
 * Regression guard: `validateSender()` must URL-parse the frame origin,
 * not substring-match it. The prior `startsWith("http://localhost")` check
 * accepted attacker-controlled hosts such as `http://localhost.attacker.com`
 * (audit finding: CRITICAL).
 */
import { describe, it, expect, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

import { validateSender } from "../ipc-bridge.js";

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

  it("rejects https://localhost.attacker.com", () => {
    expect(validateSender(ev("https://localhost.attacker.com/"))).toBe(false);
  });

  it("rejects https://localhost (non-http scheme not in allowlist)", () => {
    expect(validateSender(ev("https://localhost/"))).toBe(false);
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
