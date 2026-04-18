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
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    } as unknown as import("electron").BrowserWindow,
  };
}

function fakeUpdater() {
  const listeners: Record<string, Array<(p: unknown) => void>> = {};
  const u = {
    checks: 0,
    on(event: string, cb: (p: unknown) => void) {
      (listeners[event] ??= []).push(cb);
    },
    async checkForUpdates() {
      u.checks += 1;
    },
    quitAndInstall() {},
    emit(e: string, p: unknown) {
      (listeners[e] ?? []).forEach((cb) => cb(p));
    },
  };
  return u as unknown as UpdaterLike & { emit: (e: string, p: unknown) => void; checks: number };
}

describe("auto-updater", () => {
  it("does not check when disabled", async () => {
    const { win } = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: win,
      isEnabled: () => false,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    expect(u.checks).toBe(0);
  });

  it("checks and forwards update-available toast", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    expect(u.checks).toBe(1);
    u.emit("update-available", { version: "1.2.3" });
    expect(fw.sent[0]).toMatchObject({
      channel: "lvis:update:toast",
      payload: { kind: "info" },
    });
    expect((fw.sent[0].payload as { message: string }).message).toContain("1.2.3");
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
      updaterFactory: () => u,
    });
    await expect(svc.triggerCheck()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("emits action toast on update-downloaded with restart payload", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    u.emit("update-downloaded", { version: "9.9.9" });
    const last = fw.sent.at(-1)!;
    expect(last.payload).toMatchObject({ kind: "action", action: "restart-to-update" });
  });
});

describe("crash-reporter", () => {
  it("creates local dump dir and does not upload by default", () => {
    const userData = mkdtempSync(join(tmpdir(), "lvis-crash-"));
    const started: Array<{ uploadToServer?: boolean }> = [];
    const handle = startCrashReporter({
      userDataPath: userData,
      telemetry: { enabled: false, crashReportingEnabled: false },
      crashReporter: { start: (opts) => started.push(opts) },
      sentryLoader: () => null,
    });
    expect(handle.started).toBe(true);
    expect(started[0]?.uploadToServer).toBe(false);
    expect(handle.dumpDir).toMatch(/crash-dumps$/);
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
        crashReportEndpoint: "https://dumps.example.com/submit",
      },
      crashReporter: { start: (opts) => started.push(opts) },
      sentryLoader: () => null,
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
      sentryLoader: () => ({ init: ({ dsn }) => dsnSeen.push(dsn) }),
    });
    expect(handle.sentryActive).toBe(true);
    expect(dsnSeen[0]).toContain("sentry.example");
  });
});

describe("telemetry", () => {
  it("is inactive by default and track() is a no-op", async () => {
    const svc = new TelemetryService({ settings: { enabled: false } });
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
      settings: { enabled: true, endpoint: "https://t.example/ingest" },
      appVersion: "9.9.9",
      fetchImpl,
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
      settings: { enabled: true, endpoint: "" },
      fetchImpl,
    });
    svc.track("app_start");
    await svc.flush();
    expect(calls).toEqual([]);
  });
});
