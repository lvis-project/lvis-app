/**
 * The confinement half, against a REAL process.
 *
 * `out-of-process-plugin.test.ts` proves the protocol over paired streams and
 * proves nothing about isolation. This file spawns an actual child through the
 * actual production spawn — `spawnConfinedPluginChild`, the same allow paths,
 * the same environment, the same `grantMode` — and makes it try things.
 *
 * WHAT IS PROVEN HERE, and it is stated narrowly on purpose:
 *
 *  - The child cannot READ `~/.lvis/secrets/`. That is the first assertion §7
 *    asks for, and it is real because the ASRT deny floor covers that path.
 *  - The child cannot WRITE outside its allow set. Write in ASRT IS an
 *    allow-jail, so this one is a jail assertion rather than a deny assertion.
 *    "Its allow set" is larger than the two paths `spawnConfinedPluginChild`
 *    names: ASRT adds its own default write paths, which include the temp root
 *    it also points the child's `TMPDIR` at. So this proves the child cannot
 *    reach the fixture paths outside the jail; it does not prove the jail is
 *    those two directories and nothing else.
 *  - The child CAN read and write its own `pluginDataDir`. A confinement that
 *    also broke the plugin would be indistinguishable from one that worked, so
 *    the positive case is part of the proof.
 *  - Confinement is MANDATORY: with ASRT inactive the spawn throws and no child
 *    exists. There is no unconfined child to fall back to.
 *
 * WHAT IS NOT PROVEN HERE, stated rather than implied:
 *
 *  - "Cannot read another plugin's data directory" is only true where the
 *    plugins live under a path the deny floor covers — in production the
 *    Electron userData dir, which the floor denies wholesale and which this
 *    spawn re-allows for exactly one plugin's two directories. ASRT's read model
 *    is DENY-ONLY (`asrt-sandbox.ts` says so at length): `allowRead` re-allows
 *    inside a covering deny and is inert without one, so a path on no deny list
 *    stays readable. A test cannot write fixtures into the real userData dir, so
 *    the composition of the allow set is asserted separately and honestly as
 *    wiring rather than dressed up as a containment result.
 *  - That the temp root the child is given EXISTS. It usually will not: ASRT
 *    substitutes its own `TMPDIR` and creates nothing, so the meeting case
 *    below asserts what a child does when that path is absent rather than
 *    assuming the host's temp directory carried over.
 *  - Network confinement. The macOS backend filters egress through a proxy
 *    rather than a namespace, so a localhost probe would prove something
 *    different on each platform and an internet probe would pass on an offline
 *    machine for the wrong reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The child entry is bundled by the shared module rather than here: its
// externals, banner and target are the shipped build's, and a second copy of
// them is a second chance for one case to prove something about a child that
// does not ship.
import { buildChildEntry, childBundleDir, repositoryRoot } from "./child-entry-bundle.js";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext } from "../../types.js";
import { createOutOfProcessPluginFactory } from "../out-of-process-plugin.js";
import {
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  resetAsrtSandbox,
} from "../../../permissions/asrt-sandbox.js";
import { asrtCanInitialize } from "../../../permissions/__tests__/test-helpers.js";
import { spawnConfinedPluginChild } from "../out-of-process-plugin.js";

const PLUGIN_ID = "work-assistant";
const SECRET_TEXT = "the-host-secret-the-child-must-not-read";
/** The bytes an un-migrated session file holds, so "nothing moved" is checkable. */
const LEGACY_SESSION_BYTES = "the session that predates pluginDataDir";

interface Fixture {
  readonly root: string;
  readonly lvisHome: string;
  readonly secretFile: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  readonly outsideFile: string;
  /**
   * Stands in for what production passes as `context.hostRoot`: the app root,
   * which is NOT the plugin's data directory and NOT inside its write jail.
   * A case that passed the repository root here would assert the same denial
   * against a directory the developer's own machine happens to own.
   */
  readonly hostRoot: string;
}

let fixture: Fixture | undefined;
let previousLvisHome: string | undefined;
/**
 * ASRT reads this out of the HOST env when it builds the wrap, and it decides
 * the child's `TMPDIR`. One case sets it to reproduce the absent temp root an
 * ordinary machine has, so it is restored the same way `LVIS_HOME` is — a case
 * that leaked it would hand the next case a temp root that does not exist.
 */
let previousSandboxTmpdir: string | undefined;

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "confined-plugin-"));
  const lvisHome = join(root, ".lvis");
  const secretsDir = join(lvisHome, "secrets");
  const pluginRoot = join(lvisHome, "plugins", PLUGIN_ID);
  const pluginDataDir = join(pluginRoot, "data");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  const secretFile = join(secretsDir, "api-key.txt");
  writeFileSync(secretFile, SECRET_TEXT, "utf-8");
  writeFileSync(join(pluginDataDir, "own-data.txt"), "the plugin's own bytes", "utf-8");
  const hostRoot = join(root, "app-root");
  mkdirSync(hostRoot, { recursive: true });
  return {
    root,
    lvisHome,
    secretFile,
    pluginRoot,
    pluginDataDir,
    outsideFile: join(root, "outside-the-jail.txt"),
    hostRoot,
  };
}

