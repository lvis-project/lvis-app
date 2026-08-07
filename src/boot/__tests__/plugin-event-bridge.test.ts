/**
 * Generic plugin event bridge (manifest.emittedEvents driven).
 *
 * Every assertion here drives the ONE production bridge,
 * `registerPluginEventBridge` from `boot/steps/ipc-bridge.ts`. This file used
 * to carry a local re-implementation ("mirrors real registerPluginEventBridge")
 * that three of the tests called instead; the mirror had the
 * private-namespace skip and production did not, so the
 * "does NOT forward private-namespace events" assertion could not fail no
 * matter what production did. Do not reintroduce a local bridge here.
 *
 * Verifies:
 * - Two plugins with different emittedEvents both get forwarded to webContents.
 * - A private-namespace event is NOT forwarded (declared or host-derived).
 * - dispose() tears down handlers so no further sends occur.
 * - The manifest shape those fake runtimes feed the bridge is the shape the
 *   REAL PluginRuntime produces — pinned by the producer-driven suite at the
 *   bottom, which loads a plugin from disk and bridges its real manifest.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { emitEvent } from "../types.js";
import { registerPluginEventBridge } from "../steps/ipc-bridge.js";
import type { PluginManifest } from "../../plugins/types.js";
import {
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  makeTestPluginEntrySource,
  type TestPluginRuntimeFixture,
} from "../../plugins/__tests__/test-helpers.js";

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

function makeRuntime(
  manifests: Array<{ id: string; emittedEvents?: string[]; auth?: PluginManifest["auth"] }>,
) {
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
          ...(m.auth !== undefined ? { auth: m.auth } : {}),
        } satisfies Partial<PluginManifest> as unknown as PluginManifest,
      })),
  };
}

function bridge(runtime: ReturnType<typeof makeRuntime>, win: ReturnType<typeof makeFakeWindow>) {
  return registerPluginEventBridge(runtime as unknown as never, win as unknown as never);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("plugin event bridge — manifest.emittedEvents", () => {
  it("production bridge does not register undeclared legacy event literals", () => {
    const win = makeFakeWindow();
    const dispose = bridge(makeRuntime([]), win);

    emitEvent("meeting.transcript.updated", { chunk: "hello" });

    expect(win._sent).toHaveLength(0);
    dispose();
  });

  it("forwards public events from two plugins with distinct emittedEvents", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([
        { id: "test-a", emittedEvents: ["meeting.status.changed"] },
        { id: "test-b", emittedEvents: ["email.action.needed"] },
      ]),
      win,
    );

    emitEvent("meeting.status.changed", { status: "started" });
    emitEvent("email.action.needed", { subject: "test" });

    expect(win._sent).toHaveLength(2);
    const eventTypes = win._sent.map((s) => s.eventType);
    expect(eventTypes).toContain("meeting.status.changed");
    expect(eventTypes).toContain("email.action.needed");
    for (const s of win._sent) {
      expect(s.channel).toBe("lvis:plugin:event");
    }

    dispose();
  });

  it("does NOT forward private-namespace events", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([
        { id: "test-c", emittedEvents: ["audit.log.entry", "meeting.status.changed"] },
      ]),
      win,
    );

    emitEvent("audit.log.entry", { secret: true });
    // The public sibling from the SAME manifest still bridges — proves the
    // skip is namespace-scoped, not "this manifest was dropped entirely".
    emitEvent("meeting.status.changed", { status: "started" });

    expect(win._sent.map((s) => s.eventType)).toEqual(["meeting.status.changed"]);

    dispose();
  });

  it("does NOT forward the host-derived <id>.auth.changed for a private-namespace id", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([{ id: "dlp", auth: { statusTool: "x_status", loginTool: "x_login" } }]),
      win,
    );

    emitEvent("dlp.auth.changed", { authenticated: true });

    expect(win._sent).toHaveLength(0);

    dispose();
  });

  it("stops forwarding after dispose()", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([{ id: "test-d", emittedEvents: ["meeting.status.changed"] }]),
      win,
    );

    emitEvent("meeting.status.changed", { status: "started" });
    expect(win._sent).toHaveLength(1);

    dispose();
    emitEvent("meeting.status.changed", { status: "stopped" });
    expect(win._sent).toHaveLength(1); // no new sends after dispose
  });

  it("deduplicates when two plugins declare the same emittedEvent", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([
        { id: "test-e1", emittedEvents: ["calendar.event.created"] },
        { id: "test-e2", emittedEvents: ["calendar.event.created"] },
      ]),
      win,
    );

    emitEvent("calendar.event.created", { id: "ev1" });

    // Should fire exactly once, not twice
    expect(win._sent).toHaveLength(1);

    dispose();
  });
});

// ─── R3 — host-derived <id>.auth.changed (exercises the REAL bridge) ──────────

describe("plugin event bridge — host-derived <id>.auth.changed (R3)", () => {
  const AUTH: PluginManifest["auth"] = { statusTool: "x_status", loginTool: "x_login" };

  it("bridges ${id}.auth.changed when auth is declared but emittedEvents omits it", () => {
    const win = makeFakeWindow();
    const dispose = bridge(makeRuntime([{ id: "ms-graph", auth: AUTH }]), win); // no emittedEvents[]

    emitEvent("ms-graph.auth.changed", { authenticated: true });

    expect(win._sent).toHaveLength(1);
    expect(win._sent[0].eventType).toBe("ms-graph.auth.changed");
    expect(win._sent[0].channel).toBe("lvis:plugin:event");

    dispose();
  });

  it("preserves the LITERAL dashed manifest id (no `_`<->`-` normalization)", () => {
    const win = makeFakeWindow();
    const dispose = bridge(makeRuntime([{ id: "foo-bar", auth: AUTH }]), win);

    // The dash form is bridged...
    emitEvent("foo-bar.auth.changed", { authenticated: false });
    // ...the underscore-mirrored form is NOT (that would be the #131 regression).
    emitEvent("foo_bar.auth.changed", { authenticated: false });

    expect(win._sent).toHaveLength(1);
    expect(win._sent[0].eventType).toBe("foo-bar.auth.changed");

    dispose();
  });

  it("dedupes when the author ALSO lists ${id}.auth.changed in emittedEvents (registers once)", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([{ id: "ep-api", auth: AUTH, emittedEvents: ["ep-api.auth.changed"] }]),
      win,
    );

    emitEvent("ep-api.auth.changed", { authenticated: true });

    // Exactly one forward — the derived name deduped against the declared one.
    expect(win._sent).toHaveLength(1);
    expect(win._sent[0].eventType).toBe("ep-api.auth.changed");

    dispose();
  });

  it("does NOT derive auth.changed for a plugin without an auth block", () => {
    const win = makeFakeWindow();
    const dispose = bridge(makeRuntime([{ id: "plain-plugin" }]), win); // no auth, no emittedEvents

    emitEvent("plain-plugin.auth.changed", { authenticated: true });

    expect(win._sent).toHaveLength(0);

    dispose();
  });
});

// ─── Producer-driven — a REAL PluginRuntime feeds the REAL bridge ─────────────
//
// The suites above hand-build the `listPluginManifests()` rows. This one does
// not: it installs a plugin on disk, starts a real `PluginRuntime`, and passes
// that runtime straight into `registerPluginEventBridge`. It is the evidence
// that a private-namespace `emittedEvents` entry actually SURVIVES manifest
// validation and reaches the bridge — i.e. that the skip is reachable and not
// a guard against a manifest shape no producer can make.

describe("plugin event bridge — real PluginRuntime producer", () => {
  let fixture: TestPluginRuntimeFixture | undefined;

  afterEach(async () => {
    if (fixture) await rm(fixture.rootDir, { recursive: true, force: true });
    fixture = undefined;
  });

  it("bridges the public emittedEvent and drops the private one from a disk-loaded manifest", async () => {
    fixture = await makeTestPluginRuntimeFixture({ prefix: "lvis-bridge-producer-" });
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "producer-plugin",
      tools: ["producer_plugin_ping"],
      entrySource: makeTestPluginEntrySource({ producer_plugin_ping: `"pong"` }),
      manifest: {
        emittedEvents: ["producer-plugin.status.changed", "audit.log.entry"],
      },
    });
    await writeTestPluginRegistry(fixture, [
      { id: "producer-plugin", manifestPath, enabled: true },
    ]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    // Premise: the real loader really does hand the bridge both names. Without
    // this, a validator that silently dropped `audit.log.entry` would make the
    // assertion below pass for the wrong reason.
    const produced = runtime.listPluginManifests().find((m) => m.pluginId === "producer-plugin");
    expect(produced?.manifest.emittedEvents).toEqual([
      "producer-plugin.status.changed",
      "audit.log.entry",
    ]);

    const win = makeFakeWindow();
    const dispose = registerPluginEventBridge(runtime, win as unknown as never);

    emitEvent("audit.log.entry", { secret: "hunter2" });
    emitEvent("producer-plugin.status.changed", { status: "ok" });

    expect(win._sent.map((s) => s.eventType)).toEqual(["producer-plugin.status.changed"]);

    dispose();
    await runtime.stopAll();
  });
});
