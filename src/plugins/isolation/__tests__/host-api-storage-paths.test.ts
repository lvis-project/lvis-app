/**
 * `hostApi.storage.*` across the process boundary, child stub to host handler
 * and back.
 *
 * Driven through the REAL pieces on both ends — `createChildStorageMembers`
 * assembled by `createChildHostApiStub`, a real `HostApiDispatcher` over the
 * real dispatch table, and a real `PluginStorage` on a real temp directory.
 * The only stand-in is the channel, which is a direct call rather than a pipe;
 * that is the transport decision the blueprint leaves open, and everything
 * above it is the code that ships.
 *
 * The group is read/write × raw/text/json/encrypted, so most of what is proven
 * here is that the four asymmetries are the only ones: `read` re-encodes its
 * result, `write` re-encodes its argument, the encrypted pair can fail for a
 * reason that has nothing to do with the file, and `resolve` never leaves the
 * child. Everything else is plain JSON both ways.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reversible fake safeStorage seam, the same one `storage.test.ts` uses:
// `encryptString` wraps the plaintext in a recognisable envelope so the
// on-disk bytes are demonstrably not plaintext, and `enc.available` toggles
// the isEncryptionAvailable gate per test.
const mockedElectron = vi.hoisted(() => {
  const enc = { available: true };
  return {
    enc,
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => enc.available),
      encryptString: vi.fn((s: string) => Buffer.from(`ENC(${s})`, "utf-8")),
      decryptString: vi.fn((b: Buffer) => {
        const raw = Buffer.from(b).toString("utf-8");
        const match = /^ENC\(([\s\S]*)\)$/.exec(raw);
        if (!match) throw new Error("decryptString: not ciphertext from this seam");
        return match[1];
      }),
    },
  };
});
vi.mock("electron", () => ({ safeStorage: mockedElectron.safeStorage }));

import { EffectBoundaryDeniedError } from "../../../permissions/effect-enforcement.js";
import { cleanupTmpDir } from "../../../testing/tmp-dir-teardown.js";
import { PluginStorageError } from "../../public-contract.js";
import { createNoopHostApi } from "../../runtime/sandbox.js";
import type { PluginHostApi, PluginStorage } from "../../types.js";
import { createChildStorageMembers } from "../child-storage-members.js";
import { HostApiDispatcher, type HostApiCall } from "../host-api-dispatcher.js";
import { readStorageBytes } from "../host-api-storage-paths.js";
import { HOSTAPI_PATH_CONTRACTS } from "../host-api-path-contracts.js";
import {
  HOST_API_WIRE_VERSION,
  PluginHostApiError,
  WIRE_BYTES_MAX,
  type ChildNotificationSink,
  type HostApiChannel,
  type HostApiRequest,
  type WireBytes,
} from "../host-api-wire.js";
import {
  createChildHostApiStub,
  createHostApiCaller,
  unimplementedChildMember,
} from "../plugin-child-runtime.js";

const PLUGIN_ID = "com.example.storage";
const GENERATION = "gen-3";
const silentSink: ChildNotificationSink = { deliver: () => {} };

/**
 * Bytes a text codec would corrupt: a NUL, lone high bytes, a truncated
 * multi-byte sequence, and an encoded surrogate half. Round-tripped through
 * `utf8` every one of these comes back as U+FFFD — a successful call that
 * returned different bytes, which is the failure the tagged codec exists for.
 */
const HOSTILE_BYTES = new Uint8Array([
  0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x41, 0x00, 0xed, 0xa0, 0x80, 0x7f,
]);

interface Harness {
  readonly storage: PluginStorage;
  readonly dataDir: string;
  readonly requests: HostApiRequest[];
  /** Send a hand-built request, bypassing the child stub's marshalling. */
  readonly raw: (path: string, args: readonly unknown[]) => Promise<unknown>;
}

let dataDir: string;

beforeEach(() => {
  mockedElectron.enc.available = true;
  dataDir = mkdtempSync(join(tmpdir(), "lvis-storage-boundary-"));
});

