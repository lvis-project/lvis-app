/**
 * C1 gap-lock — PluginRuntime 4-path instantiation parity.
 *
 * A plugin instance can be created/started through four distinct entry points:
 *   • load()/startAll()  — boot path
 *   • addPlugin()        — single install path (cold add + already-loaded restart)
 *   • restartPlugin()    — targeted restart
 *   • reloadPlugin()     — dev live-reload
 *
 * Individual paths are exercised elsewhere, but their CONVERGENCE to the same
 * observable registered state was not locked. These tests pin that every path
 * ends with: the plugin listed, its tool registered + callable, a perf-stats
 * entry present, and its manifest retrievable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";

import { PluginRuntime } from "../runtime.js";
import { PluginPhase } from "../lifecycle-log.js";
import {
  makeTestPluginEntrySource,
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";

const PLUGIN_ID = "parity-plugin";
const TOOL = "parity_ping";

interface RegisteredState {
  listed: boolean;
  toolListed: boolean;
  callResult: unknown;
  hasPerfEntry: boolean;
  manifestTools: string[] | null;
}

async function captureState(rt: PluginRuntime): Promise<RegisteredState> {
  return {
    listed: rt.listPluginIds().includes(PLUGIN_ID),
    toolListed: rt.listToolNames().includes(TOOL),
    callResult: await rt.call(TOOL),
    hasPerfEntry: Boolean(rt.getPerfStats()[PLUGIN_ID]),
    // #885 v6 — manifest.tools is now Tool[]; project to names for the parity compare.
    manifestTools: rt.getPluginManifest(PLUGIN_ID)?.tools.map((t) => t.name) ?? null,
  };
}

const EXPECTED: RegisteredState = {
  listed: true,
  toolListed: true,
  callResult: "pong",
  hasPerfEntry: true,
  manifestTools: [TOOL],
};

describe("PluginRuntime instantiation parity", () => {
  let fixture: TestPluginRuntimeFixture;

  beforeEach(async () => {
    fixture = await makeTestPluginRuntimeFixture({ prefix: "lvis-parity-" });
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: PLUGIN_ID,
      tools: [TOOL],
      entrySource: makeTestPluginEntrySource({ [TOOL]: JSON.stringify("pong") }),
    });
    await writeTestPluginRegistry(fixture, [
      { id: PLUGIN_ID, manifestPath, enabled: true },
    ]);
  });

  afterEach(async () => {
    await rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("startAll (load path) and cold addPlugin reach the same registered state", async () => {
    const viaStartAll = makeTestPluginRuntime(fixture);
    await viaStartAll.startAll();
    const startState = await captureState(viaStartAll);

    const viaAddPlugin = makeTestPluginRuntime(fixture);
    await viaAddPlugin.addPlugin(PLUGIN_ID);
    const addState = await captureState(viaAddPlugin);

    expect(startState).toEqual(EXPECTED);
    expect(addState).toEqual(EXPECTED);
    expect(addState).toEqual(startState);
  });

  it("restartPlugin and reloadPlugin preserve the same registered state after startAll", async () => {
    const rt = makeTestPluginRuntime(fixture);
    await rt.startAll();
    const startState = await captureState(rt);

    await rt.restartPlugin(PLUGIN_ID);
    const restartState = await captureState(rt);

    await rt.reloadPlugin(PLUGIN_ID);
    const reloadState = await captureState(rt);

    expect(restartState).toEqual(EXPECTED);
    expect(reloadState).toEqual(EXPECTED);
    expect(restartState).toEqual(startState);
    expect(reloadState).toEqual(startState);
  });

  /**
   * A tool declared in the manifest with no matching runtime handler is
   * skipped, and the skip is reported on the structured plugin-phase stream —
   * that stream is how an operator finds out a tool silently disappeared.
   *
   * The four instantiation paths derived the same map four ways: two called
   * the shared `buildMethodMap`, two re-implemented the loop by hand. One of
   * the hand-rolled copies (addPlugin) reported the skip as a bare
   * `log.warn` string carrying neither pluginId nor phase, so a tool dropped
   * during install/enable never reached the stream the other paths feed.
   */
  describe("missing-handler skip telemetry", () => {
    const DECLARED_ONLY = "parity_orphan";

    beforeEach(async () => {
      const { manifestPath } = await writeTestPlugin(fixture, {
        id: PLUGIN_ID,
        tools: [TOOL, DECLARED_ONLY],
        entrySource: makeTestPluginEntrySource({ [TOOL]: JSON.stringify("pong") }),
      });
      await writeTestPluginRegistry(fixture, [
        { id: PLUGIN_ID, manifestPath, enabled: true },
      ]);
    });

    /** The structured phase records the run emitted for the orphan tool. */
    function skipRecords(
      warn: { mock: { calls: unknown[][] } },
    ): unknown[] {
      return warn.mock.calls
        .flat()
        .filter((arg): arg is Record<string, unknown> =>
          typeof arg === "object"
          && arg !== null
          && (arg as Record<string, unknown>).phase === PluginPhase.REGISTER_TOOL_SKIP);
    }

    const EXPECTED_SKIP = {
      pluginId: PLUGIN_ID,
      phase: PluginPhase.REGISTER_TOOL_SKIP,
      toolName: DECLARED_ONLY,
      reason: "missing_handler",
    };

    it("startAll reports the skip on the plugin-phase stream", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const rt = makeTestPluginRuntime(fixture);
        await rt.startAll();
        expect(rt.listToolNames()).not.toContain(DECLARED_ONLY);
        expect(skipRecords(warn)).toContainEqual(
          expect.objectContaining(EXPECTED_SKIP),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("addPlugin reports the skip on the same stream, not as an untagged string", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const rt = makeTestPluginRuntime(fixture);
        await rt.addPlugin(PLUGIN_ID);
        expect(rt.listToolNames()).not.toContain(DECLARED_ONLY);
        expect(skipRecords(warn)).toContainEqual(
          expect.objectContaining(EXPECTED_SKIP),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("restartPlugin reports the skip on the same stream", async () => {
      const rt = makeTestPluginRuntime(fixture);
      await rt.startAll();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await rt.restartPlugin(PLUGIN_ID);
        expect(rt.listToolNames()).not.toContain(DECLARED_ONLY);
        expect(skipRecords(warn)).toContainEqual(
          expect.objectContaining(EXPECTED_SKIP),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});
