/**
 * Route one plugin out of the main process, and confine it there
 * (`docs/blueprints/plugin-process-isolation.md` §4, §5, §7).
 *
 * Two things land here together because §4 says they have to. The process
 * boundary alone buys a great deal — no shared heap, no `electron`, one
 * structural chokepoint, a separate crash domain — and buys NO filesystem or
 * network confinement at all: a Node child still has `fs`, `net` and
 * `child_process` unless something wraps its argv. Shipping the boundary
 * without the wrap would advertise a protection that is not there, so the spawn
 * goes through `spawnConfinedChild` and nowhere else.
 *
 * THERE IS NO UNCONFINED PATH. `wrapWorkerCommand` throws when ASRT is not
 * active, and nothing here catches it: a plugin that cannot be confined fails
 * to load. That is the fail-closed rule, and it is enforced by the ABSENCE of a
 * branch rather than by one — there is no place to add "continue anyway"
 * without deleting a line rather than adding one.
 *
 * WHAT THIS SEAM IS. The host's contract with a plugin is
 * `RuntimePluginFactory`, so that is what the isolated path produces: a factory
 * that spawns a child and returns a `RuntimePlugin` whose handlers and
 * lifecycle hooks are round trips. Everything above it — the method map, the
 * permission manager, the effect gate, the generation lease, the loopback MCP
 * projection — is untouched and cannot tell the difference, which is exactly
 * why the five plugins that are not the pilot keep loading as they did.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { mainDir } from "../../main/main-paths.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { RAW_RESULT_META } from "../../mcp/protocol-constants.js";
import { spawnConfinedChild } from "../../permissions/confined-child.js";
import { createSandboxProcessHome } from "../../permissions/sandbox-process-home.js";
import { cleanupAsrtSandboxAfterCommand } from "../../permissions/asrt-sandbox.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
// The allowlist is READ where it is declared rather than mirrored here. It is
// the host's answer to "which preferences may a plugin see", and a second copy
// of that list would be a second answer to a security question.
import { HOST_PUBLIC_PREFERENCE_KEYS } from "../../boot/steps/plugin-runtime/app-preference.js";
import { subscribeAppPreferenceChange } from "../config-change-bus.js";
import type {
  PluginHostApi,
  PluginManifest,
  PluginRuntimeContext,
  PluginToolHandler,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import { createConfigSubscriptionHostApiPaths } from "./config-subscription-host.js";
import { createInteractionHostApiPaths } from "./host-api-interaction-paths.js";
import {
  createServiceHostApiPaths,
  type DelegatedWorkerConfinement,
} from "./host-api-service-paths.js";
import { createStorageHostApiPaths } from "./host-api-storage-paths.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  type HostApiPathHandler,
} from "./host-api-dispatcher.js";
import type { HostApiPath } from "./host-api-path-contracts.js";
import { HOST_API_WIRE_VERSION } from "./host-api-wire.js";
import {
  PLUGIN_INSTANCE_METHODS,
  PLUGIN_INSTANCE_WIRE_VERSION,
  type PluginConstructParams,
  type PluginConstructResult,
  type ReadUiResourceResult,
} from "./plugin-instance-wire.js";
import {
  PluginChildTransport,
  type ChildLink,
} from "./plugin-child-transport.js";
import type { PluginChildContext } from "./plugin-child-runtime.js";

const log = createLogger("out-of-process-plugin");

/**
 * The `hostApi` members this path needs to bind, as the union of the four
 * groups' own narrowings.
 *
 * Stated as an intersection of what each group asks for rather than as
 * `PluginHostApi`, so a group that widens its needs widens this too — and a
 * caller cannot satisfy the assembly with an object that happens to have the
 * right shape for three groups and not the fourth.
 */
export type DispatchableHostApi = Parameters<typeof createStorageHostApiPaths>[0] &
  Parameters<typeof createConfigSubscriptionHostApiPaths>[0] &
  Parameters<typeof createInteractionHostApiPaths>[0] &
  Parameters<typeof createServiceHostApiPaths>[0] &
  /**
   * `getInstalledPluginIds` belongs to no group because it is DISPATCHED BY
   * NOBODY: its contract is `child-local` and the table refuses it if it ever
   * arrives. The host still calls it — to build the snapshot the child answers
   * from — so it is named here rather than inside a group whose job is binding
   * handlers.
   */
  Pick<PluginHostApi, "getInstalledPluginIds">
  /**
   * `getAppPreference` joins it for the same reason and stays OPTIONAL, because
   * it is optional on `PluginHostApi`. A host that does not implement it
   * publishes no preference snapshot at all, and the child's member then throws
   * instead of answering `undefined` — see `PluginChildContext.appPreferences`.
   */
  & Pick<PluginHostApi, "getAppPreference">;

