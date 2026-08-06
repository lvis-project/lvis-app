/**
 * `lvisApi.onPluginEvent` private-namespace gate — behavioural coverage.
 *
 * The main-side plugin event bridge (`boot/steps/ipc-bridge.ts`) forwards every
 * declared event type verbatim, so this preload gate is the enforcement point
 * for the private-namespace rule on the renderer delivery path. It was
 * previously an open-coded copy of `classifySubscription`'s private branch and
 * had no test at all: refining the classifier left the copy behind silently,
 * and deleting the copy's branch reddened nothing.
 *
 * These assertions run the real preload surface with a mocked `ipcRenderer`,
 * so they red both when the gate stops rejecting and when
 * `classifySubscription` — the single authority the gate now calls — changes
 * what counts as private.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockOn, mockRemoveListener, mockInvoke } = vi.hoisted(() => ({
  mockOn: vi.fn(),
  mockRemoveListener: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: mockInvoke, on: mockOn, removeListener: mockRemoveListener },
}));

if (typeof globalThis.navigator !== "object" || globalThis.navigator === null) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
}
Object.defineProperty(globalThis.navigator, "userActivation", {
  configurable: true,
  value: { isActive: false },
});

import { buildInternalApiSurface } from "../internal-api-surface.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { PLUGIN_PRIVATE_NAMESPACES } from "../../plugins/capabilities.js";

const api = buildInternalApiSurface();

function subscribe(eventType: string): { registered: boolean; unsubscribe: () => void } {
  mockOn.mockClear();
  mockRemoveListener.mockClear();
  const unsubscribe = api.onPluginEvent(eventType, () => undefined);
  return { registered: mockOn.mock.calls.length > 0, unsubscribe };
}

describe("onPluginEvent private-namespace gate", () => {
  beforeEach(() => {
    mockOn.mockClear();
    mockRemoveListener.mockClear();
  });

  it("registers an ipcRenderer listener for a non-private event type", () => {
    const { registered, unsubscribe } = subscribe("weather.updated");
    expect(registered).toBe(true);
    expect(mockOn).toHaveBeenCalledWith(CHANNELS.pluginBridge.event, expect.any(Function));
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
  });

  it("delivers payloads to a non-private subscriber", () => {
    mockOn.mockClear();
    const received: unknown[] = [];
    api.onPluginEvent("weather.updated", (data) => received.push(data));
    const listener = mockOn.mock.calls[0]?.[1] as (
      event: unknown,
      type: string,
      data: unknown,
    ) => void;
    listener({}, "weather.updated", { temp: 3 });
    listener({}, "weather.other", { temp: 9 });
    expect(received).toEqual([{ temp: 3 }]);
  });

  it("rejects every private namespace exactly, with a no-op unsubscribe", () => {
    for (const ns of PLUGIN_PRIVATE_NAMESPACES) {
      const { registered, unsubscribe } = subscribe(ns);
      expect(registered, `subscription to "${ns}" must be rejected`).toBe(false);
      unsubscribe();
      expect(mockRemoveListener).not.toHaveBeenCalled();
    }
  });

  it("rejects dotted children of every private namespace", () => {
    for (const ns of PLUGIN_PRIVATE_NAMESPACES) {
      const child = `${ns}.entry`;
      expect(subscribe(child).registered, `subscription to "${child}" must be rejected`).toBe(false);
    }
    expect(subscribe("audit.log.entry").registered).toBe(false);
    expect(subscribe("memory.private.note").registered).toBe(false);
  });

  it("does not reject a merely prefix-similar public event type", () => {
    // "auditorium" starts with "audit" as a STRING but not as a NAMESPACE.
    expect(subscribe("auditorium.opened").registered).toBe(true);
    expect(subscribe("memory.shared").registered).toBe(true);
  });

  it("never rejects a subscription the authority classifies as non-private", () => {
    for (const eventType of ["host.theme.changed", "meeting.started", "calendar.updated"]) {
      expect(subscribe(eventType).registered, `"${eventType}" must be allowed`).toBe(true);
    }
  });
});
