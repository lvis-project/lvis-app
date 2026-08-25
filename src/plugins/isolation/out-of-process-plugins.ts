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
 *
 *    THE OTHER DIRECTION — INBOUND. The heading says egress, and for a long
 *    time this axis only asked what a child could reach. It also has to ask
 *    what can reach the child, because a plugin that CATCHES a redirect needs
 *    a listener, and a listener needs a bind. That is not egress and no amount
 *    of egress measurement finds it: `ms-graph` was carried as a candidate
 *    precisely because its egress was mediated, while the socket its sign-in
 *    actually opens was never looked at.
 *    A confined child does NOT get a usable loopback listener, and the two
 *    backends refuse in shapes that are not interchangeable — asserted
 *    per-platform in the confinement suite rather than flattened, because the
 *    difference IS the result. On macOS the Seatbelt profile emits
 *    `network-bind` only under ASRT's `allowLocalBinding`, which this app never
 *    sets, so `listen()` fails `EPERM`. On Linux the child always runs under
 *    `--unshare-net`, so `listen()` SUCCEEDS into a loopback nothing else is
 *    in; the failure moves from the bind to whoever tries to reach it, and in a
 *    real sign-in that is after the user has already entered credentials. The
 *    Linux case is therefore asserted from the HOST side — the only vantage
 *    point that can tell a bind apart from a reachable bind.
 *    MEDIATED FORM: `hostApi.authRedirect` — a host-owned loopback listener for
 *    ONE OAuth authorization-code redirect (`open`/`wait`/`close`). The host
 *    binds `127.0.0.1:0`, answers the redirect with a page of its OWN, and
 *    returns the query parameters alone. The plugin chooses when to open, when
 *    to stop waiting, and when to close; it does not choose the interface, the
 *    port, the accepted method or the response body, and the handle is bound to
 *    the calling plugin the same way an auth partition is. That covers the
 *    inbound shape a sign-in needs.
 *    SECOND MEDIATED FORM, for the shape `authRedirect` does not cover — an
 *    inbound listener a plugin operates as a SERVER, which is what a broker
 *    with its own upstream leg needs: `context.pluginSocketDir`, one directory
 *    per plugin in which the child may bind a UNIX-DOMAIN socket. It answers
 *    the axis by leaving it: a Unix socket is a filesystem object, so the
 *    macOS refusal and the Linux namespace both stop applying, and the process
 *    on the other end connects by PATH rather than by port. The host registers
 *    that directory with ASRT BEFORE wrapping the child, because the ALLOW is
 *    a shared-config entry the seatbelt profile is generated from — measured
 *    both ways: the bind succeeds and the HOST reaches the socket, and the
 *    same bind one directory over, in the writable `data` dir the host did not
 *    register, is refused `EPERM`.
 *    What it does NOT answer is the broker's UPSTREAM leg, which is ordinary
 *    egress and is covered above.
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
 *    sandbox SUBSTITUTES the temp root, and it is now THIS APP'S:
 *    `useAppOwnedSandboxTempRoot` publishes `~/.lvis/sandbox/tmp` through the
 *    variable ASRT reads, from the wrap path itself rather than from a boot
 *    step a caller could skip, and creates it `0o700`. A confined child's
 *    `os.tmpdir()` therefore now names a directory that EXISTS and that the
 *    confinement primitive grants for writing. Before, it named ASRT's
 *    `/tmp/claude`, which ASRT creates nothing for. Measured against an absent path
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
 *    about SOME of the plugins listed here rather than about the spawn: the
 *    spawn grants the child's `envelope.write`, and for an id with no row in
 *    `PLUGIN_ENVELOPE_GRANTS` that list is `pluginDataDir` alone. That is
 *    `work-assistant` and `ms-graph`. It is NOT `local-indexer`, which is the
 *    one id that holds a row, and the outcomes below are read against it with
 *    that difference in mind: its write list is `pluginDataDir` plus whichever
 *    of `indexStorageRoot` and `workspace` the user has pointed outside it, and
 *    its read list additionally carries `~/.lvis/runtime` (the provisioned
 *    Python) and `~/.lvis/certs` (the corporate CA, which the deny floor
 *    otherwise covers). Neither addition changes WHICH outcomes exist — (b)
 *    still refuses everything outside the grants — only where the line between
 *    (a) and (b) falls for that one plugin. A future admission that also holds
 *    a row has to be read the same way rather than against the two-path
 *    sentence this paragraph used to state unconditionally.
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
 *      (d) WAS A HOLE, AND THE CROSS-APPLICATION HALF IS NOW CLOSED. Those
 *    paths are per-MACHINE while the jail this spawn builds is per-plugin, so
 *    before the fix two confined plugins reached the same directory — measured,
 *    one confined child wrote bytes under the substituted temp root and a
 *    second, spawned with a different `pluginRoot` and `pluginDataDir`, read
 *    them back — and so did every OTHER ASRT consumer on the machine: a
 *    confined plugin child listed 141 entries under `/tmp/claude` that were not
 *    this app's.
 *      `getDefaultSensitiveWriteDenyPaths` now carries `/tmp/claude`,
 *    `/private/tmp/claude`, `<real home>/.npm/_logs` and
 *    `<real home>/.claude/debug`; ASRT applies the floor as `denyWithinAllow`,
 *    which takes precedence over its own defaults. ASSERTED, with an EXISTENCE
 *    control beside the `~/.npm/_logs` case — a write to a missing directory
 *    also fails, and a case that accepted any failure would go green on a
 *    machine that simply has no npm cache. Only `EPERM` beside a directory that
 *    IS there says refused.
 *      What made it possible was doing the temp root FIRST. The blocker
 *    recorded here was real: ASRT pointed `TMPDIR` AT that list, so denying it
 *    also broke every `writeFileSync(join(tmpdir(), …))` in every confined
 *    child. The mechanism the earlier note could not name is
 *    `CLAUDE_CODE_TMPDIR`, which ASRT reads from the WRAPPING process rather
 *    than from a per-command option — which is exactly why the other half is
 *    still open.
 *      WHAT REMAINS. The temp root is one directory for ALL of this app's
 *    confined children, so every admitted plugin meets every other one in it —
 *    four of them now, and the channel widens with each admission rather than
 *    staying the size it was when it was written down. Narrower than it was,
 *    and still a channel neither manifest declares. Closing it needs a root per
 *    CHILD, and because ASRT takes the value from the wrapping process's
 *    environment that means mutating `process.env` around an `await` on the
 *    spawn path — a concurrency hazard on a security boundary, which is why
 *    this stopped here rather than going one step further quietly.
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
 * `work-assistant` — ADMITTED. KNOWN FROM ITS
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
 * `meeting` — ADMITTED. Its last axis closed in plugin 0.7.0; the entry is
 *   rewritten rather than annotated, because a census that lists fixed
 *   blockers reads as a plugin with problems.
 *
 *   AXIS 2, the one that held it, is closed by a MEDIATED FORM rather than by
 *   the feature going away. The recorder opened a floating window it built
 *   itself — `BrowserWindow`, `screen`, `session.fromPartition` and `ipcMain`,
 *   all through one lazily-resolved `require` of the `electron` specifier held
 *   in a VARIABLE, which is why a literal grep never found it. It is a SLOT in
 *   the host's dock now (`hostApi.attachFloatingPanel`), and the plugin's
 *   sources resolve `electron` by no path at all: `createRequire` is gone with
 *   its only consumer.
 *
 *   That trade is the shape this boundary wants, and it is worth naming as a
 *   REDUCTION rather than a swap. What the plugin gave up is not the ability
 *   to float a surface — it kept that — but the ability to CHOOSE the
 *   surface's geometry. Frameless, transparent, always-on-top, where on the
 *   screen it sits and how large it may grow are the host's, and none of them
 *   is a parameter. A borderless always-on-top window a plugin places and
 *   sizes freely is a clickjacking primitive; the same pixels inside host
 *   chrome at host-chosen coordinates are not.
 *
 *   The other five, each re-measured against the plugin's sources at 0.7.0
 *   rather than read out of the entry that claimed them:
 *   - Axis 1. No `node:https`/`http`/`net`/`tls`/`dgram`, no socket library,
 *     no bare `fetch`. The media-runtime download goes through
 *     `hostApi.hostFetch` with both hosts of the release redirect declared.
 *   - Axis 3. No `node:child_process` in any form; every process start,
 *     including the eleven the runtime installer makes, goes through
 *     `hostApi.spawnWorker` with named grants. The plugin guards this with an
 *     import-form test, which is the only thing that would notice — ASRT's
 *     profile carries `(allow process-exec)`, so a reintroduced spawn would
 *     RUN rather than fail.
 *   - Axis 4. No native binding, no `.node`, no `bindings()`. The
 *     `electron-audio-loopback` vendor is referenced in one comment and loaded
 *     nowhere: the host captures and the plugin receives PCM through
 *     `startAudioCapture`.
 *   - Axis 5. No `tmpdir()`, no `cwd()`, no `homedir()`. The `process.env`
 *     reads that remain are configuration lookups, which the boundary does not
 *     take away.
 *   - Axis 6. Every write lands under `pluginDataDir` — the runtime install
 *     included, which derives its staging and cache directories from the same
 *     root. `context.hostRoot` is READ once, for a one-time session migration
 *     that copies and then attempts a delete, collecting what it could not
 *     remove and reporting it. A write jail therefore costs the user nothing
 *     but a duplicate directory that gets NAMED, and the plugin still starts.
 *
 *   ASSUMED: nothing about the plugin. One thing about the wire, stated
 *   because it is the newest path here and the only one this plugin is the
 *   first to use: `attachFloatingPanel` returns a handle, and a handle is a
 *   host-side object the child holds a receipt for. Releasing the receipt IS
 *   the detach, since the wire carries no per-handle call channel; `resize`
 *   needs an answer back and so is its own addressable member. Both directions
 *   are asserted in `host-api-service-members.test.ts`, including that a late
 *   `onDetached` subscriber is told the REASON the slot went away rather than
 *   a fabricated one — a recorder told `"requested"` after the USER closed the
 *   dock concludes the teardown was its own and leaves the recording running
 *   with nothing driving it.

 * `ep-api` — REFUSED, on ONE thing: ONE of its flows drives a browser.
 *
 *   THE EGRESS SENTENCE THAT USED TO OPEN THIS ENTRY CONTRADICTED THE ENTRY,
 *   which is a worse failure than being out of date. It said every REST client
 *   reached the network through the global `fetch` and that `hostApi.hostFetch`
 *   occurred in the sources exactly once, in a comment — while a paragraph
 *   forty lines below recorded the migration as DONE at plugin 0.18.7. A
 *   reader who stopped at the first sentence, which is what an opening
 *   sentence is for, would go and redo finished work.
 *
 *   Re-measured at plugin 0.19.2 so the top of the entry states the same fact
 *   as the bottom: `hostFetch` is CALLED from seven files, and the seven
 *   remaining bare `fetch(` sites are all inside `page.evaluate` bodies — the
 *   browser's egress, not this plugin's. The counts below are from 0.18.7 and
 *   have moved since; where they differ, both were true when taken.
 *
 *   MEASURED at 0.19.2, over the plugin's own sources: axis 2 names `electron`
 *   nowhere and has no `createRequire`; axis 3 has no `child_process`; axis 4
 *   has no `bindings()` and no `.node`; axis 5 has no `tmpdir`, `cwd` or
 *   `homedir`; axis 6 opens no file for writing at all — no `writeFileSync`,
 *   `mkdirSync`, `renameSync` or `createWriteStream` — and its session state
 *   goes through the wire.
 *
 *   So the plugin's own code is clean on every axis. What is not clean is what
 *   it imports, and THAT is now measured too rather than assumed. The previous
 *   entry assumed "nothing else touches axes 2 or 4" and noted the browser
 *   driver had never been measured inside a child. Measured in
 *   `playwright-core` 1.59:
 *     - Axis 4 is CLEAN. There is no native binary in the package at all —
 *       `find -name '*.node'` returns nothing. Half the old assumption closes
 *       as a pass.
 *     - Axis 2 is CLEAN. It does not reach Electron.
 *     - Axes 1 and 3 are NOT, and not in the indirect way the old entry
 *       described. It framed the problem as "the browser it launches would be
 *       a grandchild and inherit the fence". The DRIVER needs them directly:
 *       `require("net")` in 12 files, `http` in 4, `https` in 4, `tls` in 5,
 *       and `require("child_process")` in 11, with spawn/execFile/fork in 6.
 *       That runs IN the child, not in a grandchild.
 *
 *   The distinction matters because it kills the obvious workaround. If only
 *   the grandchild were fenced, a host-launched browser plus
 *   `connectOverCDP` would look like a way out. It is not: the CDP transport
 *   is itself a socket the driver opens from inside the child.
 *
 *   ASSUMED, still: the profile directory. The browser writes a
 *   `userDataDir` the plugin names, which as a grandchild would land inside
 *   the same write jail (axis 6). That is a dependency's behaviour rather
 *   than the plugin's, and it is why axis 6 has to be read over dependencies
 *   too. It is moot while axes 1 and 3 refuse first.
 *
 *   HOW THE EGRESS HALF WAS SETTLED, kept because the reasoning is what makes
 *   the current state legible. Its first prerequisite used to be written here
 *   as plugin work — "its HTTP clients call `hostApi.hostFetch` rather than
 *   `fetch`", with the manifest already carrying the capability and the hosts.
 *   Measuring it found that sentence wrong at the first step: the work is not the plugin's, and doing
 *   it would break the flows it touches. Two INDEPENDENT reasons, either one
 *   sufficient:
 *
 *     - Scheme. Its endpoints are `http://` intranet hosts. The guard is
 *       https-only for everything but loopback, so every one of those requests
 *       is denied `non-https` before the allow-list is even consulted.
 *     - Redirect. All five of its REST clients read redirects: ten sites ask
 *       for `manual` so a 302 to the SSO login can be recognised as an expired
 *       session and reported as one, and ten more need `follow` for
 *       same-origin and http→https bounces. (An eleventh `follow` sits inside
 *       a `page.evaluate` body, which is the browser's egress and not this
 *       plugin's — the same distinction that keeps its other eleven `fetch`
 *       calls out of this count entirely.) The chokepoint pins `redirect` to
 *       `"error"`, and unpinning it would not be enough: `hostFetch` runs on
 *       Electron's `net.fetch`, which cannot return a 3xx at ALL. Measured
 *       against a local redirecting server — `manual` throws "Redirect was
 *       cancelled", `error` throws, and only `follow` returns, having already
 *       followed the hop without the guard seeing it. Node's own `fetch`,
 *       which is what these clients use today, returns the 302 with `location`
 *       readable; that difference is the whole reason they work now.
 *
 *   The redirect half is now BUILT (#2245): the transport under `hostFetch` is
 *   `createSingleHopFetch` — `net.request({ redirect: "manual" })`, whose
 *   `redirect` event carries the status, the resolved next URL and the
 *   response headers, materialized as an ordinary Response instead of followed
 *   or thrown. `runHostFetchHops` reads the plugin's own `init.redirect`:
 *   `"manual"` returns the 3xx (an SSO bounce becomes a reportable expired
 *   session), `"follow"` follows up to a capped hop count with the COMPLETE
 *   egress gate re-run before every hop — strictly stronger than what
 *   `net.fetch` offered, where a followed hop was a request no gate ever saw —
 *   and the default stays a refusal. Chromium's stack throughout, so the
 *   proxy/PAC/OS-trust properties `net.fetch` was chosen for are kept.
 *
 *   The scheme half is DECIDED and BUILT too (#2247, closing #2245): the user
 *   ruled cleartext to the intranet permitted, and the gate now allows http
 *   exactly when the host is allow-listed, the manifest opts into
 *   `allowPrivateNetworks`, and every resolved address proves
 *   private-or-loopback — one public answer, the metadata range, or an
 *   unresolvable name stays denied, per hop included. This plugin's manifest
 *   already declares both the hosts and the opt-in, so NO host work blocks it
 *   any more. The first item of the census's stated order is DONE as well:
 *   its five Node-side REST call sites route through a bound
 *   `hostApi.hostFetch` (plugin 0.18.7 — with `redirect: "manual"` where an
 *   SSO bounce is read as an expired session; the eleven `fetch` calls
 *   inside `page.evaluate` bodies are the browser's and stay). What remains
 *   for admission is the tail of that order: the browser-driven flow gets an
 *   answer that is not "the plugin launches a browser"; and the reach is
 *   measured again over both sets.
 *
 *   WHAT "THE BROWSER-DRIVEN FLOW" ACTUALLY IS, measured at plugin 0.19.6 and
 *   written down because this entry's own headline reads as more work than is
 *   left. "It drives a browser" was inferred from `evaluate` counts, and a
 *   count does not say whether the call sites sit on a REACHED path. Read per
 *   flow instead of per grep, three of its four clients were already REST on
 *   the path a user takes, with the browser behind them as a fallback:
 *
 *     - The parking client runs fetch + parse-the-returned-form + POST as its
 *       PRIMARY path for all three operations. Every `evaluate` in that file
 *       is inside a legacy function reached only when the direct path
 *       declines. Its read half was checked against the live provider rather
 *       than argued from the source, and each direct step returned what the
 *       parser expects.
 *     - The conferencing client already submitted directly; only its dry run
 *       opened a browser, to fill a form it then discarded, and it stopped
 *       (0.19.5). The `evaluate` sites left in that file are its cancel path's.
 *     - The assistant client opens no browser at all as of 0.19.11, and the
 *       route there corrected this entry twice. A browser-free query answered
 *       the plain case over four REST calls (0.19.3), and an expired session
 *       stopped buying a launch (0.19.6) — the page flow re-ran the same
 *       session check against the same vault cookies and threw the same
 *       error, so the launch only delayed it.
 *
 *       This entry then said a SCOPED question still needed a page. That was
 *       wrong, and wrong in the direction that costs the most: it named an
 *       observation as the next step. The public handler exposes no scope
 *       parameter, and every page context was created blank, so the page had
 *       never answered a scoped question — there was no way to ask it one.
 *       The observation would have unblocked nothing.
 *
 *       What actually kept the page was narrower: a stream that arrived and
 *       the plugin's parser did not recognise. The page renders the same
 *       stream through the vendor's own renderer, so a vendor payload change
 *       would have been an outage rather than a bug. Answered directly
 *       (0.19.11) — the parser takes a second pass over events not labelled
 *       as model output, since a renamed event type is exactly that failure
 *       and the FIELD NAMES identify an answer. It does not extend the same
 *       tolerance to a bare token field: that field is overloaded in this
 *       payload and an auth event carries one, so an unguarded pass would
 *       assemble a reply out of a credential.
 *
 *       With that, the whole DOM prompt flow went: 3142 -> 1012 lines, 19
 *       `evaluate` -> 0, no browser driver imported. Its token refresh moved
 *       to mediated REST in the same change; the page had been there for one
 *       capability, reading web storage, and nothing replaces that rung
 *       because inventing a value would rotate a token against a principal
 *       never confirmed. An unresolved token throws into the auth ladder's
 *       existing re-login step — slower, never wrong.
 *
 *   So the tail is ONE flow, not four clients: the conferencing client's
 *   CANCEL. Not its list read, which is a fetch-and-parse with the browser
 *   behind it — the mutation itself. And it is a genuine blocker rather than
 *   unfinished migration: that code does not KNOW the cancel endpoint. It
 *   navigates to the detail page, clicks whatever reads as a cancel control,
 *   and recognises success by watching for a request URL matching a pattern.
 *   A contract discovered at runtime cannot be reimplemented from the source.
 *
 *   Two ways to settle it, and they cost very differently. Reading the detail
 *   page's cancel control and the handler behind it yields the endpoint and
 *   its body with NO mutation performed — the same read-only technique that
 *   already produced two other form contracts here. Recording a real
 *   cancellation is the fallback if that handler turns out to be opaque, and
 *   that one is a decision for the operator rather than a measurement.
 *
 *   ALSO REMOVED, 0.19.7: an interactive-login helper and a session probe,
 *   and with them the persistent-profile launch mode and the `userDataDir`
 *   input. Nothing called any of it — login had moved to `openAuthWindow` and
 *   these were left pointing at nothing. Recorded here because admission is
 *   measured over what a plugin CAN reach: an uncalled persistent browser
 *   profile is still a filesystem-and-process capability sitting in the
 *   module, and it would have had to be accounted for on axes 3 and 6 anyway.
 *
 * `local-indexer` — ADMITTED, and the entry is kept long because the route to
 *   it corrected this file twice. KNOWN FROM ITS SOURCES at the first census:
 *   it operated its own loopback HTTP listener and its own upstream TLS client
 *   as a broker, held a control channel over a unix socket, and called
 *   `execFile` on a shell interpreter to resolve a drive mapping. The name
 *   `spawn` occurs many more times than that in its sources — in comments, a
 *   type, a guard and a bind — and counting those as reach is the
 *   grep-for-a-census error this comment is about, which is why a check counts
 *   CALL SITES and not mentions.
 *
 *   AXIS 2 — the folder picker reached `dialog` through a `require` of the
 *   `electron` specifier held in a VARIABLE, the construct a literal grep
 *   misses. `hostApi.pickFolders` replaced it and the plugin USES it (0.5.37).
 *   Measured in the BUILT BUNDLE: `electron` survives only inside a comment,
 *   and `createRequire` only as the bundler's own interop banner.
 *
 *   AXIS 1, INBOUND — the broker bound loopback TCP, which is the half of axis
 *   1 a child cannot do at all: refused on macOS, and on Linux succeeding into
 *   a namespace nobody outside is in. `context.pluginSocketDir` gave it a
 *   directory the host registers with the sandbox before the spawn, and the
 *   broker binds `egress.sock` there (0.5.38). The worker reaches it with
 *   `httpx.HTTPTransport(uds=...)`, so the provider SDK's own pool never opens
 *   a TCP socket; `--egress-broker-url` still crosses because those SDKs insist
 *   on parsing an authority, but it now carries one with no port. The TCP
 *   branch is still IN the bundle and is dead: its one construction site always
 *   passes `{kind:"uds"}`. Bundled and reachable are different questions, and
 *   only the second decides admission — the same distinction MSAL's
 *   `LoopbackClient` needed below.
 *
 *   AXIS 5 — this is the correction worth keeping. The entry used to name only
 *   the index state written under a `homedir()`-rooted path, which is the
 *   WRITE case, and the write case is the one the substituted HOME handles
 *   correctly by design. What it missed is that five other sites read
 *   `homedir()` as path POLICY: `isBlockedIndexPath`, `isHomeChild`,
 *   `isOtherUserHome` and `isHighChurnFolderPath` judge paths the USER dropped
 *   or typed, against the user's home. In a confined child every one of them
 *   returns `false` — `~/.ssh` is not under the throwaway — while still
 *   reporting that it checked. That is a worse failure than the one this entry
 *   did name, because nothing reports it. `context.userHome` and
 *   `context.lvisHome` answer both, and the plugin takes an `IndexPathPolicy`
 *   whose `userHome` is REQUIRED with no default, so the compiler names every
 *   site rather than a reader having to remember them (0.5.39). What the deny
 *   floor still covers regardless is worth stating, because it bounds what a
 *   PRE-0.5.39 install could reach if one is present: the floor's `home` rows
 *   are anchored host-side to the REAL home, so `.ssh`, `.aws`, `.gnupg`,
 *   `.npmrc` and the secret parts of `~/.lvis` are refused by the kernel even
 *   when the plugin's own blocklist has gone quiet. The residue is `/etc`,
 *   `/usr` and the non-secret parts of the home — load and noise rather than
 *   credentials.
 *
 *   AXIS 3 — `hostApi.spawnWorker` was always the mediated form for the
 *   indexing work, at a SINGLE call site that THROWS rather than starting when
 *   the member is absent. What was unmediated was the `execFile` on
 *   `powershell.exe` that resolved which UNC path a mapped drive points at.
 *   `hostApi.resolveMappedDriveRoot` replaced it (0.5.40): the plugin supplies
 *   a drive letter, the host supplies the command. Its old body ended `catch {
 *   return null }`, and `null` already meant "ordinary local disk" — so a
 *   refused spawn was indistinguishable from a local drive and the allowed-root
 *   list came out silently short. This axis needs a STRUCTURAL check rather
 *   than a runtime one, and the plugin now carries one: the Seatbelt profile
 *   ASRT generates contains `(allow process-exec)`, so a reintroduced spawn
 *   does not fail — it runs, inside the same jail, and the confinement argument
 *   stops being true with nothing going red.
 *
 *   AXIS 6 — the plugin is on it more heavily than anything else here, and in
 *   both directions: it writes its index state, it carries a `hostRoot`-rooted
 *   workspace migration, and its whole PURPOSE is reading folders the user
 *   chose. Those land on three DIFFERENT outcomes of the four the axis names.
 *   The scanned folders keep working — a folder the user picked is on no deny
 *   floor and reading is not jailed. The `hostRoot` migration is refused
 *   `EPERM`, and the plugin now says so: the `catch` logs the path and states
 *   that the index rebuilds from scratch, which is true because what the legacy
 *   directory held is the incremental-scan ledger and worker scratch, all of it
 *   REBUILDABLE. And the index state no longer roots at `homedir()` — the
 *   constructor requires the path, which closed the outcome where a write
 *   SUCCEEDS into the substituted HOME and the index reports itself written and
 *   is empty again on the next start.
 *
 *   AXIS 4 — no native module. The built bundle's `.node` token count is zero.
 *
 *   MEASURED through THIS FILE'S production spawn, on macOS with the sandbox
 *   active (`confined-plugin-child.test.ts`): a child gets `context.userHome`
 *   equal to the host's `homedir()` while its OWN `homedir()` is not — the pair
 *   is the evidence, since the first assertion alone would pass if the
 *   substitution had quietly stopped and the second alone would pass if the
 *   host had handed over the throwaway — and `hostApi.resolveMappedDriveRoot`
 *   crosses the wire and comes back as an answer, with the host recording that
 *   it was the one asked.
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
 *   the `localhost` redirect. `ms-graph` calls `acquireTokenInteractive` and
 *   passes no custom client. So the earlier census was measuring the wrong
 *   socket: the mediated one, not the one the sign-in flow actually binds.
 *   (This entry said "four sites" until the call sites were COUNTED rather than
 *   grepped: there is ONE, in `src/auth/msal-client.ts`, and the other three
 *   occurrences of the name are comments. That is the mentions-as-reach error
 *   this file warns about in the `local-indexer` entry, made by this file.)
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
 *   The admission precondition was therefore not a set of measurements but one
 *   architectural change: the loopback listener for interactive sign-in had to
 *   live on the host side of the wire. It does — `hostApi.authRedirect` (axis 1,
 *   inbound) — and the plugin USES it: at its single `acquireTokenInteractive`
 *   call site it passes a `customLoopbackClient` backed by that member, and
 *   refuses the sign-in outright on a host without it rather than letting MSAL
 *   construct the socket-binding default.
 *
 *   MEASURED over the BUILT BUNDLE rather than the sources, which is where the
 *   dependency half of every axis lives. The three `electron` hits in it are the
 *   word "electronic" inside a JSDoc paragraph, and the one `.node` hit is
 *   `MSAL_SKU: "msal.js.node"`, a telemetry label — the same string this entry
 *   already named. There is no spawn, and no `tmpdir()`, `homedir()` or
 *   `process.cwd()` anywhere in it. MSAL's `LoopbackClient` IS still bundled,
 *   `node:http` and all: what makes it dead rather than reachable is
 *   `customLoopbackClient || new LoopbackClient()`, whose only caller now always
 *   supplies one. Bundled and reachable are different questions, and only the
 *   second one decides admission.
 *
 *   MEASURED, finally, through THIS FILE'S production spawn, on macOS with the
 *   sandbox active: the real build ACTIVATES inside the jail and returns its
 *   thirty tool handlers, while in the same child `listen(0, "127.0.0.1")` comes
 *   back `EPERM` and `require("electron")` comes back `MODULE_NOT_FOUND`. The
 *   `EPERM` is the control rather than a footnote — it is the socket MSAL's
 *   default client would have bound, and without it "the plugin activated" would
 *   be a sentence about a machine whose fence might simply have been off.
 *
 *   Its axis-6 migration is jail-aware rather than merely error-checked: the
 *   `rename` out of `context.hostRoot` is refused, and the code answers that by
 *   READING the legacy file — which the deny-only read model still permits — and
 *   writing it into `pluginDataDir`, then logging the leftover it cannot unlink.
 *   The user's reply history crosses the boundary it cannot be moved across.
 *
 *   ADMITTED.
 *
 * `template` — not installed; a scaffold, out of scope.
 */
export const OUT_OF_PROCESS_PLUGIN_IDS: ReadonlySet<string> = Object.freeze(
  new Set<string>(["work-assistant", "ms-graph", "local-indexer", "meeting"]),
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
