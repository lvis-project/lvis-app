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
 * Two more claims need a real child for a different reason — the child has to
 * be a separate PROCESS with its own lifecycle, not an object the host already
 * finished building:
 *
 *  - A preference that moves while the child is still CONSTRUCTING. The child
 *    has no runtime to route a notification through until its plugin module has
 *    imported and its factory has run, so the push that announcement triggers
 *    is dropped — and nothing announces the same value a second time.
 *  - A bring-up step that throws AFTER `construct` returned. What it leaks is a
 *    live OS process, so only a real child can show whether it was given up or
 *    orphaned; an in-memory double has nothing to leak.
 *
 * WHAT lands, not WHEN. Delivery ORDERING is not this file's to prove: the
 * harness below calls its `config.onChange` listener synchronously, while the
 * shipped host routes that member through a generation lease. Each ordering
 * comment marks which of the two it belongs to.
 *
 * The inherited-key assertions below are NOT in that class:
 * `config-subscription-paths.test.ts` pins the same member in memory. They are
 * here because this is where the call is a PLUGIN's, and `typeof` read on the
 * far side is the answer a plugin receives rather than the one the member
 * returned.
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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
// The child entry is bundled by the shared module rather than here, so this
// suite and `confined-plugin-child.test.ts` cannot drift into exercising two
// different bundles while reading like they exercise one.
import { buildChildEntry, childBundleDir, repositoryRoot } from "./child-entry-bundle.js";
import { lvisHome } from "../../../shared/lvis-home.js";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext, RuntimePlugin } from "../../types.js";
import {
  createOutOfProcessPluginFactory,
  type ConfinedPluginChild,
  type ConfinedPluginChildSpec,
} from "../out-of-process-plugin.js";
import { SECRET_REDACTED_SENTINEL } from "../host-api-wire.js";
import {
  emitPluginConfigChange,
  subscribePluginConfigChange,
  _resetPluginConfigChangeBus,
} from "../../config-change-bus.js";
import {
  buildAppPreferenceReader,
  publishAppPreferenceChange,
  HOST_PUBLIC_PREFERENCE_KEYS,
  _resetAppPreferencePublisher,
} from "../../../boot/steps/plugin-runtime/app-preference.js";
import type { SettingsService, WebViewPreferredFlow } from "../../../data/settings-store.js";
import { resolvePluginSocketDir } from "../../plugin-storage-layout.js";

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
  /**
   * `typeof` rather than the value: a key inherited from `Object.prototype`
   * answers with a FUNCTION when the snapshot is indexed bare, and a function
   * cannot cross back as itself.
   */
  readonly inheritedKind: string;
  readonly constructorKind: string;
}

let temporaryRoot: string | undefined;
const spawnedChildren = new Set<ChildProcess>();

/** Emitted inside the repository, under a name only this suite cleans up. */
const CHILD_BUNDLE_CACHE = "plugin-child-config-wire";

/**
 * How long the construct-window case holds the plugin module at import.
 *
 * Long enough that a host announcement fired a quarter of the way in lands
 * while the child still has no runtime, without approaching the construct
 * deadline (`pluginImportMs + pluginFactoryMs`, 20s).
 */
const CONSTRUCT_WINDOW_MS = 1_200;

/**
 * The plugin under test, as a real module the child imports.
 *
 * It reaches for the sentinel through `Symbol.for` rather than importing it:
 * that is the only route a plugin bundled apart from the host has, it is what
 * the contract documents, and it is what makes the identity check meaningful
 * across two realms.
 *
 * `importDelayMs` holds the module at TOP LEVEL, which is the widest part of
 * the window the child cannot receive notifications in: the child assigns the
 * runtime that routes them only after this module has imported and its factory
 * has run, so anything the host pushes while this await is pending is dropped.
 */
