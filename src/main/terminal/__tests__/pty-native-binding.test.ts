/**
 * node-pty's binding model, EXECUTED instead of asserted in a comment.
 *
 * The app runs no per-Electron-ABI `electron-rebuild` for node-pty: node-pty is
 * N-API (ABI-stable, `node-addon-api` dependency) and its own loader
 * (`lib/utils.js` `loadNativeModule`) is the single authority on where the
 * binding comes from — the first of `build/Release`, `build/Debug`,
 * `prebuilds/<platform>-<arch>` that loads. `scripts/electron-after-pack.cjs`
 * asserts the PACKAGED binding at that same resolved directory.
 *
 * These tests drive that real loader against the real installed module tree,
 * under the Electron test runtime (`scripts/run-vitest-under-electron.mjs`), so
 * an install/prebuild layout that cannot serve Electron fails here instead of at
 * the first terminal spawn with `ERR_DLOPEN_FAILED`.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nodeRequire = createRequire(import.meta.url);

/**
 * The Electron test runtime deletes `process.versions.electron` (see
 * `scripts/normalize-electron-node-runtime.mjs`), so the surviving markers are
 * the forked executable + `ELECTRON_RUN_AS_NODE`. `scripts/assert-electron-node-vitest.mjs`
 * (imported by `vitest.config.ts`) is the gate that enforces this for every run;
 * asserting it here too keeps the ABI claim below from silently degrading into a
 * plain-Node check if a test file is ever executed some other way.
 */
function electronRuntimeMarkers(): { executable: string; runAsNode?: string } {
  return {
    executable: basename(process.execPath).toLowerCase(),
    runAsNode: process.env.ELECTRON_RUN_AS_NODE,
  };
}

interface NodePtyUtils {
  loadNativeModule: (name: string) => {
    dir: string;
    module: Record<string, unknown>;
  };
}

/**
 * The binding's export surface is platform-shaped, so assert the exports
 * node-pty's OWN terminal implementation calls on this platform:
 *   - win32: `lib/windowsPtyAgent.js` → `startProcess`, `resize`, `kill`
 *   - posix: `lib/unixTerminal.js` → `fork`, `open`, `process`, `resize`
 * (CI caught a Windows-shaped list here: the Linux binding exports
 * `['fork','open','resize','process']` and has no `startProcess`/`kill`.)
 */
const REQUIRED_BINDING_EXPORTS = process.platform === "win32"
  ? ["startProcess", "resize", "kill"]
  : ["fork", "open", "process", "resize"];

const utilsPath = nodeRequire.resolve("node-pty/lib/utils.js");
const ptyModuleRoot = resolve(dirname(utilsPath), "..");
const prebuildDir = join(
  ptyModuleRoot,
  "prebuilds",
  `${process.platform}-${process.arch}`,
);

describe("node-pty native binding", () => {
  it("loads through node-pty's own loader under the Electron runtime", () => {
    expect(electronRuntimeMarkers()).toEqual({
      executable: expect.stringMatching(/^electron(\.exe)?$/u),
      runAsNode: "1",
    });

    const utils = nodeRequire(utilsPath) as NodePtyUtils;
    const loaded = utils.loadNativeModule("pty");

    expect(Object.keys(loaded.module)).toEqual(
      expect.arrayContaining(REQUIRED_BINDING_EXPORTS),
    );
  });

  it("resolves the binding from one of node-pty's documented search dirs", () => {
    const utils = nodeRequire(utilsPath) as NodePtyUtils;
    const loaded = utils.loadNativeModule("pty");

    // `loadNativeModule` returns a relative dir ("../build/Release/") resolved
    // against node-pty's `lib`; normalise it to an absolute path so this asserts
    // the same directory `electron-after-pack` reasons about.
    const resolvedDir = resolve(dirname(utilsPath), loaded.dir);
    expect([
      join(ptyModuleRoot, "build", "Release"),
      join(ptyModuleRoot, "build", "Debug"),
      prebuildDir,
    ]).toContain(resolvedDir);
  });

  it.runIf(existsSync(prebuildDir))(
    "dlopens the vendor prebuild itself under Electron (no per-ABI compile)",
    () => {
      // The claim that makes the postinstall `electron-rebuild` unnecessary:
      // the binary Microsoft publishes — built against Node headers, never
      // against Electron's — loads in this Electron process. Loaded directly so
      // a stale `build/Release` shadowing it cannot mask a broken prebuild.
      expect(electronRuntimeMarkers().runAsNode).toBe("1");
      const prebuilt = nodeRequire(join(prebuildDir, "pty.node")) as Record<
        string,
        unknown
      >;

      expect(Object.keys(prebuilt)).toEqual(
        expect.arrayContaining(REQUIRED_BINDING_EXPORTS),
      );
    },
  );
});
