/**
 * Production release prep — unit tests for auto-updater / crash-reporter / telemetry.
 *
 * All three modules default OFF and must produce zero side-effects when the
 * user hasn't opted in. These tests lock in that invariant.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAutoUpdater, type UpdaterLike } from "../auto-updater.js";
import { startCrashReporter } from "../crash-reporter.js";
import { TelemetryService } from "../telemetry.js";

function fakeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    win: {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
    } as unknown as import("electron").BrowserWindow
  };
}

function fakeUpdater() {
  const listeners: Record<string, Array<(p: unknown) => void>> = {};
  const u = {
    checks: 0,
    downloads: 0,
    installs: 0,
    autoDownload: undefined as boolean | undefined,
    on(event: string, cb: (p: unknown) => void) {
      (listeners[event] ??= []).push(cb);
    },
    async checkForUpdates() {
      u.checks += 1;
    },
    async downloadUpdate() {
      u.downloads += 1;
    },
    quitAndInstall() {
      u.installs += 1;
    },
    emit(e: string, p: unknown) {
      (listeners[e] ?? []).forEach((cb) => cb(p));
    }
  };
  return u as unknown as UpdaterLike & {
    emit: (e: string, p: unknown) => void;
    checks: number;
    downloads: number;
    installs: number;
    autoDownload?: boolean;
  };
}

describe("auto-updater", () => {
  it("does not check when disabled", async () => {
    const { win } = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: win,
      isEnabled: () => false,
      updaterFactory: () => u
    });
    await svc.triggerCheck();
    expect(u.checks).toBe(0);
  });

  it("checks and broadcasts available state without downloading", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u
    });
    await svc.triggerCheck();
    expect(u.checks).toBe(1);
    // User-gated download contract: detection must NOT auto-download.
    expect(u.autoDownload).toBe(false);
    expect(u.downloads).toBe(0);
    u.emit("update-available", { version: "1.2.3" });
    expect(fw.sent[0]).toMatchObject({
      channel: "lvis:update:state",
      payload: { kind: "available", version: "1.2.3" }
    });
    // Still no implicit download after the available event.
    expect(u.downloads).toBe(0);
  });

  it("swallows network errors silently", async () => {
    const fw = fakeWindow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const u = fakeUpdater();
    u.checkForUpdates = async () => {
      throw new Error("ENOTFOUND");
    };
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u
    });
    await expect(svc.triggerCheck()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("start() is idempotent and does not stack timers", () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => false, // disabled so initial triggerCheck is a no-op
      updaterFactory: () => u
    });
    svc.start();
    svc.start();
    svc.start();
    svc.stop();
    // If start() stacked timers, stop() would leave dangling intervals — but we
    // primarily assert no throw and no extra checks are made when disabled.
    expect(u.checks).toBe(0);
  });

  it("emits downloaded state on update-downloaded with version", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u
    });
    await svc.triggerCheck();
    u.emit("update-downloaded", { version: "9.9.9" });
    const last = fw.sent[fw.sent.length - 1]!;
    expect(last).toMatchObject({
      channel: "lvis:update:state",
      payload: { kind: "downloaded", version: "9.9.9" }
    });
  });

  it("translates download-progress events into downloading state with percent", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u
    });
    await svc.triggerCheck();
    u.emit("update-available", { version: "2.0.0" });
    u.emit("download-progress", { percent: 42.7, transferred: 100, total: 1000 });
    const progress = fw.sent[fw.sent.length - 1]!;
    expect(progress).toMatchObject({
      channel: "lvis:update:state",
      payload: { kind: "downloading", version: "2.0.0", percent: 43 }
    });
  });

  // ── Negative-path coverage for the three MAJOR review findings ────────
  it("downloadNow rejects when current state is not 'available'", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    // No update-available emitted yet — state is still { kind: "idle" }.
    const result = await svc._testOnly.downloadNow();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not-available");
    expect(u.downloads).toBe(0);
  });

  it("installNow rejects when current state is not 'downloaded'", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    u.emit("update-available", { version: "3.0.0" });
    // Still in "available" — install must reject (download not finished).
    const result = await svc._testOnly.installNow();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not-downloaded");
    expect(u.installs).toBe(0);
  });

  it("reverts to 'available' when downloadUpdate rejects (user can retry)", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    u.downloadUpdate = async () => {
      throw new Error("ENETUNREACH");
    };
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    u.emit("update-available", { version: "4.0.0" });
    const result = await svc._testOnly.downloadNow();
    expect(result.ok).toBe(false);
    // Final state should be back to "available" so the badge invites a retry,
    // not stuck spinning on a "downloading" pill with no progress events.
    const last = fw.sent[fw.sent.length - 1]!;
    expect(last.payload).toMatchObject({ kind: "available", version: "4.0.0" });
  });

  it("drops download-progress events when state is neither 'downloading' nor 'available'", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    // State is still idle — a stray progress event (delta probe, blockmap
    // fetch) MUST NOT promote the badge to "downloading" with version=""
    // because the tooltip would render "v 다운로드 중 — N%" (broken).
    const before = fw.sent.length;
    u.emit("download-progress", { percent: 10, transferred: 1, total: 10 });
    expect(fw.sent.length).toBe(before);
  });
});

describe("crash-reporter", () => {
  it("creates local dump dir and does not upload by default", () => {
    const userData = mkdtempSync(join(tmpdir(), "lvis-crash-"));
    const started: Array<{ uploadToServer?: boolean }> = [];
    const pathsSet: string[] = [];
    const handle = startCrashReporter({
      userDataPath: userData,
      telemetry: { enabled: false, crashReportingEnabled: false },
      crashReporter: { start: (opts) => started.push(opts) },
      setCrashDumpsPath: (p) => pathsSet.push(p),
      sentryLoader: () => null
    });
    expect(handle.started).toBe(true);
    expect(started[0]?.uploadToServer).toBe(false);
    expect(handle.dumpDir).toMatch(/crash-dumps$/);
    // dumpDir derives from userDataPath (not homedir) for predictable sandboxing.
    expect(handle.dumpDir.startsWith(userData)).toBe(true);
    // And Electron's crashDumps path is overridden BEFORE reporter.start().
    expect(pathsSet).toEqual([handle.dumpDir]);
    expect(handle.sentryActive).toBe(false);
  });

  it("enables upload when user opts in", () => {
    const userData = mkdtempSync(join(tmpdir(), "lvis-crash-"));
    const started: Array<{ uploadToServer?: boolean; submitURL?: string }> = [];
    startCrashReporter({
      userDataPath: userData,
      telemetry: {
        enabled: false,
        crashReportingEnabled: true,
        crashReportEndpoint: "https://dumps.example.com/submit"
      },
      crashReporter: { start: (opts) => started.push(opts) },
      sentryLoader: () => null
    });
    expect(started[0]?.uploadToServer).toBe(true);
    expect(started[0]?.submitURL).toBe("https://dumps.example.com/submit");
  });

  it("inits sentry only when DSN configured and loader returns module", () => {
    const userData = mkdtempSync(join(tmpdir(), "lvis-crash-"));
    const dsnSeen: string[] = [];
    const handle = startCrashReporter({
      userDataPath: userData,
      telemetry: { enabled: false, sentryDsn: "https://k@sentry.example/1" },
      crashReporter: { start: () => {} },
      sentryLoader: () => ({ init: ({ dsn }) => dsnSeen.push(dsn) })
    });
    expect(handle.sentryActive).toBe(true);
    expect(dsnSeen[0]).toContain("sentry.example");
  });
});

describe("telemetry", () => {
  it("is inactive by default and track() is a no-op", async () => {
    const svc = new TelemetryService({ settings: () => ({ enabled: false }) });
    expect(svc.isActive()).toBe(false);
    svc.track("app_start");
    await svc.flush();
  });

  it("buffers events and posts v:1 shape when enabled", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const svc = new TelemetryService({
      settings: () => ({ enabled: true, endpoint: "https://t.example/ingest" }),
      appVersion: "9.9.9",
      fetchImpl,
      allowlistEnv: "t.example"
    });
    svc.track("app_start");
    svc.track("chat_turn", { durMs: 1234 });
    await svc.flush();

    expect(calls).toHaveLength(1);
    const body = calls[0].body as {
      events: Array<{ v: number; name: string; sid: string; appVersion: string }>;
    };
    expect(body.events).toHaveLength(2);
    expect(body.events[0].v).toBe(1);
    expect(body.events[0].name).toBe("app_start");
    // sid must be a 16-hex hash — no UUID / PII leakage.
    expect(body.events[0].sid).toMatch(/^[a-f0-9]{16}$/);
    expect(body.events[1].name).toBe("chat_turn");
  });

  it("does not flush when endpoint is empty", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    const svc = new TelemetryService({
      settings: () => ({ enabled: true, endpoint: "" }),
      fetchImpl
    });
    svc.track("app_start");
    await svc.flush();
    expect(calls).toEqual([]);
  });

  it("re-queues batch on non-ok HTTP instead of losing events", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      return { ok: false, status: 500 } as Response;
    }) as unknown as typeof fetch;
    const svc = new TelemetryService({
      settings: () => ({ enabled: true, endpoint: "https://t.example/ingest" }),
      fetchImpl,
      allowlistEnv: "t.example"
    });
    svc.track("app_start");
    await svc.flush();
    // Queue preserved — next flush retries the same event.
    await svc.flush();
    expect(attempts).toBe(2);
  });

  it("honors live settings accessor (opt-out mid-session)", () => {
    let enabled = true;
    const svc = new TelemetryService({
      settings: () => ({ enabled, endpoint: "https://t.example/ingest" }),
      allowlistEnv: "t.example"
    });
    expect(svc.isActive()).toBe(true);
    enabled = false;
    expect(svc.isActive()).toBe(false);
  });
});
