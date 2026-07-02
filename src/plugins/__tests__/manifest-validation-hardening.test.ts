/**
 * Runtime manifest validation hardening.
 *
 * Covers 5 cross-field rules:
 *   1) keywords[].skillId ⊂ tools[]             (hard fail-load)
 *   2) toolSchemas keys    ⊂ tools[]             (hard fail-load)
 *   3) notificationEvents.event ⊂ eventSubscriptions (soft warn)
 *   4) ui[] kind-specific required fields (hard fail-load)
 *   5) AJV unknown-property rejection (additionalProperties:false at root,
 *      SDK 5.7.0+) — guards against silent acceptance of removed/typo'd fields
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
    await writePlugin("p-kw", {
      tools: ["pkw_hello", "pkw_bad", "pkw_good"],
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
    await writePlugin("p-ts", {
      tools: ["pts_hello", "pts_bad", "pts_good"],
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
    await writePlugin("p-notif", {
      tools: ["pnotif_hello", "pnotif_bad", "pnotif_good"],
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
    expect(runtime.listPluginIds()).toContain("p-notif");
    expect(
      cap.warns.some((w) =>
        /Plugin manifest 'p-notif': notificationEvents\[0\]\.event 'meeting\.ghost' not declared in eventSubscriptions/.test(w),
      ),
    ).toBe(true);
  });

  it("4) ui[] invalid entry fails load instead of dropping entries", async () => {
    await writePlugin("p-ui", {
      tools: ["pui_hello", "pui_bad", "pui_good"],
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
    expect(runtime.listPluginIds()).not.toContain("p-ui");
    expect(
      cap.errors.some((e) =>
        /ui\[0\].*kind="embedded-module" missing required field\(s\): exportName/.test(e),
      ),
    ).toBe(true);
  });

  it("4c) ui[] kind=\"action\" without tool fails load", async () => {
    await writePlugin("p-action-bad", {
      tools: ["pab_hello", "pab_bad", "pab_good"],
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
    expect(runtime.listPluginIds()).not.toContain("p-action-bad");
    expect(
      cap.errors.some((e) =>
        /ui\[0\].*kind="action" missing required field\(s\): tool/.test(e),
      ),
    ).toBe(true);
  });

  it("4d) ui[] kind=\"action\" with valid tool loads", async () => {
    await writePlugin("p-action-ok", {
      tools: ["my_tool"],
      ui: [
        { id: "a", slot: "sidebar", kind: "action", title: "A", tool: "my_tool" },
      ],
      uiActions: { my_tool: {} },
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("p-action-ok");
  });

  it("4b) ui[] non-plain-object entries fail load instead of being dropped", async () => {
    await writePlugin("p-ui-bad", {
      tools: ["puibad_hello", "puibad_bad", "puibad_good"],
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
    expect(runtime.listPluginIds()).not.toContain("p-ui-bad");
    expect(cap.errors.some((e) => /ui\[0\].*must be an object/.test(e))).toBe(true);
  });

  // SDK 5.7.0 의 schema 가 root 에 `additionalProperties: false` 를 강제하므로
  // 폐기된 `startupTools` 또는 plugin author 의 typo 가 silent ignore 되지 않고
  // AJV 단계에서 hard reject 되어야 한다. plugin 자체가 fail-soft drop 되며 host
  // 는 계속 동작.
  it("5) AJV rejects manifest with unknown root property (startupTools post 5.7.0)", async () => {
    await writePlugin("p-unknown-field", {
      tools: ["puf_hello", "puf_bad", "puf_good"],
      startupTools: ["p_unknown_field_hello"],
    });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).not.toContain("p-unknown-field");
    expect(
      cap.errors.some((e) => /additional|unknown|startupTools/i.test(e)),
    ).toBe(true);
  });

  // Supply-chain visibility — manifest schema reject 또는 cross-field 위반으로
  // plugin 이 fail-soft drop 될 때 audit log 에 `plugin_manifest_rejected` 가
  // 남아야 security ops / operator 가 어느 plugin 이 왜 드랍됐는지 추적 가능.
  it("6) auditLog emits plugin_manifest_rejected on manifest reject", async () => {
    await writePlugin("p-audit-target", {
      tools: ["pat_hello", "pat_bad", "pat_good"],
      startupTools: ["p_audit_target_hello"], // AJV reject trigger
    });
    const auditLog = vi.fn();
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      auditLog,
    });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).not.toContain("p-audit-target");
    const rejected = auditLog.mock.calls.find(
      (call) => call[1] === "plugin_manifest_rejected",
    );
    expect(rejected).toBeTruthy();
    expect(rejected?.[0]).toBe("error");
    const data = rejected?.[2] as { manifestPath: string; error: string };
    expect(data.manifestPath).toContain("p-audit-target");
    expect(data.error).toMatch(/additional|startupTools|schema/i);
  });

});