/** Where a second plugin's code and data live under the same fixture home. */
interface InstalledPlugin {
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
}

/**
 * Install another plugin beside the pilot, in the same fixture home.
 *
 * The fixture is shared rather than copied because everything that makes it a
 * fixture is plugin-independent: the deny floor is derived from `LVIS_HOME`,
 * the secret it protects is one file, and the write-jail escape target is one
 * path outside it. What varies per plugin is two directories, which is what
 * this returns. A second `makeFixture` would be a second copy of the deny
 * floor's own premise, and the two would only have to disagree once.
 */
function installPlugin(fx: Fixture, pluginId: string): InstalledPlugin {
  const pluginRoot = join(fx.lvisHome, "plugins", pluginId);
  const pluginDataDir = join(pluginRoot, "data");
  mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  return { pluginId, pluginRoot, pluginDataDir };
}

/**
 * A child that reports what the sandbox let it do, as one JSON line on stdout.
 *
 * Written as the child's ENTRY MODULE and spawned by the production
 * `spawnConfinedPluginChild`, so the argv wrap, the allow paths, the deny floor
 * and the environment are the ones a real plugin child gets. Only the module it
 * runs differs — because the question here is what the confinement permits, not
 * what the protocol says.
 *
 * It reports on stdout, which is free here precisely because this probe is not
 * the protocol module: `plugin-child-main.ts` claims stdout for framing, and
 * this one does not run it.
 */
function writeProbeModule(fx: Fixture): string {
  const probePath = join(fx.root, "probe.mjs");
  writeFileSync(
    probePath,
    `import { readFileSync, writeFileSync } from "node:fs";
const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } };
const report = {
  readSecret: attempt(() => readFileSync(${JSON.stringify(fx.secretFile)}, "utf-8")),
  readOwnData: attempt(() => readFileSync(${JSON.stringify(join(fx.pluginDataDir, "own-data.txt"))}, "utf-8")),
  writeOwnData: attempt(() => { writeFileSync(${JSON.stringify(join(fx.pluginDataDir, "written-by-child.txt"))}, "hello"); return "written"; }),
  writeOutside: attempt(() => { writeFileSync(${JSON.stringify(fx.outsideFile)}, "escaped"); return "written"; }),
  writeSecrets: attempt(() => { writeFileSync(${JSON.stringify(join(fx.lvisHome, "secrets", "planted.txt"))}, "escaped"); return "written"; }),
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
};
process.stdout.write("PROBE:" + JSON.stringify(report) + "\\n");
`,
    "utf-8",
  );
  return probePath;
}

interface ProbeAttempt {
  readonly ok: boolean;
  readonly value?: string;
  readonly code?: string;
}

interface ProbeReport {
  readonly readSecret: ProbeAttempt;
  readonly readOwnData: ProbeAttempt;
  readonly writeOwnData: ProbeAttempt;
  readonly writeOutside: ProbeAttempt;
  readonly writeSecrets: ProbeAttempt;
  readonly electronRunAsNode: string | null;
}

async function runProbe(fx: Fixture): Promise<ProbeReport> {
  const child = await spawnConfinedPluginChild({
    pluginId: PLUGIN_ID,
    pluginRoot: fx.pluginRoot,
    pluginDataDir: fx.pluginDataDir,
    childEntryPath: writeProbeModule(fx),
  });
  return await new Promise<ProbeReport>((resolve, reject) => {
    let stdout = "";
    child.link.input.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.link.input.on("end", () => {
      const line = stdout.split("\n").find((entry) => entry.startsWith("PROBE:"));
      if (!line) {
        reject(new Error(`the probe produced no report; stdout was: ${stdout}`));
        return;
      }
      resolve(JSON.parse(line.slice("PROBE:".length)) as ProbeReport);
    });
    child.link.input.on("error", reject);
  });
}

beforeEach(() => {
  fixture = makeFixture();
  previousLvisHome = process.env.LVIS_HOME;
  previousSandboxTmpdir = process.env.CLAUDE_CODE_TMPDIR;
  // The deny floor is derived from `lvisHome()`, so pointing it at the fixture
  // is what makes `<LVIS_HOME>/secrets` a real denied path with a real file in
  // it rather than an assertion about the developer's own home directory.
  process.env.LVIS_HOME = fixture.lvisHome;
});

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  if (previousLvisHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = previousLvisHome;
  if (previousSandboxTmpdir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
  else process.env.CLAUDE_CODE_TMPDIR = previousSandboxTmpdir;
  if (fixture) rmSync(fixture.root, { recursive: true, force: true });
  fixture = undefined;
});

describe("a plugin that cannot be confined is not spawned", () => {
  it("throws rather than producing an unconfined child when ASRT is inactive", async () => {
    const fx = fixture!;
    expect(isAsrtSandboxActive()).toBe(false);
    await expect(
      spawnConfinedPluginChild({
        pluginId: PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        childEntryPath: writeProbeModule(fx),
      }),
    ).rejects.toThrow(/sandbox is not active/i);
  });
});

