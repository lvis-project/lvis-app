/**
 * Sandboxed PluginStorage — verifies path-traversal guards, ENOENT handling,
 * and JSON helpers stay scoped to pluginDataDir.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reversible fake safeStorage seam. `encryptString` wraps the plaintext in a
// recognizable envelope (so the on-disk bytes are demonstrably NOT plaintext),
// `decryptString` unwraps it; `enc.available` toggles the isEncryptionAvailable
// gate per test. Mirrors the settings-store.test.ts electron-mock pattern.
const mockedElectron = vi.hoisted(() => {
  const enc = { available: true };
  return {
    enc,
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => enc.available),
      encryptString: vi.fn((s: string) => Buffer.from(`ENC(${s})`, "utf-8")),
      decryptString: vi.fn((b: Buffer) => {
        const raw = Buffer.from(b).toString("utf-8");
        const m = /^ENC\(([\s\S]*)\)$/.exec(raw);
        if (!m) throw new Error("decryptString: not ciphertext produced by this seam");
        return m[1];
      }),
    },
  };
});
vi.mock("electron", () => ({ safeStorage: mockedElectron.safeStorage }));

import { createPluginStorage } from "../storage.js";
import { PluginStorageEncryptionUnavailableError } from "../types.js";

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

describe("createPluginStorage encrypted-at-rest variants", () => {
  beforeEach(() => {
    mockedElectron.enc.available = true;
    mockedElectron.safeStorage.encryptString.mockClear();
    mockedElectron.safeStorage.decryptString.mockClear();
  });

  it("writeEncrypted → readEncrypted round-trips through safeStorage and never writes plaintext", async () => {
    const s = createPluginStorage("p", dataDir);
    const secret = "s3cr3t-token-値";
    await s.writeEncrypted("auth/token.enc", secret);

    expect(mockedElectron.safeStorage.encryptString).toHaveBeenCalledWith(secret);
    // On-disk bytes are the ciphertext envelope, NOT the plaintext.
    const onDisk = readFileSync(join(dataDir, "auth", "token.enc"), "utf-8");
    expect(onDisk).toBe(`ENC(${secret})`);
    expect(onDisk).not.toBe(secret);

    expect(await s.readEncrypted("auth/token.enc")).toBe(secret);
  });

  it("writeEncrypted fails closed when encryption is unavailable and creates NO file", async () => {
    mockedElectron.enc.available = false;
    const s = createPluginStorage("p", dataDir);
    await expect(s.writeEncrypted("nope.enc", "secret")).rejects.toBeInstanceOf(
      PluginStorageEncryptionUnavailableError,
    );
    // The plaintext was never persisted (no-fallback rule).
    expect(existsSync(join(dataDir, "nope.enc"))).toBe(false);
    expect(mockedElectron.safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it("the thrown error carries the stable kebab-case code", async () => {
    mockedElectron.enc.available = false;
    const s = createPluginStorage("meeting", dataDir);
    await s.writeEncrypted("x.enc", "y").catch((err: unknown) => {
      expect(err).toBeInstanceOf(PluginStorageEncryptionUnavailableError);
      expect((err as PluginStorageEncryptionUnavailableError).code).toBe("encryption-unavailable");
      expect((err as Error).name).toBe("PluginStorageEncryptionUnavailableError");
    });
  });

  it("readEncrypted fails closed when encryption is unavailable (even if the file exists)", async () => {
    const s = createPluginStorage("p", dataDir);
    await s.writeEncrypted("auth/token.enc", "secret"); // encryption available here
    mockedElectron.enc.available = false;
    await expect(s.readEncrypted("auth/token.enc")).rejects.toBeInstanceOf(
      PluginStorageEncryptionUnavailableError,
    );
  });

  it("readEncrypted throws ENOENT for a missing file (matches readText)", async () => {
    const s = createPluginStorage("p", dataDir);
    await expect(s.readEncrypted("missing.enc")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // POSIX-only: mode bits are meaningful on mac/linux, a no-op on Windows.
  // Pins the storage-namespace rule (0o700 dir / 0o600 file) so the secret
  // ciphertext can never regress to world/group-readable — and asserts the same
  // uniform rule for the plaintext writers + explicit mkdir.
  it.skipIf(process.platform === "win32")(
    "created files are 0o600 inside 0o700 dirs (encrypted + plaintext, POSIX)",
    async () => {
      const s = createPluginStorage("p", dataDir);
      await s.writeEncrypted("auth/token.enc", "secret");
      expect(statSync(join(dataDir, "auth", "token.enc")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "auth")).mode & 0o777).toBe(0o700);

      await s.write("plain/notes.txt", "hi");
      expect(statSync(join(dataDir, "plain", "notes.txt")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "plain")).mode & 0o777).toBe(0o700);

      await s.mkdir("madedir");
      expect(statSync(join(dataDir, "madedir")).mode & 0o777).toBe(0o700);
    },
  );

  it("path-escape rejection applies to the encrypted variants too", async () => {
    // Absolute + lexical .. escapes.
    const s = createPluginStorage("p", dataDir);
    await expect(s.writeEncrypted("/etc/passwd", "x")).rejects.toThrow(
      /absolute paths are not allowed/,
    );
    await expect(s.readEncrypted(join("..", "escape.enc"))).rejects.toThrow(
      /escapes plugin storage root/,
    );

    // Symlink escape: planting a junction inside dataDir that points outside.
    writeFileSync(join(outsideDir, "loot.txt"), "untouched", "utf-8");
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    await expect(s.writeEncrypted(join("escape", "loot.txt"), "tampered")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
    expect(readFileSync(join(outsideDir, "loot.txt"), "utf-8")).toBe("untouched");
  });
});
