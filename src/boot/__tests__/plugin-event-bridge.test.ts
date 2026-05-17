/**
 * Issue 1 fix — generic plugin event bridge (manifest.emittedEvents driven).
 *
 * Verifies:
 * - Two plugins with different emittedEvents both get forwarded to webContents.
 * - A private-namespace event is NOT forwarded.
 * - dispose() tears down handlers so no further sends occur.
 *
 * Tests the bridge logic in isolation (no Electron import) by reimplementing
 * the bridge using the real event bus from boot/types.ts.
 */
import { describe, it, expect } from "vitest";
import { emitEvent, onEvent } from "../types.js";
import { classifySubscription } from "../../plugins/capabilities.js";
import { registerPluginEventBridge } from "../steps/ipc-bridge.js";
import type { PluginManifest } from "../../plugins/types.js";

// ─── Stubs ───────────────────────────────────────────────────────────────────

function makeFakeWindow() {
  const sent: Array<{ channel: string; eventType: string; data: unknown }> = [];
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, eventType: string, data: unknown) => {
        sent.push({ channel, eventType, data });
      },
    },
    once: () => undefined,
    _sent: sent,
  };
}

function makeRuntime(manifests: Array<{ id: string; emittedEvents?: string[] }>) {
  return {
    listPluginManifests: () =>
      manifests.map((m) => ({
        pluginId: m.id,
        manifest: {
          id: m.id,
          name: m.id,
          version: "0.0.1",
          entry: "index.js",
          tools: [],
          emittedEvents: m.emittedEvents,
        } satisfies Partial<PluginManifest> as unknown as PluginManifest,
      })),
  };
}

// ─── Bridge logic under test (mirrors real registerPluginEventBridge) ─────────

type FakeWindow = ReturnType<typeof makeFakeWindow>;
type FakeRuntime = ReturnType<typeof makeRuntime>;

function registerBridge(runtime: FakeRuntime, win: FakeWindow): () => void {
  const disposers: Array<() => void> = [];
  const registeredEvents = new Set<string>();

  for (const { manifest } of runtime.listPluginManifests()) {
    for (const eventType of manifest.emittedEvents ?? []) {
      if (registeredEvents.has(eventType)) continue;
      const verdict = classifySubscription(eventType);
      if (verdict === "private") continue;
      registeredEvents.add(eventType);
      const handler = (data: unknown) => {
        if (win.isDestroyed()) return;
        win.webContents.send("lvis:plugin:event", eventType, data);
      };
      const unsub = onEvent(eventType, handler);
      disposers.push(unsub);
    }
  }

  return () => {
    for (const d of disposers) d();
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("plugin event bridge — manifest.emittedEvents", () => {
  it("production bridge does not register undeclared legacy event literals", () => {
    const win = makeFakeWindow();
    const runtime = makeRuntime([]);
    const dispose = registerPluginEventBridge(runtime as unknown as never, win as unknown as never);

    emitEvent("meeting.transcript.updated", { chunk: "hello" });

    expect(win._sent).toHaveLength(0);
    dispose();
  });

  it("forwards public events from two plugins with distinct emittedEvents", () => {
    const win = makeFakeWindow();
    const runtime = makeRuntime([
      { id: "test-a", emittedEvents: ["meeting.transcript.updated"] },
      { id: "test-b", emittedEvents: ["email.action.needed"] },
    ]);
    const dispose = registerBridge(runtime, win);

    emitEvent("meeting.transcript.updated", { chunk: "hello" });
    emitEvent("email.action.needed", { subject: "test" });

    expect(win._sent).toHaveLength(2);
    const eventTypes = win._sent.map((s) => s.eventType);
    expect(eventTypes).toContain("meeting.transcript.updated");
    expect(eventTypes).toContain("email.action.needed");
    for (const s of win._sent) {
      expect(s.channel).toBe("lvis:plugin:event");
    }

    dispose();
  });

  it("does NOT forward private-namespace events", () => {
    const win = makeFakeWindow();
    const runtime = makeRuntime([
      { id: "test-c", emittedEvents: ["audit.log.entry"] },
    ]);
    const dispose = registerBridge(runtime, win);

    emitEvent("audit.log.entry", { secret: true });

    expect(win._sent).toHaveLength(0);

    dispose();
  });

  it("stops forwarding after dispose()", () => {
    const win = makeFakeWindow();
    const runtime = makeRuntime([
      { id: "test-d", emittedEvents: ["meeting.status.changed"] },
    ]);
    const dispose = registerBridge(runtime, win);

    emitEvent("meeting.status.changed", { status: "started" });
    expect(win._sent).toHaveLength(1);

    dispose();
    emitEvent("meeting.status.changed", { status: "stopped" });
    expect(win._sent).toHaveLength(1); // no new sends after dispose
  });

  it("deduplicates when two plugins declare the same emittedEvent", () => {
    const win = makeFakeWindow();
    const runtime = makeRuntime([
      { id: "test-e1", emittedEvents: ["calendar.event.created"] },
      { id: "test-e2", emittedEvents: ["calendar.event.created"] },
    ]);
    const dispose = registerBridge(runtime, win);

    emitEvent("calendar.event.created", { id: "ev1" });

    // Should fire exactly once, not twice
    expect(win._sent).toHaveLength(1);

    dispose();
  });
});
