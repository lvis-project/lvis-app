/**
 * registerPluginNotifications — host-routed notification coverage
 * (#840 → #841 + #842 + #843).
 *
 * As of #841 plugin notifications no longer construct `new Notification(...)`
 * directly; they route through {@link NotificationService.fire} with
 * `kind: "plugin"`. This test suite verifies:
 *   - the emit path routes through `notificationService.fire`
 *   - `bypassFocusGate` in the manifest forwards as `FireOptions.bypassFocusGate`
 *     so critical notifications can opt out of focus suppression (#843)
 *   - destroyed-main-window short-circuit audits a `window-destroyed`
 *     suppression row so field telemetry can attribute emit-during-shutdown
 *
 * `Notification.isSupported()` is mocked to true; the constructor is also
 * stubbed so any accidental direct `new Notification` instantiation would
 * be caught — we now expect ZERO such instantiations from the plugin path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above all imports, so the ctor spy must be created via
// vi.hoisted (also hoisted) so the mock factory can capture the same reference
// the tests later assert against.
const { notificationCtor } = vi.hoisted(() => ({ notificationCtor: vi.fn() }));
vi.mock("electron", () => ({
  Notification: Object.assign(notificationCtor, {
    isSupported: () => true,
  }),
}));

import { registerPluginNotifications } from "../plugins.js";
import { emitEvent } from "../types.js";
import type { PluginManifest } from "../../plugins/types.js";
import type { BrowserWindow } from "electron";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { NotificationService, FireOptions } from "../../main/notification-service.js";

interface NotificationStubInstance {
  on: (event: string, handler: () => void) => void;
  show: () => void;
}

function makeMockWindow(opts: { focused?: boolean; minimized?: boolean; destroyed?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    isFocused: vi.fn(() => opts.focused ?? false),
    isMinimized: vi.fn(() => opts.minimized ?? false),
    show: vi.fn(),
    focus: vi.fn(),
  } as unknown as BrowserWindow;
}

function makeRuntime(
  events: Array<{ event: string; titleField?: string; bodyField?: string; bypassFocusGate?: boolean }>,
  pluginId = "test-plugin",
) {
  return {
    listPluginManifests: () => [{
      pluginId,
      manifest: {
        id: pluginId,
        name: pluginId,
        version: "0.0.1",
        entry: "index.js",
        tools: [],
        notificationEvents: events,
      } as unknown as PluginManifest,
    }],
    listPluginIds: () => [pluginId],
  };
}

function makeAuditLogger(): Pick<AuditLogger, "log"> & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    log: (entry: unknown) => { calls.push(entry as Record<string, unknown>); },
    calls,
  };
}

function makeNotificationServiceStub(): NotificationService & { calls: FireOptions[] } {
  const calls: FireOptions[] = [];
  const svc = {
    fire: (opts: FireOptions) => { calls.push(opts); },
    calls,
  };
  return svc as unknown as NotificationService & { calls: FireOptions[] };
}

describe("registerPluginNotifications — routed via NotificationService", () => {
  beforeEach(() => {
    notificationCtor.mockReset();
    notificationCtor.mockImplementation(function (this: NotificationStubInstance) {
      this.on = vi.fn();
      this.show = vi.fn();
    });
  });

  it("routes plugin emit through notificationService.fire with kind=plugin (no direct new Notification)", () => {
    const win = makeMockWindow({ focused: false, minimized: false });
    const audit = makeAuditLogger();
    const ns = makeNotificationServiceStub();
    const runtime = makeRuntime(
      [{ event: "test.fired", titleField: "title", bodyField: "body" }],
      "agent-hub",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = registerPluginNotifications(runtime as any, win, ns, audit);

    emitEvent("test.fired", { title: "hello", body: "world" });

    expect(notificationCtor).not.toHaveBeenCalled();
    expect(ns.calls.length).toBe(1);
    expect(ns.calls[0].kind).toBe("plugin");
    expect(ns.calls[0].title).toBe("hello");
    expect(ns.calls[0].body).toBe("world");
    expect(ns.calls[0].bypassFocusGate).toBe(false);
    expect(audit.calls.length).toBe(0); // routing path doesn't audit; NS handles audit
    dispose();
  });

  it("falls back to event name when titleField resolves to empty string", () => {
    const win = makeMockWindow({ focused: false });
    const ns = makeNotificationServiceStub();
    const runtime = makeRuntime([{ event: "meeting.starting-soon", titleField: "missing.path" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = registerPluginNotifications(runtime as any, win, ns);

    emitEvent("meeting.starting-soon", { other: "field" });

    expect(ns.calls.length).toBe(1);
    expect(ns.calls[0].title).toBe("meeting.starting-soon");
    dispose();
  });

  it("forwards bypassFocusGate=true from manifest to FireOptions.bypassFocusGate (#843)", () => {
    const win = makeMockWindow({ focused: true });
    const ns = makeNotificationServiceStub();
    const runtime = makeRuntime([{
      event: "meeting.starting-soon",
      titleField: "title",
      bypassFocusGate: true,
    }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = registerPluginNotifications(runtime as any, win, ns);

    emitEvent("meeting.starting-soon", { title: "In 5 minutes" });

    expect(ns.calls.length).toBe(1);
    expect(ns.calls[0].bypassFocusGate).toBe(true);
    dispose();
  });

  it("manifest with non-boolean bypassFocusGate is skipped (validation guard)", () => {
    const win = makeMockWindow({ focused: false });
    const ns = makeNotificationServiceStub();
    const runtime = makeRuntime([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { event: "bad.spec", bypassFocusGate: "yes" as any },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = registerPluginNotifications(runtime as any, win, ns);

    emitEvent("bad.spec", {});

    expect(ns.calls.length).toBe(0);
    dispose();
  });

  it("destroyed main window → audits 'window-destroyed' suppression + skips fire", () => {
    const win = makeMockWindow({ destroyed: true });
    const audit = makeAuditLogger();
    const ns = makeNotificationServiceStub();
    const runtime = makeRuntime([{ event: "test.fired" }], "work-assistant");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = registerPluginNotifications(runtime as any, win, ns, audit);

    emitEvent("test.fired", {});

    expect(ns.calls.length).toBe(0);
    expect(audit.calls.length).toBe(1);
    const input = JSON.parse(audit.calls[0].input as string) as Record<string, unknown>;
    expect(input.event).toBe("notification.suppressed");
    expect(input.reason).toBe("window-destroyed");
    expect(input.pluginId).toBe("work-assistant");
    expect(input.pluginEvent).toBe("test.fired");
    dispose();
  });

  it("audit logger absent → destroyed-window suppression still no-throws", () => {
    const win = makeMockWindow({ destroyed: true });
    const ns = makeNotificationServiceStub();
    const runtime = makeRuntime([{ event: "test.fired" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = registerPluginNotifications(runtime as any, win, ns);

    expect(() => emitEvent("test.fired", {})).not.toThrow();
    expect(ns.calls.length).toBe(0);
    dispose();
  });
});
