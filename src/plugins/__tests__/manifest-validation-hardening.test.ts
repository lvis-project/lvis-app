/**
 * Runtime manifest validation hardening.
 *
 * Covers 4 cross-field rules:
 *   1) keywords[].skillId ⊂ tools[]             (hard fail-load)
 *   2) toolSchemas keys    ⊂ tools[]             (hard fail-load)
 *   3) notificationEvents.event ⊂ eventSubscriptions (soft warn)
 *   4) ui[] kind-specific required fields (hard fail-load)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";
import { mkdtempSync } from "node:fs";

describe("runtime manifest validation hardening", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-manifest-hardening-"));
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
          category: "read",
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

  it("4) ui[] invalid entry fails load instead of dropping entries", async () => {
    await writePlugin("p_ui", {
      ui: [
        // bad embedded-module (missing exportName) — should fail the manifest
        { id: "a", slot: "sidebar", kind: "embedded-module", title: "A", entry: "dist/a.js" },
        { id: "b", slot: "sidebar", kind: "info-card", title: "B" },
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
    expect(runtime.listPluginIds()).not.toContain("p_ui");
    expect(
      cap.errors.some((e) =>
        /ui\[0\].*kind="embedded-module" missing required field\(s\): exportName/.test(e),
      ),
    ).toBe(true);
  });

  it("4c) ui[] kind=\"action\" without tool fails load", async () => {
    await writePlugin("p_action_bad", {
      ui: [
        { id: "a", slot: "sidebar", kind: "action", title: "A" },
      ],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).not.toContain("p_action_bad");
    expect(
      cap.errors.some((e) =>
        /ui\[0\].*kind="action" missing required field\(s\): tool/.test(e),
      ),
    ).toBe(true);
  });

  it("4d) ui[] kind=\"action\" with valid tool loads", async () => {
    await writePlugin("p_action_ok", {
      tools: ["my_tool"],
      ui: [
        { id: "a", slot: "sidebar", kind: "action", title: "A", tool: "my_tool" },
      ],
      uiCallable: ["my_tool"],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("p_action_ok");
  });

  it("4b) ui[] non-plain-object entries fail load instead of being dropped", async () => {
    await writePlugin("p_ui_bad", {
      ui: [
        [], // array — must fail
        123,
        null,
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
    expect(runtime.listPluginIds()).not.toContain("p_ui_bad");
    expect(cap.errors.some((e) => /ui\[0\].*must be an object/.test(e))).toBe(true);
  });

});