/**
 * Bind every dispatched member to ONE plugin incarnation's `hostApi`.
 *
 * The instance passed here must be the one the host handed the factory —
 * `context.hostApi`, which `buildHostApiIncarnation` has already wrapped in the
 * effect recorder, the effect gate and the active-incarnation proxy. Binding a
 * freshly built hostApi instead would produce a boundary that works in every
 * test and records nothing in the field: the recorder's ledger is per-wrapper,
 * so effects would be attributed to a wrapper no one reads.
 *
 * The four spreads are applied over the shipped table rather than replacing it,
 * so a member no group claims keeps its throwing default instead of becoming
 * absent. `Record<HostApiPath, …>` makes a missing key a compile error either
 * way; this makes an UNBOUND key a loud runtime refusal.
 */
export function createBoundHostApiDispatchTable(
  hostApi: DispatchableHostApi,
  /**
   * The two directories the child's own ASRT wrap grants it, so `spawnWorker`
   * can refuse a delegated worker that would reach further. It is the SAME pair
   * `spawnConfinedPluginChild` passes to the wrap, taken from the same context,
   * because a boundary that checked against a differently-derived envelope
   * would be checking against something other than the jail.
   */
  confinement: DelegatedWorkerConfinement,
): Record<HostApiPath, HostApiPathHandler> {
  return {
    ...HOSTAPI_DISPATCH_TABLE,
    ...createStorageHostApiPaths(hostApi),
    ...createConfigSubscriptionHostApiPaths(hostApi),
    ...createInteractionHostApiPaths(hostApi),
    ...createServiceHostApiPaths(hostApi, confinement),
  };
}

/**
 * Every config key the host can resolve for this plugin.
 *
 * `config.get` merges schema defaults, the manifest's own config, a host
 * wildcard slot and the user's saved settings, and `PluginHostApi` publishes no
 * way to enumerate the result — so the key set is assembled from the three
 * sources the host DOES hold: the schema's declared properties, the manifest's
 * config, and the construction snapshot (which is the merge, as it stood when
 * the plugin started). Their union is what the settings surface can change,
 * which is what a re-push has to cover.
 */
function resolvableConfigKeys(
  manifest: PluginManifest,
  constructionConfig: Record<string, unknown> | undefined,
): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(manifest.configSchema?.properties ?? {}),
      ...Object.keys(manifest.config ?? {}),
      ...Object.keys(constructionConfig ?? {}),
    ]),
  ];
}

/**
 * Where the child's entry module lives.
 *
 * Resolved from `mainDir`, NOT from this module's own `import.meta.url`: the
 * main process is an esbuild bundle with code splitting, so this file executes
 * from `main.js` or from a hashed `chunks/*.js` and has no fixed relationship
 * to any emitted sibling. `main-paths.ts` is the one place that answers "where
 * are the runtime assets", and `plugin-child-main` is registered as its own
 * esbuild entry point so an actual file exists there to run.
 */
function resolvePluginChildEntryPath(): string {
  return join(mainDir, "plugin-child-main.js");
}

/**
 * The paths the PLUGIN owns, named once.
 *
 * Read by the spawn — which adds the throwaway sandbox HOME on top — and by the
 * `spawnWorker` grant check, which does not: that HOME belongs to this process
 * and is not the plugin's to hand on. Deriving both from one function is what
 * makes the delegation check a check against the ACTUAL jail: widening what a
 * plugin child may reach widens what it may delegate, in the same edit, instead
 * of leaving a second list to drift behind the first.
 */
function pluginChildConfinement(
  spec: Pick<ConfinedPluginChildSpec, "pluginRoot" | "pluginDataDir">,
): DelegatedWorkerConfinement {
  return { pluginRoot: spec.pluginRoot, pluginDataDir: spec.pluginDataDir };
}

/** What a confined child needs to exist. */
export interface ConfinedPluginChildSpec {
  readonly pluginId: string;
  /** The plugin's immutable runtime root; the child reads its code from here. */
  readonly pluginRoot: string;
  /** `~/.lvis/plugins/<id>/data` — the ONLY path the child may write. */
  readonly pluginDataDir: string;
  /** The child's own entry module. Injected so a test can serve a stand-in. */
  readonly childEntryPath: string;
}

