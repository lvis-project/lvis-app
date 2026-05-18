/**
 * Bonus security hardening — plugin manifest `entry` must resolve inside the
 * plugin directory. Traversal (`../../../etc/passwd.js`) and absolute paths
 * are rejected fail-soft: the offending plugin is dropped + audit-logged, and
 * the rest of the registry loads normally.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime, resolvePluginEntryPath } from "../runtime.js";
import { mkdtempSync } from "node:fs";

describe("PluginRuntime — entry path allowlist", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;
  let auditEntries: Array<{ level: string; message: string; data?: unknown }>;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-entry-"));
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
    auditEntries = [];
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeManifest(
    id: string,
    entry: string,
    opts: { writeEntryFile?: boolean } = {},
  ): Promise<void> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    if (opts.writeEntryFile) {
      await writeFile(
        join(pluginDir, "entry.mjs"),
        `export default async function createPlugin(ctx) {
  return { handlers: { ${id}_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
        "utf-8",
      );
    }
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry,
      tools: [`${id}_ping`],
    };
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(manifest), "utf-8");
  }

  async function writeRegistry(ids: string[]): Promise<void> {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: ids.map((id) => ({
          id,
          manifestPath: join(installedDir, id, "plugin.json"),
        })),
      }),
      "utf-8",
    );
  }

  function makeRuntime(): PluginRuntime {
    return new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
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
      await writeManifest("p-evil", "../../../etc/passwd.js");
      await writeRegistry(["p-evil"]);

      const runtime = makeRuntime();
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
      await writeManifest("p-abs", "/etc/passwd.js");
      await writeRegistry(["p-abs"]);

      const runtime = makeRuntime();
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
    await writeManifest("p-ok", "entry.mjs", { writeEntryFile: true });
    await writeRegistry(["p-ok"]);

    const runtime = makeRuntime();
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
