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
 * Real ASRT semantics, no ASRT mocks — mirrors the no-mock style of the
 * bash/powershell tests. Windows resolves host-sensitive paths from an isolated
 * test home while leaving USERPROFILE unchanged for CreateProcessWithLogonW.
 * LVIS_HOME is pinned there too so prior test files cannot leak a host path.
 */
import {
  describe,
  it,
  expect,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  vi,
} from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => {
      const isolated = process.env.LVIS_ASRT_TEST_HOME;
      return process.platform === "win32" && isolated ? isolated : original.homedir();
    },
  };
});

import {
  isAsrtSandboxActive,
  initializeAsrtSandbox,
  resetAsrtSandbox,
  wrapToolCommand,
  wrapWorkerCommand,
  cleanupAsrtSandboxAfterCommand,
  computeUnionAllowedDomains,
  normalizeUnionForAsrt,
  computeDynamicEndpointHosts,
  updateAsrtSandboxConfig,
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  buildSandboxConfig,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  registerWorkerUnixSocketDir,
  unregisterWorkerUnixSocketDir,
} from "../asrt-sandbox.js";
import { asrtCanInitialize } from "./test-helpers.js";
// ASRT-contract guards: the real vendored matcher + parent-proxy resolver, so
// the host-side fixes are proven against ASRT's ACTUAL semantics (not a
// re-implementation that could drift from the package).
import { matchesDomainPattern } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { resolveParentProxy } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";

let originalAsrtTestHome: string | undefined;
let originalLvisHome: string | undefined;
let isolatedWindowsHome: string | undefined;

beforeAll(() => {
  if (process.platform !== "win32") return;

  originalAsrtTestHome = process.env.LVIS_ASRT_TEST_HOME;
  originalLvisHome = process.env.LVIS_HOME;
  isolatedWindowsHome = mkdtempSync(join(tmpdir(), "lvis-asrt-test-home-"));
  process.env.LVIS_ASRT_TEST_HOME = isolatedWindowsHome;
  process.env.LVIS_HOME = join(isolatedWindowsHome, ".lvis");
});

afterAll(() => {
  if (process.platform !== "win32" || isolatedWindowsHome === undefined) return;

  if (originalAsrtTestHome === undefined) {
    delete process.env.LVIS_ASRT_TEST_HOME;
  } else {
    process.env.LVIS_ASRT_TEST_HOME = originalAsrtTestHome;
  }
  if (originalLvisHome === undefined) {
    delete process.env.LVIS_HOME;
  } else {
    process.env.LVIS_HOME = originalLvisHome;
  }
  rmSync(isolatedWindowsHome, { recursive: true, force: true });
});

afterEach(async () => {
  // Always return to the gated-OFF baseline so cross-test state never leaks.
  if (isAsrtSandboxActive()) {
    await resetAsrtSandbox();
  }
});

