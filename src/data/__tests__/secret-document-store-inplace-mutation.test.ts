/**
 * Regression for the equal-size in-place mutation window in the stable secret
 * reader. A hostile writer that rewrites the same number of bytes through an
 * independent descriptor leaves device, inode, file type, and size unchanged,
 * so metadata identity alone cannot see it. Only the bytes can.
 *
 * `node:fs` is passed through unchanged except for `readSync`, which the test
 * wraps to run the real read and then perform the in-place mutation, giving a
 * deterministic stand-in for a writer that lands inside the read window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let onReadSync: (() => void) | null = null;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: ((...args: Parameters<typeof actual.readSync>) => {
      const result = (actual.readSync as (...rest: unknown[]) => number)(...args);
      onReadSync?.();
      return result;
    }) as typeof actual.readSync,
  };
});

const {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { cleanupTmpDir } = await import("../../testing/tmp-dir-teardown.js");
const { SecretDocumentStore, SecretDocumentValidationError } = await import(
  "../secret-document-store.js"
);
type SecretEncryption = import("../secret-document-store.js").SecretEncryption;

const encryption: SecretEncryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString: (value) => Buffer.from(`sealed:${value}`, "utf-8"),
  decryptString: (value) => {
    const decoded = value.toString("utf-8");
    if (!decoded.startsWith("sealed:")) throw new Error("invalid ciphertext");
    return decoded.slice(7);
  },
};

function documentBytes(sealed: string): string {
  return `${JSON.stringify({
    version: 1,
    entries: { api: { encoding: "safe-storage", value: sealed } },
  }, null, 2)}\n`;
}

/** Overwrites the file through an independent descriptor without truncating. */
function overwriteInPlace(path: string, content: string): void {
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.from(content, "utf-8"), 0, Buffer.byteLength(content), 0);
  } finally {
    closeSync(fd);
  }
}

describe("stable secret read against equal-size in-place mutation", () => {
  let root: string;
  let path: string;
  const honest = documentBytes(Buffer.from("sealed:honest-value").toString("base64"));
  const hostile = documentBytes(Buffer.from("sealed:hostile-swap").toString("base64"));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lvis-secret-inplace-"));
    path = join(root, "lvis-secrets.json");
    onReadSync = null;
  });

  afterEach(async () => {
    onReadSync = null;
    vi.restoreAllMocks();
    await cleanupTmpDir(root);
  });

  it("fixture keeps size, so metadata identity cannot distinguish the two documents", () => {
    expect(honest).not.toBe(hostile);
    expect(Buffer.byteLength(hostile)).toBe(Buffer.byteLength(honest));
  });

  it("reads the honest document when nothing mutates it", () => {
    writeFileSync(path, honest, { mode: 0o600 });
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption });
    expect(store.get("api")).toBe("honest-value");
  });

  it("rejects a document mutated in place during the descriptor read", () => {
    writeFileSync(path, honest, { mode: 0o600 });
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption });
    let mutations = 0;
    onReadSync = () => {
      // Flip the on-disk bytes after every read pass, so no attempt can observe
      // a document that stayed still for the whole of its own read window.
      mutations += 1;
      overwriteInPlace(path, mutations % 2 === 1 ? hostile : honest);
    };

    expect(() => store.get("api")).toThrow(SecretDocumentValidationError);
    expect(mutations).toBeGreaterThan(0);
  });

  it("never returns bytes that were replaced under the reader", () => {
    writeFileSync(path, honest, { mode: 0o600 });
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption });
    let mutated = false;
    onReadSync = () => {
      if (mutated) return;
      mutated = true;
      overwriteInPlace(path, hostile);
    };

    // The first attempt saw honest bytes that no longer describe the file; it
    // must not be trusted. The retry reads the settled hostile document.
    expect(store.get("api")).toBe("hostile-swap");
    expect(readFileSync(path, "utf-8")).toBe(hostile);
  });
});
