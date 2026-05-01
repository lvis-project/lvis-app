/**
 * Phase 5 — runtime manifest validation hardening.
 *
 * Covers 5 cross-field / fail-soft rules:
 *   1) keywords[].skillId ⊂ tools[]             (hard fail-load)
 *   2) toolSchemas keys    ⊂ tools[]             (hard fail-load)
 *   3) notificationEvents.event ⊂ eventSubscriptions (soft warn)
 *   4) ui[] kind-specific required fields (soft drop per entry)
 *   5) startupTools fail-soft (one throws, others run, plugin stays loaded)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";
import { runManifestStartupTools } from "../../boot/plugins.js";
import { mkdtempSync } from "node:fs";

describe("Phase 5 — runtime validation hardening", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-p5-"));
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(
    id: string,
    manifestOverrides: Record<string, unknown> = {},
    entrySource?: string,
  ): Promise<void> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const defaultEntry = `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "${id}_hello": async () => "hi",
      "${id}_bad": async () => { throw new Error("boom"); },
      "${id}_good": async () => "ok",
    },
    start: async () => {},
    stop: async () => {},
  };
}`;
    await writeFile(join(pluginDir, "entry.mjs"), entrySource ?? defaultEntry, "utf-8");
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry: "entry.mjs",
      tools: [`${id}_hello`, `${id}_bad`, `${id}_good`],
      ...manifestOverrides,
    };
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(manifest), "utf-8");
    await mkdir(join(testDir, "plugins"), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id, manifestPath: join(pluginDir, "plugin.json") }],
      }),
      "utf-8",
    );
  }

  function captureErrors(): { errors: string[]; warns: string[]; restore: () => void } {
    const errors: string[] = [];
    const warns: string[] = [];
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (msg: unknown) => errors.push(String(msg));
    console.warn = (msg: unknown, ..._rest: unknown[]) => warns.push(String(msg));
    return {
      errors,
      warns,
      restore: () => {
        console.error = origErr;
        console.warn = origWarn;
      },
    };
  }

  it("1) keywords[].skillId not in tools[] fails load", async () => {
    await writePlugin("p_kw", {
      keywords: [{ keyword: "회의", skillId: "p_kw_missing" }],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).toHaveLength(0);
    expect(
      cap.errors.some((e) => /keywords\[0\]\.skillId.*p_kw_missing.*not in tools\[\]/.test(e)),
    ).toBe(true);
  });

  it("2) toolSchemas key not in tools[] fails load", async () => {
    await writePlugin("p_ts", {
      toolSchemas: {
        p_ts_ghost: {
          description: "ghost tool description here",
          inputSchema: { type: "object", properties: {} },
        },
      },
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).toHaveLength(0);
    expect(
      cap.errors.some((e) => /toolSchemas\[.*p_ts_ghost.*\].*not in tools\[\]/.test(e)),
    ).toBe(true);
  });

  it("3) notificationEvents.event not in eventSubscriptions → soft warn, plugin still loads", async () => {
    await writePlugin("p_notif", {
      eventSubscriptions: ["meeting.started"],
      notificationEvents: [{ event: "meeting.ghost" }],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).toContain("p_notif");
    expect(
      cap.warns.some((w) =>
        /notificationEvents\[0\]\.event 'meeting\.ghost' not declared in eventSubscriptions/.test(w),
      ),
    ).toBe(true);
  });

  it("4) ui[] invalid entry dropped, other entries survive, plugin loads", async () => {
    await writePlugin("p_ui", {
      ui: [
        // bad embedded-module (missing exportName) — should drop
        { id: "a", slot: "sidebar", kind: "embedded-module", title: "A", entry: "dist/a.js" },
        // good info-card — should keep
        { id: "b", slot: "sidebar", kind: "info-card", title: "B" },
        // good embedded-page — should keep
        { id: "c", slot: "sidebar", kind: "embedded-page", title: "C", page: "dist/c.html" },
      ],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).toContain("p_ui");
    const manifest = runtime.getPluginManifest("p_ui");
    expect(manifest?.ui?.map((u) => u.id).sort()).toEqual(["b", "c"]);
    expect(
      cap.warns.some((w) =>
        /ui\[0\] kind="embedded-module" missing required field "exportName" — dropped/.test(w),
      ),
    ).toBe(true);
  });

  it("4b) ui[] non-plain-object entries (array, number, null) are dropped, plugin loads", async () => {
    await writePlugin("p_ui_bad", {
      ui: [
        [], // array — must be dropped
        123, // number — must be dropped
        null, // null — must be dropped
        // good entry should survive
        { id: "z", slot: "sidebar", kind: "info-card", title: "Z" },
      ],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).toContain("p_ui_bad");
    const manifest = runtime.getPluginManifest("p_ui_bad");
    expect(manifest?.ui?.map((u) => u.id)).toEqual(["z"]);
    // Each bad entry should have emitted a warn.
    const droppedWarns = cap.warns.filter((w) => /ui\[\d+\] is not an object — dropped/.test(w));
    expect(droppedWarns.length).toBeGreaterThanOrEqual(3);
  });

  it("5) startupTools fail-soft: one throws, others run, plugin stays loaded", async () => {
    await writePlugin("p_su", {
      startupTools: ["p_su_bad", "p_su_good"],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("p_su");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    runManifestStartupTools(runtime);

    // Drain the microtask queue: runtime.call() is async so its .catch()
    // handler fires after at least one await turn per promise in the chain.
    // Four rounds covers: call → reject → boot .catch → warn side-effect.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Plugin still loaded after a startupTool threw.
    expect(runtime.listPluginIds()).toContain("p_su");
    // Warning observed — checked before restoring spy.
    expect(
      warnSpy.mock.calls.some(([msg]) =>
        /startup-tool-failed.*plugin=p_su.*tool=p_su_bad/.test(String(msg)),
      ),
    ).toBe(true);
    vi.restoreAllMocks();
    // Good tool still callable post-failure.
    await expect(runtime.call("p_su_good", {})).resolves.toBe("ok");
  });
});
