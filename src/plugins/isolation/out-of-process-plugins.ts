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
 * ─── THE ADMISSION CRITERION, AND WHY IT IS NOT THE OBVIOUS ONE ────────────
 *
 * A plugin is admitted when it depends on nothing this boundary REMOVES.
 *
 * That is a different question from "does every hostApi member it calls have a
 * wire form", and the difference has now cost two migrations. The reason it
 * reads as the same question is that a plugin's capabilities arrive from two
 * places:
 *
 *   MEDIATED — what the host hands it as `hostApi`. The wire PRESERVES this.
 *     Every classified path is bound — `out-of-process-plugin.test.ts` fails if
 *     one is left unimplemented — so the mediated half of any plugin survives
 *     the move by construction.
 *   AMBIENT — what the RUNTIME hands it merely by being loaded there: the
 *     global scope, the built-in modules, and the identity of the process it
 *     shares. Nothing mediates this, which is precisely why the boundary
 *     exists to take it away (§4, "Gained by the process boundary alone").
 *
 * Measuring only the mediated half therefore cannot return an answer other
 * than "ready" — it asks whether a complete wire is complete. The question
 * that decides admission is the other one: WHICH AMBIENT CAPABILITIES DOES
 * THIS PLUGIN USE, and does a mediated form of each exist. Two plugins were
 * read as ready on the mediated half and were wrong on the ambient half in the
 * same way: one reaches the network through the global `fetch`, one reaches
 * the windowing system through `electron`. Neither fact was visible in a
 * `hostApi.*` census, and neither is a detail — each ends a primary feature.
 *
 * So the measurement has to be taken over BOTH sets, over the plugin's
 * DEPENDENCIES as well as its own sources (a dependency that opens its own
 * socket is ambient egress the plugin's source never mentions), and against a
 * REAL confined child rather than inferred from a manifest.
 *
 * The ambient axes, each with what a child measurably gets. Every one was
 * measured through this file's production spawn, from the Electron binary this
 * repository's own test runner already uses as `process.execPath`, with the
 * sandbox active.
 *
 * MEASURED and ASSERTED are not the same thing, and which is which is marked
 * per axis. A measurement is a fact about the machine it ran on; an assertion
 * is a case that goes red when the fact stops holding. Axes 2, 3 and 5 are
 * ASSERTED by `confined-plugin-child.test.ts`. Axes 1 and 4 are measured and
 * asserted NOWHERE, for the reasons given with each — reading them as pinned
 * would be a smaller version of the mistake this comment is about.
 *
 * 1. DIRECT NETWORK EGRESS — the global `fetch`, `node:http`/`https`/`net`/
 *    `tls`/`dgram`, an HTTP client library, a websocket, or any dependency
 *    that opens its own socket. A confined child HAS NONE. Measured against a
 *    destination that IS in the allow-list, so the answer is the fence and not
 *    a missing grant: `fetch` fails, the DNS lookup fails `ENOTFOUND`, and a
 *    raw TCP connect to a LITERAL IP — which needs no DNS at all — fails
 *    `EPERM` at the connect syscall. The child's env carries a proxy variable
 *    pointing at the loopback listener that enforces the allow-list, and
 *    `NODE_USE_ENV_PROXY` is absent, so Node's own clients ignore it and go
 *    direct into that denial. An unconfined request to the same host on the
 *    same machine answers, so this is the fence rather than an offline box.
 *    MEDIATED FORM: `hostApi.hostFetch`. Declaring the host does NOT help —
 *    the request never reaches the allow-list. NOT ASSERTED: the confinement
 *    suite says why in its own header — the macOS backend fences egress through
 *    a proxy and the Linux one through a namespace, so one probe would mean
 *    different things per platform, and an internet probe passes on an offline
 *    machine for the wrong reason. What would resolve it is a per-platform case
 *    that reaches a HOST-CONTROLLED listener rather than the internet.
 * 2. ELECTRON MAIN-PROCESS APIs — `require("electron")` or a static import of
 *    it, in the plugin or in anything it loads. A confined child has none:
 *    measured, `require("electron")` fails `MODULE_NOT_FOUND` while
 *    `process.versions.electron` in the SAME child still reports a version.
 *    That pairing is worth stating on its own, because it means a runtime
 *    check of "am I inside Electron" answers YES in a child that has no
 *    Electron API, and a plugin gated on it walks straight into the call.
 *    Vendoring the `electron` package does not restore it either: measured,
 *    its entry resolves to the binary PATH as a STRING, so `BrowserWindow` is
 *    `undefined` and a guard on it throws. MEDIATED FORM: only for the
 *    interaction members the wire carries — `openExternalUrl`,
 *    `openAuthWindow`, `openAuthPartitionViewer`, `clearAuthPartition`. There
 *    is NO mediated form of `BrowserWindow`, `screen`, `session` or `ipcMain`,
 *    and §4 names the unreachability of exactly those as a GAIN. A plugin that
 *    owns a window of its own is therefore not a migration candidate at all
 *    until that gap is answered as a design question, not a wiring one.
 * 3. PROCESS SPAWNING — `node:child_process`, a process-spawning library, a
 *    browser driver. A process a confined child starts is a GRANDCHILD and
 *    inherits its fence; the end-to-end case drives that in both directions,
 *    because a confinement that ended at the first spawn would leave every
 *    other assertion true and worthless. On Windows the sandbox confines
 *    filesystem and network but NOT process creation (§4's residual), so this
 *    axis has a different answer per platform and the child's fence is the
 *    weaker claim there. MEDIATED FORM: `hostApi.spawnWorker`, and only for a
 *    worker inside the same confinement envelope.
 * 4. NATIVE MODULES — a `.node` addon, or a dependency that loads one. These
 *    DO load: measured, `process.dlopen` of a prebuilt addon placed inside the
 *    child's read carve-out succeeded and its exports came back. Two things
 *    follow, and they point opposite ways. The addon is compiled against the
 *    ABI of the binary the child runs, which is Electron's and not plain
 *    Node's — measured, the child reports Electron's module ABI — so a plugin
 *    shipping a plain-Node prebuild breaks on a boundary that never mentions
 *    native code. And an addon is ambient code the wire cannot see: it reaches
 *    the OS directly, so the ONLY thing standing between it and the host is
 *    the sandbox. That is an argument for the sandbox being mandatory, which
 *    it already is, and against reading "the hostApi surface is covered" as
 *    "the plugin is contained". NOT ASSERTED: the measurement loaded a prebuilt
 *    addon that happens to sit in this repository's own dependency tree for one
 *    platform, and a case pinned to that path would assert a fixture rather
 *    than a boundary. What would resolve it is an addon built by the suite, for
 *    the platform it runs on.
 * 5. THE PROCESS'S OWN IDENTITY — `os.tmpdir()`, the working directory, the
 *    home directory. The sandbox SUBSTITUTES the temp root and creates
 *    nothing, so a child's `os.tmpdir()` routinely does not exist. Measured
 *    against an absent path that is INSIDE the write jail: `readdirSync` and
 *    `mkdtempSync` fail `ENOENT` while a recursive `mkdir` on the same path
 *    succeeds — absence, not permission, which is what decides where a fix
 *    goes. MEDIATED FORM: none is needed; `pluginDataDir` is granted and
 *    exists before the child starts, and that is where staging belongs.
 *
 * A plugin passes when every axis it touches has a mediated form AND the
 * plugin already uses that form. "Could be changed to use it" is a backlog
 * item, not an admission.
 *
 * ─── WHERE EACH FIRST-PARTY PLUGIN STANDS ──────────────────────────────────
 *
 * KNOWN means established, and HOW it was established is said each time,
 * because the two ways are not equally strong: driven through a real confined
 * child, or read directly out of the plugin's own sources. ASSUMED means
 * neither — believed from the shape of the thing, typically about what a
 * DEPENDENCY does internally. The distinction is marked rather than smoothed
 * over because an assumption that reads like a measurement is how both wrong
 * admissions happened.
 *
 * `work-assistant` — ADMITTED, and the only member of the set. KNOWN FROM ITS
 *   SOURCES: its production sources reach ten hostApi members — `callLlm`, `config.get`,
 *   `config.set`, `emitEvent`, `getInstalledPluginIds`, `hasRoutineBySource`,
 *   `logEvent`, `onEvent`, `onPluginsChanged`, `triggerConversation` — and
 *   none of the ones §3.2 calls lossy or stateful. It declares three tools, no
 *   `uiResources[]` and no `networkAccess`, and it names no ambient axis at
 *   all: no direct egress, no `electron`, no spawn, no native module, no
 *   runtime dependencies. Its tools are driven end-to-end through a real
 *   confined child. ASSUMED: nothing load-bearing.
 *
 * `meeting` — REFUSED, and this is the measured answer rather than an
 *   oversight. KNOWN: its primary tool opens a floating recorder window and
 *   reaches `BrowserWindow`, `screen`, `session.fromPartition` and `ipcMain`
 *   through `require("electron")`. In a confined child that require is
 *   `MODULE_NOT_FOUND`, so the tool's own pre-flight guard throws before it
 *   side-effects — measured, both bare and with the package vendored beside
 *   the plugin. Axis 2 has no mediated form for any of those members, so
 *   admitting it would not degrade recording, it would END it. KNOWN also, and
 *   independently sufficient: its `createPlugin` sweeps `os.tmpdir()`
 *   unconditionally as its first statement, so on a machine where the
 *   substituted temp root is absent (axis 5) the `ENOENT` escapes activation
 *   and the plugin does not load at all — no tools, no UI entry. And its media
 *   runtime auto-install reaches the network over `node:https` directly (axis
 *   1) and executes a staged binary (axis 3). The transcription path is the
 *   one part that is already mediated: it goes through `hostApi.hostFetch` and
 *   refuses to run without it. ASSUMED: nothing — the window and temp-root
 *   blockers were driven through a real child, and the egress and spawn ones
 *   read directly out of its sources. What would change the answer is a mediated
 *   form for axis 2, which is a design question this file does not settle;
 *   the shape it would have to take is written up beside the design's Stage 8.
 *
 * `ep-api` — REFUSED. KNOWN FROM ITS SOURCES: every one of its REST clients reaches the network
 *   through the global `fetch`, and no code path in it CALLS
 *   `hostApi.hostFetch` — the name occurs in its sources exactly once, in a
 *   comment observing that a browser process cannot be brokered by it.
 *   One flow drives a browser the plugin launches itself, which would be a
 *   grandchild of the confined child and inherit its fence (axes 1 and 3).
 *   ASSUMED: that nothing else in it touches axes 2 or 4 — its sources name
 *   neither, but the browser driver it depends on has not been measured inside
 *   a child. What it needs first, in order: its HTTP clients call
 *   `hostApi.hostFetch` rather than `fetch` (its manifest already declares the
 *   capability and the hosts, which is what that path is checked against); the
 *   browser-driven flow gets an answer that is not "the plugin launches a
 *   browser"; and the reach is measured again over both sets.
 *
 * `local-indexer` — REFUSED. KNOWN FROM ITS SOURCES: it operates its own loopback HTTP listener
 *   and its own upstream TLS client as a broker, holds a control channel over
 *   a unix socket, calls `execFile`, and delegates the indexing work to a
 *   separate interpreter process through `hostApi.spawnWorker` at a dozen call
 *   sites. The broker's upstream leg is exactly the direct egress axis 1
 *   measures a child as not having, so the broker would stop at its first
 *   request. ASSUMED: whether `spawnWorker`'s confinement envelope can carry
 *   that worker at all, and whether the worker's own egress — which is not the
 *   plugin's — has any mediated form. Both are open questions rather than
 *   wiring, and they are why this id is also the in-process counter-example
 *   the routing tests use.
 *
 * `ms-graph` — the only remaining CANDIDATE, and it is a candidate rather than
 *   an admission because the difference is what this comment is about. KNOWN
 *   FROM ITS SOURCES, and from nothing stronger — no case has driven it
 *   through a child: no direct `fetch`, no `node:http`/`https`/`net`, no
 *   `electron`, no `child_process`, and its auth library's network client is
 *   explicitly replaced with one that calls `hostApi.hostFetch`, so its token
 *   and API egress is mediated by construction rather than by convention. Its
 *   window-shaped needs go through `openAuthWindow`,
 *   `openAuthPartitionViewer` and `clearAuthPartition`, all of which the wire
 *   carries. ASSUMED, and NOT measured: that its auth library opens no socket
 *   of its own outside the injected client; that no transitive dependency
 *   loads a native module built for the wrong ABI (axis 4); and that its one
 *   `ui[]` entry is renderer-loaded and therefore indifferent to which process
 *   the factory ran in. Those three assumptions are the content of its
 *   admission PR — each has to become a measurement against a real confined
 *   child before the id is added here.
 *
 * `template` — not installed; a scaffold, out of scope.
 */
export const OUT_OF_PROCESS_PLUGIN_IDS: ReadonlySet<string> = Object.freeze(
  new Set<string>(["work-assistant"]),
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
