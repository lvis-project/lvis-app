/**
 * meeting#154 — Windows plugin install/update fails with
 * `EPERM: operation not permitted, rename '.<slug>.stage-…' -> '<slug>'`.
 *
 * Root cause (two compounding defects in `extractZipWithCommit`):
 *   1. The atomic dir-swap used a bare `rename()` with no retry. On Windows a
 *      `rename()` of a directory rejects with EPERM while any file inside it
 *      is held open by another process (a still-running plugin webview/worker,
 *      an antivirus scan). The lock is transient — it clears within a few
 *      hundred ms of the previous instance tearing down — but the bare rename
 *      gave up on the first EPERM.
 *   2. `rename(installDir, oldDir)` swallowed *every* error as "first install".
 *      A locked (not absent) installDir was misread as absent, so promotion
 *      then targeted a still-present, still-locked installDir and failed with
 *      the exact EPERM in the issue's stack trace.
 *
 * Proof strategy:
 *   - Deterministic (all platforms): drive `retryOnTransientFsLock` directly to
 *     show the retry ladder recovers transient locks, does NOT retry ENOENT,
 *     and rethrows after exhausting attempts.
 *   - Real hardware (win32 only): hold an OS file handle inside installDir to
 *     produce a genuine EPERM, then release it mid-flight and assert the
 *     install recovers. Against the pre-fix call sites this test FAILS with the
 *     issue's EPERM; against the fixed call sites it passes.
 */
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isTransientFsLockError,
  PluginArtifactStore,
  retryOnTransientFsLock,
} from "../plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";

function makeStore(tmpDir: string): PluginArtifactStore {
  const fetcher = {
    listPlugins: async () => [],
    getPluginDetail: async () => null,
    downloadVersion: async () => ({ zipBuffer: Buffer.alloc(0), sha256: "x" }),
    listAnnouncements: async () => [],
  } satisfies MarketplaceFetcher;
  return new PluginArtifactStore({
    installRoot: resolve(tmpDir, "installed"),
    cacheRoot: resolve(tmpDir, "cache"),
    fetcher,
    publicKeys: {},
    tarballCacheBase: null,
  });
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "artifact-store-winlock-"));
}

function lockError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated lock`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("retryOnTransientFsLock", () => {
  const noSleep = { sleep: async () => {} };

  it("recovers when a transient lock clears within the retry budget", async () => {
    let calls = 0;
    const result = await retryOnTransientFsLock(async () => {
      calls += 1;
      if (calls < 3) throw lockError("EPERM");
      return "promoted";
    }, noSleep);
    expect(result).toBe("promoted");
    expect(calls).toBe(3);
  });

  it("does NOT retry ENOENT — an absent source is a first-install signal", async () => {
    let calls = 0;
    await expect(
      retryOnTransientFsLock(async () => {
        calls += 1;
        throw lockError("ENOENT");
      }, noSleep),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("rethrows the last error after exhausting attempts on a persistent lock", async () => {
    let calls = 0;
    await expect(
      retryOnTransientFsLock(
        async () => {
          calls += 1;
          throw lockError("EBUSY");
        },
        { ...noSleep, attempts: 4 },
      ),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(4);
  });

  it("classifies the Windows lock codes as transient but not ENOENT", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"]) {
      expect(isTransientFsLockError(lockError(code))).toBe(true);
    }
    expect(isTransientFsLockError(lockError("ENOENT"))).toBe(false);
    expect(isTransientFsLockError(new Error("no code"))).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32")(
  "extractZipWithCommit — real Windows file-lock (meeting#154 repro)",
  () => {
    it("updates the plugin when a transient in-dir lock clears mid-swap", async () => {
      const tmp = makeTmpDir();
      try {
        const store = makeStore(tmp);
        const installDir = store.installDirFor("meeting");
        await mkdir(installDir, { recursive: true });
        // Simulate the previously-installed, still-running plugin: a file
        // inside installDir held open by another handle locks the whole dir
        // against rename on Windows.
        const lockedFile = resolve(installDir, "runtime.lock");
        await writeFile(lockedFile, "held by running plugin");
        await writeFile(
          resolve(installDir, "plugin.json"),
          JSON.stringify({ id: "meeting", version: "old" }),
        );

        const handle = await open(lockedFile, "r");
        // Release the lock partway through the install's retry window,
        // mirroring the previous plugin instance finishing its teardown.
        const releaseTimer = setTimeout(() => {
          void handle.close();
        }, 300);

        const zip = new AdmZip();
        zip.addFile("plugin.json", Buffer.from(JSON.stringify({ id: "meeting", version: "new" })));

        try {
          const { files } = await store.extractZipWithCommit(
            "meeting",
            zip.toBuffer(),
            async () => undefined,
          );
          expect(files).toContain("plugin.json");
          const promoted = JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8"));
          expect(promoted.version).toBe("new");
        } finally {
          clearTimeout(releaseTimer);
          await handle.close().catch(() => undefined);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects and preserves the old install when the in-dir lock never clears", async () => {
      const tmp = makeTmpDir();
      try {
        const store = makeStore(tmp);
        const installDir = store.installDirFor("meeting");
        await mkdir(installDir, { recursive: true });
        const lockedFile = resolve(installDir, "runtime.lock");
        await writeFile(lockedFile, "held by running plugin");
        await writeFile(
          resolve(installDir, "plugin.json"),
          JSON.stringify({ id: "meeting", version: "old" }),
        );

        // Hold the lock for the whole install: the `installDir->old` rename
        // exhausts its retry ladder and the non-ENOENT error must surface
        // (the fixed catch rethrows it instead of misreading it as "first
        // install"), leaving the previous install untouched — never a
        // half-promoted or overwritten state.
        //
        // Doubles as an erosion guard: if a future libuv stops blocking the
        // dir rename while a file inside is held open, the install would
        // *succeed* here and this `rejects` assertion would fail loudly rather
        // than the lock path silently going uncovered.
        const handle = await open(lockedFile, "r");
        try {
          const zip = new AdmZip();
          zip.addFile("plugin.json", Buffer.from(JSON.stringify({ id: "meeting", version: "new" })));

          await expect(
            store.extractZipWithCommit("meeting", zip.toBuffer(), async () => undefined),
          ).rejects.toThrow(/EPERM|EBUSY|EACCES|EEXIST|ENOTEMPTY/);

          const preserved = JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8"));
          expect(preserved.version).toBe("old");
        } finally {
          await handle.close().catch(() => undefined);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);
