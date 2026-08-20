/**
 * The plugin `<webview>`'s hardening has to come from main, not from the
 * attribute the renderer sets on the element.
 *
 * `webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"` is a
 * request, and it fails silently in two ways: a mistyped key or value is
 * ignored by Electron and falls back to the default with nothing logged, and
 * it is a DOM attribute in the host renderer, so it is only as trustworthy as
 * that renderer.
 *
 * The side-browser webview never relied on the attribute — its attach handler
 * overwrites the preferences in main. Plugin partitions hit the early
 * `"ignored"` return in that handler, so the frame that hosts third-party code
 * was the one without the enforcement.
 *
 * These pass a DELIBERATELY WEAK request, because a test that supplies the
 * hardened values it expects to see back cannot tell enforcement from an
 * unchanged echo.
 */
import { describe, expect, it } from "vitest";

import { configurePluginWebviewAttach } from "../plugin-webview-attach.js";
import { pluginPartitionName } from "../../shared/plugin-partition.js";
import { LVIS_SIDE_BROWSER_PARTITION } from "../../shared/side-browser.js";

/** What a compromised or mistyped renderer would ask for. */
function weakRequest(): Record<string, unknown> {
  return {
    nodeIntegration: true,
    nodeIntegrationInWorker: true,
    nodeIntegrationInSubFrames: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    webviewTag: true,
  };
}

describe("plugin webview attach", () => {
  it("overrides every weakened preference on a plugin partition", () => {
    const webPreferences = weakRequest();
    const result = configurePluginWebviewAttach({
      webPreferences,
      params: { partition: pluginPartitionName("meeting") },
    });

    expect(result).toBe("enforced");
    expect(webPreferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });
  });

  it("closes node reachability in all three forms, not just the headline one", () => {
    // `nodeIntegration: false` alone still leaves workers and subframes, which
    // are separate preferences with their own defaults.
    const webPreferences = weakRequest();
    configurePluginWebviewAttach({
      webPreferences,
      params: { partition: pluginPartitionName("local-indexer") },
    });
    expect(webPreferences.nodeIntegrationInWorker).toBe(false);
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false);
  });

  it("stops a plugin frame from embedding further guest views", () => {
    // A nested webview would attach with preferences this guard has no branch
    // for, which is how enforcement gets skipped one level down.
    const webPreferences = weakRequest();
    configurePluginWebviewAttach({
      webPreferences,
      params: { partition: pluginPartitionName("ms-graph") },
    });
    expect(webPreferences.webviewTag).toBe(false);
  });

  it("enforces for every plugin id, not a fixed list", () => {
    for (const pluginId of ["meeting", "ms-graph", "ep-api", "work-assistant", "unknown-future"]) {
      const webPreferences = weakRequest();
      const result = configurePluginWebviewAttach({
        webPreferences,
        params: { partition: pluginPartitionName(pluginId) },
      });
      expect(result, pluginId).toBe("enforced");
      expect(webPreferences.contextIsolation, pluginId).toBe(true);
    }
  });

  describe("partitions it must not claim", () => {
    it.each([
      [LVIS_SIDE_BROWSER_PARTITION, "the side browser, which has its own handler"],
      ["", "no partition at all"],
      ["persist:plugin:", "the prefix with no hash"],
      ["persist:plugin:XYZ", "a non-hex hash"],
      ["persist:plugin:abc", "a hash of the wrong length"],
      ["persist:plugin:0123456789ab", "a hash that is too long"],
      ["persist:evil:00000000", "a lookalike namespace"],
    ])("ignores %s (%s)", (partition) => {
      const webPreferences = weakRequest();
      const result = configurePluginWebviewAttach({ webPreferences, params: { partition } });

      expect(result).toBe("ignored");
      // Untouched, so the handler that DOES own this partition still sees the
      // request as it arrived.
      expect(webPreferences).toEqual(weakRequest());
    });
  });

  it("recognises exactly what pluginPartitionName produces", () => {
    // The predicate and the constructor drifting apart would turn enforcement
    // off silently, which is the failure this whole module exists to prevent.
    const partition = pluginPartitionName("some-plugin");
    expect(partition).toMatch(/^persist:plugin:[0-9a-f]{8}$/);
    expect(
      configurePluginWebviewAttach({ webPreferences: weakRequest(), params: { partition } }),
    ).toBe("enforced");
  });
});
