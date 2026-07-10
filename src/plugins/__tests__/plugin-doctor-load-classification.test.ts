/**
 * Plugin Doctor — runtime load-failure classification on plugin cards.
 *
 * The Doctor auto-repairs a plugin that failed to LOAD by reinstalling the
 * latest marketplace version, but only when the cause is reinstall-fixable.
 * These tests pin the classification the settings UI reads off `listPluginCards`:
 *   - a stale/pre-v6/schema-invalid on-disk manifest → `manifest-validation-error`
 *     (reinstall-fixable) plus the underlying field detail, and
 *   - a too-new `requires.minAppVersion` → `incompatible-app-version`
 *     (NOT reinstall-fixable — a reinstall re-fetches the same too-new package).
 */
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  makeTestPluginEntrySource,
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";

describe("PluginRuntime Doctor load-failure classification", () => {
  let fixture: TestPluginRuntimeFixture;

  afterEach(async () => {
    if (fixture) await rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("classifies a schema-invalid (pre-v6) on-disk manifest as reinstall-fixable", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "p-prev6",
      tools: ["p_prev6_ping"],
      entrySource: makeTestPluginEntrySource({ p_prev6_ping: JSON.stringify("hi") }),
      // Unknown top-level property rejected by the current SDK schema — this is
      // the shape a manifest shipped before #885 Phase R now fails validation on.
      manifest: { startupTools: [] },
    });
    await writeTestPluginRegistry(fixture, [{ id: "p-prev6", manifestPath, enabled: true }]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-prev6");
    expect(card?.loadStatus).toBe("failed");
    expect(card?.installFailureKind).toBe("manifest-validation-error");
    expect(card?.installFailureMessage).toMatch(/schema validation failed/);
  });

  it("classifies a too-new minAppVersion as NOT reinstall-fixable", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "p-appver",
      tools: ["p_appver_ping"],
      entrySource: makeTestPluginEntrySource({ p_appver_ping: JSON.stringify("hi") }),
      manifest: { requires: { capabilities: [], minAppVersion: "999.0.0" } },
    });
    await writeTestPluginRegistry(fixture, [{ id: "p-appver", manifestPath, enabled: true }]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-appver");
    expect(card?.loadStatus).toBe("failed");
    expect(card?.installFailureKind).toBe("incompatible-app-version");
  });
});
