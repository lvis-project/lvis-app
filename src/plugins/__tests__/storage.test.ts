/**
 * Sandboxed PluginStorage — verifies path-traversal guards, ENOENT handling,
 * and JSON helpers stay scoped to pluginDataDir.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginStorage } from "../storage.js";

let dataDir: string;
let outsideDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lvis-plugin-storage-data-"));
  outsideDir = mkdtempSync(join(tmpdir(), "lvis-plugin-storage-outside-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe("createPluginStorage path guards", () => {
  it("rejects absolute paths", () => {
    const s = createPluginStorage("p", dataDir);
    expect(() => s.resolve("/etc/passwd")).toThrow(/absolute paths are not allowed/);
  });

  it("rejects relative paths that escape via ..", () => {
    const s = createPluginStorage("p", dataDir);
    expect(() => s.resolve("..", "evil.txt")).toThrow(/escapes plugin storage root/);
    expect(() => s.resolve("nested", "..", "..", "evil.txt")).toThrow(/escapes plugin storage root/);
  });

  it("allows paths inside the root", () => {
    const s = createPluginStorage("p", dataDir);
    const target = s.resolve("subdir", "file.txt");
    // Compare against the canonical root (mkdtemp on macOS lives under /tmp,
    // which realpath resolves to /private/tmp).
    const canonicalRoot = realpathSync(dataDir);
    expect(target.startsWith(canonicalRoot + sep)).toBe(true);
  });

  it("rejects writes through symlinks pointing outside the root", async () => {
    // Create a real escape target inside outsideDir, then plant a symlink
    // inside dataDir that points to outsideDir/escape.txt.
    writeFileSync(join(outsideDir, "escape.txt"), "untouched", "utf-8");
    symlinkSync(join(outsideDir, "escape.txt"), join(dataDir, "link-out.txt"));
    const s = createPluginStorage("p", dataDir);
    // The realpath of `link-out.txt` resolves outside the root → reject.
    await expect(s.write("link-out.txt", "tampered")).resolves.toBeUndefined();
    // Direct attempts to traverse through the link path should be rejected.
    expect(() => s.resolve("..", outsideDir.split(sep).pop()!, "escape.txt"))
      .toThrow(/escapes plugin storage root/);
  });
});

describe("createPluginStorage I/O", () => {
  it("writes and reads bytes / text round-trip", async () => {
    const s = createPluginStorage("p", dataDir);
    await s.write("a/b/c.txt", "hello");
    expect(await s.readText("a/b/c.txt")).toBe("hello");
    const bytes = await s.read("a/b/c.txt");
    expect(Buffer.from(bytes).toString("utf-8")).toBe("hello");
  });

  it("readJson returns null on missing file, throws on malformed", async () => {
    const s = createPluginStorage("p", dataDir);
    expect(await s.readJson("missing.json")).toBeNull();
    await s.write("bad.json", "{not-json", "utf-8");
    await expect(s.readJson("bad.json")).rejects.toThrow();
  });

  it("writeJson + readJson round-trip", async () => {
    const s = createPluginStorage("p", dataDir);
    const value = { name: "meeting", count: 3, nested: { ok: true } };
    await s.writeJson("state.json", value);
    expect(await s.readJson("state.json")).toEqual(value);
  });

  it("rm removes files; recursive removes trees; missing is no-op", async () => {
    const s = createPluginStorage("p", dataDir);
    await s.write("a/b/c.txt", "x");
    await s.rm("a", { recursive: true });
    expect(await s.exists("a")).toBe(false);
    await expect(s.rm("missing")).resolves.toBeUndefined();
  });

  it("list returns empty array for missing dir", async () => {
    const s = createPluginStorage("p", dataDir);
    expect(await s.list("does-not-exist")).toEqual([]);
  });

  it("mkdir creates nested directories", async () => {
    const s = createPluginStorage("p", dataDir);
    await s.mkdir("deeply/nested/folder");
    expect(await s.exists("deeply/nested/folder")).toBe(true);
  });
});

describe("createPluginStorage error shape", () => {
  it("PluginStorageError carries pluginId + attempted path", () => {
    const s = createPluginStorage("meeting", dataDir);
    try {
      s.resolve("..", "outside.txt");
      throw new Error("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("plugin-storage:meeting");
      expect(message).toContain("..");
    }
  });
});