afterEach(async () => {
  await cleanupTmpDir(dataDir);
});

/** Both ends wired together; `hostApi` overrides the host implementation. */
function harness(hostApi: PluginHostApi = createNoopHostApi(PLUGIN_ID, dataDir)): Harness {
  const requests: HostApiRequest[] = [];
  const host = new HostApiDispatcher({
    pluginId: PLUGIN_ID,
    generationId: GENERATION,
    isActive: () => true,
    hostApi,
    notifications: silentSink,
  });
  const channel: HostApiChannel = {
    call: (request) => {
      requests.push(request);
      return host.handle(request);
    },
    notify: () => {},
  };
  const context = { pluginId: PLUGIN_ID, generationId: GENERATION };
  const members = createChildStorageMembers({
    pluginId: PLUGIN_ID,
    pluginDataDir: dataDir,
    call: createHostApiCaller(channel, context),
  });
  // Assembled the way the child runtime assembles it, so the nesting under
  // `storage.` is the production one rather than a hand-built object.
  const stub = createChildHostApiStub(
    PLUGIN_ID,
    (path) => members[path] ?? unimplementedChildMember(PLUGIN_ID, path),
  );
  return {
    storage: stub.storage,
    dataDir,
    requests,
    raw: async (path, args) => {
      const reply = await host.handle({
        wire: HOST_API_WIRE_VERSION,
        pluginId: PLUGIN_ID,
        generationId: GENERATION,
        callId: "raw",
        path,
        args,
      } as HostApiRequest);
      if (reply.ok) return reply.value;
      throw new PluginHostApiError(reply.error);
    },
  };
}

/** The code a failed reply carried, or a failure naming what came back instead. */
async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof PluginHostApiError) return error.code;
    return `not a wire error: ${String(error)}`;
  }
  return "resolved";
}

/** Every dispatchable member of the group, called with a traversal path. */
const TRAVERSAL_CALLS: ReadonlyArray<readonly [string, (s: PluginStorage) => Promise<unknown>]> = [
  ["storage.read", (s) => s.read("../escape.bin")],
  ["storage.readText", (s) => s.readText("../escape.txt")],
  ["storage.readJson", (s) => s.readJson("../escape.json")],
  ["storage.list", (s) => s.list("../")],
  ["storage.exists", (s) => s.exists("../escape.txt")],
  ["storage.write", (s) => s.write("../escape.txt", "x")],
  ["storage.writeJson", (s) => s.writeJson("../escape.json", { a: 1 })],
  ["storage.rm", (s) => s.rm("../escape.txt")],
  ["storage.mkdir", (s) => s.mkdir("../escape")],
  ["storage.writeEncrypted", (s) => s.writeEncrypted("../escape.enc", "x")],
  ["storage.readEncrypted", (s) => s.readEncrypted("../escape.enc")],
];

describe("storage.resolve is answered in the child", () => {
  it("joins under the data root without a round trip", () => {
    const { storage, requests } = harness();
    expect(storage.resolve("nested", "file.txt")).toBe(join(dataDir, "nested/file.txt"));
    expect(storage.resolve()).toBe(dataDir);
    expect(requests).toHaveLength(0);
  });

  it("refuses an escape with the same class the host raises", () => {
    const { storage } = harness();
    expect(() => storage.resolve("..", "evil.txt")).toThrow(PluginStorageError);
    expect(() => storage.resolve("/etc/passwd")).toThrow(/absolute paths are not allowed/);
    // Not a string: refused with a diagnostic naming the plugin, rather than
    // the bare TypeError `path.join` would raise.
    expect(() => (storage.resolve as (...a: unknown[]) => string)(7)).toThrow(
      PluginStorageError,
    );
  });

  it("refuses the same call if a child sends it anyway", async () => {
    const { raw } = harness();
    expect(await codeOf(raw("storage.resolve", ["a"]))).toBe("path-not-dispatchable");
  });
});

