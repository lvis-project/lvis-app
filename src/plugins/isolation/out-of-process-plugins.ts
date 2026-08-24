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
 * is a case that goes red when the fact stops holding. Axes 2, 3, 5 and 6 are
 * asserted by `confined-plugin-child.test.ts`. Axes 1 and 4 are measured and
 * asserted NOWHERE, for the reasons given with each — reading them as pinned
 * would be a smaller version of the mistake this comment is about.
 *
 * WHERE THOSE ASSERTIONS RUN, because an assertion is only an assertion where
 * it executes. All four sandbox cases stand behind a live-sandbox gate and
 * return early where the backend cannot initialize, so they assert nothing
 * there. Where that is:
 *   - macOS: the backend needs no install, so the cases run on any macOS
 *     machine — including the `macos-permission-tests` job in `ci.yml`, which
 *     runs `confined-plugin-child.test.ts` with `LVIS_REQUIRE_SANDBOX_CASES=1`
 *     so a machine that CANNOT initialize fails there instead of passing
 *     quietly.
 *   - Linux: the backend is bubblewrap, and the job that runs the whole suite
 *     on every pull request does not install it — `grep -rn bwrap .github/
 *     scripts/` returns nothing and ASRT vendors only seccomp and srt-win — so
 *     on that runner these cases return without measuring. Installing
 *     bubblewrap there is what would change it, and it would also un-gate the
 *     two other suites that call the same helper (`asrt-sandbox.test.ts` and
 *     `worker-spawn-uds.smoke.test.ts`), which is why it is named here as an
 *     open item rather than done in passing.
 *   - Windows: the cases do not run at all; they are `runIf(darwin || linux)`.
 * So "asserted" below means asserted on macOS, in CI and on a developer's
 * machine, and NOT on the Linux runner.
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
 *    direct into that denial. What separates that from an OFFLINE machine is
 *    the code itself — BUT the reading is PER PLATFORM, because the two
 *    backends fence differently and one of them borrows the other's code. On
 *    macOS the fence is a proxy and denial arrives as `EPERM` at the connect
 *    syscall, where an unreachable network answers `ENETUNREACH`,
 *    `EHOSTUNREACH` or a timeout — so there the code alone separates them.
 *    On Linux the fence is a network namespace, and a connect inside one
 *    returns `ENETUNREACH` — the SAME code an offline machine returns, so the
 *    code alone separates NOTHING there and reading the macOS rule on Linux
 *    would file a working fence as a broken machine. What separates them on
 *    EITHER platform is the control: measured beside it, the same connect from
 *    the UNCONFINED host process succeeds.
 *    "Does an unconfined HTTPS request answer" is NOT the discriminator, and
 *    saying so is worth the line: on a network that intercepts TLS the host's
 *    own request fails for a reason that has nothing to do with the child,
 *    which is what happened when this axis was re-measured.
 *    MEDIATED FORM: `hostApi.hostFetch`. Declaring the host does NOT help —
 *    the request never reaches the allow-list. NOT ASSERTED: the confinement
 *    suite says why in its own header — the macOS backend fences egress through
 *    a proxy and the Linux one through a namespace, so one probe would mean
 *    different things per platform, and an internet probe passes on an offline
 *    machine for the wrong reason. What would resolve it is a per-platform case
 *    that reaches a HOST-CONTROLLED listener rather than the internet.
 * 2. ELECTRON MAIN-PROCESS APIs — the `electron` specifier reached by ANY
 *    resolution path, in the plugin or in anything it loads: a static import,
 *    a bare `require`, a `require` held in a variable, a `createRequire`, a
 *    dynamic `import()`, or a dependency's re-export. Grepping for the literal
 *    `require("electron")` is how a check misses this axis — both first-party
 *    plugins that are ON it reach the specifier through a variable rather than
 *    that literal. A confined child has none:
 *    measured, `require("electron")` fails `MODULE_NOT_FOUND` while
 *    `process.versions.electron` in the SAME child still reports a version.
 *    That pairing is worth stating on its own, because it means a runtime
 *    check of "am I inside Electron" answers YES in a child that has no
 *    Electron API, and a plugin gated on it walks straight into the call.
 *    Vendoring the `electron` package does not restore it either: measured,
 *    its entry resolves to the binary PATH as a STRING, so `BrowserWindow` is
 *    `undefined` and a guard on it throws. The denial is NOT uniform across
 *    module systems, and the difference decides WHERE a plugin breaks:
 *    measured in the same child, `import("electron")` RESOLVES — to an inert
 *    namespace: `BrowserWindow` is `undefined` on the namespace AND its
 *    `default`, which is where a CJS module reached through the ESM resolver
 *    would carry the API, is an EMPTY object — while
 *    `import { BrowserWindow } from "electron"` fails to link at all with a
 *    `SyntaxError`. So a `require` plugin fails at resolution, an ESM plugin
 *    with a named import fails before it runs a line, and an ESM plugin that
 *    reads the namespace fails only once it CALLS. Three failure sites for one
 *    absent capability, which is why each form is asserted rather than one
 *    standing in for the others. MEDIATED FORM: only for the
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
 * 5. THE PROCESS'S OWN IDENTITY — the values a plugin reads OFF the process to
 *    decide where to put things: `os.tmpdir()`, the working directory, the home
 *    directory. This axis is about those values being DIFFERENT in a child, not
 *    about what the child may then do with them — that is axis 6, and the two
 *    are separated because a plugin can be broken by either one alone. The
 *    sandbox SUBSTITUTES the temp root and creates nothing, so a child's
 *    `os.tmpdir()` routinely does not exist. Measured against an absent path
 *    that is INSIDE the write jail: `readdirSync` and `mkdtempSync` fail
 *    `ENOENT` while a recursive `mkdir` on the same path succeeds — absence,
 *    not permission, which is what decides where a fix goes. The home directory
 *    is substituted the same way, with a throwaway the child is granted; the
 *    working directory is inherited from the host and is NOT writable, which is
 *    axis 6's answer rather than this one's. MEDIATED FORM: none is needed;
 *    `pluginDataDir` is granted and exists before the child starts, and that is
 *    where staging belongs. HOW TO CHECK A PLUGIN FOR IT: find every call that
 *    derives a path from `tmpdir()`, `homedir()` or `process.cwd()` and ask
 *    what happens when the answer names something that does not exist — an
 *    unguarded one in an activation body does not degrade a feature, it stops
 *    the plugin from loading.
 *
 * 6. FILESYSTEM REACH — every path the plugin touches that is not its own: a
 *    folder the user picked, an export dropped in a documents directory, a file
 *    beside the app, a directory inherited from a version of itself that
 *    predates `pluginDataDir`. This is the LARGEST capability the boundary
 *    removes, and it is removed ASYMMETRICALLY — reading and writing get
 *    different answers — so a plugin has to be measured for both. Getting the
 *    asymmetry backwards in either direction is a wrong admission: read it as a
 *    total jail and every plugin looks refused, read it as no jail and a plugin
 *    whose feature is writing somewhere the user chose looks admitted.
 *      WRITE is a real jail, but it is NOT the two paths this spawn names. It
 *    is those two — `pluginDataDir` and the throwaway sandbox HOME
 *    (`out-of-process-plugin.ts`, `spawnConfinedPluginChild`) — PLUS the
 *    default write paths ASRT merges into every wrap it builds. "Two" is a fact
 *    about the plugins listed here rather than about the spawn: the spawn grants
 *    the child's `envelope.write`, and none of the ids in
 *    `OUT_OF_PROCESS_PLUGIN_IDS` holds a row in `PLUGIN_ENVELOPE_GRANTS`, so for
 *    each of them that list is `pluginDataDir` alone. Routing a plugin that does
 *    hold a row makes this count wrong, and the count is what the outcomes below
 *    are written against.
 *      The merge is unconditional: `sandbox-manager.js` composes the
 *    allow-list as `[...getDefaultWritePaths(), ...userAllowWrite]`, so an
 *    ALLOW grant cannot subtract from it. A DENY grant can, which is the lever
 *    named at the end of this outcome list. READ OUT OF ASRT 0.0.73's
 *    `getDefaultWritePaths()`, the merged list is `/dev/stdout`, `/dev/stderr`,
 *    `/dev/null`, `/dev/tty`, `/dev/dtracehelper`, `/dev/autofs_nowait`,
 *    `/tmp/claude`, `/private/tmp/claude`, `<real home>/.npm/_logs` and
 *    `<real home>/.claude/debug` — and those last two are under the USER'S OWN
 *    home, not the substituted one. Measured through this spawn on macOS/arm64
 *    with the sandbox active: writes to `/tmp/claude`, `/private/tmp/claude`,
 *    `<real home>/.npm/_logs` and `<real home>/.claude/debug` all SUCCEEDED and
 *    the host read the bytes back afterwards, while a write to the real home
 *    itself — one level up from `.npm/_logs`, and not on that list — was
 *    refused `EPERM`.
 *      NOT `pluginRoot` — a plugin that could rewrite its own runtime root
 *    could rewrite the bytes its manifest hash was taken over; measured, the
 *    child READS `pluginRoot` and is refused `EPERM` writing into it. A path
 *    that is outside the two grants AND off ASRT's default list is refused
 *    `EPERM`, INCLUDING paths the plugin built out of values the HOST handed
 *    it: measured, a child given `context.hostRoot` receives it unchanged, and
 *    a `renameSync` out of a directory under it fails `EPERM` with nothing
 *    moved.
 *      The SECOND of the two named grants is a trap, and it does not look like
 *    one. The sandbox SUBSTITUTES `HOME`/`USERPROFILE` with that throwaway
 *    (`sandbox-process-home.ts`), so a plugin rooting its state at `homedir()`
 *    is neither denied nor durable: measured, the write returns SUCCESS, into a
 *    directory that is neither the user's home nor any durable path of the
 *    plugin's — and the same module `rmSync`s it when the child exits.
 *      So the write half has FOUR outcomes, not two and not three:
 *      (a) durable under `pluginDataDir` — where plugin state belongs;
 *      (b) refused with `EPERM` outside the grants and off ASRT's default list;
 *      (c) succeeding-then-vanishing under `homedir()`, which a source census
 *          reads as fine and which costs the user their state on every restart;
 *      (d) succeeding AND DURABLE outside both named grants, on one of ASRT's
 *          default write paths. (d) is the outcome this file previously said
 *          did not exist, and it is now asserted rather than described: a case
 *          writes into the substituted temp root — which is on that list — and
 *          the host reads the bytes back.
 *      (d) IS A HOLE, AND IT IS WORTH CLOSING. Two things follow from it that
 *    no manifest declares. First, those paths are SHARED: the jail this spawn
 *    builds is per-plugin, ASRT's defaults are per-machine, so two confined
 *    plugins reach the same directory. Measured and now asserted — one confined
 *    child wrote bytes under the substituted temp root and a second confined
 *    child, spawned with a different `pluginRoot` and `pluginDataDir`, read
 *    them back. That is a write channel between two plugins the boundary is
 *    supposed to keep apart, and it is also a channel out of a confined plugin
 *    into two paths under the user's real home that belong to other tools.
 *    Second,
 *    it means the check below cannot be "is this path one of the two grants".
 *      What closing it would take, and what it would cost, both measured here
 *    on macOS/arm64 rather than reasoned about: the lever exists —
 *    `confined-child.ts` already restates a write DENY floor on every wrap, and
 *    ASRT applies it as `denyWithinAllow`, which takes precedence. Adding
 *    `/tmp/claude`, `/private/tmp/claude`, `<real home>/.npm/_logs` and
 *    `<real home>/.claude/debug` to that floor turned all four writes above
 *    into `EPERM` while `pluginDataDir` kept working. The cost is the reason it
 *    is not done in this change: measured in the same child, `tmpdir()` was
 *    `/tmp/claude`, so the same edit also made
 *    `writeFileSync(join(tmpdir(), …))` fail `EPERM`.
 *    Closing (d) therefore needs a per-child temp root first — one inside the
 *    plugin's own grant — and that is a change to what a plugin child is
 *    handed, not a line in a deny list. Recorded here as an open defect with
 *    its lever and its blocker named, NOT fixed.
 *      READ is NOT a jail, and calling it one would be the same error facing
 *    the other way. ASRT's read model is deny-only (`asrt-sandbox.ts`,
 *    `getDefaultSensitiveReadDenyPaths`, which says so in its own header): a
 *    covering deny floor enumerates the KNOWN-sensitive subpaths — the host
 *    secret store, the credential stores it projects from
 *    `sensitive-paths.ts`, and the Electron userData directory that holds every
 *    installed plugin — and `allowRead` only RE-ALLOWS a region INSIDE that
 *    floor, which is why this spawn re-allows `pluginRoot` and `pluginDataDir`
 *    and why "cannot read another plugin's data directory" is true rather than
 *    aspirational. A path NOT on the floor stays readable. Both halves measured
 *    in ONE child: the secret file comes back `EPERM`, while a directory under
 *    `hostRoot` is listed SUCCESSFULLY — the child SEES the file it is then
 *    refused permission to move, which is what makes the refusal a write
 *    verdict rather than an empty directory.
 *      MEDIATED FORM: `hostApi.storage.*` for the plugin's own state — the wire
 *    DOES write files on a plugin's behalf, and deliberately cannot write them
 *    anywhere else: every member takes RELATIVE segments joined under
 *    `pluginDataDir`, and `plugin-storage-containment.ts` refuses an absolute
 *    path outright and refuses any join that escapes the root. So the write
 *    member is the same jail expressed as an API rather than a hole through it.
 *    For a path the USER chose there is no mediated form at all: no `hostApi`
 *    member opens a picker, and none accepts an absolute destination. So "put a
 *    file where the user asked" is not a marshalling gap a migration PR can
 *    close — it is the same shape as axis 2's windowing question, a host
 *    capability with its own consent story, and a plugin whose feature depends
 *    on it stays in-process until that exists.
 *      HOW TO CHECK A PLUGIN FOR IT: over its own sources AND its dependencies,
 *    find every filesystem WRITE — `writeFile`, `mkdir`, `rename`, `copyFile`,
 *    `rm`, a stream opened for writing, a library given an output path — and
 *    read what its path is rooted at. Then sort each root into the FOUR
 *    outcomes above, because three of them are not `EPERM`:
 *      · rooted at `pluginDataDir` → durable, and the only one that is;
 *      · rooted at `homedir()` → succeeds and vanishes at exit. Check for this
 *        one BY NAME; it is the case that passes;
 *      · on ASRT's default write list — `/tmp/claude`, `/private/tmp/claude`,
 *        `<real home>/.npm/_logs`, `<real home>/.claude/debug`, the `/dev`
 *        entries, and anything derived from `tmpdir()`, which the sandbox
 *        points AT that list → succeeds and is durable, in a directory shared
 *        with every other confined plugin. Check this one by name too: it is
 *        the second case that passes, and the one that makes "an absolute
 *        literal is refused" a WRONG rule to check by;
 *      · anything else — `context.hostRoot`, `process.cwd()`, an absolute
 *        literal off that list, a path out of the plugin's own config, a
 *        picker's return value → refused `EPERM`.
 *    So the question is not "is this path absolute" and not "is it one of the
 *    two grants". It is which of the four roots it has, and two of the four
 *    are silent. Then drive the ones you find in a real confined child, because
 *    a refusal arrives as a runtime `EPERM` the plugin's own error handling may
 *    swallow — a one-time migration that used to succeed silently now throws,
 *    and a census of sources cannot tell you which. Reads need the reverse
 *    question, and only for the floor: does it read a secret store, another
 *    plugin's data, or the userData directory.
 *    ASSERTED: in both directions, by `confined-plugin-child.test.ts`, and on
 *    the machines the header names rather than everywhere — the secret read
 *    refused beside `pluginDataDir` read AND written, a fixture path outside
 *    the allow set refused, the legacy session move listed-then-refused with
 *    nothing moved and the original still in place, the `homedir()` write
 *    succeeding into the throwaway, and the durable write into the shared
 *    default path with a second confined plugin's child reading it back.
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
 *   runtime dependencies. On axis 6 its production sources carry three
 *   filesystem writes in total — a `mkdir`, a `writeFile` and the `rename`
 *   that commits it, all in one function — and every one of them is rooted at
 *   `context.pluginDataDir`. `context.hostRoot` appears in its tests only. Its tools are driven end-to-end through a real confined child.
 *   ASSUMED: nothing load-bearing.
 *
 * `meeting` — REFUSED, and this is the measured answer rather than an
 *   oversight. KNOWN: its primary tool opens a floating recorder window and
 *   reaches `BrowserWindow`, `screen`, `session.fromPartition` and `ipcMain`
 *   through one lazily-resolved `require` of the `electron` specifier held in
 *   a VARIABLE — not the literal, which occurs in its sources only inside
 *   comments and in a renderer preload that is not on this axis at all. In a
 *   confined child that require is `MODULE_NOT_FOUND`, so the tool's own
 *   pre-flight guard throws before it
 *   side-effects — measured, both bare and with the package vendored beside
 *   the plugin. Axis 2 has no mediated form for any of those members, so
 *   admitting it would not degrade recording, it would END it. KNOWN also, and
 *   independently sufficient: its `createPlugin` sweeps `os.tmpdir()`
 *   unguarded in its activation body — not behind a `try`, not deferred to a
 *   tool call, so it runs on every load — and on a machine where the
 *   substituted temp root is absent (axis 5) the `ENOENT` escapes activation
 *   and the plugin does not load at all — no tools, no UI entry. KNOWN also,
 *   and on axis 6: the same activation body carries a one-time move of a
 *   session directory it once kept under `context.hostRoot` into
 *   `pluginDataDir`, and `hostRoot` is outside the child's write jail. The move
 *   is a per-file `renameSync`, also unguarded, so on an install that still
 *   holds un-migrated files there — the only state the plugin's own
 *   `existsSync` guard lets reach the move — the `EPERM` escapes activation the
 *   same way the `ENOENT` does. Measured through a real child: the child LISTS
 *   that directory successfully and is then refused the rename, with nothing
 *   moved and the original left in place. That is the axis-6 failure in its
 *   most expensive form — not a degraded feature but the user's existing
 *   recordings stranded behind a plugin that will not start. And its media
 *   runtime auto-install reaches the network over `node:https` directly (axis
 *   1) and executes a staged binary (axis 3). The transcription path is the
 *   one part that is already mediated: it goes through `hostApi.hostFetch` and
 *   refuses to run without it. ASSUMED: nothing — the window, temp-root and
 *   legacy-move blockers were driven through a real child, and the egress and
 *   spawn ones read directly out of its sources. What would change the answer is a mediated
 *   form for axis 2, which is a design question this file does not settle;
 *   the shape it would have to take is written up beside the design's Stage 8.
 *
 * `ep-api` — REFUSED. KNOWN FROM ITS SOURCES: every one of its REST clients reaches the network
 *   through the global `fetch`, and no code path in it CALLS
 *   `hostApi.hostFetch` — the name occurs in its sources exactly once, in a
 *   comment observing that a browser process cannot be brokered by it.
 *   One flow drives a browser the plugin launches itself, which would be a
 *   grandchild of the confined child and inherit its fence (axes 1 and 3).
 *   On axis 6 its OWN sources are clean — they open no file for writing at
 *   all, and its session state goes through the wire.
 *   ASSUMED: that nothing else in it touches axes 2 or 4 — its sources name
 *   neither, but the browser driver it depends on has not been measured inside
 *   a child — and that the browser it launches writes a profile directory of
 *   its own, which as a grandchild would land inside the same write jail
 *   (axis 6). That last one is a dependency's behaviour rather than the
 *   plugin's, and it is why axis 6 has to be read over dependencies too. What it needs first, in order: its HTTP clients call
 *   `hostApi.hostFetch` rather than `fetch` (its manifest already declares the
 *   capability and the hosts, which is what that path is checked against); the
 *   browser-driven flow gets an answer that is not "the plugin launches a
 *   browser"; and the reach is measured again over both sets.
 *
 * `local-indexer` — REFUSED. KNOWN FROM ITS SOURCES: it operates its own loopback HTTP listener
 *   and its own upstream TLS client as a broker, holds a control channel over
 *   a unix socket, and calls `execFile` on a shell interpreter to resolve a
 *   drive mapping. The indexing work itself is the one part of axis 3 that is
 *   already mediated: it reaches `hostApi.spawnWorker` at a SINGLE call site,
 *   and THROWS rather than starting when that member is absent — so what is
 *   unmediated on this axis is the `execFile`, not the worker. The name occurs
 *   many more times than that in its sources, in comments, a type, a guard and
 *   a bind; counting those as reach is the grep-for-a-census error this
 *   comment is about, which is why a check counts CALL SITES and not mentions.
 *   The broker's upstream leg is exactly the direct egress axis 1
 *   measures a child as not having, so the broker would stop at its first
 *   request. It is also on axis 2, which no `hostApi` census would have
 *   surfaced: its folder picker reaches `dialog` through a `require` of the
 *   `electron` specifier held in a VARIABLE — the construct axis 2 says a
 *   literal grep misses, and the same one the windowed plugin reaches it by —
 *   and `dialog` has no mediated form either. It is on axis 6 more heavily than any other plugin
 *   here, and in both directions: it writes its index state under a path
 *   rooted at `homedir()` rather than `pluginDataDir`, it carries its own
 *   `hostRoot`-rooted workspace migration, and its whole PURPOSE is reading
 *   folders the user chose. Those three land on three DIFFERENT outcomes of
 *   the four the axis names: the scanned folders keep
 *   working, because a folder the user picked is not on the deny floor and
 *   reading is not jailed; the `hostRoot` migration is refused `EPERM`, and it
 *   sits inside a `catch` that logs and continues, so it fails quietly; and
 *   the `homedir()`-rooted index state SUCCEEDS into the substituted HOME that
 *   is deleted when the child exits — an index that reports itself written and
 *   is empty again on the next start. ASSUMED: whether `spawnWorker`'s
 *   confinement envelope can carry that worker at all, and whether the
 *   worker's own egress — which is not the plugin's — has any mediated form. Both are open
 *   questions rather than wiring, and they are why this id is also the
 *   in-process counter-example the routing tests use.
 *
 * `ms-graph` — REFUSED, and the refusal is a measurement overturning what this
 *   comment used to assume. Its three open assumptions have now been driven
 *   against the real bundle and the real jail. Two held: no transitive
 *   dependency loads a native module (axis 4) — the bundle's only `.node`
 *   token is the string `"msal.js.node"`, an SKU label in a telemetry header —
 *   and its `ui[]` entry is renderer-loaded, which is not a property of this
 *   plugin at all but a host invariant every `ui[]` entry shares, so it could
 *   never have distinguished a candidate from a refusal.
 *
 *   The third is FALSE, and it is disqualifying. The assumption was that the
 *   auth library "opens no socket of its own outside the injected client".
 *   The injected client replaces EGRESS. Interactive sign-in does not use it:
 *   `acquireTokenInteractive` resolves `customLoopbackClient || new
 *   LoopbackClient()`, and `@azure/msal-node`'s `LoopbackClient` imports
 *   `node:http` and, in its own words, "spins up a loopback server" to catch
 *   the `localhost` redirect. `ms-graph` calls `acquireTokenInteractive` at
 *   four sites and passes no custom client at any of them. So the earlier
 *   census was measuring the wrong socket: the mediated one, not the one the
 *   sign-in flow actually binds.
 *
 *   What confinement does with that bind is worth stating, because the two
 *   platforms fail in different shapes and neither fails usefully. On macOS
 *   the Seatbelt profile emits `network-bind` only under ASRT's
 *   `allowLocalBinding`, which this app never sets, so `listen()` is refused
 *   outright. On Linux the child always runs under `--unshare-net`, so
 *   `listen()` SUCCEEDS — into a private loopback the user's browser is not
 *   in. The redirect then goes to the host's 127.0.0.1, nothing is listening
 *   there, and the flow hangs AFTER the user has already entered credentials.
 *   A refusal that arrives post-authentication as a hang is worse than one
 *   that arrives as an error, which is why this is a refusal and not a
 *   configuration knob: admitting the id would trade a working sign-in for a
 *   silent one.
 *
 *   Its axis-6 defect is separately FIXED (0.3.47): the activation-time move
 *   of a stored file out of a `context.hostRoot`-rooted path into
 *   `pluginDataDir` no longer sits in a `catch` that discards the error, and
 *   no longer clobbers a newer file when both exist. That was the half of the
 *   census a source read could see. It is not what blocks the id.
 *
 *   The admission precondition is therefore no longer a set of measurements —
 *   it is one architectural change: the loopback listener for interactive
 *   sign-in has to live on the host side of the wire, either as a host-owned
 *   redirect catcher handed to MSAL as `customLoopbackClient`, or by moving
 *   interactive acquisition behind `hostApi` entirely. Until one of those
 *   exists, this id stays out.
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
