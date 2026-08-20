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
 *  - The child cannot WRITE the fixture paths outside its allow set. Write in
 *    ASRT IS an allow-jail, so this one is a jail assertion rather than a deny
 *    assertion. "Its allow set" is larger than the two paths
 *    `spawnConfinedPluginChild` names: ASRT merges its OWN default write paths
 *    into every wrap, which include the temp root it also points the child's
 *    `TMPDIR` at. So this proves the child cannot reach the fixture paths; it
 *    does NOT prove the jail is those two directories and nothing else, and the
 *    next bullet is the case that says so out loud.
 *  - The child CAN write, durably, to a path in NEITHER named grant: the temp
 *    root ASRT substitutes, which is one of the default write paths it merges.
 *    Asserted here — with the host reading the bytes back — because the routing
 *    SOT and the blueprint both said the write jail was exactly two paths, and
 *    a sentence with no case behind it is how a false one survives review.
 *    Measured on macOS/arm64 with the sandbox active; the assertion
 *    is written against `tmpdir()` rather than a literal so it asks the same
 *    question on whichever backend is underneath.
 *  - The child CAN read and write its own `pluginDataDir`. A confinement that
 *    also broke the plugin would be indistinguishable from one that worked, so
 *    the positive case is part of the proof.
 *  - Confinement is MANDATORY: with ASRT inactive the spawn throws and no child
 *    exists. There is no unconfined child to fall back to.
 *  - `electron` is UNREACHABLE in the child. §4 lists that as a gain of the
 *    boundary; it is also the reason a plugin that owns a window cannot be
 *    admitted, so it is asserted here rather than described. The bare require,
 *    the shipped package and BOTH ESM forms are covered separately, because
 *    they do not fail in the same place and an author who hits one reaches for
 *    the next.
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
 *  - Anything at all, on a machine where the sandbox backend cannot
 *    initialize. The four cases below need a live sandbox, and where
 *    `asrtCanInitialize()` answers false they return before measuring. That is
 *    not a hypothetical machine: the Linux runner that runs the whole suite on
 *    every pull request has no bubblewrap — nothing in `.github/` or `scripts/`
 *    installs it and ASRT vendors only seccomp and srt-win — so on that runner
 *    the four sandbox cases return without spawning anything. To see what that
 *    looks like, make `asrtCanInitialize()` return false and run this file: all
 *    five cases pass, in milliseconds, with no skip mark and no warning.
 *    `sandboxCasesRun()` below is what stops that from being invisible: an
 *    environment that is SUPPOSED to run them sets
 *    `LVIS_REQUIRE_SANDBOX_CASES=1` and gets a failure instead of a silent
 *    pass. The macOS job in `ci.yml` sets it, because the macOS backend needs
 *    no install; the Linux job does not, and there these cases still return
 *    without measuring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
// The child entry is bundled by the shared module rather than here: its
// externals, banner and target are the shipped build's, and a second copy of
// them is a second chance for one case to prove something about a child that
// does not ship.
import { buildChildEntry, childBundleDir, repositoryRoot } from "./child-entry-bundle.js";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext } from "../../types.js";
import type { DelegatedWorkerConfinement } from "../host-api-service-paths.js";
import {
  createOutOfProcessPluginFactory,
  derivePluginChildEnvelope,
} from "../out-of-process-plugin.js";
import {
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  resetAsrtSandbox,
} from "../../../permissions/asrt-sandbox.js";
import { asrtCanInitialize } from "../../../permissions/__tests__/test-helpers.js";
import { spawnConfinedPluginChild } from "../out-of-process-plugin.js";

const PLUGIN_ID = "work-assistant";
/**
 * The one plugin `PLUGIN_ENVELOPE_GRANTS` carries a row for, so the widening
 * case drives the production table rather than a fixture that stands in for it.
 */
const WIDENED_PLUGIN_ID = "local-indexer";
const SECRET_TEXT = "the-host-secret-the-child-must-not-read";
/** The bytes the host-owned trust-anchor file holds, so "the child read it" is checkable. */
const CA_TEXT = "-----BEGIN CERTIFICATE-----\nthe-corporate-trust-anchor\n";
/** The bytes an un-migrated session file holds, so "nothing moved" is checkable. */
const LEGACY_SESSION_BYTES = "the session that predates pluginDataDir";
/** Stands in for the plugin's own code: readable out of `pluginRoot`, never writable back into it. */
const PLUGIN_CODE_BYTES = "the plugin's own code, which it may read and may not rewrite";
/** What one child leaves in the shared temp root, so a second child reading it is a channel and not a coincidence. */
const SHARED_TEMP_BYTES = "bytes one confined child left where another confined child can read them";

/**
 * Whether the cases that need a live sandbox may run here — and whether being
 * unable to run them is allowed to be silent.
 *
 * Returning false lets the file be developed on a machine without the backend.
 * It is ALSO how these cases pass without measuring anything, which is not a
 * theoretical concern: the Linux runner that runs the whole suite on every pull
 * request has no bubblewrap, so `asrtCanInitialize()` is false there and four of
 * this file's five cases return immediately — no skip mark, no warning, green.
 *
 * `LVIS_REQUIRE_SANDBOX_CASES` is how an environment that is supposed to run
 * them says so. With it set, a machine that cannot initialize the sandbox fails
 * HERE, loudly, instead of reporting a measurement it never took. It only ever
 * turns a silent pass into a failure; nothing about the cases themselves reads
 * it.
 */
