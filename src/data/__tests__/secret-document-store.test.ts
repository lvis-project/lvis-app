import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { FileLockReleaseError } from "../../lib/with-file-lock.js";
import {
  SecretDocumentStore,
  SecretDocumentDecryptionError,
  SecretDocumentValidationError,
  SecretEncryptionUnavailableError,
  type SecretEncryption,
} from "../secret-document-store.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const childFixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/secret-store-process-child.ts",
);
const nodeCommand = process.env.LVIS_TEST_NODE_EXEC_PATH ?? process.execPath;

function availableEncryption(overrides: Partial<SecretEncryption> = {}): SecretEncryption {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(`sealed:${value}`, "utf-8"),
    decryptString: (value) => {
      const decoded = value.toString("utf-8");
      if (!decoded.startsWith("sealed:")) throw new Error("invalid ciphertext");
      return decoded.slice(7);
    },
    ...overrides,
  };
}

function unavailableEncryption(): SecretEncryption {
  return {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => "unknown",
    encryptString: () => { throw new Error("encrypt should not run"); },
    decryptString: () => { throw new Error("decrypt should not run"); },
  };
}

function spawnNode(args: string[]): ChildProcess {
  return spawn(nodeCommand, ["--import=tsx", ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit({ code, stderr }));
  });
}

function parseDocument(path: string): {
  version: number;
  entries: Record<string, { encoding: string; value: string }>;
} {
  return JSON.parse(readFileSync(path, "utf-8")) as ReturnType<typeof parseDocument>;
}