/**
 * A connected child.
 *
 * It is a {@link ChildLink} and nothing else: the factory above never touches a
 * `ChildProcess`, so the protocol can be exercised over in-memory paired
 * streams while the confinement is exercised against a real process.
 */
export interface ConfinedPluginChild {
  readonly link: ChildLink;
}

/**
 * Spawn the child under ASRT.
 *
 * Filesystem grants, and why each is the size it is:
 *
 *  - WRITE is a real jail, and it is exactly `pluginDataDir` plus the throwaway
 *    sandbox HOME. Not `pluginRoot`: that is the immutable runtime root the
 *    integrity check covers, and a plugin that could rewrite it could rewrite
 *    the bytes its own manifest hash was taken over.
 *  - READ in ASRT is deny-only — `allowRead` re-allows a region INSIDE a
 *    covering deny and is inert without one (see `asrt-sandbox.ts`). The deny
 *    floor covers the Electron userData directory, which is where plugins are
 *    installed, so the child would not be able to read its OWN code or data
 *    without these two re-allows. This is not a widening of the floor; it is
 *    the floor's own carve-out for the one plugin this child serves — and it is
 *    what makes "cannot read another plugin's data directory" true rather than
 *    aspirational.
 *
 * On Windows ASRT 0.0.73 supports no per-exec allow grants at all — passing any
 * makes `wrapWorkerCommand` throw — so the wrap carries the deny floor alone
 * (`grantMode: "deny-only"`) and reachability is an ACL question. §4's Windows
 * residual stands unchanged and is not softened here: srt-win confines
 * filesystem and network but NOT process creation, so a confined plugin child
 * on Windows can still spawn. Admitting third-party plugins on Windows is the
 * separate owner decision §7.4 names, not something this spawn resolves.
 */
export async function spawnConfinedPluginChild(
  spec: ConfinedPluginChildSpec,
): Promise<ConfinedPluginChild> {
  const sandboxHome = createSandboxProcessHome();
  const confinement = pluginChildConfinement(spec);
  let wrapped = false;
  const releaseSandboxState = (): void => {
    if (wrapped) {
      wrapped = false;
      void cleanupAsrtSandboxAfterCommand();
    }
    sandboxHome.cleanup();
  };
  try {
    const child = await spawnConfinedChild({
      // `process.execPath` is the Electron binary in production and `node` in a
      // test runner. `ELECTRON_RUN_AS_NODE` makes the former behave as the
      // latter, which is also what strips `electron` from the child's module
      // registry — §4's "No Electron" is this environment variable plus the
      // absence of a renderer, not a promise.
      command: process.execPath,
      args: [spec.childEntryPath],
      label: `plugin-child:${spec.pluginId}`,
      grantMode: process.platform === "win32" ? "deny-only" : "allow-list",
      allowRead: [confinement.pluginRoot, confinement.pluginDataDir, sandboxHome.path],
      allowWrite: [confinement.pluginDataDir, sandboxHome.path],
      baseEnv: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
      extraEnv: { ...sandboxHome.env },
      // The child is a JSON-RPC server whose pipes the host owns, so unlike the
      // Python worker it needs stdin.
      stdio: ["pipe", "pipe", "pipe"],
      onWrapped: () => {
        wrapped = true;
      },
    });
    if (!child.stdin || !child.stdout) {
      child.kill("SIGKILL");
      throw new Error(`[out-of-process-plugin] ${spec.pluginId}: child has no pipes`);
    }
    // Diagnostics only. The child rebinds everything except the framer to
    // stderr precisely so a stray plugin `console.log` lands here instead of
    // corrupting the protocol.
    child.stderr?.on("data", (chunk: Buffer) => {
      log.debug(`[${spec.pluginId}] ${chunk.toString("utf-8").trimEnd()}`);
    });
    child.once("exit", releaseSandboxState);
    return {
      link: {
        input: child.stdout,
        output: child.stdin,
        terminate: (reason) => {
          log.debug(`[${spec.pluginId}] terminating child: ${reason}`);
          child.kill("SIGTERM");
        },
        onGone: (handler) => {
          child.once("exit", (code, signal) =>
            handler(
              `[out-of-process-plugin] ${spec.pluginId}: child exited ` +
                `code=${String(code)} signal=${String(signal)}`,
            ),
          );
          child.once("error", (error: Error) =>
            handler(`[out-of-process-plugin] ${spec.pluginId}: child error: ${error.message}`),
          );
        },
      },
    };
  } catch (error) {
    releaseSandboxState();
    throw error;
  }
}

