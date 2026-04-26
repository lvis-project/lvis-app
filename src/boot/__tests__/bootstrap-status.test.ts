/**
 * Phase 2d — bootstrap status emit helper.
 *
 * The notifyBootstrapStatus helper is best-effort: a destroyed or
 * disconnected webContents must never throw out of boot, since the
 * managed-plugin bootstrap is supposed to be graceful end-to-end.
 */
import { describe, it, expect, vi } from "vitest";
import { BOOTSTRAP_STATUS_CHANNEL, notifyBootstrapStatus } from "../bootstrap-status.js";

function makeFakeWindow(opts: {
  destroyed?: boolean;
  sendThrows?: boolean;
} = {}): { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean } {
  const send = vi.fn(() => {
    if (opts.sendThrows) throw new Error("webContents disconnected");
  });
  return {
    send,
    isDestroyed: () => opts.destroyed === true,
  };
}

function asWindow(fake: ReturnType<typeof makeFakeWindow>): never {
  // Test fake — the helper only reads `webContents.send` and `isDestroyed`,
  // so we shape it to match without pulling in Electron types.
  return {
    isDestroyed: fake.isDestroyed,
    webContents: { send: fake.send },
  } as unknown as never;
}

describe("notifyBootstrapStatus", () => {
  it("sends start payload over BOOTSTRAP_STATUS_CHANNEL", () => {
    const fake = makeFakeWindow();
    notifyBootstrapStatus(asWindow(fake), { phase: "start" });
    expect(fake.send).toHaveBeenCalledWith(BOOTSTRAP_STATUS_CHANNEL, { phase: "start" });
  });

  it("sends complete payload with installed/failed lists", () => {
    const fake = makeFakeWindow();
    notifyBootstrapStatus(asWindow(fake), {
      phase: "complete",
      installed: ["calendar"],
      failed: [{ id: "meeting", error: "tarball unreachable" }],
    });
    expect(fake.send).toHaveBeenCalledWith(BOOTSTRAP_STATUS_CHANNEL, {
      phase: "complete",
      installed: ["calendar"],
      failed: [{ id: "meeting", error: "tarball unreachable" }],
    });
  });

  it("is a no-op when the window is null", () => {
    expect(() => notifyBootstrapStatus(null, { phase: "start" })).not.toThrow();
  });

  it("is a no-op when the window is destroyed", () => {
    const fake = makeFakeWindow({ destroyed: true });
    notifyBootstrapStatus(asWindow(fake), { phase: "start" });
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("swallows webContents.send errors so boot is never bricked", () => {
    const fake = makeFakeWindow({ sendThrows: true });
    expect(() =>
      notifyBootstrapStatus(asWindow(fake), { phase: "error", message: "catalog fetch failed" }),
    ).not.toThrow();
  });
});
