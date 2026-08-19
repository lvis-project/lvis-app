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
 *  - Network confinement. The macOS backend filters egress through a proxy
 *    rather than a namespace, so a localhost probe would prove something
 *    different on each platform and an internet probe would pass on an offline
 *    machine for the wrong reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
// The SAME external boundary the shipped entry is built against, so the child
// bundled here is the child that ships rather than one built to different rules.
import { MAIN_BUNDLE_EXTERNALS } from "../../../../scripts/lib/main-bundle-externals.mjs";
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

interface Fixture {
  readonly root: string;
  readonly lvisHome: string;
  readonly secretFile: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  readonly outsideFile: string;
}

let fixture: Fixture | undefined;
let previousLvisHome: string | undefined;

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
  return {
    root,
    lvisHome,
    secretFile,
    pluginRoot,
    pluginDataDir,
    outsideFile: join(root, "outside-the-jail.txt"),
  };
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
  // The deny floor is derived from `lvisHome()`, so pointing it at the fixture
  // is what makes `<LVIS_HOME>/secrets` a real denied path with a real file in
  // it rather than an assertion about the developer's own home directory.
  process.env.LVIS_HOME = fixture.lvisHome;
});

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  if (previousLvisHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = previousLvisHome;
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

/** The repository root, from this test file's own location. */
function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

/**
 * Where the bundled child entry is emitted.
 *
 * INSIDE the repository, not in the fixture's temp dir. The bundle keeps `pino`
 * and ASRT external — for reasons the shipped build documents at length — so it
 * must sit where `node_modules` resolves, which is exactly the relationship
 * `dist/src/main/` has in production.
 */
function childBundleDir(repoRoot: string): string {
  return join(repoRoot, ".cache", "plugin-child-confined-e2e");
}

/**
 * Build the REAL child entry, against the real bundle boundary.
 *
 * Shared by both end-to-end cases rather than written twice: the externals, the
 * banner and the target are the shipped build's, and two copies of them are two
 * chances for one case to prove something about a child that does not ship.
 */
async function buildChildEntry(repoRoot: string): Promise<string> {
  const childEntryPath = join(childBundleDir(repoRoot), "plugin-child-main.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [join(repoRoot, "src/plugins/isolation/plugin-child-main.ts")],
    outfile: childEntryPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node22"],
    external: [...MAIN_BUNDLE_EXTERNALS],
    logLevel: "silent",
    banner: {
      js:
        'import { createRequire as __r } from "node:module";\n'
        + "const require = __r(import.meta.url);\n",
    },
  });
  return childEntryPath;
}

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
      const childOutDir = childBundleDir(repoRoot);
      const childEntryPath = await buildChildEntry(repoRoot);

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
      const childOutDir = childBundleDir(repoRoot);
      const childEntryPath = await buildChildEntry(repoRoot);

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
