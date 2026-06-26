/**
 * Production release prep — unit tests for auto-updater / crash-reporter / telemetry.
 *
 * All three modules default OFF and must produce zero side-effects when the
 * user hasn't opted in. These tests lock in that invariant.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";

import type { AuditEntry, AuditLogger } from "../../audit/audit-logger.js";
import { createAutoUpdater, type AutoUpdaterDeps, type UpdaterLike } from "../auto-updater.js";
import { startCrashReporter } from "../crash-reporter.js";
import { TelemetryService } from "../telemetry.js";
import {
  clearAppUpdateInstallRequested,
  isAppUpdateInstallRequested,
} from "../app-update-install-intent.js";
import {
  hasPluginInstallInFlight,
  withPluginInstallLock,
} from "../../plugins/install-lifecycle.js";

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

function fakeAuditLogger() {
  const entries: AuditEntry[] = [];
  return {
    entries,
    logger: {
      log: (entry: AuditEntry) => {
        entries.push(entry);
      },
    } as AuditLogger,
  };
}

function createTestAutoUpdater(
  deps: Omit<AutoUpdaterDeps, "auditLogger"> & { auditLogger?: AuditLogger },
) {
  return createAutoUpdater({
    // Default to the signed / self-installable path plus a no-op guide opener so
    // existing install tests exercise quitAndInstall deterministically (the real
    // codesign probe would otherwise return false on an unsigned CI runner).
    // Tests targeting the unsigned fallback override canSelfInstall/openExternal.
    canSelfInstall: () => true,
    openExternal: () => {},
    ...deps,
    auditLogger: deps.auditLogger ?? fakeAuditLogger().logger,
  });
}

function ipcEvent(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url } } as unknown as IpcMainInvokeEvent;
}

const HOST_RENDERER_URL = "file:///Applications/LVIS.app/Contents/Resources/app.asar/dist/src/index.html";
const PLUGIN_SHELL_URL = "file:///Applications/LVIS.app/Contents/Resources/app.asar/dist/src/plugin-ui-shell.html";

describe("auto-updater", () => {
  beforeEach(() => {
    clearAppUpdateInstallRequested();
  });

  it("does not check when disabled", async () => {
    const { win } = fakeWindow();
    const u = fakeUpdater();
    const svc = createTestAutoUpdater({
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
    const svc = createTestAutoUpdater({
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
    const svc = createTestAutoUpdater({
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
    const svc = createTestAutoUpdater({
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
    const svc = createTestAutoUpdater({
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
    const svc = createTestAutoUpdater({
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
    const svc = createTestAutoUpdater({
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
    const svc = createTestAutoUpdater({
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

  it("installNow reports not-downloaded before plugin install interlock state", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    u.emit("update-available", { version: "3.0.0" });

    let releasePluginInstall!: () => void;
    const pluginInstall = withPluginInstallLock(
      "meeting",
      async () =>
        new Promise<void>((resolve) => {
          releasePluginInstall = resolve;
        }),
    );

    await vi.waitFor(() => expect(releasePluginInstall).toBeTypeOf("function"));
    expect(hasPluginInstallInFlight()).toBe(true);

    const result = await svc._testOnly.installNow();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not-downloaded");
    expect(u.installs).toBe(0);
    expect(isAppUpdateInstallRequested()).toBe(false);

    releasePluginInstall();
    await pluginInstall;
    expect(hasPluginInstallInFlight()).toBe(false);
  });

  it("installNow invokes quitAndInstall when update is downloaded", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    u.emit("update-downloaded", { version: "3.0.0" });
    const result = await svc._testOnly.installNow();
    expect(result.ok).toBe(true);
    expect(u.installs).toBe(1);
    expect(isAppUpdateInstallRequested()).toBe(true);
  });

  it("installNow rejects duplicate install attempts while updater handoff is in progress", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    u.emit("update-downloaded", { version: "3.0.0" });

    const first = await svc._testOnly.installNow();
    const second = await svc._testOnly.installNow();

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: "install-in-progress" });
    expect(u.installs).toBe(1);
    expect(isAppUpdateInstallRequested()).toBe(true);
  });

  it("installNow rejects while a plugin install lifecycle is in progress", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    u.emit("update-downloaded", { version: "3.0.0" });

    let releasePluginInstall!: () => void;
    const pluginInstall = withPluginInstallLock(
      "meeting",
      async () =>
        new Promise<void>((resolve) => {
          releasePluginInstall = resolve;
        }),
    );

    await vi.waitFor(() => expect(releasePluginInstall).toBeTypeOf("function"));
    expect(hasPluginInstallInFlight()).toBe(true);
    const result = await svc._testOnly.installNow();

    expect(result).toEqual({ ok: false, reason: "plugin-install-in-progress" });
    expect(u.installs).toBe(0);
    expect(isAppUpdateInstallRequested()).toBe(false);

    releasePluginInstall();
    await pluginInstall;
    expect(hasPluginInstallInFlight()).toBe(false);
  });

  it("installNow opens the update guide + returns manual-install-required when quitAndInstall throws", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    u.quitAndInstall = () => {
      throw new Error("quit failed");
    };
    const opened: string[] = [];
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
      openExternal: (url) => opened.push(url),
    });
    await svc.triggerCheck();
    u.emit("update-downloaded", { version: "3.0.0" });
    const result = await svc._testOnly.installNow();
    // Reactive safety net: a throwing quitAndInstall must not leave a dead
    // button — it opens the homepage guide and signals manual install.
    expect(result).toEqual({ ok: false, reason: "manual-install-required" });
    expect(opened).toEqual(["https://lvisai.xyz"]);
    expect(isAppUpdateInstallRequested()).toBe(false);
  });

  it("installNow opens the update guide instead of quitAndInstall on an unsigned build", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const opened: string[] = [];
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
      canSelfInstall: () => false,
      openExternal: (url) => opened.push(url),
    });
    await svc.triggerCheck();
    u.emit("update-downloaded", { version: "3.0.0" });
    const result = await svc._testOnly.installNow();
    // Proactive: an unsigned macOS build can't self-install, so quitAndInstall
    // is never attempted — open the guide and tell the renderer.
    expect(result).toEqual({ ok: false, reason: "manual-install-required" });
    expect(u.installs).toBe(0);
    expect(opened).toEqual(["https://lvisai.xyz"]);
    expect(isAppUpdateInstallRequested()).toBe(false);
  });

  it("skipVersion persists the current app update and hides only that exact version", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    let skippedVersion: string | undefined;
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
      getSkippedVersion: () => skippedVersion,
      setSkippedVersion: async (version) => {
        skippedVersion = version;
      },
    });
    await svc.triggerCheck();

    u.emit("update-available", { version: "3.0.0" });
    expect(svc._testOnly.getState()).toEqual({ kind: "available", version: "3.0.0" });

    const result = await svc._testOnly.skipVersion();

    expect(result).toEqual({ ok: true });
    expect(skippedVersion).toBe("3.0.0");
    expect(svc._testOnly.getState()).toEqual({ kind: "idle" });

    u.emit("update-available", { version: "3.0.0" });
    expect(svc._testOnly.getState()).toEqual({ kind: "idle" });
    expect(fw.sent[fw.sent.length - 1]?.payload).toEqual({ kind: "idle" });

    u.emit("update-available", { version: "3.0.1" });
    expect(svc._testOnly.getState()).toEqual({ kind: "available", version: "3.0.1" });
  });

  it("install IPC rejects plugin shell senders and audits the attempt", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const audit = fakeAuditLogger();
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      auditLogger: audit.logger,
      isEnabled: () => true,
      updaterFactory: () => u,
      confirmInstallForTest: async () => true,
    });
    await svc.triggerCheck();
    u.emit("update-downloaded", { version: "3.0.0" });

    const result = await svc._testOnly.ipcInstallNow(ipcEvent(PLUGIN_SHELL_URL));

    expect(result).toEqual({ ok: false, reason: "unauthorized-frame" });
    expect(u.installs).toBe(0);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.input).toContain("lvis:update:install-now");
    expect(audit.entries[0]?.input).toContain("plugin-ui-shell.html");
  });

  it("download IPC rejects missing sender frames before mutating updater state", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const audit = fakeAuditLogger();
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      auditLogger: audit.logger,
      isEnabled: () => true,
      updaterFactory: () => u,
    });
    await svc.triggerCheck();
    u.emit("update-available", { version: "3.0.0" });

    const result = await svc._testOnly.ipcDownloadNow({} as IpcMainInvokeEvent);

    expect(result).toEqual({ ok: false, reason: "unauthorized-frame" });
    expect(u.downloads).toBe(0);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.input).toContain("lvis:update:download-now");
  });

  it("install IPC owns native confirmation and does not install when canceled", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
      confirmInstallForTest: async () => false,
    });
    await svc.triggerCheck();
    u.emit("update-downloaded", { version: "3.0.0" });

    const result = await svc._testOnly.ipcInstallNow(ipcEvent(HOST_RENDERER_URL));

    expect(result).toEqual({ ok: false, reason: "not-confirmed" });
    expect(u.installs).toBe(0);
    expect(isAppUpdateInstallRequested()).toBe(false);
  });

  it("install IPC applies the update only after trusted sender and main confirmation", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    const svc = createTestAutoUpdater({
      mainWindow: fw.win,
      isEnabled: () => true,
      updaterFactory: () => u,
      confirmInstallForTest: async () => true,
    });
    await svc.triggerCheck();
    u.emit("update-downloaded", { version: "3.0.0" });

    const result = await svc._testOnly.ipcInstallNow(ipcEvent(HOST_RENDERER_URL));

    expect(result).toEqual({ ok: true });
    expect(u.installs).toBe(1);
    expect(isAppUpdateInstallRequested()).toBe(true);
  });

  it("reverts to 'available' when downloadUpdate rejects (user can retry)", async () => {
    const fw = fakeWindow();
    const u = fakeUpdater();
    u.downloadUpdate = async () => {
      throw new Error("ENETUNREACH");
    };
    const svc = createTestAutoUpdater({
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
    const svc = createTestAutoUpdater({
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