async function sandboxCasesRun(): Promise<boolean> {
  if (await asrtCanInitialize()) return true;
  if (process.env.LVIS_REQUIRE_SANDBOX_CASES === "1") {
    throw new Error(
      "LVIS_REQUIRE_SANDBOX_CASES=1 but the ASRT sandbox cannot initialize on this "
        + "machine, so the confinement cases would pass without measuring anything. "
        + "Install the platform backend (macOS needs none; Linux needs bubblewrap) or "
        + "unset the variable and accept that these cases do not run here.",
    );
  }
  return false;
}

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
  /**
   * The basename a child writes into the temp root ASRT substitutes.
   *
   * Unique per fixture because that root is SHARED — it is one of ASRT's own
   * default write paths, so every confined child on the machine reaches the
   * same directory and a fixed name would let two runs, or two plugins, collide
   * in it. Which is the finding the case using this asserts.
   */
  readonly sharedTempName: string;
  /** `<LVIS_HOME>/certs/corp-ca.pem` — host-owned AND on the read-deny floor. */
  readonly caFile: string;
  /** A directory the user approved, standing in for a chosen index root. */
  readonly userRoot: string;
  /** Its name-prefix sibling, which no grant covers. */
  readonly userRootSibling: string;
  /**
   * A chosen directory INSIDE the approved root that does not exist yet — the
   * case that decides what "the declared path is not there" means.
   */
  readonly pendingWorkspace: string;
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
  const certsDir = join(lvisHome, "certs");
  const pluginRoot = join(lvisHome, "plugins", PLUGIN_ID);
  const pluginDataDir = join(pluginRoot, "data");
  const userRoot = join(root, "chosen-index-root");
  const userRootSibling = `${userRoot}-elsewhere`;
  // Deliberately NOT created: the spawn is what materialises a granted root.
  const pendingWorkspace = join(userRoot, "pending-workspace");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  mkdirSync(userRootSibling, { recursive: true, mode: 0o700 });
  const secretFile = join(secretsDir, "api-key.txt");
  const caFile = join(certsDir, "corp-ca.pem");
  writeFileSync(secretFile, SECRET_TEXT, "utf-8");
  writeFileSync(caFile, CA_TEXT, "utf-8");
  writeFileSync(join(pluginDataDir, "own-data.txt"), "the plugin's own bytes", "utf-8");
  writeFileSync(join(pluginRoot, "own-code.js"), PLUGIN_CODE_BYTES, "utf-8");
  const hostRoot = join(root, "app-root");
  mkdirSync(hostRoot, { recursive: true });
  // The user's own workspace-root approvals, read back by the envelope
  // derivation through `readPermissionSettings()`. Written as a file rather
  // than stubbed because the ceiling on a user-chosen directory is exactly this
  // list, and a stub would prove the test's copy of the rule.
  writeFileSync(
    join(lvisHome, "settings.json"),
    JSON.stringify({ permissions: { additionalDirectories: [userRoot] } }, null, 2),
    "utf-8",
  );
  return {
    root,
    lvisHome,
    secretFile,
    pluginRoot,
    pluginDataDir,
    outsideFile: join(root, "outside-the-jail.txt"),
    hostRoot,
    sharedTempName: `${basename(root)}.txt`,
    caFile,
    userRoot,
    userRootSibling,
    pendingWorkspace,
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
  // The `electron` npm package's entry, in the shape that matters: it exports
  // the PATH of the binary as a string. Planted from the host, inside the
  // child's read carve-out, because the child could not create it and because
  // the question it answers — "what if the plugin ships the package?" — is
  // about what the entry EXPORTS, not about module resolution.
  const vendoredDir = join(fx.pluginRoot, "vendored-electron");
  mkdirSync(vendoredDir, { recursive: true });
  writeFileSync(
    join(vendoredDir, "index.js"),
    "module.exports = '/path/to/an/Electron/binary';\n",
    "utf-8",
  );
  // A module whose only content is the form an ESM plugin writes. Planted as a
  // FILE rather than evaluated inline because a named import is resolved when
  // the module is LINKED, and linking is the step whose failure is the answer.
  const namedImportPath = join(fx.pluginRoot, "named-electron-import.mjs");
  writeFileSync(
    namedImportPath,
    "import { BrowserWindow } from \"electron\";\nexport const browserWindow = typeof BrowserWindow;\n",
    "utf-8",
  );
  writeFileSync(
    probePath,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } };
/** What \`typeof\` says about a resolved module's \`BrowserWindow\`, or the kind of the module itself. */
const describeModule = (value) => (value && typeof value === "object")
  ? { kind: "object", browserWindow: typeof value.BrowserWindow }
  : { kind: typeof value, browserWindow: "undefined" };