describe("bytes survive the boundary unchanged", () => {
  it("round-trips content a text codec would corrupt", async () => {
    const { storage, requests } = harness();
    await storage.write("blob.bin", HOSTILE_BYTES);
    const read = await storage.read("blob.bin");
    expect(Array.from(read)).toEqual(Array.from(HOSTILE_BYTES));
    // The file on disk holds the raw bytes, not a base64 transcript of them.
    expect(Array.from(readFileSync(join(dataDir, "blob.bin")))).toEqual(
      Array.from(HOSTILE_BYTES),
    );
    // Both directions carried the base64 tag rather than the utf8 one.
    expect((requests[0].args[1] as WireBytes).encoding).toBe("base64");
  });

  it("keeps a base64-looking STRING verbatim, which the tag is what stops", async () => {
    const { storage, requests } = harness();
    await storage.write("verbatim.txt", "aGVsbG8=");
    expect((requests[0].args[1] as WireBytes).encoding).toBe("utf8");
    expect(readFileSync(join(dataDir, "verbatim.txt"), "utf-8")).toBe("aGVsbG8=");
  });

  it("still honours the separate StorageEncoding argument", async () => {
    const { storage } = harness();
    // The wire tag says "this crossed as text"; the encoding argument says
    // "interpret that text as base64 when writing". Two different questions.
    await storage.write("decoded.bin", "aGVsbG8=", "base64");
    expect(readFileSync(join(dataDir, "decoded.bin"), "utf-8")).toBe("hello");
    expect(await storage.readText("decoded.bin", "base64")).toBe("aGVsbG8=");
  });

  it("returns bytes, not the `{type:'Buffer'}` a naive round trip produces", async () => {
    const { storage } = harness();
    await storage.write("blob.bin", HOSTILE_BYTES);
    const read = await storage.read("blob.bin");
    expect(read).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(JSON.stringify(read))).not.toHaveProperty("type", "Buffer");
  });

  it("refuses a payload over the boundary limit instead of truncating it", async () => {
    const { storage, requests } = harness();
    await expect(
      storage.write("huge.bin", new Uint8Array(WIRE_BYTES_MAX + 1)),
    ).rejects.toMatchObject({ code: "payload-too-large" });
    // Refused at the child's own call site: nothing was sent, nothing landed.
    expect(requests).toHaveLength(0);
    expect(existsSync(join(dataDir, "huge.bin"))).toBe(false);
  });

  it("refuses an over-limit READ rather than handing back part of the file", async () => {
    const oversized: PluginHostApi = {
      ...createNoopHostApi(PLUGIN_ID, dataDir),
      storage: {
        ...createNoopHostApi(PLUGIN_ID, dataDir).storage,
        read: async () => new Uint8Array(WIRE_BYTES_MAX + 1),
      },
    };
    const call: HostApiCall = {
      path: "storage.read",
      callId: "c1",
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      args: ["big.bin"],
      hostApi: oversized,
    };
    await expect(readStorageBytes(call)).rejects.toMatchObject({
      code: "payload-too-large",
    });
  });
});

