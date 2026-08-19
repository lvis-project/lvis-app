/**
 * Every way boot can decline to run an installed plugin must end somewhere the
 * user can look, and the three ways must not look the same.
 *
 * The registry row survives all of them, so `marketplace.list()` keeps
 * reporting the package as installed. When the load path drops the plugin
 * without producing a card, the sidebar, Settings and the Plugin Doctor all
 * show nothing — an install that exists everywhere except in the app.
 *
 * These tests drive the REAL `PluginRuntime.load()` over a real on-disk
 * fixture and render the REAL App and Plugin Settings with the cards it
 * produced, because that is the only way to observe the property that actually
 * broke: not a wrong `loadStatus`, but no row at all. Asserting on the card
 * projection alone would have passed throughout the bug.
 *
 * A separate file rather than a case added to `boot-preflight.test.ts` or
 * `PluginConfigTab.test.tsx`: this is the only suite needing BOTH halves — the
 * runtime (tmp fixtures, install receipts) and the renderer (jsdom, which
 * vitest grants only under `test/renderer/**`). Neither existing home can host
 * the other half. The complementary half — that a plugin listed AFTER a
 * throwing one still loads — lives in `boot-preflight.test.ts`, because
 * loading a plugin for real needs the node environment: jsdom's module runner
 * cannot import a plugin entry from outside the project root.
 */
import "./setup.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeTestPluginRuntime,
  makeTestTreeWritable,
} from "../../src/plugins/__tests__/test-helpers.js";
import {
  buildInstallReceipt,
  writeInstallReceipt,
} from "../../src/plugins/plugin-install-receipt.js";
import type { PluginCardSummary } from "../../src/ui/renderer/types.js";
import { renderApp } from "./render-app.js";

const STRAY_REGISTRY_PLUGIN = "stray-registry-plugin";
const SWITCHED_OFF_PLUGIN = "switched-off-plugin";
const CRASHING_PLUGIN = "crashing-plugin";