function runArgv(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd as string, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env,
      cwd,
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

      const { argv, env } = await wrapToolCommand(
        "echo asrt-ok",
        process.platform === "win32"
          ? {}
          : { filesystem: { allowWrite: [writeDir], allowRead: [writeDir] } },
      );

      // mac/linux: [<shell>, "-c", <wrapped>]; Windows: [srt-win, "exec", ...]
      expect(argv.length).toBeGreaterThanOrEqual(3);
      expect(argv[1]).toBe(process.platform === "win32" ? "exec" : "-c");

      const res = await runArgv(argv, env, writeDir);
      cleanupAsrtSandboxAfterCommand();

      expect(res.code, res.stderr).toBe(0);
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

/**
 * ASRT 0.0.66 can return the bare command on Linux only when there are NO
 * restrictions at all. LVIS's initialized config always carries
 * `network.allowedDomains` (including [] = deny all), so this real contract
 * locks that the same wrapper route used by the boot-time `true` probe reaches
 * bwrap's secure user namespace/capability path rather than a no-op shell.
 */
describe("asrt-sandbox — Linux configured-wrapper runtime contract", () => {
  it.runIf(process.platform === "linux")(
    "emits bwrap with user namespace and dropped capabilities for the fixed probe command",
    async () => {
      // Keep the existing helper's contract: only unsupported/missing-dep hosts
      // skip. A host with binaries but userns blocked must fail initialization,
      // which is exactly the runtime-probe regression this test protects.
      if (!(await asrtCanInitialize())) return;

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const { argv } = await wrapToolCommand("true");
      try {
        expect(argv[1]).toBe("-c");
        const renderedWrapper = argv[2] ?? "";
        expect(renderedWrapper).toContain("bwrap");
        expect(renderedWrapper).toContain("--unshare-user");
        expect(renderedWrapper).toContain("--cap-drop");
        expect(renderedWrapper).toContain("ALL");
      } finally {
        // wrapToolCommand increments ASRT's Linux bwrap cleanup accounting even
        // though this contract test only inspects argv and does not spawn it.
        await cleanupAsrtSandboxAfterCommand();
      }
    },
  );
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
    // `network` channel (it would be INERT per command; enforcement is the
    // shared config). The wrap succeeds with the filesystem slice only.
    const { argv } = await wrapWorkerCommand("echo worker-ok", {
      filesystem: { allowWrite: [], allowRead: [] },
    });
    expect(argv.length).toBeGreaterThanOrEqual(3);
    expect(argv[1]).toBe(process.platform === "win32" ? "exec" : "-c");
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

  it("a host derived from a CONFIGURED endpoint (settings → computeDynamicEndpointHosts) is allowed; live-refresh swaps it", async () => {
    if (!(await asrtCanInitialize())) return;
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    // DYNAMIC-ENDPOINT PROVENANCE: the allow-list host comes from a SETTINGS
    // baseUrl reduced via computeDynamicEndpointHosts — the exact boot path for
    // a user-configured Azure/embedding endpoint — NOT a hardcoded literal.
    // example.com/.org stand in for the configured resource (CI-reachable IANA
    // domains; a real *.openai.azure.com is not resolvable offline).
    const dynamicHostsFor = (baseUrl: string) =>
      computeDynamicEndpointHosts({ llm: { vendors: { "azure-foundry": { baseUrl } } } });

    // Union built from the CONFIGURED endpoint (example.com), normalized for
    // ASRT exactly as boot does.
    const initialUnion = normalizeUnionForAsrt(
      computeUnionAllowedDomains([dynamicHostsFor("https://example.com/openai/v1")], []),
    );
    expect(initialUnion).toContain("example.com");

    await initializeAsrtSandbox({ allowedDomains: initialUnion, strictAllowlist: true });
    const configuredAllowed = await curlProbe("https://example.com");
    const reachable = httpOk(configuredAllowed);
    // A host NOT derived from any configured endpoint is HARD-DENIED.
    const nonConfiguredDenied = await curlProbe("https://example.org");

    if (!reachable) {
      await resetAsrtSandbox();
      return; // offline — the allow side can't be proven, skip the contrast.
    }
    // The configured-endpoint host is reachable; the non-configured one is not.
    expect(httpOk(nonConfiguredDenied)).toBe(false);

    // LIVE-REFRESH: user reconfigures the endpoint to example.org. Recompute the
    // union from the NEW settings value and swap the live ASRT config (the same
    // updateAsrtSandboxConfig call refreshSandboxNetworkConfig makes). No
    // re-initialize — this is the live network swap.
    const refreshedUnion = normalizeUnionForAsrt(
      computeUnionAllowedDomains([dynamicHostsFor("https://example.org/openai/v1")], []),
    );
    expect(refreshedUnion).toContain("example.org");
    await updateAsrtSandboxConfig({ allowedDomains: refreshedUnion, strictAllowlist: true });

    // After the live refresh: the NEW configured host is allowed, the OLD one
    // is now hard-denied — proving the swap took effect with no restart.
    const newHostAllowed = await curlProbe("https://example.org");
    const oldHostDenied = await curlProbe("https://example.com");
    await resetAsrtSandbox();
    expect(httpOk(newHostAllowed)).toBe(true);
    expect(httpOk(oldHostDenied)).toBe(false);
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

describe("asrt-sandbox — computeDynamicEndpointHosts (user-configured endpoint union seam)", () => {
  /**
   * Some plugins' real egress host is NOT a static manifest domain but
   * USER-CONFIGURED — notably local-indexer's embedding/caption calls hit the
   * host's Azure OpenAI resource (`llm.vendors["azure-foundry"].baseUrl`, the
   * same value resolveApiKey hands the worker). This extractor reduces every
   * configured vendor baseUrl to its hostname so the union reflects what
   * plugins actually reach. No-fallback: a malformed/empty endpoint yields NO
   * host (never a wildcard / allow-all).
   */
  it("extracts the hostname from an Azure OpenAI resource baseUrl", () => {
    expect(
      computeDynamicEndpointHosts({
        llm: {
          vendors: {
            "azure-foundry": {
              baseUrl: "https://my-resource.openai.azure.com/openai/deployments/x",
            },
          },
        },
      }),
    ).toEqual(["my-resource.openai.azure.com"]);
  });

  it("collects hostnames across multiple configured vendors, deduped + order-stable", () => {
    expect(
      computeDynamicEndpointHosts({
        llm: {
          vendors: {
            "azure-foundry": { baseUrl: "https://res.openai.azure.com/v1" },
            openai: { baseUrl: "https://proxy.internal.example:8443/v1" },
            // duplicate host (different path) collapses to one entry
            copilot: { baseUrl: "https://res.openai.azure.com/other" },
          },
        },
      }),
    ).toEqual(["res.openai.azure.com", "proxy.internal.example"]);
  });

  it("a malformed/empty/whitespace baseUrl contributes NOTHING (deny-by-default, NOT a wildcard)", () => {
    expect(
      computeDynamicEndpointHosts({
        llm: {
          vendors: {
            "azure-foundry": { baseUrl: "not a url" },
            openai: { baseUrl: "" },
            copilot: { baseUrl: "   " },
            gemini: { baseUrl: undefined },
            // a value present but not even a string
            claude: { baseUrl: 123 as unknown as string },
          },
        },
      }),
    ).toEqual([]);
    // No vendors / no llm section ⇒ empty (never an allow-all fallback).
    expect(computeDynamicEndpointHosts({})).toEqual([]);
    expect(computeDynamicEndpointHosts(undefined)).toEqual([]);
    expect(computeDynamicEndpointHosts({ llm: {} })).toEqual([]);
  });

  it("the boot union includes BOTH static manifest domains AND dynamic endpoint hosts", () => {
    // Mirrors the boot wiring: union over [...manifestAllowLists, dynamicHosts].
    const manifestAllowLists = [["plugin-a.example"], ["plugin-b.example"]];
    const dynamicHosts = computeDynamicEndpointHosts({
      llm: { vendors: { "azure-foundry": { baseUrl: "https://res.openai.azure.com" } } },
    });
    const union = normalizeUnionForAsrt(
      computeUnionAllowedDomains([...manifestAllowLists, dynamicHosts], []),
    );
    // Static manifest domains present (apex + wildcard) …
    expect(union).toContain("plugin-a.example");
    expect(union).toContain("*.plugin-a.example");
    expect(union).toContain("plugin-b.example");
    // … AND the host-resolved dynamic endpoint host (apex + wildcard).
    expect(union).toContain("res.openai.azure.com");
    expect(union).toContain("*.res.openai.azure.com");
  });

  it("a union with NO dynamic hosts is unchanged from the static-only union (default-OFF safety)", () => {
    const manifestAllowLists = [["plugin-a.example"]];
    const withoutDynamic = normalizeUnionForAsrt(
      computeUnionAllowedDomains([...manifestAllowLists, []], []),
    );
    const staticOnly = normalizeUnionForAsrt(
      computeUnionAllowedDomains(manifestAllowLists, []),
    );
    expect(withoutDynamic).toEqual(staticOnly);
  });
});

describe("asrt-sandbox — parentProxy direct-connect floor (PR #1356 MAJOR, corrected)", () => {
  /**
   * Pins the ASRT contract the buildSandboxConfig default path depends
   * on: resolveParentProxy (parent-proxy.js:46) is
   *   `cfg?.http ?? process.env.HTTP_PROXY ?? process.env.http_proxy`.
   * An EMPTY object `{}` (the prior buggy value) has no `http` key, so the `??`
   * chain STILL inherits the host HTTP_PROXY — identical to passing nothing.
   * Only EXPLICIT EMPTY STRINGS short-circuit the chain (`'' ?? x` ⇒ `''`) and
   * yield genuine direct-connect. The fix emits `{ http: '', https: '' }` on
   * the default path, so resolveParentProxy returns undefined (no host-proxy
   * chaining) even with a host HTTP_PROXY set.
   */
  it("explicit empty strings → no host-proxy inheritance; {} would inherit (proves the floor)", () => {
    const prev = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://host-proxy.invalid:3128";
    try {
      // The value buildSandboxConfig emits on the DEFAULT path (no corporateProxy).
      const direct = resolveParentProxy({ http: "", https: "" });
      expect(direct).toBeUndefined(); // direct-connect, no inheritance

      // The OLD buggy value — proves why `{}` is NOT a secure floor.
      const inherited = resolveParentProxy({});
      expect(inherited).toBeDefined();
      expect(inherited?.httpUrl?.href).toContain("host-proxy.invalid");

      // Sanity: undefined behaves identically to `{}` (both inherit).
      expect(resolveParentProxy(undefined)?.httpUrl?.href).toContain("host-proxy.invalid");
    } finally {
      if (prev === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prev;
    }
  });

  it("a trusted corporateProxy value is honored (still no host-env inheritance path)", () => {
    const prev = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://host-proxy.invalid:3128";
    try {
      // What buildSandboxConfig emits when corporateProxy.http is set.
      const corp = resolveParentProxy({ http: "http://corp-proxy.example:8080", https: "" });
      expect(corp?.httpUrl?.href).toContain("corp-proxy.example");
      expect(corp?.httpUrl?.href).not.toContain("host-proxy.invalid");
    } finally {
      if (prev === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prev;
    }
  });
});

describe("asrt-sandbox — normalizeUnionForAsrt (domain-matching alignment, PR #1356 MINOR)", () => {
  /**
   * ASRT matchesDomainPattern (domain-pattern.js:23) matches a BARE domain
   * EXACTLY; a strict subdomain needs `*.d`. LVIS hostFetch treats a bare
   * domain as a dot-boundary SUFFIX. normalizeUnionForAsrt emits both `d` and
   * `*.d` so ASRT's matcher reproduces the suffix semantics. These assertions
   * run the REAL vendored matcher against the normalized list.
   */
  it("emits apex + wildcard for each bare domain (order-stable, deduped)", () => {
    expect(normalizeUnionForAsrt(["example.com"])).toEqual([
      "example.com",
      "*.example.com",
    ]);
    expect(
      normalizeUnionForAsrt(["a.example", "a.example", "b.example"]),
    ).toEqual(["a.example", "*.a.example", "b.example", "*.b.example"]);
  });

  it("passes wildcard entries through unchanged; drops `*` and empties", () => {
    expect(normalizeUnionForAsrt(["*.example.com"])).toEqual(["*.example.com"]);
    expect(normalizeUnionForAsrt(["*", "", "  "])).toEqual([]);
  });

  it("normalized bare domain matches the apex AND subdomains under the REAL ASRT matcher", () => {
    const normalized = normalizeUnionForAsrt(["example.com"]);
    const matches = (host: string) =>
      normalized.some((p) => matchesDomainPattern(host, p));
    // Apex + strict subdomains are ALLOWED (mirrors LVIS suffix semantics).
    expect(matches("example.com")).toBe(true);
    expect(matches("sub.example.com")).toBe(true);
    expect(matches("a.b.example.com")).toBe(true);
    // A different registrable domain and a suffix-spoof are NOT allowed.
    expect(matches("notexample.com")).toBe(false);
    expect(matches("example.com.attacker.com")).toBe(false);
  });

  it("a RAW bare domain (un-normalized) would NOT match subdomains under ASRT — the divergence the fix closes", () => {
    // This is the bug: without normalization, ASRT's exact match rejects the
    // subdomain that LVIS hostFetch would have allowed.
    expect(matchesDomainPattern("sub.example.com", "example.com")).toBe(false);
    expect(matchesDomainPattern("example.com", "example.com")).toBe(true);
  });
});

describe("asrt-sandbox — proxyPortRange single SOT (install↔config consistency)", () => {
  /**
   * The WFP rule stamped at install time MUST cover exactly the port range the
   * srt-win egress proxy binds at runtime. Both the install handler
   * (ipc/domains/permissions.ts sandboxWindowsInstall) and buildSandboxConfig
   * (asrt-sandbox.ts) source their range from the SAME local
   * DEFAULT_WINDOWS_PROXY_PORT_RANGE constant — the local mirror of ASRT's
   * value. This test pins the invariant: the local constant is identical to
   * ASRT's real export, so the WFP-permitted range (stamped at install) equals
   * the proxy bind range (at runtime) by construction, and any upstream drift
   * in ASRT fails this test rather than silently desyncing the two paths.
   */
  it("local DEFAULT_WINDOWS_PROXY_PORT_RANGE matches ASRT's real export", async () => {
    const asrt = await import("@anthropic-ai/sandbox-runtime");
    // Both references must be the identical value — the install path and the
    // buildSandboxConfig runtime path converge on this one constant.
    expect(DEFAULT_WINDOWS_PROXY_PORT_RANGE).toEqual(asrt.DEFAULT_WINDOWS_PROXY_PORT_RANGE);
  });

  it("buildSandboxConfig emits the local SOT constant as windows.proxyPortRange (win32 path)", () => {
    // Force win32 so the windows section is emitted regardless of the actual
    // platform running CI. The install handler sources the same local constant,
    // so this assertion proves both paths use the same value.
    const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const config = buildSandboxConfig({ allowedDomains: [] });
      // The windows section must be present and use the local SOT constant.
      expect(config.windows).toBeDefined();
      expect(config.windows!.proxyPortRange).toEqual(DEFAULT_WINDOWS_PROXY_PORT_RANGE);
    } finally {
      if (prevPlatform) {
        Object.defineProperty(process, "platform", prevPlatform);
      }
    }
  });
});

describe("asrt-sandbox — sensitive read deny-list (host-secret hardening)", () => {
  // getDefaultSensitiveReadDenyPaths derives `~/.lvis/*` from lvisHome() (which
  // honors the LVIS_HOME env override) and the standard credential stores from
  // os.homedir(). Pin LVIS_HOME to a deterministic value so the ~/.lvis assertions
  // are stable across machines; restore it after each test.
  const FAKE_LVIS_HOME = join(tmpdir(), "lvis-readdeny-test-home", ".lvis");
  let prevLvisHome: string | undefined;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    process.env.LVIS_HOME = FAKE_LVIS_HOME;
  });
  afterEach(() => {
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
  });

  it("returns the expected absolute sensitive paths (LVIS namespaces + standard credential stores)", () => {
    const paths = getDefaultSensitiveReadDenyPaths();
    const home = homedir();

    // Every entry is an absolute path with NO glob char (literal — works on both
    // macOS seatbelt subpath and Linux bwrap deny-bind; ASRT only expands globs).
    for (const p of paths) {
      expect(p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)).toBe(true);
      expect(/[*?[\]]/.test(p)).toBe(false);
    }

    // LVIS host-domain sensitive namespaces, derived from the (overridden) lvisHome.
    expect(paths).toContain(join(FAKE_LVIS_HOME, "secrets"));
    expect(paths).toContain(join(FAKE_LVIS_HOME, "sessions"));
    expect(paths).toContain(join(FAKE_LVIS_HOME, "routine"));
    expect(paths).toContain(join(FAKE_LVIS_HOME, "audit.log"));
    expect(paths).toContain(join(FAKE_LVIS_HOME, "audit"));
    expect(paths).toContain(join(FAKE_LVIS_HOME, "settings.json"));

    // Standard credential / secret stores under the real home.
    expect(paths).toContain(join(home, ".ssh"));
    expect(paths).toContain(join(home, ".aws"));
    expect(paths).toContain(join(home, ".config", "gcloud"));
    expect(paths).toContain(join(home, ".config", "gh"));
    expect(paths).toContain(join(home, ".config", "git"));
    expect(paths).toContain(join(home, ".kube", "config"));
    expect(paths).toContain(join(home, ".gnupg"));
    expect(paths).toContain(join(home, ".npmrc"));
    expect(paths).toContain(join(home, ".netrc"));
    expect(paths).toContain(join(home, ".git-credentials"));
    expect(paths).toContain(join(home, ".docker", "config.json"));

    // LVIS ~/.lvis permission / auth-partition namespaces.
    expect(paths).toContain(join(FAKE_LVIS_HOME, "permissions"));
    expect(paths).toContain(join(FAKE_LVIS_HOME, "permissions.json"));
    expect(paths).toContain(join(FAKE_LVIS_HOME, "policy.json"));
    expect(paths).toContain(join(FAKE_LVIS_HOME, "plugins", "auth-partitions.json"));

    // FIX 3: drift-sync paths added to match SENSITIVE_PATH_PATTERNS.
    expect(paths).toContain(join(FAKE_LVIS_HOME, "certs"));
    expect(paths).toContain(join(FAKE_LVIS_HOME, "keys"));
    expect(paths).toContain(join(home, ".azure"));
    expect(paths).toContain(join(home, ".pgpass"));
    expect(paths).toContain(join(home, ".gitconfig"));
    expect(paths).toContain(join(home, ".bash_history"));
    expect(paths).toContain(join(home, ".zsh_history"));

    // Electron userData dir (deny whole dir — covers OAuth session cookies/tokens,
    // Cookies SQLite, Local/Session Storage, lvis-secrets.json, etc.).
    // FIX 1: Linux base mirrors Electron's XDG_CONFIG_HOME resolution.
    const xdgBase = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
    const expectedUserData =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "LVIS")
        : process.platform === "win32"
          ? join(home, "AppData", "Roaming", "LVIS")
          : join(xdgBase, "LVIS");
    expect(paths).toContain(expectedUserData);

    // No duplicates (deduped, order-stable).
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("does NOT deny $HOME wholesale (over-deny safety — legit shell tools still read ~)", () => {
    const paths = getDefaultSensitiveReadDenyPaths();
    const home = homedir();
    // The bare home dir must never be on the deny-list — denying all of ~ would
    // break tools reading ~/.cargo, ~/.config, etc. We deny SPECIFIC subpaths.
    expect(paths).not.toContain(home);
    // A clearly-legit subpath (not a credential store) must NOT be denied.
    expect(paths).not.toContain(join(home, ".cargo"));
    // ~/.config wholesale must never be denied — only specific subdirs.
    expect(paths).not.toContain(join(home, ".config"));
  });

  it("FIX 1 — Linux XDG_CONFIG_HOME: when set, userData base uses $XDG_CONFIG_HOME not ~/.config", () => {
    // This test only exercises the XDG path on Linux (the env var is harmless
    // on other platforms since darwin/win32 branches never read it).
    if (process.platform !== "linux") return;
    const home = homedir();
    const fakeXdg = join(tmpdir(), "fake-xdg-config-home");
    const prevXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = fakeXdg;
      const paths = getDefaultSensitiveReadDenyPaths();
      // Must deny the XDG-resolved path.
      expect(paths).toContain(join(fakeXdg, "LVIS"));
      // Must NOT deny the default ~/.config/LVIS when XDG is overridden
      // (belt-and-suspenders is the caller's choice; this SOT mirrors Electron).
      expect(paths).not.toContain(join(home, ".config", "LVIS"));
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });

  it("FIX 2 — userDataDir param: exact path is denied when provided (handles --user-data-dir)", () => {
    const customUserData = join(tmpdir(), "custom-electron-userData-for-test");
    const paths = getDefaultSensitiveReadDenyPaths(customUserData);
    // The exact provided path must be denied.
    expect(paths).toContain(customUserData);
    // No duplicates.
    expect(new Set(paths).size).toBe(paths.length);
    // Over-deny safety: the derived fallback is NOT additionally added when
    // the exact path is provided (the dedup set handles this if they collide,
    // but the function uses the provided value exclusively for the userData slot).
    // Verify the provided path is present exactly once.
    expect(paths.filter((p) => p === customUserData).length).toBe(1);
  });

  it("FIX 2 — userDataDir absent: falls back to per-platform derived path (no electron import)", () => {
    const home = homedir();
    const paths = getDefaultSensitiveReadDenyPaths(); // no arg → fallback
    const xdgBase = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
    const fallback =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "LVIS")
        : process.platform === "win32"
          ? join(home, "AppData", "Roaming", "LVIS")
          : join(xdgBase, "LVIS");
    expect(paths).toContain(fallback);
  });

  it("FIX 2 — buildSandboxConfig threads userDataDir into deny-list", () => {
    const customUserData = join(tmpdir(), "threaded-userData-deny-test");
    const config = buildSandboxConfig({
      allowedDomains: [],
      userDataDir: customUserData,
    });
    expect(config.filesystem.denyRead).toContain(customUserData);
  });

  it("buildSandboxConfig unions the sensitive deny-list into filesystem.denyRead", () => {
    const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true });
    const sensitive = getDefaultSensitiveReadDenyPaths();
    for (const p of sensitive) {
      expect(config.filesystem.denyRead).toContain(p);
    }
    // Secrets is part of the floor (the prior single-entry deny is subsumed).
    expect(config.filesystem.denyRead).toContain(join(FAKE_LVIS_HOME, "secrets"));
  });

  it("buildSandboxConfig keeps a caller-supplied denyRead AND adds the sensitive floor (union, deduped)", () => {
    const extra = join(tmpdir(), "caller-supplied-deny-xyz");
    const config = buildSandboxConfig({ allowedDomains: [], denyRead: [extra] });
    // Caller entry survives.
    expect(config.filesystem.denyRead).toContain(extra);
    // Sensitive floor is still present.
    expect(config.filesystem.denyRead).toContain(join(FAKE_LVIS_HOME, "secrets"));
    // Passing a path already on the floor does not duplicate it.
    const dupConfig = buildSandboxConfig({
      allowedDomains: [],
      denyRead: [join(FAKE_LVIS_HOME, "secrets")],
    });
    const occurrences = dupConfig.filesystem.denyRead.filter(
      (p) => p === join(FAKE_LVIS_HOME, "secrets"),
    ).length;
    expect(occurrences).toBe(1);
  });

  it("buildSandboxConfig unions the sensitive write deny-list into filesystem.denyWrite", () => {
    const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true });
    const sensitive = getDefaultSensitiveWriteDenyPaths();
    for (const p of sensitive) {
      expect(config.filesystem.denyWrite).toContain(p);
    }
    expect(config.filesystem.denyWrite).toContain(join(homedir(), ".config"));
    expect(config.filesystem.denyWrite).toContain(join(homedir(), ".ssh"));
  });

  it("buildSandboxConfig keeps caller-supplied denyWrite AND adds the sensitive write floor", () => {
    const extra = join(tmpdir(), "caller-supplied-write-deny-xyz");
    const config = buildSandboxConfig({ allowedDomains: [], denyWrite: [extra] });
    expect(config.filesystem.denyWrite).toContain(extra);
    expect(config.filesystem.denyWrite).toContain(join(homedir(), ".config"));

    const dup = join(homedir(), ".config");
    const dupConfig = buildSandboxConfig({ allowedDomains: [], denyWrite: [dup] });
    expect(dupConfig.filesystem.denyWrite.filter((p) => p === dup)).toHaveLength(1);
  });

  it("default-OFF: computing the deny-list / config does NOT activate the sandbox gate", () => {
    // Pure functions — no side effect on the boot-time spawn gate.
    expect(isAsrtSandboxActive()).toBe(false);
    getDefaultSensitiveReadDenyPaths();
    buildSandboxConfig({ allowedDomains: [] });
    expect(isAsrtSandboxActive()).toBe(false);
  });

  it("does not put plugin worker data roots into the shared sandbox config", () => {
    const data = join(FAKE_LVIS_HOME, "plugins", "local-indexer", "data");
    const cfg = buildSandboxConfig({
      allowedDomains: [],
      allowRead: [join(FAKE_LVIS_HOME, "notes")],
      allowWrite: [join(FAKE_LVIS_HOME, "tasks")],
    });

    expect(cfg.filesystem.allowRead ?? []).not.toContain(data);
    expect(cfg.filesystem.allowWrite ?? []).not.toContain(data);
  });
});

