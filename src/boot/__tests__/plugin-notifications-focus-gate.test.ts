/**
 * registerPluginNotifications — focus gate behavior coverage (#840).
 *
 * Verifies that plugin-declared `notificationEvents` honor the same
 * focused-window suppression policy as NotificationService:
 *   - main window focused & not minimized → notification dropped, audit row written
 *   - main window unfocused                → OS notification fires
 *   - main window minimized                → OS notification fires
 *
 * `Notification.isSupported()` is mocked to true; `new Notification(...)` is
 * captured as a constructor spy so we can assert whether it was instantiated.
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

function makeRuntime(events: Array<{ event: string }>, pluginId = "test-plugin") {
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

describe("registerPluginNotifications — focus gate", () => {
  beforeEach(() => {
    notificationCtor.mockReset();
    notificationCtor.mockImplementation(function (this: NotificationStubInstance) {
      this.on = vi.fn();
      this.show = vi.fn();
    });
  });

  it("focused + not minimized → OS notification suppressed, audit row written with pluginId", () => {
    const win = makeMockWindow({ focused: true, minimized: false });
    const audit = makeAuditLogger();
    const runtime = makeRuntime([{ event: "test.fired" }], "agent-hub");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = registerPluginNotifications(runtime as any, win, audit);

    emitEvent("test.fired", { foo: "bar" });

    expect(notificationCtor).not.toHaveBeenCalled();
    expect(audit.calls.length).toBe(1);
    const input = JSON.parse(audit.calls[0].input as string) as Record<string, unknown>;
    expect(input.event).toBe("notification.suppressed");
    expect(input.kind).toBe("plugin");
    expect(input.reason).toBe("window-focused");
    expect(input.pluginId).toBe("agent-hub");
    expect(input.pluginEvent).toBe("test.fired");
    dispose();
  });

  it("unfocused → OS notification fires (focus-suppress only triggers when focused)", () => {
    const win = makeMockWindow({ focused: false, minimized: false });
    const audit = makeAuditLogger();
    const runtime = makeRuntime([{ event: "test.fired" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = registerPluginNotifications(runtime as any, win, audit);

    emitEvent("test.fired", {});

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(audit.calls.length).toBe(0);
    dispose();
  });

  it("minimized → OS notification fires (matches NotificationService policy)", () => {
    const win = makeMockWindow({ focused: false, minimized: true });
    const audit = makeAuditLogger();
    const runtime = makeRuntime([{ event: "test.fired" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = registerPluginNotifications(runtime as any, win, audit);

    emitEvent("test.fired", {});

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(audit.calls.length).toBe(0);
    dispose();
  });

  it("audit logger absent → focused-suppression still drops the notification (no throw)", () => {
    const win = makeMockWindow({ focused: true, minimized: false });
    const runtime = makeRuntime([{ event: "test.fired" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = registerPluginNotifications(runtime as any, win);

    expect(() => emitEvent("test.fired", {})).not.toThrow();
    expect(notificationCtor).not.toHaveBeenCalled();
    dispose();
  });
});