function writePluginEntry(root: string, importDelayMs = 0): string {
  const entryPath = join(root, "plugin.mjs");
  writeFileSync(
    entryPath,
    `${importDelayMs > 0 ? `await new Promise((settle) => setTimeout(settle, ${importDelayMs}));\n` : ""}const SENTINEL = Symbol.for("lvis.config.secret.redacted");
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
        // Keys the snapshot object inherits rather than owns. A bare index
        // answers these with Object.prototype's functions; the host reader
        // answers undefined, because they are not on the allowlist.
        inheritedKind: typeof api.getAppPreference("toString"),
        constructorKind: typeof api.getAppPreference("constructor"),
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
function hostApiFor(
  settingsService: SettingsService,
  options: {
    /**
     * Make the Nth preference SNAPSHOT read throw, counting from one.
     *
     * Counted on the allowlist's first key rather than on every call, so the
     * ordinal keeps naming the same snapshot when the allowlist grows a second
     * key.
     *
     * The production `hostApi` a plugin incarnation holds is the
     * generation-scoped proxy, and every member on it throws outright once that
     * generation is superseded, discarded or retired
     * (`plugin-host-effect-scope.ts`). So "a read that worked while the child
     * was constructing and throws right after" is a shape the host really
     * produces, not one invented for this case.
     */
    readonly throwOnPreferenceSnapshot?: number;
  } = {},
): {
  hostApi: PluginHostApi;
  subscribedKeys: Set<string>;
  /** Config-bus disposers the boundary asked for, and whether it ran them. */
  configWatchers: Array<{ key: string; released: boolean }>;
} {
  const subscribedKeys = new Set<string>();
  const configWatchers: Array<{ key: string; released: boolean }> = [];
  const readPreference = buildAppPreferenceReader(settingsService, { warn: () => undefined });
  let snapshotReads = 0;
  const hostApi = {
    getInstalledPluginIds: () => [PLUGIN_ID],
    onPluginsChanged: () => () => undefined,
    getAppPreference: (key: string) => {
      if (key === HOST_PUBLIC_PREFERENCE_KEYS[0]) snapshotReads += 1;
      if (options.throwOnPreferenceSnapshot === snapshotReads) {
        throw new Error("hostApi.getAppPreference belongs to a retired generation");
      }
      return readPreference(PLUGIN_ID, key);
    },
    config: {
      // Secrets never live in the cleartext record the host resolves, which is
      // why a secret change carries the sentinel instead of a value.
      get: () => undefined,
      set: async () => undefined,
      onChange: (key: string, callback: (value: unknown) => void) => {
        subscribedKeys.add(key);
        const unsubscribe = subscribePluginConfigChange(PLUGIN_ID, key, (_changedKey, value) => {
          callback(value);
        });
        const watcher = { key, released: false };
        configWatchers.push(watcher);
        return () => {
          watcher.released = true;
          unsubscribe();
        };
      },
    },
  } as unknown as PluginHostApi;
  return { hostApi, subscribedKeys, configWatchers };
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
  rmSync(childBundleDir(CHILD_BUNDLE_CACHE), { recursive: true, force: true });
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
        childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE),
        connect: connectPlainChild,
      });
      const instance = await factory({
        pluginId: PLUGIN_ID,
        pluginRoot: root,
        hostRoot: repositoryRoot(),
        pluginDataDir,
        pluginSocketDir: resolvePluginSocketDir(pluginDataDir),
        userHome: homedir(),
        lvisHome: lvisHome(),
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
        //
        // THAT ORDER IS THIS HARNESS'S, not the shipped host's. `hostApiFor`
        // hands `config.onChange` a listener the bus calls synchronously; the
        // real member routes it through `HostApiGenerationScope.wrapListener`,
        // which awaits a generation lease before the callback runs — so in
        // production the notification is written on a later turn than the emit
        // and nothing here pins WHEN it lands. What this case does pin is WHAT
        // lands, which is the defect it exists for. The preference case below
        // makes the same claim about ordering and it holds in production, for
        // the reason stated there.
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
        childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE),
        connect: connectPlainChild,
      });
      const instance = await factory({
        pluginId: PLUGIN_ID,
        pluginRoot: root,
        hostRoot: repositoryRoot(),
        pluginDataDir,
        pluginSocketDir: resolvePluginSocketDir(pluginDataDir),
        userHome: homedir(),
        lvisHome: lvisHome(),
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
        // …and "not in the snapshot" has to mean it for a key the snapshot
        // object INHERITS too. `appPreferences["toString"]` is a function, and
        // a plugin handed a function where the host reader hands `undefined` is
        // reading a different member on each side of the boundary.
        expect(seeded.inheritedKind).toBe("undefined");
        expect(seeded.constructorKind).toBe("undefined");

        // THE DEFECT. The member used to have no child half precisely because
        // this move had no signal behind it: a plugin reading the preference at
        // CALL time would have kept reading "in-app" for the life of the child.
        set("system-browser");
        publishAppPreferenceChange(service);
        // No polling. The notification and the next tool request are written to
        // the SAME pipe in that order, so a reply that had not applied the push
        // would be a protocol ordering failure and should fail this assertion
        // rather than be waited out.
        //
        // Unlike the config case above, this order IS the shipped host's:
        // `emitAppPreferenceChange` calls its listeners synchronously inside
        // `publishAppPreferenceChange`, and the host's preference watcher is
        // registered on that bus directly rather than through the plugin's
        // generation-scoped `hostApi`, so no lease sits between the announcement
        // and the write.
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

  it(
    "answers with a preference that moved while the child was still constructing",
    async () => {
      const root = temporaryRoot!;
      const pluginDataDir = join(root, "data");
      mkdirSync(pluginDataDir, { recursive: true });
      const { service, set } = fakeSettingsService("in-app");
      const { hostApi } = hostApiFor(service);
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        // The plugin module sleeps at import, so the child spends this long
        // with no runtime to route a host notification through.
        entryPath: writePluginEntry(root, CONSTRUCT_WINDOW_MS),
        childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE),
        connect: connectPlainChild,
      });
      const constructing = factory({
        pluginId: PLUGIN_ID,
        pluginRoot: root,
        hostRoot: repositoryRoot(),
        pluginDataDir,
        pluginSocketDir: resolvePluginSocketDir(pluginDataDir),
        userHome: homedir(),
        lvisHome: lvisHome(),
        config: {},
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);

      // Well inside the sleep above. The snapshot that went into the construct
      // params was read BEFORE this, and the push this announcement triggers
      // reaches a child that has no runtime yet and is dropped.
      await new Promise((settle) => setTimeout(settle, CONSTRUCT_WINDOW_MS / 4));
      set("system-browser");
      publishAppPreferenceChange(service);

      const instance = await constructing;
      try {
        // THE DEFECT this case exists for. Nothing announces the preference a
        // second time — the bus fires only on a MOVE, and the value has already
        // moved — so without a push once construct resolves the plugin would
        // read "in-app" until someone changed the preference AGAIN.
        const probed = (await instance.handlers.probe_preference!()) as PreferenceProbe;
        expect(probed.preferredFlow).toBe("system-browser");
      } finally {
        await instance.stop?.();
      }
    },
    180_000,
  );

  it(
    "kills the child and releases the host watchers when a step after construct throws",
    async () => {
      const root = temporaryRoot!;
      const pluginDataDir = join(root, "data");
      mkdirSync(pluginDataDir, { recursive: true });
      const { service } = fakeSettingsService("in-app");
      // Snapshot 1 is the construction seed and snapshot 2 is the push sent once
      // `construct` resolves — so this fails the step that runs AFTER the child
      // is alive and its module has been imported.
      const { hostApi, configWatchers } = hostApiFor(service, { throwOnPreferenceSnapshot: 2 });
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath: writePluginEntry(root),
        childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE),
        connect: connectPlainChild,
      });
      const before = new Set(spawnedChildren);

      await expect(
        factory({
          pluginId: PLUGIN_ID,
          pluginRoot: root,
          hostRoot: repositoryRoot(),
          pluginDataDir,
        pluginSocketDir: resolvePluginSocketDir(pluginDataDir),
        userHome: homedir(),
        lvisHome: lvisHome(),
          config: {},
          log: () => undefined,
          hostApi,
        } as PluginRuntimeContext),
      ).rejects.toThrow(/retired generation/);

      const spawned = [...spawnedChildren].filter((child) => !before.has(child));
      expect(spawned).toHaveLength(1);
      // THE DEFECT. The push ran outside the block that owned the teardown, so
      // a throw from it rejected the factory with the child still spawned and
      // reading stdin, the transport still open, and every bus subscription
      // still registered — an orphan with no ledger entry and no owner left to
      // stop it.
      await waitFor(() => spawned[0]!.exitCode !== null || spawned[0]!.signalCode !== null,
        "the abandoned child to exit");
      // Both halves: the host's own `"*"` snapshot watcher, and the one the
      // plugin opened through the dispatcher while it was constructing.
      expect(configWatchers.map((watcher) => watcher.key).sort()).toEqual(["*", "apiKey"]);
      expect(configWatchers.every((watcher) => watcher.released)).toBe(true);
    },
    180_000,
  );
});