describe("asrt-sandbox — worker-UDS shared-config emission (worker-confinement PR D-1)", () => {
  it("buildSandboxConfig emits network.allowUnixSockets from allowUnixSocketDirs", () => {
    const cfg = buildSandboxConfig({
      allowedDomains: [],
      strictAllowlist: true,
      allowUnixSocketDirs: ["/run/a", "/run/b"],
    });
    expect(cfg.network.allowUnixSockets).toEqual(["/run/a", "/run/b"]);
  });

  it("buildSandboxConfig omits allowUnixSockets when no dirs are supplied (default shape unchanged)", () => {
    const cfg = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true });
    expect(cfg.network.allowUnixSockets).toBeUndefined();
  });
});

describe("asrt-sandbox — worker-UDS register/unregister (shared-config, not per-command)", () => {
  it("registerWorkerUnixSocketDir throws when the sandbox is not active (self-enforcing gate)", async () => {
    await expect(registerWorkerUnixSocketDir("/run/x")).rejects.toThrow(/not active/);
  });

  it("unregisterWorkerUnixSocketDir is a no-op (does not throw) when the sandbox is not active", async () => {
    await expect(unregisterWorkerUnixSocketDir("/run/x")).resolves.toBeUndefined();
  });

  it("register/unregister round-trip on a LIVE sandbox keeps the config consistent (idempotent)", async () => {
    if (!(await asrtCanInitialize())) return;
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    await initializeAsrtSandbox({ allowedDomains: ["example.com"], strictAllowlist: true });
    // First register pushes the dir; a duplicate register is a no-op (idempotent).
    await registerWorkerUnixSocketDir("/run/worker-a");
    await registerWorkerUnixSocketDir("/run/worker-a");
    // Unregister of an unknown dir is a no-op; the known dir unregisters cleanly.
    await unregisterWorkerUnixSocketDir("/run/unknown");
    await unregisterWorkerUnixSocketDir("/run/worker-a");
    // Reset clears the live worker set so the next init starts clean.
    await resetAsrtSandbox();
    // After teardown a register must throw again (no stale base settings).
    await expect(registerWorkerUnixSocketDir("/run/worker-a")).rejects.toThrow(/not active/);
  }, 60_000);
});
