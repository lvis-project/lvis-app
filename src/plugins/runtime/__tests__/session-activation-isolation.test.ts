/**
 * PluginRuntime — per-session on-demand activation isolation (real Map methods).
 *
 * Exercises the REAL PluginRuntime.setSessionActivated / isSessionActivated /
 * clearSessionActivated against an actual instance (not a local mock Map). The
 * existing delegate-level isolation test stands up its own Map stub, so a
 * regression that reverted production `clearSessionActivated` from
 * `this.sessionActivatedBySession.delete(sessionId)` to a global `.clear()`
 * (wiping ALL sessions) would NOT fail it. This test closes that gap:
 *
 * MUTATION GUARD — if `clearSessionActivated(sessionId)` were reverted to
 * wiping every session's activation, the "session B's clear does NOT remove
 * session A's activation" assertion below FAILS.
 *
 * The session-activation Map methods are pure in-memory state, independent of
 * plugin load/registry machinery, so no `startAll()` is required.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeTestPluginRuntime } from "../../__tests__/test-helpers.js";

describe("PluginRuntime — per-session activation isolation (real methods)", () => {
  let rootDir: string;
  let pluginsRoot: string;
  let registryPath: string;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "lvis-session-activation-"));
    pluginsRoot = join(rootDir, "plugins", "installed");
    registryPath = join(rootDir, "plugins", "registry.json");
    await mkdir(pluginsRoot, { recursive: true });
    await mkdir(dirname(registryPath), { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeRuntime() {
    return makeTestPluginRuntime({ rootDir, pluginsRoot, registryPath });
  }

  it("set/isSessionActivated records activation scoped to a single session", () => {
    const runtime = makeRuntime();
    runtime.setSessionActivated("session-A", "local-indexer");

    expect(runtime.isSessionActivated("session-A", "local-indexer")).toBe(true);
    // A different session never inherits session A's activation.
    expect(runtime.isSessionActivated("session-B", "local-indexer")).toBe(false);
    // A different plugin in the same session is unaffected.
    expect(runtime.isSessionActivated("session-A", "meeting")).toBe(false);
  });

  it("clearing session B does NOT remove session A's activation (mutation guard)", () => {
    const runtime = makeRuntime();
    runtime.setSessionActivated("session-A", "local-indexer");
    runtime.setSessionActivated("session-B", "meeting");

    // Clearing session B must leave session A untouched. A global `.clear()`
    // regression would wipe BOTH and fail the session-A assertion.
    runtime.clearSessionActivated("session-B");

    expect(runtime.isSessionActivated("session-A", "local-indexer")).toBe(true);
    expect(runtime.isSessionActivated("session-B", "meeting")).toBe(false);
  });

  it("clearing session A removes ONLY session A's activations", () => {
    const runtime = makeRuntime();
    runtime.setSessionActivated("session-A", "local-indexer");
    runtime.setSessionActivated("session-A", "meeting");
    runtime.setSessionActivated("session-B", "ms-graph");

    runtime.clearSessionActivated("session-A");

    expect(runtime.isSessionActivated("session-A", "local-indexer")).toBe(false);
    expect(runtime.isSessionActivated("session-A", "meeting")).toBe(false);
    // Session B's unrelated activation survives session A's clear.
    expect(runtime.isSessionActivated("session-B", "ms-graph")).toBe(true);
  });
});
