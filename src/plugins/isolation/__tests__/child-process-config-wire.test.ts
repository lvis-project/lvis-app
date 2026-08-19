/**
 * The two config values a plugin reads, driven across a REAL process boundary.
 *
 * `config-subscription-paths.test.ts` drives the same members over an in-memory
 * channel, where the host hands the child the very object it built — so a value
 * JSON cannot carry survives that harness untouched and proves nothing about
 * what a plugin actually receives. Both defects here are exactly that shape:
 *
 *  - `SECRET_REDACTED_SENTINEL` is a Symbol, and `JSON.stringify` drops a
 *    symbol-valued property. Over a pipe, the documented
 *    `value === SECRET_REDACTED_SENTINEL` check silently never matched and the
 *    plugin read the change as "the key was cleared".
 *  - `getAppPreference` had no child half at all, because a snapshot with no
 *    re-push answers with the value a preference held at plugin start.
 *
 * So this file spawns an actual child, over actual pipes, with actual JSON
 * framing, and asks a plugin what it got. The plugin performs the identity
 * check the way a real plugin must — `Symbol.for(...)` in its OWN realm, a
 * different process from the host's — which is the whole reason the sentinel is
 * a registered symbol rather than a private one.
 *
 * NOT CONFINED, and that is deliberate rather than an omission:
 * `confined-plugin-child.test.ts` owns the sandbox claim and needs ASRT (and so
 * runs on two platforms). The question here is what survives JSON on a pipe,
 * which is the same on every platform and needs no jail — pairing the two would
 * make this evidence unavailable wherever ASRT cannot initialize.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
// The SAME external boundary the shipped entry is built against, so the child
// bundled here is the child that ships.
import { MAIN_BUNDLE_EXTERNALS } from "../../../../scripts/lib/main-bundle-externals.mjs";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext, RuntimePlugin } from "../../types.js";
import {
  createOutOfProcessPluginFactory,
  type ConfinedPluginChild,
  type ConfinedPluginChildSpec,
} from "../out-of-process-plugin.js";
import { SECRET_REDACTED_SENTINEL } from "../config-subscription-child.js";
import {
  emitPluginConfigChange,
  subscribePluginConfigChange,
  _resetPluginConfigChangeBus,
} from "../../config-change-bus.js";
import {
  buildAppPreferenceReader,
  publishAppPreferenceChange,
  _resetAppPreferencePublisher,
} from "../../../boot/steps/plugin-runtime/app-preference.js";
import type { SettingsService, WebViewPreferredFlow } from "../../../data/settings-store.js";

const PLUGIN_ID = "work-assistant";

/** What the plugin reports for one `config.onChange` delivery. */
interface RecordedChange {
  readonly isSentinel: boolean;
  readonly kind: string;
  readonly description: string | null;
  readonly plainValue: string | null;
  /** What `config.get` answered INSIDE the callback, encoded so a Symbol shows. */
  readonly configGet: string;
}

interface PreferenceProbe {
  readonly preferredFlow: string | null;
  readonly offAllowlist: string | null;
}

let temporaryRoot: string | undefined;
const spawnedChildren = new Set<ChildProcess>();

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

/** Inside the repository, so the bundle's externals resolve from node_modules. */
function childBundleDir(): string {
  return join(repositoryRoot(), ".cache", "plugin-child-config-wire");
}