export interface OutOfProcessPluginSpec {
  readonly manifest: PluginManifest;
  /** The resolved, real entry path of the PLUGIN (not of the child runtime). */
  readonly entryPath: string;
  /**
   * How the factory obtains a child. Defaults to the confined spawn; a test may
   * supply paired streams so the protocol can be exercised without a process.
   */
  readonly connect?: (spec: ConfinedPluginChildSpec) => Promise<ConfinedPluginChild>;
  /** Defaults to the emitted `plugin-child-main.js` under the runtime asset dir. */
  readonly childEntryPath?: string;
}

/**
 * Read a plugin's declared tool names.
 *
 * The same derivation `buildMethodMap` performs, and it is repeated here rather
 * than shared because it answers a different question: that one asks which
 * handlers an instance HAS, this one tells the child which handlers the host
 * will ask it for. Passing the declared set is what stops a compromised child
 * announcing a tool the reviewed manifest never contained.
 */
function declaredToolNames(manifest: PluginManifest): string[] {
  return [...new Set((manifest.tools ?? []).map((tool) => tool.name))];
}

/**
 * The `tools/call` arguments object for one invocation.
 *
 * Refuses anything that is neither absent nor a plain object. Coercing a
 * string or an array to `{}` would turn "you invoked this tool wrongly" into
 * "you invoked it with no payload", which the plugin would answer as a normal
 * call — a wrong answer with no error anywhere.
 */
