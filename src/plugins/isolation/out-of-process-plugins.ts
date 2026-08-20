/**
 * Which plugins load in their own process.
 *
 * Populated one id at a time, which is how the isolated path gets exercised by
 * real plugins before an untrusted one is ever admitted to it.
 *
 * NO CONFIGURATION READS THIS. Not an environment variable, not a settings key,
 * not a manifest field. A plugin moves out-of-process when a reviewed commit
 * adds its id here, which means the move is visible in a diff and revertable by
 * a revert. An env-var switch would let the boundary change under a user with
 * no record of it, and a manifest field would let the PLUGIN choose whether it
 * is isolated — which is the one party that must not have a say.
 *
 * This is a routing decision, not a fallback: a call never retries in-process
 * when the child fails. A failed child fails the call
 * (`docs/blueprints/plugin-process-isolation.md` §9, "A note on the coexistence
 * question").
 */

/**
 * Plugin ids served by a child process instead of an in-main dynamic import.
 *
 * Frozen so an id cannot be added at runtime — the set a plugin is checked
 * against must be the set that was reviewed.
 *
 * `work-assistant` is first because it is the least entangled first-party
 * plugin, and that was measured rather than assumed. Across the six, its
 * production sources reach ten hostApi members — `callLlm`, `config.get`,
 * `config.set`, `emitEvent`, `getInstalledPluginIds`, `hasRoutineBySource`,
 * `logEvent`, `onEvent`, `onPluginsChanged`, `triggerConversation` — and none
 * of the ones whose marshalling §3.2 calls out as lossy or stateful: no
 * `getSecret`, no `hostFetch`, no `resolveApiKey`, no `spawnWorker`, no
 * `storage.*`, no auth window. It declares three tools, no `uiResources[]`, and
 * no `networkAccess`, so nothing about it depends on a grant this boundary
 * cannot express. `meeting` (32 tools, `getSecret` + `hostFetch` +
 * `resolveApiKey`) and `local-indexer` (`spawnWorker`, whose grandchild is
 * explicitly outside a plugin child's authority per §3.2) are the far end of
 * that scale and are deliberately not first.
 *
 * `meeting` is second, and it is the one that changes what the gate MEANS. In
 * one heap `getSecret` was a function a plugin could decline to call before
 * reading the secrets directory itself; across this boundary the gate's
 * verdict is the only entrance. So its end-to-end case shows both arms of that
 * verdict - the granted key comes back as the value, the refused one as
 * `null` - beside a direct filesystem read that comes back denied, all from
 * one confined child inside one tool call.
 *
 * Its reach is ten members: `callLlm`, `config.get`, `config.onChange`,
 * `emitEvent`, `getSecret`, `hostFetch`, `logEvent`, `onEvent`, `onShutdown`
 * and `resolveApiKey`. Its ONE direct egress is the FFmpeg download below;
 * transcription goes through `hostApi.hostFetch` and refuses to run without it.
 * The `config.onChange` subscriptions are on `customSummaryFinalPrompt` and
 * `customSummaryIntermediatePrompt`; neither is declared `format: "secret"`, so
 * neither asks the snapshot push to carry a value it withholds. It declares no
 * `spawnWorker` and no `storage.*` - the transcript store is its own JSON under
 * `pluginDataDir`, which the child's write jail already contains.
 *
 * It declares one `ui[]` entry, and that is deliberately unaffected: an
 * `embedded-module` slot is loaded by the RENDERER out of the plugin root
 * (`plugin-ui-host.tsx` mounts it from an `entryUrl`), not by the plugin
 * factory, so it never depended on which process the factory ran in.
 *
 * FOUR CONSEQUENCES OF MOVING IT, NAMED HERE RATHER THAN DISCOVERED LATER.
 * Two are behaviour this boundary deliberately removes (1 and 3); two are ways
 * the plugin BREAKS on an ordinary machine and must be fixed on the plugin
 * side (2 and 4). Each was MEASURED against a real confined child rather than
 * inferred from the hostApi surface — that inference is exactly what got
 * `ep-api` wrong below.
 *
 * A measurement is only as portable as the machine it ran on, so where one
 * depended on something the measuring machine HAPPENED to already have, that
 * dependency is named rather than left implicit. Consequence 2 is exactly such
 * a case: stated without it, a measurement reads as a guarantee.
 *
 * 1. THE FFMPEG AUTO-INSTALL NOW FAILS CLOSED. When no runtime is found
 *    `meeting` downloads one over `node:https` DIRECTLY. In main that egress
 *    met no fence, because main is not itself wrapped. A confined child has NO
 *    direct egress at all: measured, a `fetch` or `node:https` request from
 *    inside one fails with `ENOTFOUND` even when the destination host IS in the
 *    allow-list. The allow-list is enforced by a localhost proxy the child's
 *    env points at (`HTTPS_PROXY` is set in the child), and Node's own clients
 *    ignore that variable unless `NODE_USE_ENV_PROXY` says otherwise — measured
 *    absent in the child, so they go direct and DNS is where they stop. So
 *    declaring the artifact host would NOT restore the download; what works is
 *    a fix in `lvis-plugin-meeting` routing the download through
 *    `hostApi.hostFetch`, which is served by main and therefore unaffected.
 *    Existing installs keep the runtime already staged under `pluginDataDir`;
 *    new ones lose the automatic install until the plugin is fixed. It is
 *    deliberately not softened here, because a carve-out for direct egress is
 *    the exact thing this boundary exists to remove. Staging and EXECUTING a
 *    runtime under `pluginDataDir` is unaffected and is covered by the
 *    end-to-end case.
 *
 * 2. TEMP STAGING BREAKS, AND THE HOST'S OWN `TMPDIR` HAS NOTHING TO DO WITH
 *    IT. `meeting` stages uploaded audio and the FFmpeg unpack under
 *    `os.tmpdir()`. The child does not inherit the host's: ASRT REWRITES
 *    `TMPDIR` for any wrap that carries a write policy — which this spawn's
 *    does — to `CLAUDE_CODE_TMPDIR`, else `CLAUDE_TMPDIR`, else the literal
 *    `/tmp/claude`. That is `sandbox-runtime`'s `generateProxyEnvVars`, whose
 *    `skipTmpdir` argument the macOS and the Linux backend both pass as
 *    `writeConfig === undefined` — and ASRT assembles a write config whenever
 *    its filesystem policy is on, which this spawn requires, since it refuses
 *    to produce a child at all when the sandbox is inactive.
 *
 *    Measured on macOS through this branch's production spawn: the host's
 *    `os.tmpdir()` was its per-user temp directory and the child's was
 *    `/tmp/claude`. The end-to-end case carries only HALF of that to other
 *    platforms, and the halves are worth keeping apart. The case NAMES the
 *    substitute itself, so what it asserts wherever it runs is that the
 *    substitution HAPPENS: the child's `os.tmpdir()` comes back equal to the
 *    path the case supplied and UNEQUAL to the host's. That the fallback —
 *    with nothing supplied — is the literal `/tmp/claude` is read from the
 *    runtime source above and measured on macOS only; NO case asserts it, on
 *    Linux or anywhere. That gap is tolerable only because the fallback's
 *    identity is not the failure axis. Its ABSENCE is, and the case does
 *    assert that.
 *
 *    That substituted path is on ASRT's own default WRITE allow-list, and
 *    NOTHING CREATES IT — not this repository, not the sandbox runtime, which
 *    allows it and never makes it. So the failure axis is the directory's
 *    ABSENCE rather than a permission, and the axis is NOT "a platform whose
 *    `TMPDIR` is unset" — the host's variable never reaches the child either
 *    way. It is "a machine that has never run a tool which makes
 *    `/tmp/claude`", and that machine hands the child an `os.tmpdir()` that
 *    does not exist. Measured against an absent path that IS inside the
 *    write jail: `readdirSync` and `mkdtempSync` on it both fail `ENOENT`,
 *    while `mkdirSync(…, { recursive: true })` on the same path SUCCEEDS —
 *    which is what distinguishes "absent" from "denied" and decides what the
 *    fix has to be.
 *
 *    A machine that already has `/tmp/claude` — anything that has run Claude
 *    Code — sees none of this, which is why the end-to-end case points
 *    `CLAUDE_CODE_TMPDIR` at an absent path instead of trusting the developer
 *    machine's answer. The durable fix is the plugin staging under its own
 *    `pluginDataDir`, which this spawn grants and which exists before the child
 *    starts.
 *
 * 3. THE LEGACY SESSION MOVE IS DENIED RATHER THAN SILENT. `meeting` still
 *    carries a one-time migration that moves a directory under `hostRoot` into
 *    its own data directory. `hostRoot` is the app root, which is outside the
 *    child's write jail — measured `EPERM` — so on an install that still holds
 *    un-migrated files there, which is the only state the plugin's own guard
 *    lets reach the move, it now throws where it used to succeed. The
 *    end-to-end case plants an un-migrated file from the host side and then
 *    runs the plugin's own operation on it — the per-file `renameSync` out of
 *    `hostRoot`, not a stand-in `mkdir`; both land outside the same jail, but
 *    only one of them is what the plugin does — so the denial is a measured
 *    fact rather than a prediction, and the case also asserts that nothing
 *    moved.
 *
 * 4. `meeting` THROWS DURING ACTIVATION WHERE CONSEQUENCE 2'S PATH IS ABSENT,
 *    WHICH IS NOT A DEGRADED FEATURE BUT NO PLUGIN AT ALL. Its `createPlugin`
 *    runs a stale-staging sweep unconditionally, and that sweep's FIRST
 *    statement iterates `readdirSync(os.tmpdir())` outside any `try`. On the
 *    machine consequence 2 describes — the ordinary one, where the substituted
 *    temp root was never created — that `ENOENT` escapes `createPlugin`, so
 *    the plugin does not load: no tools registered, no UI entry, not a lost
 *    transcode. It is recorded separately from 2 because "uploads do not
 *    stage" and "the plugin never starts" are different failures, and folding
 *    the second into the first is how it went unnoticed. The end-to-end case
 *    pins the mechanism by pointing `CLAUDE_CODE_TMPDIR` at an absent path
 *    inside the write jail and asserting the child's `readdirSync(os.tmpdir())`
 *    fails `ENOENT` while `mkdirSync` on the same path succeeds. It pins the
 *    MECHANISM and not the plugin's own call site, which lives in another
 *    repository; the fix belongs there.
 *
 * `ep-api` IS NOT HERE, AND ITS ABSENCE IS THE MEASURED ANSWER RATHER THAN AN
 * OVERSIGHT. Every hostApi member it touches has a wire form, and a measurement
 * that counted only `hostApi.*` calls therefore read as "ready". That
 * measurement was of the wrong set. `ep-api` never calls `hostApi.hostFetch`:
 * every one of its REST clients reaches the network through the global
 * `fetch`, which is the direct egress point 1 above measures a confined child
 * as NOT having. One of its flows additionally drives a browser the plugin
 * launches itself, which would be a grandchild of that child and would inherit
 * its fence. So admitting `ep-api` would fail its network tools at the first
 * request rather than isolate them. What it needs first, in order:
 *   - its HTTP clients call `hostApi.hostFetch` rather than `fetch`, because
 *     host-mediated egress is the only kind this boundary can express (its
 *     manifest already declares the `external-auth-consumer` capability and the
 *     hosts, which is what that path is checked against);
 *   - the browser-driven flow gets an answer that is not "the plugin launches
 *     a browser". A process a confined child starts is a grandchild of it and
 *     inherits its fence, so the manifest's browser-launch exception stops
 *     being expressible the moment the plugin moves out of main;
 *   - the reach is measured again over BOTH sets — `hostApi.*` AND the direct
 *     network and process APIs — since it was the second set that decided this.
 * Until then `ep-api` belongs in neither this set nor a carve-out from it.
 */
export const OUT_OF_PROCESS_PLUGIN_IDS: ReadonlySet<string> = Object.freeze(
  new Set<string>(["work-assistant", "meeting"]),
);

/** Whether `pluginId` loads out-of-process. */
export function isOutOfProcessPlugin(pluginId: string): boolean {
  return OUT_OF_PROCESS_PLUGIN_IDS.has(pluginId);
}

/**
 * Whether the in-process loader still has a reason to exist.
 *
 * The removal trigger for `importPluginFactory` is a STATE, not a date: every
 * installed plugin is out-of-process. Exposing it as a predicate is what makes
 * that trigger mechanically checkable instead of a note someone has to remember.
 */
export function allPluginsAreOutOfProcess(
  installedPluginIds: readonly string[],
): boolean {
  return (
    installedPluginIds.length > 0
    && installedPluginIds.every((pluginId) => isOutOfProcessPlugin(pluginId))
  );
}