describe("the plain-json members carry their declared values", () => {
  it("reads text with and without an explicit encoding", async () => {
    const { storage } = harness();
    await storage.write("note.txt", "안녕하세요");
    // No encoding supplied: the argument must be ABSENT on the wire, because
    // `undefined` inside an args array is refused outright.
    expect(await storage.readText("note.txt")).toBe("안녕하세요");
    expect(await storage.readText("note.txt", "utf-8")).toBe("안녕하세요");
    expect(await storage.readText("note.txt", "hex")).toBe(
      Buffer.from("안녕하세요", "utf-8").toString("hex"),
    );
  });

  it("round-trips JSON and answers null for a missing file", async () => {
    const { storage } = harness();
    await storage.writeJson("state.json", { nested: { list: [1, null, "x"] } });
    expect(await storage.readJson("state.json")).toEqual({
      nested: { list: [1, null, "x"] },
    });
    expect(await storage.readJson("missing.json")).toBeNull();
  });

  it("passes the indent argument through", async () => {
    const { storage } = harness();
    await storage.writeJson("wide.json", { a: 1 }, 4);
    expect(readFileSync(join(dataDir, "wide.json"), "utf-8")).toBe('{\n    "a": 1\n}');
    await storage.writeJson("narrow.json", { a: 1 });
    expect(readFileSync(join(dataDir, "narrow.json"), "utf-8")).toBe('{\n  "a": 1\n}');
  });

  it("lists the root and a subdirectory, and empty for a missing one", async () => {
    const { storage } = harness();
    await storage.mkdir("nested");
    await storage.write("nested/a.txt", "a");
    await storage.write("nested/b.txt", "b");
    expect((await storage.list()).sort()).toEqual(["nested"]);
    expect((await storage.list("nested")).sort()).toEqual(["a.txt", "b.txt"]);
    expect(await storage.list("absent")).toEqual([]);
  });

  it("reports existence and removes files and trees", async () => {
    const { storage } = harness();
    expect(await storage.exists("gone.txt")).toBe(false);
    await storage.write("gone.txt", "x");
    expect(await storage.exists("gone.txt")).toBe(true);
    await storage.rm("gone.txt");
    expect(await storage.exists("gone.txt")).toBe(false);

    await storage.mkdir("tree/inner");
    await storage.write("tree/inner/deep.txt", "x");
    await storage.rm("tree", { recursive: true });
    expect(await storage.exists("tree")).toBe(false);
  });

  it("creates a directory recursively", async () => {
    const { storage } = harness();
    await storage.mkdir("a/b/c");
    expect(await storage.exists("a/b/c")).toBe(true);
  });
});

describe("the encrypted pair fails for its own reasons", () => {
  it("round-trips a secret and never writes the plaintext", async () => {
    const { storage } = harness();
    await storage.writeEncrypted("auth/token.enc", "s3cret");
    // The seam's envelope, not the plaintext — what lands on disk is whatever
    // `encryptString` produced, and it came back through the boundary intact.
    expect(readFileSync(join(dataDir, "auth/token.enc"), "utf-8")).toBe("ENC(s3cret)");
    expect(mockedElectron.safeStorage.encryptString).toHaveBeenCalledWith("s3cret");
    expect(await storage.readEncrypted("auth/token.enc")).toBe("s3cret");
  });

  it("reports an absent key with its own code, and writes nothing", async () => {
    const { storage } = harness();
    mockedElectron.enc.available = false;
    expect(await codeOf(storage.writeEncrypted("nokey.enc", "s3cret"))).toBe(
      "plugin-storage-encryption-unavailable",
    );
    expect(existsSync(join(dataDir, "nokey.enc"))).toBe(false);
    expect(await codeOf(storage.readEncrypted("nokey.enc"))).toBe(
      "plugin-storage-encryption-unavailable",
    );
  });

  it("distinguishes a missing key from a missing file", async () => {
    const { storage } = harness();
    // Encryption available, file absent: NOT the encryption code. Conflating
    // the two would tell a plugin to re-provision a key it already has.
    expect(await codeOf(storage.readEncrypted("absent.enc"))).toBe("host-internal");
    mockedElectron.enc.available = false;
    expect(await codeOf(storage.readEncrypted("absent.enc"))).toBe(
      "plugin-storage-encryption-unavailable",
    );
  });

  it("lets a path refusal win over the encryption check", async () => {
    const { storage } = harness();
    mockedElectron.enc.available = false;
    expect(await codeOf(storage.writeEncrypted("../out.enc", "x"))).toBe("plugin-storage");
  });
});

