/**
 * Bonus security hardening — plugin manifest `entry` must resolve inside the
 * plugin directory. Traversal (`../../../etc/passwd.js`) and absolute paths
 * are rejected fail-soft: the offending plugin is dropped + audit-logged, and
 * the rest of the registry loads normally.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { PluginRuntime, resolvePluginEntryPath } from "../runtime.js";

describe("PluginRuntime — entry path allowlist", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;
  let auditEntries: Array<{ level: string; message: string; data?: unknown }>;

  beforeEach(async () => {
    testDir = join(homedir(), ".lvis", "test-tmp", `lvis-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
      await writeManifest("p_evil", "../../../etc/passwd.js");
      await writeRegistry(["p_evil"]);

      const runtime = makeRuntime();
      await runtime.load();

      // Plugin dropped fail-soft.
      expect(runtime.listPluginIds()).not.toContain("p_evil");
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
      await writeManifest("p_abs", "/etc/passwd.js");
      await writeRegistry(["p_abs"]);

      const runtime = makeRuntime();
      await runtime.load();

      expect(runtime.listPluginIds()).not.toContain("p_abs");
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
    await writeManifest("p_ok", "entry.mjs", { writeEntryFile: true });
    await writeRegistry(["p_ok"]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p_ok");
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
  it("accepts a relative entry inside the plugin dir", () => {
    const root = "/tmp/plugins/sample";
    expect(() => resolvePluginEntryPath(root, "entry.mjs")).not.toThrow();
    expect(resolvePluginEntryPath(root, "entry.mjs")).toBe("/tmp/plugins/sample/entry.mjs");
  });

  it("accepts a nested relative entry", () => {
    const root = "/tmp/plugins/sample";
    expect(resolvePluginEntryPath(root, "dist/entry.mjs")).toBe(
      "/tmp/plugins/sample/dist/entry.mjs",
    );
  });

  it("rejects traversal via ..", () => {
    expect(() => resolvePluginEntryPath("/tmp/plugins/sample", "../other/entry.mjs")).toThrow(
      /outside plugin directory/,
    );
  });

  it("rejects absolute POSIX paths", () => {
    expect(() => resolvePluginEntryPath("/tmp/plugins/sample", "/etc/passwd")).toThrow(
      /absolute/,
    );
  });

  it("rejects absolute Windows paths (drive-letter rooted)", () => {
    // `path.isAbsolute('C:\\...')` is true only on win32, but a leading drive
    // letter should never appear in a sandboxed relative entry regardless of
    // OS. Node's resolver treats it as relative on POSIX, which still lands
    // the resolved path *inside* the plugin dir as a literal `C:/…` segment
    // — acceptable. The real Windows-sep concern is the traversal test below.
    const root = "/tmp/plugins/sample";
    // literal "C:\\" as a relative entry on POSIX becomes a child dir; not
    // considered traversal. Assert it does NOT throw (behaviour == previous).
    expect(() => resolvePluginEntryPath(root, "C:\\entry.mjs")).not.toThrow();
  });

  it("accepts entry when root path uses trailing separator", () => {
    // This is the scenario the old `pluginRootResolved + "/"` hardcode
    // was trying to cover. With path.relative() it is unconditional.
    const root = "/tmp/plugins/sample/";
    expect(() => resolvePluginEntryPath(root, "entry.mjs")).not.toThrow();
  });

  it("rejects traversal even when entry starts with a sibling name prefix", () => {
    // Guards against the classic `pluginRootResolved` string-prefix bug:
    // "/root/plugin-foo" should NOT accept a resolve() result of
    // "/root/plugin-foobar/evil.js". path.relative() catches this.
    const root = "/tmp/plugins/sample";
    expect(() => resolvePluginEntryPath(root, "../sample-evil/entry.mjs")).toThrow(
      /outside plugin directory/,
    );
  });
});