describe("installed plugins boot refuses to run", () => {
  let testDir: string;
  let pluginsRoot: string;
  let registryPath: string;
  let strayManifestPath: string;

  async function writePlugin(id: string): Promise<string> {
    const pluginDir = join(pluginsRoot, id);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      "export default async () => ({ handlers: {}, start: async () => {}, stop: async () => {} });\n",
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id,
        name: `Plugin ${id}`,
        version: "1.0.0",
        description: `${id} fixture`,
        publisher: "Test",
        entry: "entry.mjs",
        tools: [],
        ui: [{ id: `${id}-panel`, slot: "sidebar", kind: "info-card", title: `Panel ${id}` }],
      }),
      "utf-8",
    );
    const { receipt } = await buildInstallReceipt(pluginDir, {
      pluginId: id,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "prod-v1",
      files: ["entry.mjs", "plugin.json"],
      installedAt: new Date(0).toISOString(),
    });
    await writeInstallReceipt(testDir, receipt);
    return manifestPath;
  }

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-plugin-refusal-"));
    pluginsRoot = join(testDir, "plugins");
    registryPath = join(pluginsRoot, "registry.json");
    await mkdir(pluginsRoot, { recursive: true });

    // A real file, deliberately OUTSIDE pluginsRoot. It exists so containment
    // is what refuses it rather than a missing file, and so a regression that
    // reads it would succeed — exactly as it would for a planted manifest.
    const strayDir = join(testDir, "outside-the-plugin-root");
    await mkdir(strayDir, { recursive: true });
    strayManifestPath = join(strayDir, "plugin.json");
    await writeFile(
      strayManifestPath,
      JSON.stringify({
        id: STRAY_REGISTRY_PLUGIN,
        name: "Stray Registry Plugin",
        version: "1.0.0",
        description: "must never be read",
        publisher: "Test",
        entry: "entry.mjs",
        tools: [],
      }),
      "utf-8",
    );

    const switchedOffManifest = await writePlugin(SWITCHED_OFF_PLUGIN);
    const crashingManifest = await writePlugin(CRASHING_PLUGIN);

    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: STRAY_REGISTRY_PLUGIN, manifestPath: strayManifestPath, enabled: true },
          { id: SWITCHED_OFF_PLUGIN, manifestPath: switchedOffManifest, enabled: false },
          { id: CRASHING_PLUGIN, manifestPath: crashingManifest, enabled: true },
        ],
      }),
      "utf-8",
    );
  });

  afterEach(async () => {
    await makeTestTreeWritable(testDir);
    await rm(testDir, { recursive: true, force: true });
  });

  async function loadCards(): Promise<PluginCardSummary[]> {
    const runtime = makeTestPluginRuntime(
      { rootDir: testDir, registryPath, pluginsRoot },
      { installReceiptCacheRoot: testDir },
    );
    // Candidate-root materialization has no local failure handler, so a throw
    // here is the unclassified crash the per-plugin boundary has to absorb.
    const internals = runtime as unknown as {
      materializeImmutableRuntimeRoot(
        pluginId: string,
        pluginRoot: string,
        activationId: string,
        installId: string,
      ): Promise<string>;
    };
    const materialize = internals.materializeImmutableRuntimeRoot.bind(runtime);
    internals.materializeImmutableRuntimeRoot = async (pluginId, ...rest) => {
      if (pluginId === CRASHING_PLUGIN) {
        throw new Error("ENOSPC: no space left on device, mkdir runtime root");
      }
      return materialize(pluginId, ...rest);
    };
    await runtime.load();
    return runtime.listPluginCards() as PluginCardSummary[];
  }

  it("gives every refused plugin its own card and its own reason", async () => {
    const cards = await loadCards();

    const stray = cards.find((card) => card.id === STRAY_REGISTRY_PLUGIN);
    expect(stray?.loadStatus).toBe("failed");
    expect(stray?.installFailureKind).toBe("untrusted-manifest-path");
    expect(stray?.installFailureMessage).toContain("not inside the plugin root");

    const crashed = cards.find((card) => card.id === CRASHING_PLUGIN);
    expect(crashed?.loadStatus).toBe("failed");
    expect(crashed?.installFailureKind).toBe("load-crash");
    expect(crashed?.installFailureMessage).toContain("no space left on device");

    // Switched off by the user, so NOT a failure: no Doctor classification and
    // no failure detail, only the inactive status.
    const switchedOff = cards.find((card) => card.id === SWITCHED_OFF_PLUGIN);
    expect(switchedOff?.loadStatus).toBe("disabled");
    expect(switchedOff?.installFailureKind).toBeUndefined();
    expect(switchedOff?.installFailureMessage).toBeUndefined();
  });

  it("renders a sidebar row for each of them, telling repair apart from off", async () => {
    const cards = await loadCards();
    await renderApp({ pluginCards: cards });

    await waitFor(() =>
      expect(screen.getByTestId(`sidebar-plugin-doctor-${STRAY_REGISTRY_PLUGIN}`)).toBeTruthy(),
    );
    expect(screen.getByTestId(`sidebar-plugin-doctor-${CRASHING_PLUGIN}`)).toBeTruthy();

    // The switched-off plugin gets a row too — but it routes to Plugin
    // Settings, not to the Doctor, and carries a neutral "off" badge rather
    // than the destructive repair badge. Presenting a deliberate choice as a
    // fault would be its own defect.
    const inactiveRow = screen.getByTestId(`sidebar-plugin-settings-${SWITCHED_OFF_PLUGIN}`);
    expect(inactiveRow.getAttribute("data-viewkey")).toBe(`plugin-settings:${SWITCHED_OFF_PLUGIN}`);
    expect(screen.queryByTestId(`sidebar-plugin-doctor-${SWITCHED_OFF_PLUGIN}`)).toBeNull();
    expect(inactiveRow.textContent).toContain("꺼짐");
    expect(inactiveRow.textContent).not.toContain("Doctor");
  });

  it("explains the two refusals differently in the Plugin Doctor panel", async () => {
    const cards = await loadCards();
    const { PluginConfigTab } = await import("../../src/ui/renderer/tabs/PluginConfigTab.js");
    Object.defineProperty(window, "lvis", {
      value: { plugins: { cards: async () => cards } },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    (await screen.findByTestId(`plugin-config:row:${STRAY_REGISTRY_PLUGIN}`)).click();
    await waitFor(() =>
      expect(screen.getByText("플러그인 레지스트리 항목 거부됨")).toBeTruthy(),
    );

    (await screen.findByTestId(`plugin-config:row:${CRASHING_PLUGIN}`)).click();
    await waitFor(() =>
      expect(screen.getByText("플러그인 로드 중 오류 발생")).toBeTruthy(),
    );
    // The two refusals never share a sentence: a single generic "failed to
    // load" panel would leave the user in the same dead end as no card.
    expect(screen.queryByText("플러그인 레지스트리 항목 거부됨")).toBeNull();
  });
});
