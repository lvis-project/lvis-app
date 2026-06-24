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
  wrapWorkerCommand,
  cleanupAsrtSandboxAfterCommand,
  isAsrtSandboxSupported,
  checkAsrtDependencies,
  computeUnionAllowedDomains,
} from "../asrt-sandbox.js";

/**
 * The wrap/initialize assertions need the platform's sandbox dependencies to be
 * actually present (Linux: bwrap + socat + ripgrep). `isSupportedPlatform()` is
 * only a platform check — a Linux CI runner returns true there but may lack the
 * binaries, in which case `initialize` correctly throws (the same fail-closed
 * signal boot.ts honors). Gate the live tests on the honest precondition:
 * supported platform AND no dependency errors. Returns the boolean so each test
 * can early-return as a skip.
 */
async function asrtCanInitialize(): Promise<boolean> {
  if (!(await isAsrtSandboxSupported())) return false;
  const deps = await checkAsrtDependencies();
  return deps.errors.length === 0;
}

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
    if (!(await asrtCanInitialize())) {
      // Unsupported platform or missing sandbox deps — initialize would
      // fail-closed at boot anyway; the gate stays OFF.
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
    if (!(await asrtCanInitialize())) return;

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
    if (!(await asrtCanInitialize())) return;

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

describe("asrt-sandbox — self-enforcing gate (PR #1356 NIT)", () => {
  it("wrapToolCommand throws when the sandbox is not active", async () => {
    expect(isAsrtSandboxActive()).toBe(false);
    await expect(wrapToolCommand("echo nope")).rejects.toThrow(/not active/i);
  });

  it("wrapWorkerCommand throws when the sandbox is not active", async () => {
    expect(isAsrtSandboxActive()).toBe(false);
    await expect(wrapWorkerCommand("echo nope")).rejects.toThrow(/not active/i);
  });
});

describe("asrt-sandbox — idempotency guard (PR #1356 NIT)", () => {
  it("initialize throws if already active (double-init is a loud failure)", async () => {
    if (!(await asrtCanInitialize())) return;
    await initializeAsrtSandbox({ allowedDomains: [] });
    expect(isAsrtSandboxActive()).toBe(true);
    await expect(initializeAsrtSandbox({ allowedDomains: [] })).rejects.toThrow(/already active/i);
  });
});

describe("asrt-sandbox — worker wrap carries only the filesystem jail", () => {
  it("wrapWorkerCommand wraps with no per-command network override (network is the shared config)", async () => {
    if (!(await asrtCanInitialize())) return;
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    // WrapOptions exposes only `filesystem` + `abortSignal` — there is no
    // `network` channel (it would be INERT in ASRT 0.0.59; enforcement is the
    // shared config). The wrap succeeds with the filesystem slice only.
    const { argv } = await wrapWorkerCommand("echo worker-ok", {
      filesystem: { allowWrite: [], allowRead: [] },
    });
    expect(argv.length).toBeGreaterThanOrEqual(3);
    expect(argv[1]).toBe("-c");
  });
});

describe("asrt-sandbox — REAL enforcement via the SHARED config (strict union allow-list)", () => {
  /**
   * The cluster review demands enforcement proof, not a shape assertion. This
   * exercises the ACTUALLY-configured shared SandboxManager: a host IN the
   * union allow-list is permitted through the egress proxy; a host OUTSIDE it
   * is HARD-DENIED at the proxy with NO askCb fallthrough (strictAllowlist).
   *
   * Probe hosts: both `example.com` and `example.org` are real, resolvable IANA
   * reserved-example domains that return HTTP 200, so the ONLY variable is
   * whether they are on the shared allow-list. (A non-resolvable TLD like
   * `*.test` would conflate a DNS failure with a proxy denial.)
   *
   * Verified verbatim on darwin:
   *   union=[example.com] strict → example.com: code=0 http=200 (ALLOWED);
   *                                example.org: code=56 "CONNECT tunnel failed,
   *                                response 403" (HARD-DENIED, no askCb).
   *
   * Skipped when the live network can't reach example.com (the in-union host
   * must succeed for the deny side to be a meaningful contrast).
   */
  const curlProbe = async (url: string) => {
    const { argv, env } = await wrapWorkerCommand(
      `curl -sS -o /dev/null -w '%{http_code}' --max-time 8 ${url}`,
      { filesystem: { allowWrite: [], allowRead: [] } },
    );
    const res = await runArgv(argv, env);
    cleanupAsrtSandboxAfterCommand();
    return res;
  };
  const httpOk = (r: { code: number | null; stdout: string }) =>
    r.code === 0 && /^[23]\d\d$/.test(r.stdout.trim());

  it("in-union host is permitted and out-of-union host is hard-denied with NO askCb", async () => {
    if (!(await asrtCanInitialize())) return;
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    const askCalls: Array<{ host: string }> = [];
    const recordingAskCb = async (p: { host: string; port: number | undefined }) => {
      askCalls.push({ host: p.host });
      return true; // would ALLOW if ever consulted — strict must bypass it.
    };

    // Shared config: union includes example.com, NOT example.org.
    // strictAllowlist hard-denies everything else.
    await initializeAsrtSandbox(
      { allowedDomains: ["example.com"], strictAllowlist: true },
      recordingAskCb,
    );

    const allowed = await curlProbe("https://example.com");
    const denied = await curlProbe("https://example.org");

    // In-union host must reach the network; if it can't, the host is offline —
    // skip rather than assert a false negative.
    if (!httpOk(allowed)) return;

    // Out-of-union host is HARD-DENIED at the egress proxy: never a 2xx/3xx.
    expect(httpOk(denied)).toBe(false);
    // Strict means the askCb is NEVER consulted — prove no interactive
    // fallthrough for the out-of-union host (the WIRING-A model is superseded).
    expect(askCalls).toHaveLength(0);
  }, 60_000);

  it("changing the union changes the result (the shared config genuinely enforces)", async () => {
    if (!(await asrtCanInitialize())) return;
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    // Sanity: example.com reachable? If not, the host is offline — skip.
    await initializeAsrtSandbox({ allowedDomains: ["example.com"], strictAllowlist: true });
    const reachable = httpOk(await curlProbe("https://example.com"));
    // With example.org OUT of the union it is denied.
    const beforeAdd = await curlProbe("https://example.org");
    await resetAsrtSandbox();
    if (!reachable) return;
    expect(httpOk(beforeAdd)).toBe(false);

    // Now ADD example.org to the union → the SHARED config now PERMITS it
    // (no longer a strict hard-deny on a config-rule miss). Same probe, same
    // host — only the shared allow-list changed. This is the property the inert
    // per-command override could never provide.
    await initializeAsrtSandbox({
      allowedDomains: ["example.com", "example.org"],
      strictAllowlist: true,
    });
    const afterAdd = await curlProbe("https://example.org");
    await resetAsrtSandbox();
    expect(httpOk(afterAdd)).toBe(true);
  }, 60_000);
});

describe("asrt-sandbox — parentProxy explicit (PR #1356 security MINOR)", () => {
  it("the composed child env never carries the host HTTP_PROXY (no covert egress chain)", async () => {
    if (!(await asrtCanInitialize())) return;
    // Set a bogus host proxy. Two layers must prevent it reaching the child:
    //   1. network.parentProxy is set explicitly to {} so ASRT's egress proxy
    //      does NOT chain through the host proxy (resolveParentProxy would
    //      otherwise silently inherit process.env.HTTP_PROXY);
    //   2. buildSandboxedChildEnv strips the host HTTP_PROXY from the child env
    //      because ASRT did not change it (it equals process.env).
    const { buildSandboxedChildEnv } = await import("../../tools/safe-env.js");
    const HOST_PROXY = "http://host-proxy.invalid:3128";
    const prev = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = HOST_PROXY;
    try {
      await initializeAsrtSandbox({ allowedDomains: ["example.com"], strictAllowlist: true });
      const { env } = await wrapWorkerCommand("echo proxy-check", {
        filesystem: { allowWrite: [], allowRead: [] },
      });
      const childEnv = buildSandboxedChildEnv(env);
      // The host's external proxy must never reach the sandboxed child. Any
      // HTTP_PROXY present must be ASRT's own localhost egress proxy.
      if (childEnv.HTTP_PROXY !== undefined) {
        expect(childEnv.HTTP_PROXY).not.toContain("host-proxy.invalid");
      }
      cleanupAsrtSandboxAfterCommand();
    } finally {
      if (prev === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prev;
    }
  });
});

describe("asrt-sandbox — computeUnionAllowedDomains (shared-config enforcement seam)", () => {
  it("unions every plugin's manifest allow-list, deduped and order-stable", () => {
    const union = computeUnionAllowedDomains([
      ["a.example", "b.example"],
      ["b.example", "c.example"],
      [],
    ]);
    expect(union).toEqual(["a.example", "b.example", "c.example"]);
  });

  it("prepends the trusted host baseline ahead of the manifest union (still deduped)", () => {
    const union = computeUnionAllowedDomains(
      [["a.example"], ["base.example"]],
      ["base.example", "host.example"],
    );
    expect(union).toEqual(["base.example", "host.example", "a.example"]);
  });

  it("empty manifests + empty baseline ⇒ empty union (deny-by-default)", () => {
    expect(computeUnionAllowedDomains([], [])).toEqual([]);
    expect(computeUnionAllowedDomains([[], []])).toEqual([]);
  });

  it("drops empty/non-string entries (defensive against malformed manifest fields)", () => {
    const union = computeUnionAllowedDomains([
      ["", "ok.example", undefined as unknown as string],
    ]);
    expect(union).toEqual(["ok.example"]);
  });
});