async function buildChildEntry(): Promise<string> {
  const childEntryPath = join(childBundleDir(), "plugin-child-main.mjs");
  await build({
    absWorkingDir: repositoryRoot(),
    entryPoints: [join(repositoryRoot(), "src/plugins/isolation/plugin-child-main.ts")],
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
 * The plugin under test, as a real module the child imports.
 *
 * It reaches for the sentinel through `Symbol.for` rather than importing it:
 * that is the only route a plugin bundled apart from the host has, it is what
 * the contract documents, and it is what makes the identity check meaningful
 * across two realms.
 */
function writePluginEntry(root: string): string {
  const entryPath = join(root, "plugin.mjs");
  writeFileSync(
    entryPath,
    `const SENTINEL = Symbol.for("lvis.config.secret.redacted");
const describe = (value) => (typeof value === "symbol" ? "SYMBOL:" + value.description : JSON.stringify(value ?? null));
export const createPlugin = async (context) => {
  const api = context.hostApi;
  const changes = [];
  api.config.onChange("apiKey", (value) => {
    changes.push({
      isSentinel: value === SENTINEL,
      kind: typeof value,
      description: typeof value === "symbol" ? (value.description ?? null) : null,
      plainValue: typeof value === "symbol" ? null : (value ?? null),
      // Read INSIDE the callback, before any later snapshot push can arrive:
      // this is what the plugin would see if the sentinel had been written into
      // the child's config snapshot.
      configGet: describe(api.config.get("apiKey")),
    });
  });
  return {
    handlers: {
      probe_changes: async () => changes,
      probe_preference: async () => ({
        preferredFlow: api.getAppPreference("webView.preferredFlow") ?? null,
        offAllowlist: api.getAppPreference("llm.provider") ?? null,
      }),
    },
  };
};
`,
    "utf-8",
  );
  return entryPath;
}

const MANIFEST = {
  id: PLUGIN_ID,
  name: "Work Assistant",
  version: "0.10.14",
  entry: "plugin.mjs",
  description: "reports what crossed the boundary",
  tools: [
    {
      name: "probe_changes",
      description: "every config.onChange delivery this plugin received",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "probe_preference",
      description: "the host preferences as they read right now",
      inputSchema: { type: "object", properties: {} },
    },
  ],
} as PluginManifest;

/** Spawn the bundled child as a plain Node process and hand back its pipes. */
async function connectPlainChild(spec: ConfinedPluginChildSpec): Promise<ConfinedPluginChild> {
  const child = spawn(process.execPath, [spec.childEntryPath], {
    stdio: ["pipe", "pipe", "pipe"],
    // The production spawn sets this for the same reason: under the test runner
    // `process.execPath` is the Electron binary, and this is what makes it
    // behave as Node — which is also what strips `electron` from the child's
    // module registry.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  spawnedChildren.add(child);
  child.once("exit", () => spawnedChildren.delete(child));
  if (!child.stdin || !child.stdout) {
    child.kill("SIGKILL");
    throw new Error("the spawned child has no pipes");
  }
  return {
    link: {
      input: child.stdout,
      output: child.stdin,
      terminate: () => child.kill("SIGTERM"),
      onGone: (handler) => {
        child.once("exit", (code, signal) =>
          handler(`child exited code=${String(code)} signal=${String(signal)}`),
        );
        child.once("error", (error: Error) => handler(`child error: ${error.message}`));
      },
    },
  };
}

/** A settings service with only what the preference reader touches. */
function fakeSettingsService(initial: WebViewPreferredFlow): {
  service: SettingsService;
  set: (flow: WebViewPreferredFlow) => void;
} {
  let flow = initial;
  return {
    service: {
      get: (key: string) => (key === "webView" ? { preferredFlow: flow } : undefined),
    } as unknown as SettingsService,
    set: (next) => {
      flow = next;
    },
  };
}

/**
 * The host object the boundary binds, wired to the REAL change bus and the REAL
 * preference reader.
 *
 * Only the members this exercise reaches are implemented — the cast is the same
 * one `confined-plugin-child.test.ts` makes, and for the same reason: standing
 * up the other thirty would prove nothing about these two and would hide which
 * ones the path actually touches.
 */
function hostApiFor(settingsService: SettingsService): {
  hostApi: PluginHostApi;
  subscribedKeys: Set<string>;
} {
  const subscribedKeys = new Set<string>();
  const readPreference = buildAppPreferenceReader(settingsService, { warn: () => undefined });
  const hostApi = {
    getInstalledPluginIds: () => [PLUGIN_ID],
    onPluginsChanged: () => () => undefined,
    getAppPreference: (key: string) => readPreference(PLUGIN_ID, key),
    config: {
      // Secrets never live in the cleartext record the host resolves, which is
      // why a secret change carries the sentinel instead of a value.
      get: () => undefined,
      set: async () => undefined,
      onChange: (key: string, callback: (value: unknown) => void) => {
        subscribedKeys.add(key);
        return subscribePluginConfigChange(PLUGIN_ID, key, (_changedKey, value) => {
          callback(value);
        });
      },
    },
  } as unknown as PluginHostApi;
  return { hostApi, subscribedKeys };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function readChanges(instance: RuntimePlugin): Promise<RecordedChange[]> {
  return (await instance.handlers.probe_changes!()) as RecordedChange[];
}

beforeEach(() => {
  _resetPluginConfigChangeBus();
  _resetAppPreferencePublisher();
  temporaryRoot = mkdtempSync(join(tmpdir(), "child-config-wire-"));
});

afterEach(() => {
  for (const child of spawnedChildren) child.kill("SIGKILL");
  spawnedChildren.clear();
  _resetPluginConfigChangeBus();
  _resetAppPreferencePublisher();
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
  rmSync(childBundleDir(), { recursive: true, force: true });
});

describe("the config values a plugin reads, across a real child process", () => {
  it(
    "carries the secret sentinel, keeps it out of the config snapshot, and still reports a real clear",
    async () => {
      const root = temporaryRoot!;
      const pluginDataDir = join(root, "data");
      mkdirSync(pluginDataDir, { recursive: true });
      const { service } = fakeSettingsService("in-app");
      const { hostApi, subscribedKeys } = hostApiFor(service);
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath: writePluginEntry(root),
        childEntryPath: await buildChildEntry(),
        connect: connectPlainChild,
      });
      const instance = await factory({
        pluginId: PLUGIN_ID,
        pluginRoot: root,
        hostRoot: repositoryRoot(),
        pluginDataDir,
        // The stray cleartext copy a secret key can still have: the host deletes
        // it on a secret write, and the child must do the same rather than
        // storing the sentinel in its place.
        config: { apiKey: "stale-cleartext-copy" },
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);
      try {
        // The subscribe round trip is deliberately not awaited by the child, so
        // the host side has to be observed rather than assumed.
        await waitFor(() => subscribedKeys.has("apiKey"), "the host to adopt the subscription");

        // No polling after the emit. The notification and the tool request that
        // reads the result are written to the SAME pipe in that order, so a
        // reply that had not applied the delivery is a protocol ordering
        // failure and must fail here rather than be waited out.
        emitPluginConfigChange(PLUGIN_ID, "apiKey", SECRET_REDACTED_SENTINEL);
        const afterSecret = await readChanges(instance);
        expect(afterSecret).toHaveLength(1);

        // THE DEFECT. Before the wire form existed this was `kind: "undefined"`
        // and `isSentinel: false` — indistinguishable from a cleared key.
        expect(afterSecret[0]!.isSentinel).toBe(true);
        expect(afterSecret[0]!.kind).toBe("symbol");
        expect(afterSecret[0]!.description).toBe("lvis.config.secret.redacted");
        // …and the sentinel is not a config value: `config.get` must not start
        // answering with a Symbol no in-process plugin could ever see.
        expect(afterSecret[0]!.configGet).toBe("null");

        // A REAL clear still reads as a clear. The two are the pair this member
        // must keep apart, so proving one without the other proves nothing.
        emitPluginConfigChange(PLUGIN_ID, "apiKey", undefined);
        const afterClear = await readChanges(instance);
        expect(afterClear).toHaveLength(2);
        expect(afterClear[1]!.isSentinel).toBe(false);
        expect(afterClear[1]!.kind).toBe("undefined");

        // And a cleartext value still crosses as itself.
        emitPluginConfigChange(PLUGIN_ID, "apiKey", "plain-text");
        const afterPlain = await readChanges(instance);
        expect(afterPlain).toHaveLength(3);
        expect(afterPlain[2]!.isSentinel).toBe(false);
        expect(afterPlain[2]!.plainValue).toBe("plain-text");
      } finally {
        await instance.stop?.();
      }
    },
    180_000,
  );

  it(
    "answers getAppPreference from a snapshot the host keeps current",
    async () => {
      const root = temporaryRoot!;
      const pluginDataDir = join(root, "data");
      mkdirSync(pluginDataDir, { recursive: true });
      const { service, set } = fakeSettingsService("in-app");
      const { hostApi } = hostApiFor(service);
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath: writePluginEntry(root),
        childEntryPath: await buildChildEntry(),
        connect: connectPlainChild,
      });
      const instance = await factory({
        pluginId: PLUGIN_ID,
        pluginRoot: root,
        hostRoot: repositoryRoot(),
        pluginDataDir,
        config: {},
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);
      try {
        const seeded = (await instance.handlers.probe_preference!()) as PreferenceProbe;
        expect(seeded.preferredFlow).toBe("in-app");
        // A key off the host allowlist is not in the snapshot at all, which is
        // the same answer the in-process reader gives for one.
        expect(seeded.offAllowlist).toBeNull();

        // THE DEFECT. The member used to have no child half precisely because
        // this move had no signal behind it: a plugin reading the preference at
        // CALL time would have kept reading "in-app" for the life of the child.
        set("system-browser");
        publishAppPreferenceChange(service);
        // No polling. The notification and the next tool request are written to
        // the SAME pipe in that order, so a reply that had not applied the push
        // would be a protocol ordering failure and should fail this assertion
        // rather than be waited out.
        const afterChange = (await instance.handlers.probe_preference!()) as PreferenceProbe;
        expect(afterChange.preferredFlow).toBe("system-browser");

        // A settings save that moves nothing a plugin can read announces
        // nothing, and the answer stays put.
        publishAppPreferenceChange(service);
        const afterNoop = (await instance.handlers.probe_preference!()) as PreferenceProbe;
        expect(afterNoop.preferredFlow).toBe("system-browser");
      } finally {
        await instance.stop?.();
      }
    },
    180_000,
  );
});
