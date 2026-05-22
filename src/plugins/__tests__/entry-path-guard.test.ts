/**
 * Bonus security hardening — plugin manifest `entry` must resolve inside the
 * plugin directory. Traversal (`../../../etc/passwd.js`) and absolute paths
 * are rejected fail-soft: the offending plugin is dropped + audit-logged, and
 * the rest of the registry loads normally.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginEntryPath } from "../runtime.js";
import {
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";

describe("PluginRuntime — entry path allowlist", () => {
  let fixture: TestPluginRuntimeFixture;
  let auditEntries: Array<{ level: string; message: string; data?: unknown }>;

  beforeEach(async () => {
    fixture = await makeTestPluginRuntimeFixture({ prefix: "lvis-entry-" });
    auditEntries = [];
  });

  afterEach(async () => {
    await rm(fixture.rootDir, { recursive: true, force: true });
  });

  async function installManifestFixture(
    id: string,
    entry: string,
    opts: { writeEntryFile?: boolean } = {},
  ): Promise<void> {
    const toolName = `${id.replace(/-/g, "_")}_ping`;
    await writeTestPlugin(fixture, {
      id,
      entry,
      tools: [toolName],
      entrySource: opts.writeEntryFile
        ? `export default async function createPlugin(ctx) {
  return { handlers: { ${toolName}: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`
        : undefined,
    });
  }

  async function registerPlugins(ids: string[]): Promise<void> {
    await writeTestPluginRegistry(
      fixture,
      ids.map((id) => ({
        id,
        manifestPath: join(fixture.pluginsRoot, id, "plugin.json"),
      })),
    );
  }

  function runtimeWithAudit() {
    return makeTestPluginRuntime(fixture, {
      auditLog: (level, message, data) => {
        auditEntries.push({ level, message, data });
      },
    });
  }

  it("rejects a manifest whose entry traverses outside the plugin directory", async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: unknown) => { errors.push(String(msg)); };
    try {
      await installManifestFixture("p-evil", "../../../etc/passwd.js");
      await registerPlugins(["p-evil"]);

      const runtime = runtimeWithAudit();
      await runtime.load();

      // Plugin dropped fail-soft.
      expect(runtime.listPluginIds()).not.toContain("p-evil");
      // Audit trail recorded the rejection.
      expect(
        auditEntries.some(
          (e) => e.level === "error" && e.message === "plugin_entry_path_rejected",
        ),
      ).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  it("rejects a manifest with an absolute entry path", async () => {
    const origError = console.error;
    console.error = () => {};
    try {
      await installManifestFixture("p-abs", "/etc/passwd.js");
      await registerPlugins(["p-abs"]);

      const runtime = runtimeWithAudit();
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("p-abs");
      expect(
        auditEntries.some(
          (e) => e.level === "error" && e.message === "plugin_entry_path_rejected",
        ),
      ).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  it("accepts a normal relative entry inside the plugin dir", async () => {
    await installManifestFixture("p-ok", "entry.mjs", { writeEntryFile: true });
    await registerPlugins(["p-ok"]);

    const runtime = runtimeWithAudit();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p-ok");
    expect(
      auditEntries.some((e) => e.message === "plugin_entry_path_rejected"),
    ).toBe(false);
  });
});

/**
 * Direct unit tests of the exported resolver. These exercise the
 * path-sep independence that the old string-prefix check lacked.
 *
 * Note: We can't truly swap the path module at runtime in a single vitest
 * process, but we *can* assert that the current (POSIX) path impl accepts
 * plausibly-rooted relative entries and rejects traversal — the core shape
 * the Windows fix preserves.
 */
describe("resolvePluginEntryPath — direct", () => {
  const root = join(tmpdir(), "plugins", "sample");

  it("accepts a relative entry inside the plugin dir", () => {
    expect(() => resolvePluginEntryPath(root, "entry.mjs")).not.toThrow();
    expect(resolvePluginEntryPath(root, "entry.mjs")).toBe(join(root, "entry.mjs"));
  });

  it("accepts a nested relative entry", () => {
    expect(resolvePluginEntryPath(root, join("dist", "entry.mjs"))).toBe(
      join(root, "dist", "entry.mjs"),
    );
  });

  it("rejects traversal via ..", () => {
    expect(() => resolvePluginEntryPath(root, "../other/entry.mjs")).toThrow(
      /outside plugin directory/,
    );
  });

  it("rejects absolute POSIX paths (non-Windows only)", () => {
    if (process.platform !== "win32") {
      expect(() => resolvePluginEntryPath(root, "/etc/passwd")).toThrow(/absolute/);
    }
  });

  it("rejects/accepts absolute Windows drive-letter paths per OS", () => {
    if (process.platform === "win32") {
      // On Windows C:\entry.mjs is a true absolute path — guard must throw.
      expect(() => resolvePluginEntryPath(root, "C:\\entry.mjs")).toThrow(/absolute/);
    } else {
      // On POSIX C:\... is a relative literal string — resolves inside root.
      expect(() => resolvePluginEntryPath(root, "C:\\entry.mjs")).not.toThrow();
    }
  });

  it("accepts entry when root path uses trailing path separator", () => {
    const rootTrailing = root + (process.platform === "win32" ? "\\" : "/");
    expect(() => resolvePluginEntryPath(rootTrailing, "entry.mjs")).not.toThrow();
  });

  it("rejects traversal even when entry starts with a sibling name prefix", () => {
    // Guards against the classic `pluginRootResolved` string-prefix bug:
    // "/root/plugin-foo" should NOT accept "/root/plugin-foobar/evil.js".
    expect(() => resolvePluginEntryPath(root, "../sample-evil/entry.mjs")).toThrow(
      /outside plugin directory/,
    );
  });
});