describe("the confined child, against the real sandbox", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "is denied the host's secrets and the paths outside its write jail, and keeps its own",
    async () => {
      if (!(await asrtCanInitialize())) return;
      const fx = fixture!;
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

      const report = await runProbe(fx);

      // The assertion the whole exercise exists for. Not "we called
      // spawnConfinedChild" — an actual `readFileSync` of an actual secret file
      // that actually failed.
      expect(report.readSecret.ok, JSON.stringify(report.readSecret)).toBe(false);
      expect(report.readSecret.value).toBeUndefined();

      // The write jail, in both directions.
      expect(report.writeOutside.ok, JSON.stringify(report.writeOutside)).toBe(false);
      expect(report.writeSecrets.ok, JSON.stringify(report.writeSecrets)).toBe(false);

      // …and the plugin still works, which is the other half of the claim.
      expect(report.readOwnData.ok, JSON.stringify(report.readOwnData)).toBe(true);
      expect(report.readOwnData.value).toBe("the plugin's own bytes");
      expect(report.writeOwnData.ok, JSON.stringify(report.writeOwnData)).toBe(true);
      expect(readFileSync(join(fx.pluginDataDir, "written-by-child.txt"), "utf-8")).toBe(
        "hello",
      );

      // The child runs as plain Node, which is what makes `electron`
      // unreachable in it (§4).
      expect(report.electronRunAsNode).toBe("1");
    },
    60_000,
  );
});

/** Emitted inside the repository, under a name only this suite cleans up. */
const CHILD_BUNDLE_CACHE = "plugin-child-confined-e2e";

/**
 * The pilot's own tool, invoked out of process AND confined, through the
 * production factory.
 *
 * This is the claim the two stages make together, and neither of the other
 * suites makes it: `out-of-process-plugin.test.ts` runs the real protocol over
 * fake pipes, the probe above runs a real sandbox around a fake protocol, and
 * only here are both real at once. It is also the only test that exercises the
 * BUNDLED child entry — the stdout claim, the entry-module guard, and the ESM
 * bundle boundary are all things the TypeScript source cannot prove.
 */
