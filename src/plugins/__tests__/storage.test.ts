/**
 * Sandboxed PluginStorage — verifies path-traversal guards, ENOENT handling,
 * and JSON helpers stay scoped to pluginDataDir.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginStorage } from "../storage.js";

const dirLinkType = process.platform === "win32" ? "junction" : "dir";

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
    // Create a real escape target inside outsideDir, then plant a directory
    // symlink/junction inside dataDir that points to outsideDir. Windows can
    // create junctions without Developer Mode or SeCreateSymbolicLinkPrivilege,
    // so this still exercises real reparse-point traversal locally.
    writeFileSync(join(outsideDir, "escape.txt"), "untouched", "utf-8");
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    const s = createPluginStorage("p", dataDir);
    // The realpath of `escape/escape.txt` resolves outside the root → reject.
    await expect(s.write(join("escape", "escape.txt"), "tampered")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
    // The escape target on disk must remain untouched.
    expect(readFileSync(join(outsideDir, "escape.txt"), "utf-8")).toBe("untouched");
    // Direct attempts to traverse through the link path should be rejected.
    expect(() => s.resolve("..", outsideDir.split(sep).pop()!, "escape.txt"))
      .toThrow(/escapes plugin storage root/);
  });

  it("rejects reads through symlinks pointing outside the root", async () => {
    // Plant a directory symlink/junction inside dataDir whose realpath escapes
    // via outsideDir.
    writeFileSync(join(outsideDir, "secret.txt"), "shhh", "utf-8");
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    const s = createPluginStorage("p", dataDir);
    await expect(s.read(join("escape", "secret.txt"))).rejects.toThrow(/symlink escapes plugin storage root/);
    await expect(s.readText(join("escape", "secret.txt"))).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
  });

  it("rejects writes whose existing ancestor is a symlink to outside", async () => {
    // The new file (`payload.txt`) doesn't exist yet, but its closest
    // existing ancestor (`escape/`) is a symlink whose realpath points
    // outside the root. The realpath check must climb up to the symlink
    // and reject before any write touches disk.
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    const s = createPluginStorage("p", dataDir);
    await expect(s.write("escape/payload.txt", "x")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
  });

  it("rejects dangling symlinks (target doesn't exist)", async () => {
    // Plant a symlink inside dataDir whose *target* does not exist. realpath
    // raises ENOENT (because the chain is broken) but lstat sees the
    // symlink. The host cannot validate where the symlink would resolve, so
    // it must fail closed — otherwise a plugin could plant a dangling link
    // whose target is created later out of band.
    const danglingRel = process.platform === "win32" ? join("dangling", "payload.txt") : "dangling.txt";
    symlinkSync(
      join(outsideDir, "does-not-exist"),
      join(dataDir, process.platform === "win32" ? "dangling" : "dangling.txt"),
      process.platform === "win32" ? "junction" : undefined,
    );
    const s = createPluginStorage("p", dataDir);
    await expect(s.write(danglingRel, "x")).rejects.toThrow(/dangling symlink/);
    await expect(s.read(danglingRel)).rejects.toThrow(/dangling symlink/);
    await expect(s.exists(danglingRel)).rejects.toThrow(/dangling symlink/);
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