const report = {
  readSecret: attempt(() => readFileSync(${JSON.stringify(fx.secretFile)}, "utf-8")),
  readOwnData: attempt(() => readFileSync(${JSON.stringify(join(fx.pluginDataDir, "own-data.txt"))}, "utf-8")),
  writeOwnData: attempt(() => { writeFileSync(${JSON.stringify(join(fx.pluginDataDir, "written-by-child.txt"))}, "hello"); return "written"; }),
  writeOutside: attempt(() => { writeFileSync(${JSON.stringify(fx.outsideFile)}, "escaped"); return "written"; }),
  writeSecrets: attempt(() => { writeFileSync(${JSON.stringify(join(fx.lvisHome, "secrets", "planted.txt"))}, "escaped"); return "written"; }),
  // \`pluginRoot\` is the asymmetric one: the child READS it — that is where
  // its own code lives — and cannot WRITE it, because those are the bytes the
  // integrity check hashed. Read and write are separate grants and only one of
  // them names this path.
  readOwnCode: attempt(() => readFileSync(${JSON.stringify(join(fx.pluginRoot, "own-code.js"))}, "utf-8")),
  writeOwnCode: attempt(() => { writeFileSync(${JSON.stringify(join(fx.pluginRoot, "smuggled.js"))}, "escaped"); return "written"; }),
  // The third answer this axis gives, and the only one that looks like
  // success. HOME is SUBSTITUTED with a throwaway the spawn grants and
  // \`createSandboxProcessHome\` removes when the child exits, so a plugin that
  // roots its state at \`homedir()\` is neither denied nor durable: the write
  // returns \`written\` and the bytes are gone by the next start.
  childHome: homedir(),
  writeChildHome: attempt(() => { writeFileSync(join(homedir(), "state.json"), "state"); return "written"; }),
  // The FOURTH answer, and the one that falsifies "the jail is those two
  // paths". ASRT merges its own default write paths into every wrap, and the
  // temp root it substitutes is one of them — so this write is outside
  // \`pluginDataDir\`, outside the substituted HOME, and DURABLE. The host reads
  // the bytes back to show the last part.
  childTmpdir: tmpdir(),
  writeChildTmpdir: attempt(() => { mkdirSync(tmpdir(), { recursive: true }); writeFileSync(join(tmpdir(), ${JSON.stringify(fx.sharedTempName)}), ${JSON.stringify(SHARED_TEMP_BYTES)}); return "written"; }),
  readCa: attempt(() => readFileSync(${JSON.stringify(fx.caFile)}, "utf-8")),
  writeCa: attempt(() => { writeFileSync(${JSON.stringify(fx.caFile)}, "rewritten"); return "written"; }),
  writeUserRoot: attempt(() => { writeFileSync(${JSON.stringify(join(fx.userRoot, "index.bin"))}, "index"); return "written"; }),
  writeUserRootSibling: attempt(() => { writeFileSync(${JSON.stringify(join(fx.userRootSibling, "index.bin"))}, "escaped"); return "written"; }),
  writePendingWorkspace: attempt(() => { writeFileSync(${JSON.stringify(join(fx.pendingWorkspace, "state.json"))}, "{}"); return "written"; }),
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  // The process IS Electron — this is the binary the host runs as — and the
  // next two lines are what it can do with that.
  electronVersion: process.versions.electron ?? null,
  requireElectron: (() => { const r = attempt(() => require("electron")); return r.ok ? { ok: true, module: describeModule(r.value) } : r; })(),
  // The package, resolved by absolute path so the answer is about what the
  // ENTRY exports rather than about where resolution happened to look.
  requirePackagedElectron: (() => { const r = attempt(() => require(${JSON.stringify(join(fx.pluginRoot, "vendored-electron", "index.js"))})); return r.ok ? { ok: true, module: describeModule(r.value) } : r; })(),
  // The two ESM forms. \`require\` is not the whole answer: the CJS registry and
  // the ESM resolver disagree about \`electron\` in this child, so a plugin's
  // module system decides WHERE it breaks.
  //
  // The namespace's OWN \`BrowserWindow\` is not the whole answer either. A CJS
  // module reached through the ESM resolver hangs its exports off \`default\`, so
  // the question "did the API come back" has to be asked of \`default\` — an
  // assertion that only read the namespace would stay green if \`default\` were
  // the real \`electron\`.
  importElectron: await (async () => { try { const ns = await import("electron"); const d = ns.default; return { ok: true, module: describeModule(ns), defaultKeys: (d && typeof d === "object") ? Object.keys(d) : null, defaultBrowserWindow: d ? typeof d.BrowserWindow : "no-default" }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } })(),
  namedImportElectron: await (async () => { try { const m = await import(${JSON.stringify(namedImportPath)}); return { ok: true, module: { kind: "namespace", browserWindow: String(m.browserWindow) } }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } })(),
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

/** What a resolved module turned out to be, from inside the child. */
interface ProbeModule {
  readonly kind: string;
  readonly browserWindow: string;
}

interface ProbeModuleAttempt {
  readonly ok: boolean;
  readonly module?: ProbeModule;
  readonly code?: string;
}

/**
 * A namespace produced by the ESM resolver, which is not the same object shape
 * a `require` returns: a CJS module reached this way carries its exports on
 * `default`, so the namespace and its `default` are reported separately.
 */
interface ProbeNamespaceAttempt extends ProbeModuleAttempt {
  readonly defaultKeys?: readonly string[] | null;
  readonly defaultBrowserWindow?: string;
}

interface ProbeReport {
  readonly readSecret: ProbeAttempt;
  readonly readOwnData: ProbeAttempt;
  readonly writeOwnData: ProbeAttempt;
  readonly writeOutside: ProbeAttempt;
  readonly writeSecrets: ProbeAttempt;
  readonly readOwnCode: ProbeAttempt;
  readonly writeOwnCode: ProbeAttempt;
  readonly childHome: string;
  readonly writeChildHome: ProbeAttempt;
  readonly childTmpdir: string;
  readonly writeChildTmpdir: ProbeAttempt;
  readonly readCa: ProbeAttempt;
  readonly writeCa: ProbeAttempt;
  readonly writeUserRoot: ProbeAttempt;
  readonly writeUserRootSibling: ProbeAttempt;
  readonly writePendingWorkspace: ProbeAttempt;
  readonly electronRunAsNode: string | null;
  readonly electronVersion: string | null;
  readonly requireElectron: ProbeModuleAttempt;
  readonly requirePackagedElectron: ProbeModuleAttempt;
  readonly importElectron: ProbeNamespaceAttempt;
  readonly namedImportElectron: ProbeModuleAttempt;
}

/**
 * The envelope an UNWIDENED plugin gets: its own two directories and nothing
 * else, as `derivePluginChildEnvelope` produces for a plugin with no row in
 * `PLUGIN_ENVELOPE_GRANTS`.
 */
function baseEnvelope(fx: Fixture): DelegatedWorkerConfinement {
  return derivePluginChildEnvelope({
    pluginId: PLUGIN_ID,
    pluginRoot: fx.pluginRoot,
    pluginDataDir: fx.pluginDataDir,
    configValue: () => undefined,
  });
}

async function runProbe(
  fx: Fixture,
  envelope: DelegatedWorkerConfinement = baseEnvelope(fx),
): Promise<ProbeReport> {
  const child = await spawnConfinedPluginChild({
    pluginId: PLUGIN_ID,
    envelope,
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

/**
 * A SECOND confined child, from a second plugin, reading one absolute path.
 *
 * Spawned through the same production spawn with a different `pluginRoot` and
 * `pluginDataDir`, so the only thing the two children share is what ASRT gives
 * every wrap. That is the whole question: the routing SOT's write jail is
 * per-plugin, but the default write paths ASRT merges are not, so a path on
 * that list is reachable by both. This returns what the second child got.
 */
async function runCrossPluginReadProbe(
  fx: Fixture,
  reader: InstalledPlugin,
  absolutePath: string,
): Promise<ProbeAttempt> {
  const probePath = join(fx.root, "cross-plugin-probe.mjs");
  writeFileSync(
    probePath,
    `import { readFileSync } from "node:fs";
const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, code: error.code ?? error.name }; } };
process.stdout.write("PROBE:" + JSON.stringify(attempt(() => readFileSync(${JSON.stringify(absolutePath)}, "utf-8"))) + "\\n");
`,
    "utf-8",
  );
  const child = await spawnConfinedPluginChild({
    pluginId: reader.pluginId,
    pluginRoot: reader.pluginRoot,
    pluginDataDir: reader.pluginDataDir,
    childEntryPath: probePath,
  });
  return await new Promise<ProbeAttempt>((resolve, reject) => {
    let stdout = "";
    child.link.input.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.link.input.on("end", () => {
      const line = stdout.split("\n").find((entry) => entry.startsWith("PROBE:"));
      if (!line) {
        reject(new Error(`the cross-plugin probe produced no report; stdout was: ${stdout}`));
        return;
      }
      resolve(JSON.parse(line.slice("PROBE:".length)) as ProbeAttempt);
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

/**
 * What the host decided, before any of it reaches a kernel.
 *
 * These drive `derivePluginChildEnvelope` directly because the interesting
 * cases are REFUSALS, and a refusal has no child to probe. The approved-root
 * ceiling is read from the fixture's real `settings.json` through
 * `readPermissionSettings()`, so what is under test is the host's own notion of
 * "the user authorised this directory" rather than a copy of it.
 */
describe("the host decides how far a plugin child reaches", () => {
  /** `PLUGIN_ID` has no row in the table, so it gets the unwidened envelope. */
  it("gives a plugin with no host decision exactly its own two directories", () => {
    const fx = fixture!;
    expect(
      derivePluginChildEnvelope({
        pluginId: PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: () => undefined,
      }),
    ).toEqual({
      read: [fx.pluginRoot, fx.pluginDataDir],
      write: [fx.pluginDataDir],
    });
  });

  it("adds the host-owned directories its row names, to READ only", () => {
    const fx = fixture!;
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: () => undefined,
    });
    expect(envelope.read).toEqual([
      fx.pluginRoot,
      fx.pluginDataDir,
      join(fx.lvisHome, "runtime"),
      join(fx.lvisHome, "certs"),
    ]);
    // The row is READ, and nothing turns it into a write. A child that could
    // rewrite `~/.lvis/runtime` would be rewriting the interpreter its own
    // worker is about to execute.
    expect(envelope.write).toEqual([fx.pluginDataDir]);
  });

  it("admits a chosen directory the user approved, as read AND write", () => {
    const fx = fixture!;
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? fx.userRoot : undefined),
    });
    expect(envelope.read).toContain(fx.userRoot);
    expect(envelope.write).toEqual([fx.pluginDataDir, fx.userRoot]);
  });

  it("refuses a chosen directory no approved workspace root covers", () => {
    // THE ESCALATION THIS EXISTS TO STOP. `config.set` is a member the plugin
    // holds, so a widening that trusted the config value would let the plugin
    // name its own envelope. The host names the KEY; the user names the ceiling.
    const fx = fixture!;
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? fx.userRootSibling : undefined),
      }),
    ).toThrow(/no workspace root the user approved covers it/);
  });

  it("refuses the filesystem root, which no approval can cover", () => {
    const fx = fixture!;
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "workspace" ? "/" : undefined),
      }),
    ).toThrow(/no workspace root the user approved covers it/);
  });

  it("refuses a sensitive path even when an approved root contains it", () => {
    // `~/.lvis` is not itself a sensitive path, so the approval flow accepts it
    // as a workspace root — and `~/.lvis/secrets` is on the read-deny floor
    // that `allowRead` re-opens. Without this refusal the config key would be a
    // way to hand the floor's own contents to a plugin child.
    const fx = fixture!;
    writeFileSync(
      join(fx.lvisHome, "settings.json"),
      JSON.stringify({ permissions: { additionalDirectories: [fx.lvisHome] } }, null, 2),
      "utf-8",
    );
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) =>
          key === "indexStorageRoot" ? join(fx.lvisHome, "secrets") : undefined,
      }),
    ).toThrow(/matches the sensitive-path rule/);
  });

  it("admits a chosen directory inside the plugin's own data dir with no approval", () => {
    // It adds nothing the child did not already hold, so requiring an approval
    // would refuse the plugin's own default location.
    const fx = fixture!;
    const inside = join(fx.pluginDataDir, "index");
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? inside : undefined),
    });
    expect(envelope.write).toEqual([fx.pluginDataDir, inside]);
  });

  it("refuses a chosen directory under the plugin's own immutable runtime root", () => {
    // A `userChosenDirectory` grant carries WRITE. `pluginRoot` holds the
    // bundle the next load imports and the bytes the install receipt is taken
    // over, so admitting a value under it would hand the child a kernel-level
    // write over its own code — the primitive the jail exists to remove rather
    // than detect. The plugin reaches this with one `config.set` call: the
    // runtime root is a member of the context it is handed.
    const fx = fixture!;
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "workspace" ? join(fx.pluginRoot, "dist") : undefined),
      }),
    ).toThrow(/resolves inside the plugin's own immutable runtime root/);
  });

  it("refuses that runtime root even when an approved workspace root covers it", () => {
    // THE ARM THE TEST ABOVE DOES NOT REACH. That one leaves the runtime root
    // outside every approved root, so the refusal it observes could come from
    // the approval half alone. In the production layout `pluginDataDir` is a
    // CHILD of `pluginRoot` (`~/.lvis/plugins/<id>/data`), so a user who
    // approves any workspace root at or above the install location pulls the
    // runtime root back inside their own approvals — and an exclusion that
    // lives only on the own-root half is then not an exclusion at all. The
    // ceiling has two halves and the bundle has to be out of both.
    const fx = fixture!;
    writeFileSync(
      join(fx.lvisHome, "settings.json"),
      JSON.stringify({ permissions: { additionalDirectories: [fx.root] } }, null, 2),
      "utf-8",
    );
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "workspace" ? join(fx.pluginRoot, "dist") : undefined),
      }),
    ).toThrow(/resolves inside the plugin's own immutable runtime root/);
  });

  it("still admits the plugin's own data dir when an approved root covers the runtime root", () => {
    // The refusal above must not swallow the data directory, which is itself
    // under `pluginRoot`. If it did, the fix would be a plugin that cannot
    // write anywhere dressed as a containment result.
    const fx = fixture!;
    writeFileSync(
      join(fx.lvisHome, "settings.json"),
      JSON.stringify({ permissions: { additionalDirectories: [fx.root] } }, null, 2),
      "utf-8",
    );
    const inside = join(fx.pluginDataDir, "index");
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? inside : undefined),
    });
    expect(envelope.write).toEqual([fx.pluginDataDir, inside]);
  });

  it("refuses a chosen directory that reaches out of the data dir through a symlink", () => {
    // THE OTHER HALF OF THE SAME ESCALATION. The plugin writes its own data
    // directory, so a containment test on spellings alone is one it can satisfy
    // by planting the link and then naming it: the value reads as inside the
    // ceiling and denotes a directory the user never approved. The comparison
    // is canonical, so the link resolves before containment is asked.
    const fx = fixture!;
    const link = join(fx.pluginDataDir, "reaches-elsewhere");
    symlinkSync(fx.userRootSibling, link);
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? link : undefined),
      }),
    ).toThrow(/no workspace root the user approved covers it/);
  });

  it("still admits a symlink that stays inside the plugin's own data dir", () => {
    // The canonical comparison must not refuse the legitimate case, or the
    // fix would be a narrowing dressed as a containment result. The GRANTED
    // path stays the caller's spelling — the delegated-worker check compares
    // against these entries and the plugin asks with the value it holds.
    const fx = fixture!;
    const real = join(fx.pluginDataDir, "index-store");
    const link = join(fx.pluginDataDir, "index-link");
    mkdirSync(real, { recursive: true, mode: 0o700 });
    symlinkSync(real, link);
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? link : undefined),
    });
    expect(envelope.write).toEqual([fx.pluginDataDir, link]);
  });

  it("refuses a relative value rather than resolving it against the host's cwd", () => {
    const fx = fixture!;
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? "index" : undefined),
      }),
    ).toThrow(/is not an absolute path/);
  });

  it("refuses a value that is not a string", () => {
    const fx = fixture!;
    expect(() =>
      derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        configValue: (key) => (key === "indexStorageRoot" ? 7 : undefined),
      }),
    ).toThrow(/expected a string, got number/);
  });

  it("treats an unset and an empty key as no widening, not as the host's cwd", () => {
    // `""` is the default several plugin config schemas ship for an unset
    // string key, and `resolve("")` is the process working directory.
    const fx = fixture!;
    const envelope = derivePluginChildEnvelope({
      pluginId: WIDENED_PLUGIN_ID,
      pluginRoot: fx.pluginRoot,
      pluginDataDir: fx.pluginDataDir,
      configValue: (key) => (key === "indexStorageRoot" ? "" : undefined),
    });
    expect(envelope.write).toEqual([fx.pluginDataDir]);
  });
});