describe("SecretDocumentStore atomicity and policy", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lvis-secret-document-"));
    path = join(root, "lvis-secrets.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("serializes same-process set/set without losing either key", async () => {
    const first = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    const second = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });

    await Promise.all([first.set("alpha", "one"), second.set("beta", "two")]);

    expect(first.get("alpha")).toBe("one");
    expect(first.get("beta")).toBe("two");
  });

  it("serializes same-process set/delete against the locked fresh document", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    await store.set("remove", "old");
    await Promise.all([store.set("keep", "new"), store.delete("remove")]);
    expect(store.get("keep")).toBe("new");
    expect(store.get("remove")).toBeNull();
  });

  it("applies bulk deletion as one exact-key mutation", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    await store.set("plugin.alpha.token", "one");
    await store.set("plugin.alpha.token.extra", "two");
    await store.set("plugin.beta.token", "three");

    await expect(store.deleteMany(["plugin.alpha.token", "plugin.beta.token"])).resolves.toBe(2);
    expect(store.get("plugin.alpha.token")).toBeNull();
    expect(store.get("plugin.alpha.token.extra")).toBe("two");
    expect(store.get("plugin.beta.token")).toBeNull();
  });

  it("stores and deletes keys that collide with object prototypes", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });

    await store.set("__proto__", "prototype-value");
    await store.set("toString", "method-value");

    expect(store.get("__proto__")).toBe("prototype-value");
    expect(store.get("toString")).toBe("method-value");
    await expect(store.delete("__proto__")).resolves.toBe(true);
    await expect(store.deleteMany(["toString", "constructor"])).resolves.toBe(1);
    expect(store.get("__proto__")).toBeNull();
    expect(store.get("toString")).toBeNull();
  });

  it("serializes cross-process set/set", async () => {
    const first = spawnNode([childFixture, "set", path, "alpha", "one"]);
    const second = spawnNode([childFixture, "set", path, "beta", "two"]);
    const results = await Promise.all([waitForExit(first), waitForExit(second)]);
    expect(results, results.map((result) => result.stderr).join("\n")).toEqual([
      expect.objectContaining({ code: 0 }),
      expect.objectContaining({ code: 0 }),
    ]);
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    expect(store.get("alpha")).toBe("one");
    expect(store.get("beta")).toBe("two");
  }, 20_000);

  it("serializes cross-process set/delete", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    await store.set("remove", "old");
    const first = spawnNode([childFixture, "set", path, "keep", "new"]);
    const second = spawnNode([childFixture, "delete", path, "remove"]);
    const results = await Promise.all([waitForExit(first), waitForExit(second)]);
    expect(results.every((result) => result.code === 0), results.map((result) => result.stderr).join("\n")).toBe(true);
    expect(store.get("keep")).toBe("new");
    expect(store.get("remove")).toBeNull();
  }, 20_000);

  it("serializes cross-process bulk deletion with an unrelated set", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    await store.set("remove-alpha", "old-alpha");
    await store.set("remove-beta", "old-beta");
    await store.set("preserve", "old-preserve");
    const first = spawnNode([childFixture, "delete-many", path, "remove-alpha", "remove-beta"]);
    const second = spawnNode([childFixture, "set", path, "concurrent", "new"]);
    const results = await Promise.all([waitForExit(first), waitForExit(second)]);
    expect(results.every((result) => result.code === 0), results.map((result) => result.stderr).join("\n")).toBe(true);
    expect(store.get("remove-alpha")).toBeNull();
    expect(store.get("remove-beta")).toBeNull();
    expect(store.get("preserve")).toBe("old-preserve");
    expect(store.get("concurrent")).toBe("new");
  }, 20_000);

  it.each([
    "{\"version\":1",
    "[]",
    JSON.stringify({ version: 1, entries: { key: { encoding: "safe-storage", value: 7 } } }),
    JSON.stringify({ version: 1, entries: { key: { encoding: "unknown", value: "abc" } } }),
    JSON.stringify({ version: 1, entries: { key: { encoding: "safe-storage", value: "not-base64" } } }),
  ])("preserves invalid bytes and fails visibly: %s", async (raw) => {
    writeFileSync(path, raw, { mode: 0o600 });
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    expect(() => store.get("key")).toThrow(SecretDocumentValidationError);
    await expect(store.set("next", "value")).rejects.toThrow(SecretDocumentValidationError);
    expect(readFileSync(path, "utf-8")).toBe(raw);
  });

  it("does not include corrupt plaintext or secret keys in validation errors", async () => {
    const plaintext = "TOP-SECRET-API-KEY";
    writeFileSync(path, plaintext, { mode: 0o600 });
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    let message = "";
    try {
      store.get("provider.secret.key");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Secret document contains invalid JSON");
    expect(message).not.toContain(plaintext);
    expect(message).not.toContain("provider.secret.key");
  });

  it("rejects an invalid mutation key before creating an unreadable document", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    await expect(store.set("", "value")).rejects.toThrow(SecretDocumentValidationError);
    expect(lstatSync.bind(null, path)).toThrow();
  });

  it("uses plaintext only under explicit development policy", async () => {
    const store = new SecretDocumentStore({ path, policy: "development", encryption: unavailableEncryption() });
    await store.set("api", "development-secret");
    expect(store.get("api")).toBe("development-secret");
    expect(parseDocument(path).entries.api).toEqual({
      encoding: "plain-development",
      value: "development-secret",
    });
  });

  it("packaged policy creates no plaintext and rejects every write when encryption is unavailable", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: unavailableEncryption() });
    await expect(store.set("api", "must-not-land")).rejects.toThrow(SecretEncryptionUnavailableError);
    expect(() => readFileSync(path, "utf-8")).toThrow();

    writeFileSync(path, `${JSON.stringify({
      version: 1,
      entries: { api: { encoding: "plain-development", value: "must-not-return" } },
    })}\n`, { mode: 0o600 });
    expect(() => store.get("api")).toThrow(SecretEncryptionUnavailableError);
    expect(() => store.getEncrypted("api")).toThrow(SecretEncryptionUnavailableError);
    expect(store.get("missing")).toBeNull();
    expect(store.getEncrypted("missing")).toBeNull();
    await expect(store.delete("api")).rejects.toThrow(SecretEncryptionUnavailableError);
    expect(readFileSync(path, "utf-8")).toContain("must-not-return");
  });

  it.each(["basic_text", "unknown"] as const)(
    "treats the packaged Linux %s backend as unavailable",
    async (backend) => {
      const store = new SecretDocumentStore({
        path,
        policy: "packaged",
        platform: "linux",
        encryption: availableEncryption({ getSelectedStorageBackend: () => backend }),
      });
      await expect(store.set("api", "must-not-land")).rejects.toThrow(SecretEncryptionUnavailableError);
      expect(lstatSync.bind(null, path)).toThrow();
    },
  );

  it("fails packaged Linux migration and reads closed on an existing basic_text document", async () => {
    const original = `${JSON.stringify({
      version: 1,
      entries: {
        api: {
          encoding: "safe-storage",
          value: Buffer.from("sealed:legacy-basic-text").toString("base64"),
        },
      },
    })}\n`;
    writeFileSync(path, original, { mode: 0o600 });
    const store = new SecretDocumentStore({
      path,
      policy: "packaged",
      platform: "linux",
      encryption: availableEncryption({ getSelectedStorageBackend: () => "basic_text" }),
    });
    await expect(store.migrate()).rejects.toThrow(SecretEncryptionUnavailableError);
    expect(() => store.get("api")).toThrow(SecretEncryptionUnavailableError);
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("accepts a protected packaged Linux secret backend", async () => {
    const store = new SecretDocumentStore({
      path,
      policy: "packaged",
      platform: "linux",
      encryption: availableEncryption({ getSelectedStorageBackend: () => "kwallet6" }),
    });
    await store.set("api", "protected");
    expect(store.get("api")).toBe("protected");
  });

  it("fails closed when an encrypted entry cannot be decrypted", async () => {
    writeFileSync(path, `${JSON.stringify({
      version: 1,
      entries: { api: { encoding: "safe-storage", value: Buffer.from("sealed:value").toString("base64") } },
    })}\n`, { mode: 0o600 });
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: unavailableEncryption() });

    expect(() => store.get("api")).toThrow(SecretEncryptionUnavailableError);
    expect(() => store.getEncrypted("api")).toThrow(SecretEncryptionUnavailableError);
    expect(store.get("missing")).toBeNull();
    expect(store.getEncrypted("missing")).toBeNull();
  });

  it("accepts a legacy flat map only during explicit migration", async () => {
    const legacy = `${JSON.stringify({ api: "plain:legacy", token: "plain:second" })}\n`;
    writeFileSync(path, legacy, { mode: 0o600 });
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    expect(() => store.get("api")).toThrow(SecretDocumentValidationError);
    await expect(store.set("next", "value")).rejects.toThrow(SecretDocumentValidationError);
    expect(readFileSync(path, "utf-8")).toBe(legacy);
    await expect(store.migrate()).resolves.toBe(true);
    expect(store.get("api")).toBe("legacy");
    expect(store.get("token")).toBe("second");
    expect(readFileSync(path, "utf-8")).not.toContain("legacy");
  });

  it.each([
    { version: "plain:not-a-version", entries: "plain:not-an-object" },
    { version: "plain:not-a-version" },
    { entries: "plain:not-an-object" },
  ])("preserves malformed versioned documents instead of treating them as legacy: %j", async (document) => {
    const original = `${JSON.stringify(document)}\n`;
    writeFileSync(path, original, { mode: 0o600 });
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    await expect(store.migrate()).rejects.toThrow(SecretDocumentValidationError);
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("wraps decryption failures without disclosing ciphertext or key names", async () => {
    const ciphertext = Buffer.from("sealed:secret").toString("base64");
    writeFileSync(path, `${JSON.stringify({
      version: 1,
      entries: { "provider.secret.key": { encoding: "safe-storage", value: ciphertext } },
    })}\n`, { mode: 0o600 });
    const store = new SecretDocumentStore({
      path,
      policy: "packaged",
      encryption: availableEncryption({ decryptString: () => { throw new Error("ciphertext leaked"); } }),
    });
    expect(() => store.get("provider.secret.key")).toThrow(SecretDocumentDecryptionError);
    try {
      store.get("provider.secret.key");
    } catch (error) {
      expect((error as Error).message).toBe("Stored secret could not be decrypted");
      expect((error as Error).message).not.toContain(ciphertext);
      expect((error as Error).message).not.toContain("provider.secret.key");
    }
  });

  it("preserves old bytes when encrypting all development entries fails part-way", async () => {
    const original = `${JSON.stringify({
      version: 1,
      entries: {
        alpha: { encoding: "plain-development", value: "one" },
        beta: { encoding: "plain-development", value: "two" },
      },
    }, null, 2)}\n`;
    writeFileSync(path, original, { mode: 0o600 });
    const encryptString = vi.fn((value: string) => {
      if (value === "two") throw new Error("injected encryption failure");
      return Buffer.from(`sealed:${value}`);
    });
    const store = new SecretDocumentStore({
      path,
      policy: "packaged",
      encryption: availableEncryption({ encryptString }),
    });

    await expect(store.migrate()).rejects.toThrow("injected encryption failure");
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("preserves old bytes on a pre-rename atomic failure", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    await store.set("old", "value");
    const original = readFileSync(path, "utf-8");
    const failing = new SecretDocumentStore({
      path,
      policy: "packaged",
      encryption: availableEncryption(),
      runtime: { writeAtomic: () => { throw new Error("injected pre-rename failure"); } },
    });
    await expect(failing.set("new", "value")).rejects.toThrow("injected pre-rename failure");
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("accepts a committed post-rename sync error only after exact-byte reconciliation", async () => {
    const warn = vi.fn();
    const store = new SecretDocumentStore({
      path,
      policy: "packaged",
      encryption: availableEncryption(),
      runtime: {
        writeAtomic: (target, content, mode) => {
          writeUtf8FileAtomicSync(target, content, mode);
          throw Object.assign(new Error("injected directory sync failure"), { committed: true });
        },
        warn,
      },
    });
    await expect(store.set("api", "value")).resolves.toBeUndefined();
    expect(store.get("api")).toBe("value");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      reason: "atomic-directory-sync-unconfirmed",
      path,
      error: expect.any(Error),
    }));
  });

  it("rejects committed ambiguity when the target bytes do not match", async () => {
    const mismatched = "{\"tampered\":true}\n";
    const store = new SecretDocumentStore({
      path,
      policy: "packaged",
      encryption: availableEncryption(),
      runtime: {
        writeAtomic: (target) => {
          writeFileSync(target, mismatched, { mode: 0o600 });
          throw Object.assign(new Error("injected directory sync failure"), { committed: true });
        },
      },
    });
    await expect(store.set("api", "value")).rejects.toThrow("injected directory sync failure");
    expect(readFileSync(path, "utf-8")).toBe(mismatched);
  });

  it("accepts lock release ambiguity only when exact intended bytes remain", async () => {
    const warn = vi.fn();
    const store = new SecretDocumentStore({
      path,
      policy: "packaged",
      encryption: availableEncryption(),
      runtime: {
        lock: async (_anchor, callback) => {
          const result = await callback();
          throw new FileLockReleaseError(result, new Error("injected release failure"));
        },
        warn,
      },
    });
    await expect(store.set("api", "value")).resolves.toBeUndefined();
    expect(store.get("api")).toBe("value");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      reason: "lock-release-failed-after-commit",
      path,
      error: expect.any(Error),
    }));
  });

  it("rejects lock release ambiguity when the committed bytes changed", async () => {
    const mismatched = "{\"tampered\":true}\n";
    const store = new SecretDocumentStore({
      path,
      policy: "packaged",
      encryption: availableEncryption(),
      runtime: {
        lock: async (_anchor, callback) => {
          const result = await callback();
          writeFileSync(path, mismatched, { mode: 0o600 });
          throw new FileLockReleaseError(result, new Error("injected release failure"));
        },
      },
    });
    await expect(store.set("api", "value")).rejects.toThrow(FileLockReleaseError);
    expect(readFileSync(path, "utf-8")).toBe(mismatched);
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked secret document without reading its target", async () => {
    const externalPath = join(root, "outside.json");
    const external = `${JSON.stringify({
      version: 1,
      entries: {
        api: {
          encoding: "safe-storage",
          value: Buffer.from("sealed:outside-secret").toString("base64"),
        },
      },
    })}\n`;
    writeFileSync(externalPath, external, { mode: 0o600 });
    symlinkSync(externalPath, path);
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });

    await expect(store.migrate()).rejects.toThrow(SecretDocumentValidationError);
    expect(() => store.get("api")).toThrow(SecretDocumentValidationError);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(externalPath, "utf-8")).toBe(external);
  });

  it.skipIf(process.platform === "win32")("repairs corrupt secret-file permissions before reporting corruption", async () => {
    const original = "TOP-SECRET-INVALID-JSON";
    writeFileSync(path, original, { mode: 0o644 });
    chmodSync(path, 0o644);
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });

    await expect(store.migrate()).rejects.toThrow(SecretDocumentValidationError);
    expect(readFileSync(path, "utf-8")).toBe(original);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("promotes the canonical document with mode 0600", async () => {
    const store = new SecretDocumentStore({ path, policy: "packaged", encryption: availableEncryption() });
    await store.set("api", "value");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    await expect(store.migrate()).resolves.toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
