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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { PluginRuntime } from "../runtime.js";
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
    manifestTools: rt.getPluginManifest(PLUGIN_ID)?.tools ?? null,
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
});