describe("the pilot's tools, out of process and confined", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "invokes a declared tool in a sandboxed child and returns the plugin's own value",
    async () => {
      if (!(await asrtCanInitialize())) return;
      const fx = fixture!;
      const repoRoot = repositoryRoot();
      const childOutDir = childBundleDir(CHILD_BUNDLE_CACHE);
      const childEntryPath = await buildChildEntry(CHILD_BUNDLE_CACHE);

      // The plugin lives inside the child's own read carve-out, which is where
      // an installed plugin lives in production.
      const entryPath = join(fx.pluginRoot, "plugin.mjs");
      writeFileSync(
        entryPath,
        `import { readFileSync } from "node:fs";
export const createPlugin = async (context) => ({
  handlers: {
    pilot_probe: async () => ({
      ownData: readFileSync(${JSON.stringify(join(fx.pluginDataDir, "own-data.txt"))}, "utf-8"),
      secretRead: (() => { try { return readFileSync(${JSON.stringify(fx.secretFile)}, "utf-8"); } catch (error) { return "DENIED:" + (error.code ?? error.name); } })(),
      fromHost: await context.hostApi.callLlm("ping"),
      installed: context.hostApi.getInstalledPluginIds(),
    }),
  },
});
`,
        "utf-8",
      );

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const factory = createOutOfProcessPluginFactory({
        manifest: {
          id: PLUGIN_ID,
          name: "Work Assistant",
          version: "0.10.14",
          entry: "plugin.mjs",
          description: "the pilot, confined",
          tools: [
            {
              name: "pilot_probe",
              description: "report what the confined child could reach",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        } as PluginManifest,
        entryPath,
        childEntryPath,
      });
      const hostApi = {
        callLlm: async () => "the host answered",
        getInstalledPluginIds: () => ["work-assistant"],
        onPluginsChanged: () => () => undefined,
        config: { get: () => undefined, set: async () => undefined, onChange: () => () => undefined },
      } as unknown as PluginHostApi;
      const instance = await factory({
        pluginId: PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        hostRoot: repoRoot,
        pluginDataDir: fx.pluginDataDir,
        config: {},
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);
      try {
        const result = (await instance.handlers.pilot_probe!()) as Record<string, unknown>;
        // The plugin's own structured value, out of a different process.
        expect(result.ownData).toBe("the plugin's own bytes");
        expect(result.fromHost).toBe("the host answered");
        expect(result.installed).toEqual(["work-assistant"]);
        // …and the same process could not read the host's secrets while doing it.
        expect(String(result.secretRead)).toMatch(/^DENIED:/);
      } finally {
        await instance.stop?.();
        rmSync(childOutDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

/**
 * The members §3.2 calls lossy or stateful, exercised by a REAL confined child.
 *
 * `host-api-service-paths.test.ts` drives the same members across a real
 * dispatcher and a real child runtime over an in-memory channel, which proves
 * the marshalling and proves nothing about the jail. This proves both at once,
 * and it is the only place that can: the question "can the plugin reach the
 * secret it was not handed" has two answers — one from the gate and one from
 * the sandbox — and only a real process has both.
 */
describe("the lossy and stateful members, across a real confined boundary", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "hands over what the gate grants, refuses what it does not, and cannot be reached around",
    async () => {
      if (!(await asrtCanInitialize())) return;
      const fx = fixture!;
      const repoRoot = repositoryRoot();
      const childOutDir = childBundleDir(CHILD_BUNDLE_CACHE);
      const childEntryPath = await buildChildEntry(CHILD_BUNDLE_CACHE);

      const entryPath = join(fx.pluginRoot, "plugin.mjs");
      writeFileSync(
        entryPath,
        `import { readFileSync } from "node:fs";
const attempt = async (fn) => {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, code: error.code ?? error.name, message: String(error.message ?? "") }; }
};
export const createPlugin = async (context) => {
  const api = context.hostApi;
  return {
    handlers: {
      // What the gate hands over, versus what the filesystem does.
      probe_credentials: async () => ({
        granted: await api.getSecret("granted"),
        denied: await api.getSecret("denied"),
        directRead: await attempt(() => readFileSync(${JSON.stringify(fx.secretFile)}, "utf-8")),
      }),
      // A lease: two closures in the return value, neither of which crosses.
      probe_lease: async () => {
        const lease = await api.resolveApiKey({ purpose: "llm" });
        const spent = lease.bearer();
        lease.release();
        const afterRelease = await attempt(() => lease.bearer());
        return { ok: lease.ok, vendor: lease.vendor, spent, afterRelease };
      },
      // A Response with a streaming body and bytes no text codec survives.
      probe_fetch: async () => {
        const response = await api.hostFetch("https://example.invalid/bytes");
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, header: response.headers.get("x-lvis"), bytes: [...bytes] };
      },
      // Delegation: the plugin asks the host to spawn something that can reach
      // further than the plugin process may.
      probe_worker_escape: async () => await attempt(() => api.spawnWorker({
        workerId: "escape",
        command: "/bin/sh",
        allowWritePaths: ["/"],
      })),
      probe_worker_allowed: async () => {
        const worker = await api.spawnWorker({
          workerId: "indexer",
          command: "/usr/bin/true",
          allowReadPaths: [context.pluginRoot],
          allowWritePaths: [context.pluginDataDir],
        });
        return {
          socketPath: worker.socketPath,
          pid: worker.pid,
          // A live handle would carry these. An id carries none of them.
          fields: Object.keys(worker).sort(),
        };
      },
      probe_config: async () => api.config.get("watched") ?? null,
    },
  };
};
`,
        "utf-8",
      );

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

      const release = vi.fn();
      const spawnWorker = vi.fn(async () => ({
        socketPath: "/run/indexer.sock",
        pid: 31337,
        stop: () => undefined,
        onStdout: () => undefined,
        onStderr: () => undefined,
        onExit: () => undefined,
      }));
      const configValues = new Map<string, unknown>([["watched", "before"]]);
      const configListeners = new Set<(value: unknown) => void>();
      const hostApi = {
        // The four-tier gate, standing in for its verdict: one key granted, one
        // refused. The boundary's job is to carry the verdict, not to make it.
        getSecret: async (key: string) => (key === "granted" ? SECRET_TEXT : null),
        resolveApiKey: async () => ({
          ok: true as const,
          vendor: "openai" as const,
          bearer: () => "sk-lease-credential",
          release,
        }),
        hostFetch: async () =>
          new Response(new Uint8Array([0x00, 0x80, 0xff, 0x41]), {
            status: 207,
            headers: { "x-lvis": "from-the-host" },
          }),
        spawnWorker,
        getInstalledPluginIds: () => ["work-assistant"],
        onPluginsChanged: () => () => undefined,
        config: {
          get: (key: string) => configValues.get(key),
          set: async () => undefined,
          onChange: (_key: string, callback: (value: unknown) => void) => {
            configListeners.add(callback);
            return () => configListeners.delete(callback);
          },
        },
      } as unknown as PluginHostApi;

      const factory = createOutOfProcessPluginFactory({
        manifest: {
          id: PLUGIN_ID,
          name: "Work Assistant",
          version: "0.10.14",
          entry: "plugin.mjs",
          description: "the lossy members, confined",
          configSchema: { type: "object", properties: { watched: { type: "string" } } },
          tools: [
            "probe_credentials",
            "probe_lease",
            "probe_fetch",
            "probe_worker_escape",
            "probe_worker_allowed",
            "probe_config",
          ].map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        } as PluginManifest,
        entryPath,
        childEntryPath,
      });
      const instance = await factory({
        pluginId: PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        hostRoot: repoRoot,
        pluginDataDir: fx.pluginDataDir,
        config: { watched: "before" },
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);

      try {
        // ── getSecret ──────────────────────────────────────────────────────
        const credentials = (await instance.handlers.probe_credentials!()) as {
          granted: string | null;
          denied: string | null;
          directRead: { ok: boolean; value?: string };
        };
        // The value DOES cross. The gate is the control, and a plugin the gate
        // granted holds the same string it would hold in-process.
        expect(credentials.granted).toBe(SECRET_TEXT);
        // …and one it did not is `null`, not a throw and not a stale value.
        expect(credentials.denied).toBeNull();
        // The half isolation adds: the same process cannot reach around the
        // gate to the file, so the gate's verdict is the ONLY way in.
        expect(credentials.directRead.ok).toBe(false);
        expect(credentials.directRead.value).toBeUndefined();

        // ── resolveApiKey ──────────────────────────────────────────────────
        const lease = (await instance.handlers.probe_lease!()) as {
          ok: boolean;
          vendor: string;
          spent: string;
          afterRelease: { ok: boolean; message: string };
        };
        expect(lease).toMatchObject({ ok: true, vendor: "openai", spent: "sk-lease-credential" });
        // `release()` is a real release on BOTH sides: the child's copy is gone
        // and the host's lease was told.
        expect(lease.afterRelease.ok).toBe(false);
        expect(lease.afterRelease.message).toMatch(/lease already released/);
        expect(release).toHaveBeenCalledTimes(1);

        // ── hostFetch ──────────────────────────────────────────────────────
        const fetched = (await instance.handlers.probe_fetch!()) as {
          status: number;
          header: string;
          bytes: number[];
        };
        expect(fetched.status).toBe(207);
        expect(fetched.header).toBe("from-the-host");
        // A NUL, a lone continuation byte and a 0xFF. A text codec replaces all
        // three with U+FFFD and reports success.
        expect(fetched.bytes).toEqual([0x00, 0x80, 0xff, 0x41]);

        // ── spawnWorker ────────────────────────────────────────────────────
        const escape = (await instance.handlers.probe_worker_escape!()) as {
          ok: boolean;
          message: string;
        };
        expect(escape.ok).toBe(false);
        expect(escape.message).toMatch(/outside the plugin's own confinement/);
        // Refused at the boundary, so the supervisor never saw it. A refusal
        // that still spawned would be no refusal.
        expect(spawnWorker).not.toHaveBeenCalled();

        const spawned = (await instance.handlers.probe_worker_allowed!()) as {
          socketPath: string;
          pid: number;
          fields: string[];
        };
        expect(spawnWorker).toHaveBeenCalledTimes(1);
        expect(spawned.socketPath).toBe("/run/indexer.sock");
        expect(spawned.pid).toBe(31337);
        // The plugin holds an id and two scalars behind four local methods —
        // nothing that could be a `ChildProcess`.
        expect(spawned.fields).toEqual([
          "onExit",
          "onStderr",
          "onStdout",
          "pid",
          "socketPath",
          "stop",
        ]);

        // ── config.get, re-pushed ──────────────────────────────────────────
        await expect(instance.handlers.probe_config!()).resolves.toBe("before");
        configValues.set("watched", "after");
        for (const listener of configListeners) listener("after");
        // The child answers `config.get` from a snapshot, so this is the whole
        // difference between a current answer and a permanently stale one.
        await expect(instance.handlers.probe_config!()).resolves.toBe("after");
      } finally {
        await instance.stop?.();
        rmSync(childOutDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

/**
 * `meeting`, out of process and confined, through the production factory.
 *
 * THE POINT OF THIS ONE IS THE GATE. In one heap `hostApi.getSecret` was a
 * function `meeting` could simply not call: the secret gate lives in the same
 * process as the plugin, and `<LVIS_HOME>/secrets/` is a `readFileSync` away.
 * Out of process it is the only entrance, so the interesting assertion is not
 * that a granted key crosses — it is all three answers side by side, from one
 * child inside one call: the granted key comes back as its value, the refused
 * key comes back as `null`, and the file itself comes back denied. Any two of
 * those without the third is a weaker claim than it reads as.
 *
 * `meeting` also runs FFmpeg, which it stages under its own `pluginDataDir`
 * and executes. That is a grandchild of a confined child, so one handler stages
 * an executable exactly where `ffmpegRuntime.ts` puts it, runs it, and makes it
 * try both directions of the jail — a confinement that ended at the first
 * `spawn()` would leave every assertion above true and worthless.
 *
 * The last two handlers drive the two of `meeting`'s CHANGED paths a test can
 * reach without a live egress fence, and each is asserted here so the routing
 * SOT's note about it is a measurement rather than a prediction:
 *
 *  - The legacy session move out of `<hostRoot>`. An un-migrated file is
 *    PLANTED from the host side first, so the handler runs the plugin's own
 *    `renameSync` out of that directory rather than a stand-in `mkdir` — the
 *    two land outside the same jail but they are different syscalls, and only
 *    one of them is the operation the plugin performs.
 *  - The temp root the sandbox substitutes. `CLAUDE_CODE_TMPDIR` is pointed at
 *    a path that does NOT exist, which is the state an ordinary machine is in:
 *    ASRT rewrites the child's `TMPDIR` to `/tmp/claude` when nothing names
 *    another, that path is on its default WRITE allow-list, and nothing
 *    creates it. Pointing it at an absent path INSIDE this child's own write
 *    jail reproduces that state on any machine — including one whose
 *    `/tmp/claude` happens to exist, which is the only reason the first
 *    measurement of this consequence read as green.
 */
describe("meeting, out of process and confined", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "carries the gate's verdict both ways while the secrets file stays out of reach",
    async () => {
      if (!(await asrtCanInitialize())) return;
      const fx = fixture!;
      const plugin = installPlugin(fx, "meeting");
      const repoRoot = repositoryRoot();
      const childOutDir = childBundleDir(repoRoot);
      const childEntryPath = await buildChildEntry(repoRoot);

      // The un-migrated state the plugin's own guard requires before it will
      // attempt the move at all, planted from the HOST side because a confined
      // child could not have created it. Without this the handler below would
      // exercise a `mkdir` the plugin never performs and report the same
      // denial for a different reason.
      const legacyDir = join(fx.hostRoot, ".meeting-sessions");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "session-1.json"), LEGACY_SESSION_BYTES, "utf-8");

      const entryPath = join(plugin.pluginRoot, "plugin.mjs");
      writeFileSync(
        entryPath,
        `import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const attempt = async (fn) => {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, code: error.code ?? error.name, message: String(error.message ?? "") }; }
};
export const createPlugin = async (context) => {
  const api = context.hostApi;
  // The plugin's own view of the two prompt keys it watches. Written by the
  // host's change push, read back by a tool, so the assertion is on what the
  // PLUGIN saw rather than on what the host sent.
  const observedPrompts = {};
  // Tagged with \`typeof\` rather than normalised with \`?? null\`, because the
  // claim being made is that a CLEARED key arrives as \`undefined\` and not as
  // \`null\`. A stub that folded both into \`null\` would report the same thing
  // either way, and the wire's reason for wrapping the value would go untested.
  const observe = (value) => [typeof value, value ?? null];
  api.config.onChange("customSummaryFinalPrompt", (value) => { observedPrompts.final = observe(value); });
  api.config.onChange("customSummaryIntermediatePrompt", (value) => { observedPrompts.intermediate = observe(value); });
  return {
    handlers: {
      // The three answers to "can this plugin have the STT key", together.
      meeting_credentials_probe: async () => ({
        granted: await api.getSecret("llm.apiKey.openai"),
        denied: await api.getSecret("llm.apiKey.azure-foundry"),
        directRead: await attempt(() => readFileSync(${JSON.stringify(fx.secretFile)}, "utf-8")),
      }),
      // The transcription round: a lease, the Whisper egress, the summary.
      meeting_transcription_probe: async () => {
        const lease = await api.resolveApiKey({ purpose: "stt" });
        const bearer = lease.bearer();
        lease.release();
        const afterRelease = await attempt(() => lease.bearer());
        const response = await api.hostFetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST" });
        return {
          vendor: lease.vendor,
          bearer,
          afterRelease,
          status: response.status,
          transcript: [...new Uint8Array(await response.arrayBuffer())],
          summary: await api.callLlm("summarise the meeting"),
        };
      },
      meeting_prompts_probe: async () => ({ ...observedPrompts }),
      // FFmpeg: staged under pluginDataDir exactly where ffmpegRuntime.ts puts
      // it, then run. The plugin is useless without this, and it is the second
      // thing a jail could plausibly break.
      meeting_ffmpeg_probe: async () => {
        const binDir = join(context.pluginDataDir, "vendor", "ffmpeg", "bin");
        mkdirSync(binDir, { recursive: true });
        const staged = join(binDir, "ffmpeg");
        writeFileSync(staged, "#!/bin/sh\\n"
          + "echo staged-runtime-ran\\n"
          + "cat " + ${JSON.stringify(fx.secretFile)} + " 2>/dev/null && echo LEAKED || echo denied\\n"
          + "echo escaped > " + ${JSON.stringify(fx.outsideFile)} + " 2>/dev/null && echo wrote || echo denied\\n");
        chmodSync(staged, 0o755);
        const run = spawnSync(staged, [], { encoding: "utf-8" });
        if (run.error) return { started: false, code: run.error.code ?? run.error.name };
        return { started: true, status: run.status, stdout: String(run.stdout).trim().split("\\n") };
      },
      // The one-time move of the pre-\`pluginDataDir\` session directory, run as
      // the plugin runs it: the source path built off \`context.hostRoot\`, the
      // destination inside \`pluginDataDir\`, and the move itself a
      // \`renameSync\` per file rather than a directory creation.
      meeting_legacy_session_probe: async () => {
        const legacyDir = join(context.hostRoot, ".meeting-sessions");
        const sessionsDir = join(context.pluginDataDir, "sessions");
        return {
          legacyDir,
          listed: await attempt(() => readdirSync(legacyDir)),
          prepared: await attempt(() => { mkdirSync(sessionsDir, { recursive: true }); return "made"; }),
          migrate: await attempt(() => {
            for (const file of readdirSync(legacyDir)) {
              renameSync(join(legacyDir, file), join(sessionsDir, file));
            }
            return "moved";
          }),
        };
      },
      // The temp root the plugin stages under. \`readdirSync(tmpdir())\` is the
      // first statement of the sweep its own \`createPlugin\` runs unguarded,
      // and \`mkdtempSync(join(tmpdir(), ...))\` is how it stages an upload.
      meeting_tmpdir_probe: async () => ({
        tmpdir: tmpdir(),
        sweep: await attempt(() => readdirSync(tmpdir()).length),
        stage: await attempt(() => mkdtempSync(join(tmpdir(), "lvis-meeting-upload-"))),
        // The plugin does not do this, and that is the point: the path is
        // inside the write jail, so creating it succeeds. Absence is the
        // failure, not permission.
        create: await attempt(() => { mkdirSync(tmpdir(), { recursive: true }); return "made"; }),
      }),
    },
  };
};
`,
        "utf-8",
      );

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

      const release = vi.fn();
      const configValues = new Map<string, unknown>([
        ["customSummaryFinalPrompt", "the original final prompt"],
        ["customSummaryIntermediatePrompt", "the original intermediate prompt"],
      ]);
      /**
       * Per-key listeners, because the host's own change bus is per-key.
       *
       * A single undifferentiated set would deliver every notification to
       * every subscriber, and the assertion below — that the plugin's two
       * prompt watchers each saw THEIR key's value — would pass no matter
       * which key actually changed.
       */
      const configListeners = new Map<string, Set<(value: unknown) => void>>();
      const changeConfig = (key: string, value: unknown): void => {
        if (value === undefined) configValues.delete(key);
        else configValues.set(key, value);
        // `"*"` is the bus's every-key wildcard, which is what the factory's own
        // snapshot re-push subscribes to.
        for (const listener of configListeners.get(key) ?? []) listener(value);
        for (const listener of configListeners.get("*") ?? []) listener(value);
      };
      const hostApi = {
        // The four-tier gate, standing in for its verdict. Both keys are ones
        // `meeting` really declares under `hostSecrets.read`, so the shape of
        // the question is the plugin's own.
        getSecret: async (key: string) =>
          key === "llm.apiKey.openai" ? SECRET_TEXT : null,
        resolveApiKey: async () => ({
          ok: true as const,
          vendor: "openai" as const,
          bearer: () => "sk-stt-lease",
          release,
        }),
        hostFetch: async () =>
          new Response(new Uint8Array([0x00, 0x80, 0xff, 0x41]), { status: 200 }),
        callLlm: async () => "three action items",
        emitEvent: () => undefined,
        logEvent: () => undefined,
        onEvent: () => () => undefined,
        getInstalledPluginIds: () => ["meeting"],
        onPluginsChanged: () => () => undefined,
        config: {
          get: (key: string) => configValues.get(key),
          set: async () => undefined,
          onChange: (key: string, callback: (value: unknown) => void) => {
            const forKey = configListeners.get(key) ?? new Set();
            forKey.add(callback);
            configListeners.set(key, forKey);
            return () => forKey.delete(callback);
          },
        },
      } as unknown as PluginHostApi;

      const factory = createOutOfProcessPluginFactory({
        manifest: {
          id: "meeting",
          name: "LVIS Meeting",
          version: "0.5.42",
          entry: "plugin.mjs",
          description: "the recorder, confined",
          configSchema: {
            type: "object",
            properties: {
              customSummaryFinalPrompt: { type: "string" },
              customSummaryIntermediatePrompt: { type: "string" },
            },
          },
          tools: [
            "meeting_credentials_probe",
            "meeting_transcription_probe",
            "meeting_prompts_probe",
            "meeting_ffmpeg_probe",
            "meeting_legacy_session_probe",
            "meeting_tmpdir_probe",
          ].map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        } as PluginManifest,
        entryPath,
        childEntryPath,
      });
      // Reproduce, on THIS machine, the temp root an ordinary machine has:
      // one the sandbox hands the child and that does not exist. It is placed
      // inside `pluginDataDir` so it is WRITE-ALLOWED and merely absent, which
      // is exactly `/tmp/claude`'s status — on ASRT's default write allow-list
      // and created by nothing. Read by ASRT out of the HOST env while it
      // builds the wrap, so it must be set before the spawn.
      const absentSandboxTmp = join(plugin.pluginDataDir, "sandbox-tmp-that-is-absent");
      expect(existsSync(absentSandboxTmp)).toBe(false);
      process.env.CLAUDE_CODE_TMPDIR = absentSandboxTmp;

      const instance = await factory({
        pluginId: "meeting",
        pluginRoot: plugin.pluginRoot,
        // The app root, as production passes it — a directory the child has no
        // write grant for, which is what makes the legacy-migration case below
        // an assertion rather than a coincidence.
        hostRoot: fx.hostRoot,
        pluginDataDir: plugin.pluginDataDir,
        config: Object.fromEntries(configValues),
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);

      try {
        // ── the gate's two arms, and the door it replaced ──────────────────
        const credentials = (await instance.handlers.meeting_credentials_probe!()) as {
          granted: string | null;
          denied: string | null;
          directRead: { ok: boolean; value?: string };
        };
        expect(credentials.granted).toBe(SECRET_TEXT);
        // Refused is `null` — not a throw, and not a stale value from a key the
        // gate did grant.
        expect(credentials.denied).toBeNull();
        // …and the file the plugin used to be able to read instead.
        expect(credentials.directRead.ok).toBe(false);
        expect(credentials.directRead.value).toBeUndefined();

        // ── resolveApiKey / hostFetch / callLlm ────────────────────────────
        const transcription = (await instance.handlers.meeting_transcription_probe!()) as {
          vendor: string;
          bearer: string;
          afterRelease: { ok: boolean; message: string };
          status: number;
          transcript: number[];
          summary: string;
        };
        expect(transcription.vendor).toBe("openai");
        expect(transcription.bearer).toBe("sk-stt-lease");
        expect(transcription.afterRelease.ok).toBe(false);
        expect(transcription.afterRelease.message).toMatch(/lease already released/);
        expect(release).toHaveBeenCalledTimes(1);
        expect(transcription.status).toBe(200);
        // A NUL, a lone continuation byte and a 0xFF: audio bytes no text codec
        // survives, which is what the transcription upload actually carries.
        expect(transcription.transcript).toEqual([0x00, 0x80, 0xff, 0x41]);
        expect(transcription.summary).toBe("three action items");

        // ── config.onChange, on the two keys meeting really watches ────────
        // Nothing has changed yet, so the plugin has seen no notification.
        await expect(instance.handlers.meeting_prompts_probe!()).resolves.toEqual({});
        changeConfig("customSummaryFinalPrompt", "the edited final prompt");
        changeConfig("customSummaryIntermediatePrompt", undefined);
        await expect(instance.handlers.meeting_prompts_probe!()).resolves.toEqual({
          final: ["string", "the edited final prompt"],
          // A cleared key reaches the plugin as `undefined` — the plugin tagged
          // the type before anything could normalise it. That is the whole
          // reason the wire wraps the value in a property instead of sending it
          // bare: an absent property reads back as `undefined`, and this is the
          // assertion that would go red if it started reading back as `null`.
          intermediate: ["undefined", null],
        });

        // ── the FFmpeg runtime the plugin stages and runs itself ───────────
        const ffmpeg = (await instance.handlers.meeting_ffmpeg_probe!()) as {
          started: boolean;
          status: number;
          stdout: string[];
        };
        expect(ffmpeg.started).toBe(true);
        expect(ffmpeg.status).toBe(0);
        // It runs — and it inherits the jail in both directions, so the
        // transcoder can neither read what the plugin that started it cannot
        // nor write where the plugin cannot. A confinement that ended at the
        // first `spawn()` would produce "LEAKED" and "wrote" here.
        expect(ffmpeg.stdout).toEqual(["staged-runtime-ran", "denied", "denied"]);
        expect(existsSync(fx.outsideFile)).toBe(false);

        // ── the legacy session move, which this boundary CHANGES ───────────
        const legacy = (await instance.handlers.meeting_legacy_session_probe!()) as {
          legacyDir: string;
          listed: { ok: boolean; value?: string[] };
          prepared: { ok: boolean; code?: string };
          migrate: { ok: boolean; code?: string };
        };
        // The plugin still builds the path off `hostRoot`, and it arrives in
        // the child unchanged…
        expect(legacy.legacyDir).toBe(legacyDir);
        // …the child can SEE the un-migrated file, so what follows is a WRITE
        // denial and not a child that simply found nothing to move…
        expect(legacy.listed.ok, JSON.stringify(legacy.listed)).toBe(true);
        expect(legacy.listed.value).toEqual(["session-1.json"]);
        // …its destination inside the jail is created without complaint…
        expect(legacy.prepared.ok, JSON.stringify(legacy.prepared)).toBe(true);
        // …but the move itself now fails closed rather than silently
        // succeeding, which is the consequence the routing SOT names.
        expect(legacy.migrate.ok, JSON.stringify(legacy.migrate)).toBe(false);
        // And nothing moved: the file is where it was, and none landed. A
        // partially-completed migration would be worse than a refused one.
        expect(readFileSync(join(legacyDir, "session-1.json"), "utf-8")).toBe(
          LEGACY_SESSION_BYTES,
        );
        expect(existsSync(join(plugin.pluginDataDir, "sessions", "session-1.json"))).toBe(
          false,
        );

        // ── the temp root the sandbox substitutes, and its absence ─────────
        const temp = (await instance.handlers.meeting_tmpdir_probe!()) as {
          tmpdir: string;
          sweep: { ok: boolean; code?: string };
          stage: { ok: boolean; code?: string };
          create: { ok: boolean; code?: string };
        };
        // The host's own temp directory is IRRELEVANT: the child never sees
        // it. ASRT rewrites `TMPDIR` for any wrap that carries a write policy,
        // and this spawn's does.
        expect(temp.tmpdir).toBe(absentSandboxTmp);
        expect(temp.tmpdir).not.toBe(tmpdir());
        // The sweep the plugin runs unguarded inside `createPlugin` — this
        // `ENOENT` is what escapes it and stops the plugin loading at all.
        expect(temp.sweep, JSON.stringify(temp.sweep)).toMatchObject({
          ok: false,
          code: "ENOENT",
        });
        // …and the upload staging, for the same reason.
        expect(temp.stage, JSON.stringify(temp.stage)).toMatchObject({
          ok: false,
          code: "ENOENT",
        });
        // The failure axis is ABSENCE, not permission: the same path is
        // writable the moment it exists. A jail denial would fail this too and
        // would mean something entirely different about the fix.
        expect(temp.create, JSON.stringify(temp.create)).toMatchObject({ ok: true });
      } finally {
        await instance.stop?.();
        rmSync(childOutDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