describe("a plugin that cannot be confined is not spawned", () => {
  it("throws rather than producing an unconfined child when ASRT is inactive", async () => {
    const fx = fixture!;
    expect(isAsrtSandboxActive()).toBe(false);
    await expect(
      spawnConfinedPluginChild({
        pluginId: PLUGIN_ID,
        envelope: baseEnvelope(fx),
        childEntryPath: writeProbeModule(fx),
      }),
    ).rejects.toThrow(/sandbox is not active/i);
  });

  it("throws rather than granting a root that is a dangling symlink", async () => {
    // The containment answer for a path that does not resolve is the nearest
    // existing ancestor plus the missing tail, which for a link planted inside
    // the data dir is a path INSIDE the ceiling — correct, because that is
    // where a write through it would land today. Where the link would point
    // once its target exists is unknowable, so the grant must not be handed to
    // a kernel: materialisation refuses it and the plugin does not load. Note
    // what fails here is the spawn, ahead of the wrap — an ASRT-inactive
    // harness reaches this first.
    const fx = fixture!;
    const dangling = join(fx.pluginDataDir, "dangling");
    symlinkSync(join(fx.root, "target-that-does-not-exist"), dangling);
    await expect(
      spawnConfinedPluginChild({
        pluginId: PLUGIN_ID,
        envelope: { read: [fx.pluginRoot, fx.pluginDataDir, dangling], write: [dangling] },
        childEntryPath: writeProbeModule(fx),
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("the confined child, against the real sandbox", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "is denied the host's secrets and the paths outside its write jail, and keeps its own",
    async () => {
      if (!(await sandboxCasesRun())) return;
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
      // …and it stops at `pluginDataDir` rather than covering everything the
      // child can reach: `pluginRoot` is READABLE, because the child loads its
      // own code out of it, and NOT writable, because a plugin that could
      // rewrite its runtime root could rewrite the bytes its own manifest hash
      // was taken over. Read and write are separate grants; asserting only the
      // paths that are denied to both would not show that.
      expect(report.readOwnCode.ok, JSON.stringify(report.readOwnCode)).toBe(true);
      expect(report.readOwnCode.value).toBe(PLUGIN_CODE_BYTES);
      expect(report.writeOwnCode.ok, JSON.stringify(report.writeOwnCode)).toBe(false);
      expect(existsSync(join(fx.pluginRoot, "smuggled.js"))).toBe(false);
      // The third answer, and the one a source census reads as success: HOME
      // is SUBSTITUTED, so a plugin that roots its state at `homedir()` is
      // neither denied nor durable. The write SUCCEEDS — and it lands in a
      // throwaway that is neither the user's home nor any granted path of this
      // plugin's, which `createSandboxProcessHome` removes when the child
      // exits. Asserted because "it worked" is the reading that admits a
      // plugin whose state silently resets on every start.
      expect(report.childHome).not.toBe(homedir());
      expect(report.childHome.startsWith(fx.pluginRoot)).toBe(false);
      expect(report.childHome.startsWith(fx.pluginDataDir)).toBe(false);
      expect(report.writeChildHome.ok, JSON.stringify(report.writeChildHome)).toBe(true);

      // ── the FOURTH answer: outside both grants, and DURABLE ────────────
      //
      // The write jail is NOT the two paths the spawn names. ASRT merges its
      // own default write paths into every wrap it builds, and the temp root
      // it substitutes is one of them — so this is a path in neither grant
      // that the child writes and the HOST then reads back. Asserted rather
      // than described because "exactly two paths" survived two revisions of
      // the routing SOT and the blueprint with no case able to contradict it.
      // Written against `tmpdir()` rather than a literal so it asks the same
      // question whichever backend is underneath.
      const sharedTemp = join(report.childTmpdir, fx.sharedTempName);
      // The shared root outlives the fixture, so this file is the one artefact
      // `afterEach` cannot reclaim — and it lands in a directory every other
      // confined child on the machine also reaches. The cleanup wraps every
      // assertion that follows the write, so a failing one does not leave it
      // there.
      try {
        expect(report.childTmpdir).not.toBe(report.childHome);
        expect(report.childTmpdir.startsWith(fx.pluginDataDir)).toBe(false);
        expect(report.childTmpdir.startsWith(report.childHome)).toBe(false);
        expect(report.writeChildTmpdir.ok, JSON.stringify(report.writeChildTmpdir)).toBe(true);
        // Durable, which is what separates this outcome from the `homedir()`
        // one: the bytes are still there, read from the unconfined host.
        expect(readFileSync(sharedTemp, "utf-8")).toBe(SHARED_TEMP_BYTES);

        // …and that path is SHARED. A second confined child, from a second
        // plugin with its own `pluginRoot` and `pluginDataDir`, reads the first
        // one's bytes. The per-plugin jail is per-plugin; the default paths
        // ASRT merges are not, so two confined plugins have a write channel
        // between them that neither manifest declares. Recorded as a defect
        // rather than closed here — the SOT's axis 6 says what closing it would
        // take and what it would cost.
        const crossPluginRead = await runCrossPluginReadProbe(
          fx,
          installPlugin(fx, "a-second-confined-plugin"),
          sharedTemp,
        );
        expect(crossPluginRead.ok, JSON.stringify(crossPluginRead)).toBe(true);
        expect(crossPluginRead.value).toBe(SHARED_TEMP_BYTES);
      } finally {
        rmSync(sharedTemp, { force: true });
      }

      // Nothing the host DID NOT widen this plugin with is reachable — the
      // corporate CA the deny floor covers, and a directory the user approved
      // for the host's own tools. Asserted on the unwidened plugin so the
      // widened case below is a difference rather than a claim.
      expect(report.readCa.ok, JSON.stringify(report.readCa)).toBe(false);
      expect(report.writeUserRoot.ok, JSON.stringify(report.writeUserRoot)).toBe(false);

      // …and the plugin still works, which is the other half of the claim.
      expect(report.readOwnData.ok, JSON.stringify(report.readOwnData)).toBe(true);
      expect(report.readOwnData.value).toBe("the plugin's own bytes");
      expect(report.writeOwnData.ok, JSON.stringify(report.writeOwnData)).toBe(true);
      expect(readFileSync(join(fx.pluginDataDir, "written-by-child.txt"), "utf-8")).toBe(
        "hello",
      );

      // ── §4's "No Electron", as a measurement rather than a sentence ────
      //
      // This used to assert the environment variable alone, under a comment
      // saying `electron` was unreachable — a control claimed in prose beside
      // code that never checked it. The variable is the MECHANISM; these are
      // the answers.
      expect(report.electronRunAsNode).toBe("1");
      // The process is Electron: `process.execPath` is the Electron binary in
      // production and, because this repository runs its own tests under that
      // binary, here too. So this is not a Node-versus-Electron artifact of the
      // runner — and the version being present while the API is not is the
      // trap: a plugin gating on `process.versions.electron` gets YES and walks
      // into the call below.
      expect(report.electronVersion).not.toBeNull();
      expect(report.requireElectron, JSON.stringify(report.requireElectron)).toMatchObject({
        ok: false,
        code: "MODULE_NOT_FOUND",
      });
      // And shipping the package does not answer it: its entry exports the
      // binary's PATH as a string, so `BrowserWindow` is `undefined` and any
      // guard on it throws. Both halves are asserted because a plugin author
      // hitting the first will try the second.
      expect(
        report.requirePackagedElectron,
        JSON.stringify(report.requirePackagedElectron),
      ).toMatchObject({ ok: true, module: { kind: "string", browserWindow: "undefined" } });
      // And the two ESM forms, which do NOT answer the way `require` does.
      // Asserted separately rather than left to the require case, because the
      // three differ in WHERE the plugin breaks and a note claiming one denial
      // for all three would be describing something untrue: `import()`
      // RESOLVES, to a namespace whose `BrowserWindow` is `undefined`, so an
      // ESM plugin reading it off the namespace fails only when it calls…
      expect(report.importElectron, JSON.stringify(report.importElectron)).toMatchObject({
        ok: true,
        module: { kind: "object", browserWindow: "undefined" },
        // …and the namespace's `default`, which is where a CJS module reached
        // through the ESM resolver would carry the API, is an EMPTY object. This
        // is the arm that would go red if the ESM path ever started handing back
        // the real `electron`, which the namespace's own keys would not show.
        defaultKeys: [],
        defaultBrowserWindow: "undefined",
      });
      // …while a NAMED import of the same specifier never links at all.
      expect(
        report.namedImportElectron,
        JSON.stringify(report.namedImportElectron),
      ).toMatchObject({ ok: false, code: "SyntaxError" });
    },
    60_000,
  );
});

/**
 * The widening, end to end: the host-owned table decides, the derivation
 * resolves, the wrap grants, and the kernel is asked.
 *
 * The point of running the WHOLE chain rather than handing the spawn a
 * hand-built envelope is that the interesting claims are about the derivation's
 * output — that a `hostDirectory` row re-opens a path the deny floor closed,
 * that a `userChosenDirectory` row admits the user's directory and only it, and
 * that neither one turns a read grant into a write. A fixture envelope would
 * prove the wrap works and say nothing about what the host decided.
 */
describe("a child the host widened reaches exactly what the host widened it with", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "opens the corporate CA and the user's chosen root, and nothing beside them",
    async () => {
      if (!(await asrtCanInitialize())) return;
      const fx = fixture!;
      const envelope = derivePluginChildEnvelope({
        pluginId: WIDENED_PLUGIN_ID,
        pluginRoot: fx.pluginRoot,
        pluginDataDir: fx.pluginDataDir,
        // `indexStorageRoot` is one of the two config keys the table names for
        // this plugin; the value is admitted because the fixture's settings
        // file lists it as a user-approved workspace root.
        configValue: (key) =>
          key === "indexStorageRoot"
            ? fx.userRoot
            : key === "workspace"
              ? fx.pendingWorkspace
              : undefined,
      });
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

      const report = await runProbe(fx, envelope);

      // The two widenings, proven by the syscalls they exist for.
      expect(report.readCa.ok, JSON.stringify(report.readCa)).toBe(true);
      expect(report.readCa.value).toBe(CA_TEXT);
      expect(report.writeUserRoot.ok, JSON.stringify(report.writeUserRoot)).toBe(true);
      expect(readFileSync(join(fx.userRoot, "index.bin"), "utf-8")).toBe("index");

      // …and nothing beside them. The CA stays UNWRITABLE, and the honest
      // attribution is that the write-deny floor takes precedence over
      // `allowWrite` — so this holds even for a row that mistakenly asked for
      // write, which is why it is asserted here rather than assumed. That a
      // `hostDirectory` row grants READ ONLY is a property of the derivation
      // and is proven above, against the envelope it returns.
      expect(report.writeCa.ok, JSON.stringify(report.writeCa)).toBe(false);
      // The sibling shares the user root's name as a string prefix and is not
      // inside it, which is the case a `startsWith` containment check admits.
      expect(
        report.writeUserRootSibling.ok,
        JSON.stringify(report.writeUserRootSibling),
      ).toBe(false);
      // A granted root that did not exist is CREATED by the spawn rather than
      // dropped from the grant. Without that the child gets an envelope smaller
      // than the host decided and is told nothing about it: here that surfaces
      // as this `ENOENT`, and on Linux as an allow path ASRT skips out of the
      // bwrap argv with a debug line. Neither raises, which is why the
      // materialisation is asserted rather than assumed.
      expect(
        report.writePendingWorkspace.ok,
        JSON.stringify(report.writePendingWorkspace),
      ).toBe(true);

      // The floor the widening pierced for `certs` is otherwise untouched.
      expect(report.readSecret.ok, JSON.stringify(report.readSecret)).toBe(false);
      expect(report.writeOutside.ok, JSON.stringify(report.writeOutside)).toBe(false);
      expect(report.writeSecrets.ok, JSON.stringify(report.writeSecrets)).toBe(false);
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
      if (!(await sandboxCasesRun())) return;
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
      if (!(await sandboxCasesRun())) return;
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
 * A CANDIDATE's members, driven through the production factory.
 *
 * The plugin modelled here is `meeting`, and the routing SOT REFUSES it. This
 * case is what produced that refusal and what keeps it honest: it drives the
 * members that plugin reaches against a real confined child and reports, in one
 * run, both what survives the move and what does not. Read as "evidence the
 * plugin is ready" it would be misread — a case that only ever exercised the
 * surviving members is exactly the measurement that admitted two plugins
 * wrongly, and the refusing assertions below are here so that shape cannot come
 * back.
 *
 * WHAT REFUSES IT, and each is independently sufficient:
 *
 *  - Its primary tool opens a floating recorder window through `electron`, and
 *    a confined child has no `electron` — the window handler below runs the
 *    plugin's own pre-flight guard and is denied. There is no wire form for
 *    `BrowserWindow`, `screen`, `session` or `ipcMain`, so this is not a
 *    marshalling gap but the boundary working as designed.
 *  - Its `createPlugin` sweeps `os.tmpdir()` unguarded — not behind a `try`,
 *    not deferred to a tool call, so it runs on every load — and the
 *    substituted temp root does not exist on an ordinary machine, so the
 *    plugin would not load at all, which is a different and worse failure than
 *    a degraded one.
 *  - The same activation body moves a session directory it once kept under
 *    `context.hostRoot` into `pluginDataDir`, per file and equally unguarded.
 *    `hostRoot` is outside the child's write jail, so on an install that still
 *    holds un-migrated files there the move throws where it used to succeed
 *    and takes activation down with it — the user's existing recordings
 *    stranded behind a plugin that will not start.
 *
 * THE POINT OF THE REST OF IT IS THE GATE. In one heap `hostApi.getSecret` was a
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
 * reach without a live egress fence. Each is asserted here rather than
 * described anywhere, because a boundary that CHANGES a plugin's behaviour is
 * the part most easily written down as a prediction and never checked:
 *
 *  - The legacy session move out of `<hostRoot>` — filesystem reach, which is
 *    the axis that takes the most away and the one whose two halves disagree.
 *    An un-migrated file is PLANTED from the host side first, so the handler
 *    runs the plugin's own `renameSync` out of that directory rather than a
 *    stand-in `mkdir` — the two land outside the same jail but they are
 *    different syscalls, and only one of them is the operation the plugin
 *    performs. The listing that precedes the move is load-bearing rather than
 *    setup: it is what makes the refusal a WRITE verdict instead of a child
 *    that found an empty directory, and it is the READ half of the same axis
 *    measured in the same call — a path outside the plugin's own directories
 *    and off the sandbox's deny floor stays readable.
 *  - The temp root the sandbox substitutes. `CLAUDE_CODE_TMPDIR` is pointed at
 *    a path that does NOT exist, which is the state an ordinary machine is in:
 *    ASRT rewrites the child's `TMPDIR` to `/tmp/claude` when nothing names
 *    another, that path is on its default WRITE allow-list, and nothing
 *    creates it. Pointing it at an absent path INSIDE this child's own write
 *    jail reproduces that state on any machine — including one whose
 *    `/tmp/claude` happens to exist, which is the only reason the first
 *    measurement of this consequence read as green.
 */
describe("a refused candidate's members, out of process and confined", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "carries the gate's verdict both ways, and refuses the window its primary tool opens",
    async () => {
      if (!(await sandboxCasesRun())) return;
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
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
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
      // The primary tool's own pre-flight, transcribed from the plugin: resolve
      // \`electron\`, insist \`BrowserWindow\` is constructible and \`screen\` can
      // answer for the display, then bind a partitioned session for the
      // recorder's audio capture. The plugin runs exactly this BEFORE it
      // side-effects, and wraps a failure as "floating window unsupported".
      // Reproduced rather than imported because the plugin lives in another
      // repository; what makes it a measurement is that the shape of the guard
      // is the plugin's and the answer is a real confined child's.
      meeting_window_probe: async () => await attempt(() => {
        const electron = require("electron");
        if (typeof electron.BrowserWindow !== "function"
          || typeof electron.screen?.getPrimaryDisplay !== "function") {
          throw new Error("BrowserWindow/screen unavailable in this host context");
        }
        electron.session.fromPartition("persist:recorder");
        return "the recorder window would open";
      }),
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
      // first filesystem call in the sweep its own \`createPlugin\` runs
      // unguarded — nothing precedes it that could throw first — and
      // \`mkdtempSync(join(tmpdir(), ...))\` is how it stages an upload.
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
            "meeting_window_probe",
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

        // ── the window its primary tool opens, which does NOT survive ──────
        const window = (await instance.handlers.meeting_window_probe!()) as {
          ok: boolean;
          code?: string;
          value?: string;
        };
        // The guard fails at RESOLUTION, before it can even ask whether
        // `BrowserWindow` is a constructor. Asserted by code so a future child
        // that resolved `electron` to something inert would fail here loudly
        // rather than by returning a shape the guard happens to reject.
        expect(window, JSON.stringify(window)).toMatchObject({
          ok: false,
          code: "MODULE_NOT_FOUND",
        });
        expect(window.value).toBeUndefined();

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
        // …but the move itself fails closed. `hostRoot` is outside the
        // child's write jail, and this is the same unguarded `renameSync` the
        // plugin runs in its activation body — so on an install that still
        // holds un-migrated files there, this denial is not a lost migration,
        // it is a plugin that does not start.
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
