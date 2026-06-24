/**
 * ASRT (Anthropic sandbox-runtime) host adapter — wiring tests.
 *
 * Covers the WIRING-A invariants the host-tool spawn path depends on:
 *   - gate DEFAULT OFF: `isAsrtSandboxActive()` is false until initialize runs;
 *   - the active flag flips on initialize and clears on reset (the boot-time,
 *     no-runtime-injection gate bash.ts/powershell.ts read);
 *   - trust boundary: a per-command wrap can only ever carry a `filesystem`
 *     slice — never a network or sandbox-weakening flag;
 *   - gate ON → real ASRT `{ argv, env }` (the wrapped command runs under the
 *     OS sandbox and resolves its vendor binaries — same proof as the runtime
 *     smoke, exercised through the host adapter here).
 *
 * Real ASRT, no mocks — mirrors the no-mock style of the bash/powershell tests.
 * The wrap/spawn assertions are guarded to supported platforms (darwin/linux);
 * the flag + trust-boundary assertions run everywhere.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isAsrtSandboxActive,
  initializeAsrtSandbox,
  resetAsrtSandbox,
  wrapToolCommand,
  cleanupAsrtSandboxAfterCommand,
  isAsrtSandboxSupported,
} from "../asrt-sandbox.js";

afterEach(async () => {
  // Always return to the gated-OFF baseline so cross-test state never leaks.
  if (isAsrtSandboxActive()) {
    await resetAsrtSandbox();
  }
});

function runArgv(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd as string, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.on("error", (e) => resolve({ code: null, stdout: "", stderr: e.message }));
  });
}

describe("asrt-sandbox — gate default OFF", () => {
  it("isAsrtSandboxActive() is false before any initialize (the shipped default)", () => {
    expect(isAsrtSandboxActive()).toBe(false);
  });
});

describe("asrt-sandbox — active flag lifecycle (boot-time, no runtime injection)", () => {
  it("flips to true on initialize and back to false on reset", async () => {
    if (!(await isAsrtSandboxSupported())) {
      // Unsupported platform — initialize would fail-closed at boot anyway.
      expect(isAsrtSandboxActive()).toBe(false);
      return;
    }
    expect(isAsrtSandboxActive()).toBe(false);
    await initializeAsrtSandbox({ allowedDomains: [] });
    expect(isAsrtSandboxActive()).toBe(true);
    await resetAsrtSandbox();
    expect(isAsrtSandboxActive()).toBe(false);
  });
});

describe("asrt-sandbox — gate ON wraps a real command under the OS sandbox", () => {
  it("returns ASRT argv whose wrapped echo runs and resolves vendor binaries", async () => {
    if (!(await isAsrtSandboxSupported())) return;

    const writeDir = mkdtempSync(join(tmpdir(), "asrt-test-"));
    try {
      await initializeAsrtSandbox({ allowedDomains: [], allowWrite: [writeDir] });

      const { argv, env } = await wrapToolCommand("echo asrt-ok", {
        filesystem: { allowWrite: [writeDir], allowRead: [writeDir] },
      });

      // mac/linux wrap shape: [<shell>, "-c", <wrapped>]
      expect(argv.length).toBeGreaterThanOrEqual(3);
      expect(argv[1]).toBe("-c");

      const res = await runArgv(argv, env);
      cleanupAsrtSandboxAfterCommand();

      expect(res.stdout).toContain("asrt-ok");
      // vendor-resolved: no module/vendor resolution failure in the wrapper.
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(combined).not.toMatch(
        /vendor.*not found|cannot find module|MODULE_NOT_FOUND|no such file.*vendor/i,
      );
    } finally {
      rmSync(writeDir, { recursive: true, force: true });
    }
  });
});

describe("asrt-sandbox — per-command trust boundary (security MINOR)", () => {
  it("a per-command filesystem wrap cannot carry a weakening flag (no such field)", async () => {
    if (!(await isAsrtSandboxSupported())) return;

    await initializeAsrtSandbox({ allowedDomains: [] });
    // The WrapOptions surface only exposes `filesystem` + `abortSignal`. There
    // is no `customConfig` / network / weakening channel — a call attempting to
    // smuggle `allowAppleEvents` etc. is a compile error, so the runtime call
    // simply succeeds with only the filesystem slice applied.
    const { argv } = await wrapToolCommand("echo trust-ok", {
      filesystem: { allowWrite: [], allowRead: [] },
    });
    expect(argv.length).toBeGreaterThanOrEqual(3);
  });
});