describe("every member reports the errors its contract lists", () => {
  it.each(TRAVERSAL_CALLS)("%s refuses an escape as plugin-storage", async (path, run) => {
    expect(HOSTAPI_PATH_CONTRACTS[path as "storage.read"].errors).toContain(
      "plugin-storage",
    );
    const { storage } = harness();
    expect(await codeOf(run(storage))).toBe("plugin-storage");
  });

  it("keeps the host error's own name and detail across the wire", async () => {
    const { storage } = harness();
    await storage.read("../escape.bin").catch((error: unknown) => {
      expect(error).toBeInstanceOf(PluginHostApiError);
      expect((error as PluginHostApiError).name).toBe("PluginStorageError");
      expect((error as PluginHostApiError).detail).toMatchObject({
        pluginId: PLUGIN_ID,
        attemptedPath: "../escape.bin",
      });
    });
    expect.assertions(3);
  });

  it("carries a denied mutation as effect-boundary-denied", async () => {
    const base = createNoopHostApi(PLUGIN_ID, dataDir);
    const denied: PluginHostApi = {
      ...base,
      storage: {
        ...base.storage,
        write: async () => {
          throw new EffectBoundaryDeniedError(
            PLUGIN_ID,
            "storage.write",
            "denied.txt",
            "denied",
          );
        },
      },
    };
    const { storage } = harness(denied);
    expect(HOSTAPI_PATH_CONTRACTS["storage.write"].errors).toContain(
      "effect-boundary-denied",
    );
    expect(await codeOf(storage.write("denied.txt", "x"))).toBe("effect-boundary-denied");
  });
});

describe("malformed arguments are refused, never coerced", () => {
  it("refuses a non-string path", async () => {
    const { raw } = harness();
    expect(await codeOf(raw("storage.read", [7]))).toBe("argument-marshalling-rejected");
    expect(await codeOf(raw("storage.exists", [null]))).toBe(
      "argument-marshalling-rejected",
    );
  });

  it("refuses an encoding outside the declared union", async () => {
    const { raw } = harness();
    expect(await codeOf(raw("storage.readText", ["a.txt", "rot13"]))).toBe(
      "argument-marshalling-rejected",
    );
    // A prototype member is not an encoding, whatever `in` would say.
    expect(await codeOf(raw("storage.readText", ["a.txt", "toString"]))).toBe(
      "argument-marshalling-rejected",
    );
  });

  it("refuses an untagged write payload", async () => {
    const { raw } = harness();
    expect(await codeOf(raw("storage.write", ["a.txt", "raw string"]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(await codeOf(raw("storage.write", ["a.txt", { encoding: "rot13", data: "x" }]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(existsSync(join(dataDir, "a.txt"))).toBe(false);
  });

  it("refuses an absent writeJson value rather than writing `undefined`", async () => {
    const { raw } = harness();
    expect(await codeOf(raw("storage.writeJson", ["j.json"]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(await codeOf(raw("storage.writeJson", ["j.json", { a: 1 }, 1.5]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(existsSync(join(dataDir, "j.json"))).toBe(false);
  });

  it("refuses an rm option it does not recognise", async () => {
    const { storage, raw } = harness();
    await storage.mkdir("keep/inner");
    expect(await codeOf(raw("storage.rm", ["keep", { recursive: "yes" }]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(await codeOf(raw("storage.rm", ["keep", { force: true }]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(await storage.exists("keep/inner")).toBe(true);
  });

  it("refuses a write payload that is neither text nor bytes, before sending it", async () => {
    const { storage, requests } = harness();
    await expect(
      (storage.write as (...a: unknown[]) => Promise<void>)("a.txt", { not: "bytes" }),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(requests).toHaveLength(0);
  });
});

describe("the boundary refuses a member the plugin is no longer entitled to", () => {
  it("stops a storage call from a retired incarnation", async () => {
    const host = new HostApiDispatcher({
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      isActive: () => false,
      hostApi: createNoopHostApi(PLUGIN_ID, dataDir),
      notifications: silentSink,
    });
    writeFileSync(join(dataDir, "live.txt"), "live");
    const reply = await host.handle({
      wire: HOST_API_WIRE_VERSION,
      pluginId: PLUGIN_ID,
      generationId: GENERATION,
      callId: "c1",
      path: "storage.read",
      args: ["live.txt"],
    });
    expect(reply.ok).toBe(false);
    expect(reply.ok === false && reply.error.code).toBe("plugin-inactive");
  });
});