function asToolArguments(
  pluginId: string,
  toolName: string,
  payload: unknown,
): Record<string, unknown> {
  if (payload === undefined) return {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: tool '${toolName}' payload must be an ` +
        `object or absent to cross the boundary, received ${typeof payload}`,
    );
  }
  return payload as Record<string, unknown>;
}

/**
 * Read a tool result off the MCP reply.
 *
 * `_meta[RAW_RESULT_META]` and NOT `content[0].text`: the text branch is lossy,
 * because a plugin returning the string `'{"a":1}'` and one returning the
 * object `{a:1}` produce the same text. The raw value is the plugin's own
 * return, and this is the same key the in-process delegate uses, so a tool's
 * result has one representation regardless of which arm ran it.
 */
function readToolResult(pluginId: string, toolName: string, result: unknown): unknown {
  if (typeof result !== "object" || result === null) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: tool '${toolName}' returned no result body`,
    );
  }
  const body = result as { isError?: boolean; content?: unknown; _meta?: Record<string, unknown> };
  if (body.isError === true) {
    // The child turns a throwing handler into an `isError` result, which is the
    // mechanism `plugin-mcp-server.ts` already has for the child→host
    // direction (§3.3). The identity that survives is the message; nothing is
    // reconstructed by matching it.
    const content = Array.isArray(body.content) ? body.content : [];
    const first = content[0] as { text?: unknown } | undefined;
    throw new Error(
      typeof first?.text === "string"
        ? first.text
        : `[out-of-process-plugin] ${pluginId}: tool '${toolName}' failed`,
    );
  }
  const meta = body._meta;
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, RAW_RESULT_META)) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: tool '${toolName}' returned a result ` +
        `without '${RAW_RESULT_META}' — the child and the host disagree about the wire`,
    );
  }
  return meta[RAW_RESULT_META];
}

/**
 * Build the factory the lifecycle calls in place of the in-process one.
 *
 * The returned factory does the whole of the boundary's setup — spawn,
 * dispatcher assembly, construct — inside ONE call, which is what puts it under
 * the host's existing `runPluginFactoryWithTimeout`. A child that never
 * finishes constructing therefore fails the plugin exactly as a factory that
 * never resolves does today, with no new timeout policy invented for it.
 */
export function createOutOfProcessPluginFactory(
  spec: OutOfProcessPluginSpec,
): RuntimePluginFactory {
  const connect = spec.connect ?? spawnConfinedPluginChild;
  const childEntryPath = spec.childEntryPath ?? resolvePluginChildEntryPath();
  const pluginId = spec.manifest.id;

  return async (context: PluginRuntimeContext): Promise<RuntimePlugin> => {
    // Minted per factory call, which is per incarnation. Its job (§2.4) is that
    // the child is told which incarnation it serves and a message naming a
    // different one is refused; a fresh id per construction is exactly that.
    const generationId = randomUUID();
    const hostApi = context.hostApi as unknown as DispatchableHostApi;
    const child = await connect({
      pluginId,
      pluginRoot: context.pluginRoot,
      pluginDataDir: context.pluginDataDir,
      childEntryPath,
    });

    let live = true;
    const transport = new PluginChildTransport({
      pluginId,
      generationId,
      // The boundary's own liveness, not a second authority. The authoritative
      // check is still `enforceActiveHostApi` on the object below, which throws
      // on every member once the incarnation deactivates — and which the child
      // cannot reach around, because it is on the other side of a pipe. This
      // one exists so a call arriving after `stop()` is refused at the wire
      // instead of being carried to a hostApi that will refuse it anyway.
      isActive: () => live,
      table: createBoundHostApiDispatchTable(hostApi, pluginChildConfinement(context)),
      link: child.link,
    });
    transport.start();

    /**
     * Every host-owned watcher for this incarnation, ended together.
     *
     * A LIST rather than three named disposers, because REGISTERING one can
     * fail: `hostApi` here is the generation-scoped proxy, and every member on
     * it throws once that generation retires. A failure partway through has to
     * end the ones that already exist, and by this line the child is already
     * spawned — so anything that escapes without this leaves a live process
     * reading stdin with nobody subscribed on its behalf.
     */
    const hostWatchers: Array<() => void> = [];
    const stopHostWatchers = (): void => {
      while (hostWatchers.length > 0) hostWatchers.pop()?.();
    };
    /**
     * Give up the child this call spawned, and everything registered for it.
     *
     * ONE teardown for the whole bring-up below, rather than a guard around the
     * single step most likely to throw. Every step after the spawn can fail —
     * the watcher registrations, the two hostApi reads that build the child's
     * context, `construct` itself, and the snapshot pushed once it returns —
     * and each of them fails with the same thing already owned: a child
     * process, an open transport, and however many watchers exist.
     *
     * NOT the same path `instance.stop()` takes, and deliberately so: a normal
     * stop keeps `live` true across the plugin's own `stop()` hook so that hook
     * can still reach hostApi, and flips it only afterwards. Here there is no
     * hook to run — the plugin never became an instance — so the flip comes
     * first and nothing the child sends after it is honoured.
     */
    const abandonChild = (reason: string): void => {
      live = false;
      stopHostWatchers();
      transport.close(reason);
    };

    try {
      // The host re-pushes the installed-plugin snapshot the child answers
      // `getInstalledPluginIds` from. It is the host's OWN subscription, separate
      // from any the plugin opens: the member has to answer whether or not the
      // plugin ever subscribed to `onPluginsChanged`.
      hostWatchers.push(hostApi.onPluginsChanged(() => {
        transport.sendToChild({
          wire: HOST_API_WIRE_VERSION,
          pluginId,
          generationId,
          kind: "installed-plugins",
          pluginIds: hostApi.getInstalledPluginIds(),
        });
      }));

      /**
       * The host re-pushes the config snapshot the child answers `config.get`
       * from. Also the host's OWN subscription, and for the same reason as the
       * one above: `config.get` has to answer whether or not the plugin ever
       * called `config.onChange`, and without a re-push it would answer with the
       * value the key had at construction for the life of the process.
       *
       * `"*"` is the change bus's every-key wildcard, so this fires for a user's
       * settings edit and for the plugin's own `config.set` alike. The bus emits
       * INSIDE `config.set`'s persistence chain, before that call's reply is
       * produced — which is what makes the contract's ordering obligation ("the
       * push is emitted before the `config.set` reply") hold on the wire rather
       * than by luck: both are written to the same pipe in that order.
       *
       * The callback's value is ignored on purpose. It carries one key's new
       * value and not which key, and a snapshot rebuilt through `config.get` is
       * the same merge the in-process member reads — one authority for what a
       * config value is, rather than a second assembled from change events.
       */
      const configKeys = resolvableConfigKeys(spec.manifest, context.config);
      hostWatchers.push(hostApi.config.onChange("*", () => {
        const values: Record<string, unknown> = {};
        for (const key of configKeys) {
          const value = hostApi.config.get(key);
          // Absent, not `undefined`: the wire distinguishes "unset" from "has a
          // value" by presence in this record, because JSON has no `undefined`.
          if (value !== undefined) values[key] = value;
        }
        transport.sendToChild({
          wire: HOST_API_WIRE_VERSION,
          pluginId,
          generationId,
          kind: "config-snapshot",
          keys: configKeys,
          values,
        });
      }));
      /**
       * The allow-listed host preferences, read through the SAME member a plugin
       * would call — so the snapshot is the reader's answer, not a second one.
       *
       * `undefined` when this host implements no `getAppPreference`: the member
       * is optional on `PluginHostApi`, and a child seeded with an empty snapshot
       * could not tell "unset" from "unavailable". Not seeding at all keeps those
       * apart, because the child's member throws when nothing was seeded.
       *
       * NO HOST THE APP BUILDS TAKES THAT BRANCH — `host-api-factory.ts` always
       * defines the member — so it is the shape of a partial hostApi assembled in
       * a test, kept because the optional member and this reader are two objects
       * that nothing forces to agree.
       */
      const readAppPreferences = ():
        | { keys: readonly string[]; values: Record<string, unknown> }
        | undefined => {
        const read = hostApi.getAppPreference;
        if (typeof read !== "function") return undefined;
        const values: Record<string, unknown> = {};
        for (const key of HOST_PUBLIC_PREFERENCE_KEYS) {
          const value = read.call(hostApi, key);
          // Absent, not `undefined`: the wire distinguishes "unset" from "has a
          // value" by presence in this record, because JSON has no `undefined`.
          if (value !== undefined) values[key] = value;
        }
        return { keys: HOST_PUBLIC_PREFERENCE_KEYS, values };
      };

      /**
       * Send the child the preferences as they read RIGHT NOW.
       *
       * One function for the watcher below and for the post-construct push, so
       * the two cannot disagree about what a snapshot contains.
       */
      const pushPreferenceSnapshot = (): void => {
        const snapshot = readAppPreferences();
        // A host with no reader never seeded the child, so there is nothing this
        // push could correct. Unreachable for the same reason the branch above
        // is; it is here so the two stay one decision rather than two.
        if (!snapshot) return;
        transport.sendToChild({
          wire: HOST_API_WIRE_VERSION,
          pluginId,
          generationId,
          kind: "preference-snapshot",
          keys: snapshot.keys,
          values: snapshot.values,
        });
      };

      /**
       * The host re-pushes the preference snapshot the child answers
       * `getAppPreference` from — the third host-owned watcher, and the one that
       * makes the member answerable out of process at all.
       *
       * `getAppPreference` is synchronous, so §3.1 answers it from a snapshot,
       * and a snapshot with no re-push is the value the preference held at plugin
       * start. `ms-graph` reads `webView.preferredFlow` at CALL time, so it would
       * have read a stale answer for the life of the process with nothing
       * reporting it. The bus announces only a REAL change to an allow-listed
       * key (`publishAppPreferenceChange` diffs before emitting), so an unrelated
       * settings save costs nothing here.
       */
      hostWatchers.push(subscribeAppPreferenceChange(pushPreferenceSnapshot));

      const constructionPreferences = readAppPreferences();
      const childContext: PluginChildContext = {
        pluginId,
        pluginRoot: context.pluginRoot,
        hostRoot: context.hostRoot,
        pluginDataDir: context.pluginDataDir,
        generationId,
        installedPluginIds: hostApi.getInstalledPluginIds(),
        ...(context.config !== undefined ? { config: context.config } : {}),
        // Omitted entirely when the host implements no reader, which is what lets
        // the child tell "unset" from "unavailable".
        ...(constructionPreferences ? { appPreferences: constructionPreferences } : {}),
      };
      const constructParams: PluginConstructParams = {
        wire: PLUGIN_INSTANCE_WIRE_VERSION,
        manifest: spec.manifest,
        context: childContext,
        entryPath: spec.entryPath,
        declaredToolNames: declaredToolNames(spec.manifest),
      };

      const construction = (await transport.request(
        PLUGIN_INSTANCE_METHODS.construct,
        constructParams as unknown as Record<string, unknown>,
        // The child performs BOTH halves of what the in-process path splits
        // between `importPluginFactory` and the factory call, so the import
        // bound is applied here and the outer factory bound covers the rest. A
        // child that hangs is killed by this deadline rather than left running
        // under a confinement nobody is watching.
        TOOL_TIMEOUT_POLICY.pluginImportMs + TOOL_TIMEOUT_POLICY.pluginFactoryMs,
      )) as PluginConstructResult;

      /**
       * The seed above was read BEFORE the child could receive anything, so this
       * re-push closes the window between the two.
       *
       * A `preference-snapshot` sent while the child is still constructing is
       * DROPPED: the child routes notifications through a runtime it assigns only
       * after the plugin module has imported and its factory has run
       * (`plugin-child-main.ts`). The two watchers above survive that: neither
       * compares anything, so the next event either of them receives re-pushes
       * its whole snapshot and repairs the drop. Preferences do not work that
       * way — the bus announces only a MOVE, and the value that moved is already
       * the current one — so the child would answer `getAppPreference` with its
       * construction value until the preference moved AGAIN, which is exactly the
       * staleness this member was wired to end.
       *
       * Sending it here cannot be dropped in turn: the child assigns its runtime
       * before it writes the construct reply, this runs after that reply arrived,
       * and one pipe delivers both in order.
       */
      pushPreferenceSnapshot();

      const handlers: Record<string, PluginToolHandler> = {};
      for (const toolName of construction.implementedToolNames) {
        handlers[toolName] = async (payload?: unknown) => {
          const result = await transport.request("tools/call", {
            name: toolName,
            // MCP's `tools/call` params are an OBJECT, so an absent payload
            // crosses as `{}` and the child's delegate turns it back into
            // "absent" — the same conversion the in-process delegate performs.
            // A payload that is neither absent nor an object cannot make that
            // round trip, and is refused rather than silently replaced by `{}`.
            arguments: asToolArguments(pluginId, toolName, payload),
          });
          return readToolResult(pluginId, toolName, result);
        };
      }

      const instance: RuntimePlugin = {
        handlers,
        /**
         * ALWAYS present, unlike the other two hooks.
         *
         * `stop` is the host's only hand on the child's lifetime: the lifecycle
         * calls `instance.stop?.()` when it retires a generation, and if the
         * proxy omitted it for a plugin that implements no `stop()` the child
         * would outlive the incarnation it serves. So the plugin's own hook is
         * optional and the teardown is not.
         */
        stop: async () => {
          stopHostWatchers();
          try {
            if (construction.lifecycleHooks.includes("stop")) {
              await transport.request(
                PLUGIN_INSTANCE_METHODS.stop,
                {},
                // Bounded where the in-process call is not, which §3.1 names as
                // an improvement: today a plugin can hang shutdown forever. The
                // child is killed either way on the next line.
                TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs,
              );
            }
          } finally {
            // Marked dead AFTER the hook, not before. The in-process lifecycle
            // deactivates the incarnation once `stop()` has returned, so a
            // plugin's stop hook can still reach hostApi — flipping this first
            // would refuse the very last thing a plugin does (flush a file, log a
            // shutdown line) and would do it silently, as a `plugin-inactive`
            // rejection on a `void` member the plugin never awaits.
            live = false;
            transport.close(`[out-of-process-plugin] ${pluginId}: stopped`);
          }
        },
      };
      if (construction.lifecycleHooks.includes("start")) {
        instance.start = async () => {
          await transport.request(PLUGIN_INSTANCE_METHODS.start, {});
        };
      }
      if (construction.lifecycleHooks.includes("onPublished")) {
        instance.onPublished = async () => {
          await transport.request(PLUGIN_INSTANCE_METHODS.onPublished, {});
        };
      }
      if (construction.servesUiResources) {
        instance.readUiResource = async (uri: string) => {
          const result = (await transport.request(PLUGIN_INSTANCE_METHODS.readUiResource, {
            uri,
          })) as ReadUiResourceResult;
          if (typeof result?.html !== "string") {
            throw new Error(
              `[out-of-process-plugin] ${pluginId}: readUiResource('${uri}') returned no html`,
            );
          }
          return result.html;
        };
      }
      return instance;
    } catch (error) {
      // Named for the whole bring-up rather than for `construct`: a throw from
      // any of the steps above leaves the same three things owned — the spawned
      // child, the open transport, and the watchers registered so far — and one
      // teardown for all of them is what keeps a failed start from turning into
      // an orphaned process no ledger knows about.
      abandonChild(`[out-of-process-plugin] ${pluginId}: startup failed`);
      throw error;
    }
  };
}
