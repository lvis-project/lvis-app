# Plugin Process Isolation — Design And Staged Plan

Status: design, not implemented. This document is the agreement that has to exist
before any code moves, because a half-migrated plugin boundary is worse than the
one we have.

Anchors: `docs/architecture/architecture.md` (Process Boundaries, Plugin Runtime,
OS Execution Sandbox And Plugin Workers) and
`docs/architecture/mcp-alignment-design.md` (§0 ratified topology, §3.1, §5
milestone `untrusted-stdio-isolation`). Where this design asks the architecture
to change, the exact section is named in "Architecture amendment requested".

---

## 1. What is actually true today

`src/plugins/runtime/plugin-loader.ts:61` is the whole of it:

```ts
const module = (await import(buildImportUrl(resolvedEntryPath, bustCache))) as {
  default?: RuntimePluginFactory;
  createPlugin?: RuntimePluginFactory;
};
```

Called from three lifecycle sites (`runtime-lifecycle.ts:266`, `:983`,
`runtime-lifecycle-capability-operations.ts:511`, `:1389`). Plugin JavaScript is
evaluated in the Electron **main** process. There is no `utilityProcess` anywhere
in `src/` — verified by grep, zero hits.

Consequences, stated plainly:

- A plugin can `import("node:fs")` and read `~/.lvis/secrets/`, `~/.lvis/sessions/`,
  the plugin registry, and the user's home directory. The `hostApi.getSecret` gate
  (`runSecretGate`) is a function it can simply not call.
- A plugin can `import("node:net")` / `undici` and reach the network directly. The
  `hostFetch` deny-by-default allow-list (`evaluateHostFetch`) is a chokepoint only
  for traffic that chooses to enter it.
- A plugin can `import("electron")` and get `BrowserWindow`, `session`, `app`.
- A plugin shares a heap with `PluginRuntime`, the effect recorder
  (`instrumentEffectsByPath`), the effect gate (`enforceMutatingEffects`), the
  permission manager, and the audit logger. It can monkey-patch any of them.

The entire capability model — 36 classified hostApi paths, the effect ledger, the
egress guard, the approval gate — is a set of in-heap JavaScript closures sitting
next to code that can rewrite them. That is the finding. Everything below is about
turning that into a wire.

### What already exists in our favour

The MCP alignment work has already moved the **host→plugin tool-call direction**
behind a protocol boundary, and it is live on `main`:

- `boot/plugins.ts:66` records the flag-day: the manifest-driven
  `registerPluginTools` / `syncPluginToolRegistry` path is **removed**. Every plugin
  now registers through `PluginLoopbackManager`, i.e. the host runs each plugin as
  an MCP server (`server/discover` → `tools/list` → reverse projection from `_meta`).
- `src/mcp/plugin-mcp-server.ts`, `plugin-server-projection.ts`,
  `plugin-runtime-delegate.ts`, `plugin-mcp-host.ts`, `plugin-loopback-manager.ts`
  are the in-process arm. `PluginMcpHost` is transport-agnostic.
- `src/mcp/experimental/stdio-child-transport.ts` and
  `stdio-server-loop.ts` are the out-of-process arm, already written and tested over
  in-memory paired streams. Their own headers name this milestone.

So the work is **not** "invent an RPC for plugins". It is:

1. swap the transport under an existing, tested projection, and
2. build the reverse channel — the 36 hostApi paths — which MCP does not cover and
   which today is a plain object handed to the factory.

Point 2 is the whole job.

---

## 2. The IPC contract

This enumeration is the contract. Anything missing here becomes a broken plugin.

### 2.1 Host → plugin instance (6 entry points)

From `RuntimePlugin` / `RuntimePluginFactory` (`public-contract.ts:1528`, `:1559`)
and the call sites in `runtime/index.ts` and `runtime-lifecycle*.ts`:

| # | Entry point | Shape | Call site |
|---|---|---|---|
| 1 | `RuntimePluginFactory(context)` | `PluginRuntimeContext` → `RuntimePlugin` | `importPluginFactory` + the four lifecycle sites |
| 2 | `instance.start()` | `Promise<void> \| void`, timeout-bounded by `manifest.startupTimeoutMs` | `runtime-lifecycle.ts:483,1081`, `…capability-operations.ts:628,1468` |
| 3 | `instance.onPublished()` | `Promise<void> \| void` | `runtime-publication-state.ts:154` |
| 4 | `instance.stop()` | `Promise<void> \| void` | `runtime-state.ts:1103` |
| 5 | `instance.handlers[toolName](payload?)` | `unknown → Promise<unknown> \| unknown` | via `buildMethodMap`; reached by `PluginRuntime.callForPlugin` (governed/MCP), `callDeclaredAppOnlyTool` (renderer UI activation) |
| 6 | `instance.readUiResource(uri)` | `string → Promise<string> \| string`, capped at `MAX_UI_RESOURCE_HTML_BYTES` | `runtime/index.ts:659` |

The `PluginRuntimeContext` handed to (1) carries: `pluginId`, `pluginRoot`,
`hostRoot`, `pluginDataDir` (all strings), `config` (resolved plain object from
`applyConfigDefaults`), `log` (a **function**), and `hostApi` (the object below).

### 2.2 Plugin → host: the 36 hostApi paths

The authoritative list is `HOSTAPI_EFFECT_BY_PATH` in
`src/permissions/effect-kind.ts`. It is not hand-maintained prose: the completeness
test (`src/permissions/__tests__/hostapi-effect-completeness.test.ts`) constructs the
**real** hostApi via the production `createHostApi` factory, walks every
function-valued leaf, and fails if any path is unmapped. That test is why this
enumeration can be trusted, and it is the mechanism that must keep guarding the
IPC contract afterwards.

**storage (12)** — `storage.resolve`, `.read`, `.readText`, `.readJson`, `.list`,
`.exists`, `.write`, `.writeJson`, `.rm`, `.mkdir`, `.writeEncrypted`,
`.readEncrypted`

**config (3)** — `config.get`, `config.set`, `config.onChange`

**agentApproval (2)** — `agentApproval.request`, `agentApproval.respond`

**top level (19)** — `getSecret`, `getInstalledPluginIds`, `hasRoutineBySource`,
`getAppPreference`, `probePrivateHost`, `resolveApiKey`, `emitEvent`,
`onEvent`, `onPluginsChanged`, `onShutdown`, `logEvent`, `callLlm`, `hostFetch`,
`spawnWorker`, `openExternalUrl`, `openAuthWindow`, `openAuthPartitionViewer`,
`clearAuthPartition`, `triggerConversation`

Total: **36 paths + 6 host→instance entry points = 42 members** the boundary must
carry. (36, not 37, once the `callTool` drift in §2.3 is closed.)

### 2.3 Two drifts that must be closed before the contract is frozen

Both are small; both would silently corrupt the enumeration if left.

- **`callTool` is in the effect SOT but is not on `PluginHostApi` and is not
  constructed by `createHostApi`.** The live `callTool` is the *plugin UI webview*
  bridge — `src/plugin-preload.ts:94` → `CHANNELS.pluginBridge.callTool` →
  `PluginRuntime.callDeclaredAppOnlyTool`. That is a renderer→main path, not a
  plugin-JS→host path, and it is unaffected by this work. Decision: remove the entry
  from `HOSTAPI_EFFECT_BY_PATH` (its effect is recorded on the executor path it
  actually takes) and record the webview bridge as a separate, already-isolated
  surface. Leaving it inflates the contract by a member that cannot be implemented.
- **`showOverlay?` is declared in `PluginHostApi` (`public-contract.ts:1358`) but is
  in neither the effect SOT nor `createHostApi`.** It is dead surface. It is also
  the single worst-shaped member for a process boundary (takes `onPrimaryAction` /
  `onDismiss` callbacks *in its arguments* and returns a `{ dismiss() }` handle).
  Decision: delete the declaration. Deleting an optional member nothing implements
  is dead-surface removal, not a contract break. If it is ever wanted, it gets built
  boundary-first with the handle-id + callback-channel pattern used for
  `spawnWorker` below.

### 2.4 Shared object and closure state crossing the line today

These are not method calls, so they are the things an enumeration of methods
misses. Each needs a decided fate.

| Shared state | What it does today | Fate under isolation |
|---|---|---|
| `enforceActiveHostApi` Proxy (`host-api-factory.ts:90`) | Wraps the whole hostApi so every member throws once the incarnation deactivates | Becomes a host-side dispatcher precondition. **Strictly stronger** — today the plugin shares a heap with the proxy target and can reach around it. |
| `incarnation.trackOperation(promise)` | Host tracks every returned promise so teardown can drain in-flight work | Survives unchanged. The host still holds the promise; it is now the RPC promise. |
| `runWithCeiling` detached settlement (`runtime/index.ts:~400`) | A hung handler's work stays detached **in main**, holding a generation lease indefinitely (`PluginRuntimeDetachedOperationError`) | Becomes recoverable: kill the child, the lease releases. Real win. |
| `withPinnedGeneration` lease | Pins the active generation across a handler call | Stays host-side. The child is told which `generationId` it serves and rejects a mismatched request. |
| `_meta["lvisai/rawResult"]` | `plugin-runtime-delegate.ts` puts the plugin's **raw return value** into the MCP result | **This is the hazard.** See §3.6. |
| `context.log` | A host closure the plugin calls directly | Becomes a notification. |
| `perf.beginCall` stats | Host-side timing around the handler | Unchanged; now measures RPC round-trip too. |

---

## 3. Marshalling decisions

No item below is a TODO. Where a decision loses something, the loss is named.

### 3.1 The synchronous members — and why there is no clever escape

Eleven hostApi members return synchronously. A process boundary is asynchronous.
Before anything else: **synchronous cross-process RPC is not implementable here.**
`Atomics.wait` over a `SharedArrayBuffer` is the usual trick, and it does not apply
— `SharedArrayBuffer` is shared between *threads*, not *processes*. Choosing a
worker thread instead would restore sync RPC and simultaneously delete the entire
point of the exercise (a thread shares the process's file descriptors, its network
stack, and its ability to crash the host). So each sync member gets a real decision:

| Member | Returns | Decision |
|---|---|---|
| `storage.resolve(...segments)` | `string` | **Compute in the child.** It is a pure lexical join under `pluginDataDir`, which the child already has. No IPC. The traversal-rejection logic moves into a shared module both sides import, so the child's answer and the host's enforcement cannot diverge. |
| `config.get(key)` | `T \| undefined` | **Host-pushed snapshot.** The resolved config object is sent at construction and re-sent on every change; the child reads its local copy. The re-push is its own notification kind, carrying the key set and the values separately, because `config.get` answers `undefined` for a cleared key and `undefined` is not a JSON value — a plain record would lose the property and the child would keep the value it was supposed to drop. The host subscribes to the change bus's every-key wildcard and rebuilds the snapshot through `config.get`, so there is one authority for what a config value is. The key set is the one the host can enumerate (schema properties, manifest config, construction snapshot); a key a plugin invents at runtime through `config.set` is written by the child when its own call resolves and is not re-pushed. Ordering guarantee: the push is emitted *before* the `config.set` reply, so a plugin that sets-then-gets sees its own write. Cross-plugin config visibility was never a guarantee and is unchanged. |
| `getInstalledPluginIds()` | `string[]` | **Host-pushed snapshot**, re-sent on the same events `onPluginsChanged` already fires. |
| `getAppPreference(key)` | `T \| undefined` | **Host-pushed snapshot.** The allow-listed key set is small and host-known. |
| `getSecret(key)` | `string \| null` | **Contract change: becomes `Promise<string \| null>`.** No alternative exists. It cannot be snapshot-pushed — eagerly shipping secrets into the child is the exact opposite of the goal, and `runSecretGate` is a per-call four-tier decision, not a static grant. This is the one place the migration cannot avoid a flag-day. See Stage 4. |
| `emitEvent(type, data)` | `void` | **Notification**, fire-and-forget. But it can *throw synchronously today* on a denied event (`canEmitEvent` + `auditPluginEmitDenial`). Decision: the host pushes the plugin's declared emittable set (derived from its own manifest, which the child already holds) at construction; the child stub checks locally and throws synchronously, and the host re-checks authoritatively and writes the denial audit. Both run. The host check is the control; the child check only preserves the synchronous throw the contract promises. This is not a fallback — neither side is a degraded substitute for the other. |
| `logEvent(level, msg, data)` | `void` | **Notification.** No return, nothing lost. |
| `onEvent(type, handler)` | `() => void` | Handler stays in the child. The child sends `subscribe(type)`, stores the handler in a child-local map, and returns a **local** disposer that sends `unsubscribe`. The host delivers matching events as notifications. Only strings and JSON payloads cross. |
| `config.onChange(key, cb)` | `() => void` | Same pattern. |
| `onPluginsChanged(handler)` | `() => void` | Same pattern. |
| `onShutdown(handler)` | `void` | Child registers locally. The host sends a `shutdown` **request** and awaits the reply before terminating, bounded by the existing lifecycle timeout, then SIGTERM → SIGKILL. This preserves today's "host awaits the handler's promise" semantics; the bound is new and is an improvement (today a plugin can hang shutdown forever). |

### 3.2 Async members returning non-clonable values

**`hostFetch(input, init) → Response`.** A `Response` is a class instance with a
streaming body; neither survives a wire.

- *Reply:* the host consumes the body and returns
  `{ status, statusText, headers: [[k, v], …], bodyBase64 }`; the child reconstructs
  a real `Response`. An explicit maximum buffered size applies, and exceeding it
  **throws a typed error** — never a silent truncation.
- *Argument:* `init` may carry a `Headers` instance, an `AbortSignal`, and a
  `ReadableStream` body. The child serializes to
  `{ method, headers: [[k, v], …], body: string | base64 }`. A `signal` becomes an
  **abort-channel id**: the child sends `abort(id)` and the host aborts its own
  `AbortController`. A stream body is **rejected with a typed error**, not silently
  buffered.
- *Loss, stated:* streaming responses stop streaming. If a first-party plugin needs
  it, the follow-up is a chunked notification stream keyed by request id — designed
  then, not stubbed now. **Unverified: whether any of the six plugins streams
  today.** See §7.
- The verb snapshot that makes the effect record non-forgeable
  (`host-api-factory.ts:~775`) is unaffected and gets stronger: the child no longer
  supplies a live `init` object whose `method` getter could be stateful — it supplies
  a parsed JSON primitive.

**`resolveApiKey(opts) → { ok, vendor, bearer(), baseUrl?, release() }`.** Two
functions in a return value.

- The host replies with `{ ok, vendor, baseUrl?, key, leaseId }`; the child stub
  closes over `key` and synthesizes `bearer()` / `release()` locally. `release()`
  drops the child's copy and sends `release(leaseId)` so the host drops its own and
  unwires the abort. `bearer()` after release throws, per the existing contract.
- *The other direction is a message too.* A host-side revocation reaches the child
  as `subscription-closed`, and the child's lease stub drops its copy of the key on
  it — otherwise the credential outlives the host's decision to take it back. That
  notification is sent from the dispatcher's release path and from nowhere else,
  for exactly one of the three close reasons: `disposed` came from the child so
  echoing it is a ping-pong, `peer-gone` means the pipe is already closed, and
  `revoked` is the host's own decision and the only one the child cannot otherwise
  learn.
- The `signal` in `opts` becomes an abort-channel id, as above.
- *Honest note:* an isolated plugin still receives whatever credential the gate
  grants it. Isolation does not shrink what a **granted** plugin can exfiltrate; it
  shrinks what an **ungranted** one can reach. `resolveApiKey` is a gate, and the
  gate is what does the work here.

**`callLlm(prompt, { maxTokens, systemPrompt, signal })`.** Plain data plus an
`AbortSignal` → abort-channel id. Reply is a `string`.

**`spawnWorker(spec) → SpawnedPluginWorker`.** Returns `{ socketPath, pid, stop(),
onStdout(), onStderr(), onExit() }` — live process control.

- The host **keeps owning the worker process**. It must: the ASRT grant machinery,
  the wrapped-worker registry (`markPluginWorkerWrapped`), the Windows holder-PID
  ACL lifecycle, and `trackManagedChildProcess` all live in main.
- Reply: `{ workerHandleId, socketPath, pid }`. The child stub's `stop()` sends a
  notification; `onStdout` / `onStderr` / `onExit` register **child-local**
  listeners fed by host notifications keyed by `workerHandleId`.
- *This is a security improvement, not just a port.* Today `spawnWorker` hands the
  plugin a live `ChildProcess`-derived handle in the same heap. Afterwards the
  plugin holds an opaque id.
- *Corollary that must be enforced:* the isolated plugin process must **not** be
  permitted to spawn its own workers. ASRT grants are keyed to host-allocated paths
  and, on Windows, to a holder PID; a plugin-spawned grandchild would be outside
  that. The worker stays a child of main.
- *Confinement composes.* `PluginWorkerSpec` lets the caller name its own
  `allowReadPaths` and `allowWritePaths`, and in one heap that was harmless — the
  plugin and the worker supervisor were the same trust domain. Across the boundary
  they are not: a child that can ask the host to spawn `/bin/sh` with
  `allowWritePaths: ["/"]` has escaped its jail by asking someone else to hold the
  door. So the child's own filesystem envelope crosses with the dispatcher binding
  and a delegated worker's grants are checked against it — read within
  `pluginRoot` ∪ `pluginDataDir`, write within `pluginDataDir`, which is exactly
  the pair the child's own wrap grants. `command` and `env` are deliberately not
  constrained: the worker runs under those grants plus the shared deny floor, so
  naming a different binary reaches nothing the grants do not already allow.
  Stated residual: the check is lexical, because a grant may name a directory the
  worker is about to create, so a symlink planted inside the data directory is the
  worker supervisor's to catch and not this.
- *What this makes visible.* `local-indexer`'s worker asks to read a corp CA under
  `~/.lvis/certs/` and to write the user's chosen index root and workspace — all
  outside the plugin's own two directories. The composition rule refuses that, and
  refusing it is the correct answer: the plugin child cannot reach those paths
  either, so a worker that could would be a widening nobody granted. Moving that
  plugin therefore starts with the HOST widening the child's own envelope to
  include them, after which the delegated worker composes with no further change —
  which is the point of deriving both lists from one place.

**`storage.read → Uint8Array` and `storage.write(data: string | Uint8Array)`.**
Base64 on the wire with an explicit encoding tag, reconstructed as `Uint8Array` in
the child. Base64 inflates payloads by 4/3; an explicit maximum applies and
exceeding it throws. Note what the conformance test measured: `storage.read`
declares `Uint8Array` but actually delivers a Node `Buffer`, and `Buffer` carries a
`toJSON()`. A naive round-trip therefore does **not** throw — it succeeds into
`{ type: "Buffer", data: number[] }`, a different type that reads as success. The
encoding has to be explicit precisely because JSON will not object.

**Everything else is plain data** and crosses unchanged: `openAuthWindow` →
`AuthWindowCookie[]` or `{ finalUrl }`; `agentApproval.request` → an `ApprovalChoice`
string union; `triggerConversation` → `ConversationTriggerResult`;
`probePrivateHost` → `boolean`; `hasRoutineBySource` → `boolean`;
`openExternalUrl` / `openAuthPartitionViewer` / `clearAuthPartition` / `config.set`
→ `void`; the remaining `storage.*` → strings, JSON, string arrays, booleans, void.

### 3.3 Error identity

Errors currently cross as `Error` instances and the host distinguishes several by
identity — `ManifestIntegrityError`, `PluginRuntimeDetachedOperationError`,
and the `[plugin:<id>] <member>: plugin instance is no longer active` string thrown
by `assertActiveHostApi`. Over a wire an `Error` degrades to `{ message, stack }`.

Decision: every host→child error reply carries an explicit `code` from a closed
union, and the child stub reconstructs the matching error class. The child→host
direction reuses the mechanism `plugin-mcp-server.ts` already has (a thrown
delegate becomes an `isError` `CallToolResult`). No error is reconstructed from
message-string matching.

### 3.4 The context object

`pluginId` / `pluginRoot` / `hostRoot` / `pluginDataDir` are strings sent at
construction. `config` is the already-resolved plain object. `log` becomes a
notification. `hostApi` is the stub the child builds. Nothing in the context is
inherently unmarshallable.

### 3.5 Tool payloads and results

`PluginToolHandler` is `(payload?: unknown) => Promise<unknown> | unknown`. Both
directions must become JSON.

### 3.6 The hazard: the loopback transport does not serialize

`src/mcp/loopback-transport.ts` calls `this.server.handle(...)` **directly** and
passes `response.result` through by reference. There is no JSON round-trip. Combined
with `plugin-runtime-delegate.ts` placing the plugin's raw return value into
`_meta["lvisai/rawResult"]`, this means:

> Today a plugin may return a `Date`, a `Map`, a `Set`, a class instance, a
> function, or a live mutable object, and the host will receive that exact
> reference. Over a real wire, every one of those changes shape or disappears.

The MCP framing therefore does **not** currently prove serializability. It looks
like a boundary and is not one. Closing this is Stage 2, and it is the stage most
likely to be skipped because it delivers no isolation on its own.

---

## 4. What isolation actually buys — and what it does not

`utilityProcess` and a spawned Node child are both Node processes. By default each
still has `fs`, `net`, and `child_process`. Overstating this would be the easiest
way to ship a boundary that reassures without protecting.

### Gained by the process boundary alone

- **No shared heap.** The plugin can no longer monkey-patch `PluginRuntime`, the
  effect recorder, `evaluateHostFetch`, `runSecretGate`, the approval gate, or the
  audit logger. This is the largest gain, it is total, and nothing else in the stack
  provides it.
- **No Electron.** `require("electron")` in the child yields nothing. `BrowserWindow`,
  `session`, and `app` become unreachable.
- **A structural chokepoint.** Every hostApi call becomes a message the host
  services. `instrumentEffectsByPath` stops being "a wrapper we hope is total,
  guarded by a completeness test" and becomes "the only way in".
- **A separate crash and hang domain.** A plugin OOM or infinite loop no longer takes
  main — and therefore the entire UI — down. The detached-settlement problem
  (§2.4) becomes killable.
- **Per-plugin resource accounting** becomes possible (it is currently
  indistinguishable from host CPU and memory).

### NOT gained by the process boundary alone

- The child still reads `~/.lvis/secrets/`, `~/.lvis/sessions/`, the plugin
  registry, and the user's home — **unless ASRT jails its filesystem**.
- The child still opens sockets directly, bypassing the `hostFetch` allow-list —
  **unless ASRT confines its network** (`--unshare-net` on Linux, seatbelt on macOS).
- The child still spawns processes — **unless ASRT confines process creation**.

So the security claim is only real when the child is spawned **through the ASRT
argv wrapper**. The boundary is necessary and not sufficient, and the two halves
have to land together (Stage 6 then Stage 7) or the intermediate state advertises
protection it does not have.

### The Windows residual, stated rather than buried

`architecture.md` (OS Execution Sandbox And Plugin Workers) is explicit: Windows
srt-win provides filesystem and network confinement but **no process confinement**.
A confined plugin child on Windows therefore still cannot be prevented from
spawning a process, which can in turn do anything the user can. Opening the
marketplace to third-party plugins on Windows is a **separate owner decision**, not
something this design can resolve. See §7.

---

## 5. Process model, and the transport that follows from it

### 5.1 One process per plugin

**Decision: one child process per loaded plugin. Not a shared plugin host.**

Trade-off, both directions:

*For per-plugin:* per-plugin OS confinement is only expressible per-process. The
filesystem jail is rooted at `~/.lvis/plugins/<pluginId>/` and the network
allow-list is `manifest.networkAccess.allowedDomains` — **both are per-plugin
today**. A shared host would have to union every loaded plugin's grants into one
jail, which is strictly weaker than what we already enforce, and would let plugin A
read plugin B's storage. Crash blast radius is also per-plugin: one bad plugin does
not take the other five down. And the ratified topology (`mcp-alignment-design.md`
§0, §3.1) is already 1:1 client↔server per plugin, so the host-side lifecycle is
built for it.

*Against per-plugin:* roughly six extra Node processes on a desktop app. Baseline
Node RSS is on the order of 30–40 MB before the plugin's own footprint, so call it
200–250 MB of additional resident memory, plus six cold starts on boot. That is a
real cost on a laptop and it is the honest price. **Unmeasured — see §7.**

A shared host would save most of that memory and would cost the per-plugin
confinement that is the entire security argument. The trade is not close.

### 5.2 Spawned stdio child, not `utilityProcess`

**Decision: `spawn` a Node child speaking Content-Length-framed JSON-RPC over
stdio. Not `utilityProcess.fork`.**

The deciding reason is not preference:

> **`utilityProcess.fork()` makes Electron spawn its own helper binary. You cannot
> prefix that argv.** ASRT confinement works by wrapping the command line —
> `sandbox-exec -f <profile> <cmd>` on macOS, `bwrap … <cmd>` on Linux, srt-win on
> Windows (`wrapWorkerCommand` in `asrt-sandbox.ts`). A primitive that owns its own
> spawn cannot be wrapped. Choosing `utilityProcess` would therefore forfeit the
> confinement layer that §4 identifies as the difference between real protection and
> the appearance of it.

Secondary reasons, in order:

1. `StdioChildTransport` + `StdioServerLoop` already exist and are tested; the
   framing (`stdio-framing.ts`) is shared with the MCP client; `PluginMcpHost` is
   already transport-agnostic. This is the arm the architecture named.
2. The child is a plain Node process, so the ASRT wrapper, the sandboxed env
   builder, and the managed-child supervision from `worker-spawn.ts` apply
   unchanged.

Honest cost of not using `utilityProcess`:

- We give up `MessagePort` structured clone, so `Uint8Array` needs base64 and there
  are no transferable `ArrayBuffer`s. §3.2 already pays this.
- We give up Electron's automatic child teardown on app quit, so the child must join
  the existing `managed-child-processes` registry — which is a reuse, not new work.
- JSON framing costs more than structured clone on large payloads. The storage and
  `hostFetch` size caps (§3.2) bound the exposure.

---

## 6. The existing worker infrastructure: reuse the confinement, not the channel

`src/permissions/worker-spawn.ts` already solves the hard half of this problem for
Python workers. Its `spawnWorker` provides: ASRT argv wrapping (`wrapWorkerCommand`),
a per-worker control dir at `~/.lvis/plugins/<pluginId>/run/<workerId>/`
(`PLUGIN_WORKER_RUN_DIR_NAME`), the Linux `registerWorkerUnixSocketDir` shared-config
dance, the Windows holder-PID ACL grant/revoke lifecycle, secret-stripped env via
`buildSafeChildEnv` / `buildSandboxedChildEnv`, `markPluginWorkerWrapped` so the
effect boundary can recognise a confined worker, and registration into
`managed-child-processes` (`trackManagedChildProcess`,
`assertManagedChildProcessAdmissionOpen`, `forceKillAndDrainManagedChildProcesses`,
`sealManagedChildProcessAdmission`).

**Decision: reuse the confinement and supervision half. Do not reuse the control
channel.**

*Reuse:* ASRT wrapping, sandboxed env construction, the Windows holder-grant
lifecycle, managed-child tracking and shutdown drain, the wrapped-worker marking.
Rebuilding any of these would be a second, divergent implementation of the most
security-sensitive code in the repo.

*Do not reuse:* the Unix-domain-socket control channel. That socket exists for a
specific reason spelled out in the `worker-spawn.ts` header — the Python worker is
an **HTTP server the host connects inbound to**, and on Linux ASRT's
`--unshare-net` puts it in its own network namespace, so loopback TCP does not
reach it. A JS plugin child has no such problem: it is a JSON-RPC **server whose
pipes the host owns**, because the host spawned it. Adding a socket would require
the `allowAllUnixSockets` seccomp weakening, a socket directory inside the jail,
and a Windows TCP fallback — three pieces of attack surface for no capability we
need.

*The honest cost:* `worker-spawn.ts` currently interleaves the confinement half and
the UDS half in one function. Factoring the confinement half into a primitive both
paths share, without changing Python-worker behaviour by a byte, is real work with
a genuinely fiddly Windows lifecycle. It gets its own stage (Stage 3) rather than
being smuggled into a larger one.

---

## 7. Uncertainties, and what would resolve each

Named rather than hidden, because each one can move a stage estimate.

1. **Do any of the six first-party plugins return non-JSON values from tool
   handlers?** §3.6 shows the current boundary would not have caught it. *Resolve:*
   Stage 2 — make the loopback transport serialize and run the full suite plus the
   app e2e. This is a measurement, not a guess, and it is the first thing to do.
2. **Does any first-party plugin stream a `hostFetch` response, read large binaries
   through `storage.read`, or call `getSecret` from a synchronous context (a
   constructor or a sync handler)?** *Resolve:* audit the hostApi call sites in the
   six plugin repos. Not done here — those are separate repositories and this clone
   is the host only.
3. **What is the real cold-start and per-call cost of six child processes?**
   The §5.1 memory figure is a Node-baseline estimate, not a measurement. *Resolve:*
   Stage 6 — measure boot-to-tools-registered and per-tool-call round-trip on the
   pilot, before committing to Stage 8.
4. **Windows has no process confinement.** Does that block admitting third-party
   plugins on Windows? *Resolve:* owner decision at Stage 9. The options are to gate
   third-party install on Windows, or to accept and document the residual. This
   design does not have standing to pick.
5. **Does the effect-enforcement gate's approval modal (`gateMutatingEffect`)
   interact badly with an async boundary?** The gate awaits a user response inside
   a hostApi call. That already works because the gated paths are already async — but
   a child now waits on a round-trip that may block on a human. *Resolve:* Stage 5 —
   an explicit test that a gated write from the child survives a slow approval and
   that a child timeout does not leave the host gate pending.
6. **`mcp-alignment-design.md` §3.3 still describes `_meta["lvisai/category"]` as
   the policy SOT and `plugin-tool-from-mcp.ts` as failing closed on a missing
   category, while per-tool `category` was removed from the manifest and the host now
   classifies risk per invocation.** This drift is adjacent to, not part of, this
   work, but the reverse projection is on the path every isolated tool call takes.
   *Resolve:* confirm the live behaviour of `plugin-tool-from-mcp.ts` before Stage 6,
   so the pilot does not inherit a fail-closed branch that no longer has an input.

---

## 8. Architecture amendment requested

One, and only if the owner wants first-party plugins isolated too.

**`docs/architecture/mcp-alignment-design.md` §0 (Ratified decisions, "Topology"
row) and §3.1 (Topology).** Both currently ratify: out-of-process stdio for
*marketplace/untrusted* plugins, in-process loopback for *first-party/trusted*
plugins, justified by performance.

Two readings follow from that, and they lead to different endings:

- **As ratified.** Third-party plugins are isolated; the six first-party plugins keep
  full main-process authority permanently. This closes the red-team's blocker as
  stated, and it is a coherent position — first-party code is reviewed code.
- **Amended.** The transport is selected by *host policy* rather than by a fixed
  first-party/marketplace split, and first-party plugins move out-of-process too.

This design recommends **planning for the amendment but not requiring it**, for a
practical reason: the isolated path has to be proven on real plugins, and the six
first-party plugins are the only real plugins we have. So they run out-of-process
*first*, as the test fleet, and third-party admission is flipped on afterwards
(Stages 6–9). That ordering is the inverse of the intuitive one and it is the right
one — it means third-party plugins are admitted onto a path that six real plugins
have already exercised, rather than onto a path whose first user is an untrusted
stranger.

Whether first-party plugins then *stay* out-of-process (Stage 10) is the amendment,
and the thing that should settle it is the §7.3 measurement, not the assumption
that in-process is faster by enough to matter. If the cost is small, the amendment
should be taken and the in-process loader deleted; if it is large, the ratified
hybrid stands and `importPluginFactory` remains — as permanent architecture for
first-party plugins, not as a shim.

**No other section requires change.** `architecture.md`'s Process Boundaries
("Plugin code can request host operations only through declared capabilities and
HostApi methods") is a statement this work finally makes *true* rather than
aspirational. Plugin Runtime's boundaries are all preserved. OS Execution Sandbox
And Plugin Workers gains a second consumer of the same ASRT primitives, which is
what §6 is about.

---

## 9. Staged plan

Each stage is independently mergeable, independently testable, and leaves the app
working. The estimate is deliberately **not** spread evenly: Stage 5 is where the
difficulty concentrates, and Stages 2 and 4 are the ones most likely to be
underestimated.

### Stage 1 — Freeze and prove the surface

*Scope.* Close the two drifts in §2.3: remove `callTool` from
`HOSTAPI_EFFECT_BY_PATH`, delete the unimplemented `showOverlay?` declaration from
`PluginHostApi` and its SDK mirror. Add a serialization-conformance test that walks
the real hostApi and asserts, per path, whether its arguments and return values are
JSON-representable — with the non-representable members named explicitly as
requiring a decided representation rather than being silently allowed.

*Correction from doing it.* That set is **ten**, not eight. Alongside `hostFetch`,
`resolveApiKey`, `spawnWorker`, `storage.read`, `storage.write` and the three
disposer-returning subscriptions (`onEvent`, `onPluginsChanged`,
`config.onChange`), the criterion "arguments **and** return values" also catches:

- `onShutdown`, whose argument is a handler function. It differs from the three
  subscriptions only in returning `void` instead of a disposer, which is not a
  difference the wire cares about. §3.1 already decided it.
- `callLlm`, whose `options.signal` is an `AbortSignal`. Its return (`string`) is
  fine, which is why counting by return value alone missed it. §3.2 already decided
  it.

Neither is a new design question — both already have a decided representation
above; the Stage 1 enumeration simply undercounted. The conformance test pins all
ten.

*What proves it.* The existing completeness test stays green; the new conformance
test fails if a member is added without a marshalling decision. It also asserts the
direction the completeness test never did — that every `HOSTAPI_EFFECT_BY_PATH` key
exists on the real hostApi — which is the check whose absence let `callTool` sit in
the effect SOT unimplemented.

*Risk: low.* No behaviour change. This is the artifact every later stage is checked
against.

### Stage 2 — Make the existing boundary honest

*Scope.* `LoopbackTransport` JSON-round-trips its messages (or asserts
serializability on every hop) instead of passing object references. Everything stays
in-process. Fix whatever this surfaces in the six plugins' tool results and
`_meta["lvisai/rawResult"]` payloads.

*What proves it.* Full vitest suite plus the app e2e, with all six plugins loaded and
each of their tools invoked. Any `Date` / `Map` / class instance / function in a
result surfaces here or nowhere.

*Risk: medium-high, and structurally under-appreciated.* It delivers no isolation on
its own, which makes it the easiest stage to skip — and skipping it moves every
failure it would have found into Stage 6, where they arrive mixed with genuine
transport bugs. §3.6 is why this cannot be deferred.

### Stage 3 — Extract the confinement primitive

*Scope.* Factor ASRT argv wrapping, sandboxed env construction, the Windows
holder-PID grant lifecycle, and managed-child registration out of `worker-spawn.ts`
into a primitive usable by both the Python worker path and a future JS plugin child.
The UDS half stays with the Python worker.

*What proves it.* Existing worker tests green unchanged, plus a test asserting the
extracted primitive produces byte-identical wrapped argv and env for the Python
worker case.

*Risk: medium.* The Windows holder-PID lifecycle is intricate and is the part CI
covers least well.

### Stage 4 — Async-ify the members that cannot cross

*Scope.* `getSecret` becomes `Promise<string | null>` in `public-contract.ts`, the
SDK mirror, the host implementation, and all six plugins. Any other synchronous
member that §3.1 could not resolve locally moves in the same PR. Still fully
in-process.

*What proves it.* Host and all six plugins build and pass against the new contract,
in-process, with no behaviour change.

*Risk: medium-high — this is a cross-repo flag-day across seven repositories.* The
release-order constraint applies: the host capability release must ship before any
plugin republish, and `minAppVersion` must name the first released host version that
carries it. This is a coordination risk, not a technical one, which is exactly the
kind that slips.

### Stage 5 — The child runtime and the reverse channel

*Scope.* Ship the child-side entrypoint that builds the hostApi stub, imports the
plugin factory, and serves `PluginMcpServer` over `StdioServerLoop`; plus the
host-side dispatcher that services all 36 paths. Behind a host-owned routing SOT
that **ships empty**. Nothing routes to it; the app is unchanged.

*What proves it.* The child runtime driven over in-memory paired streams, following
the pattern `stdio-server-loop`'s own tests already use. A contract test that every
one of the 36 paths dispatches, marshals per §3, and reconstructs the right error
class per §3.3. A leak test for each of the four subscription members
(`onEvent`, `config.onChange`, `onPluginsChanged`, `onShutdown`): subscribe,
dispose, assert both sides released.

*Risk: this is where the real difficulty concentrates, and it is not close.* No
single method is hard. The difficulty is 36 methods × (argument marshalling ×
return marshalling × disposer lifetime × error identity), which is 36 independent
opportunities to change behaviour in a way no existing test notices — because today
every one of them is a direct function call that no test was written to pin. The
four subscription members are the worst of it: each needs a two-sided lifetime that
does not leak when either side dies. If this plan is under-resourced anywhere, it
will be here, and the failure mode is a plugin that works in every test and
misbehaves in the field.

### Stage 6 — First plugin out-of-process, unconfined

*Scope.* Populate the routing SOT with one plugin id. Process boundary only; no ASRT
yet. Measure §7.3.

*What proves it.* End-to-end: the pilot's tools, UI resources
(`readUiResource`), event subscriptions, config changes, and shutdown all behave
identically. A containment test: kill the child mid-call, assert the host survives,
the pending call rejects with a typed error, and the tools deregister cleanly.

*Risk: medium.* First real exposure of latency, lifecycle, and restart semantics.
The measurement here gates Stage 8 and informs §8.

### Stage 7 — Confine the pilot

*Scope.* Route the pilot's spawn through the Stage 3 primitive. Fail closed if
confinement is unavailable on the platform — no unconfined fallback.

*What proves it.* **The security claim becomes testable for the first time:** a test
asserting the child cannot read `~/.lvis/secrets/`, cannot read another plugin's
data directory, and cannot open a socket to a host outside
`manifest.networkAccess.allowedDomains`. Until this stage those are assertions; here
they become tests.

*Risk: medium-high on Windows.* Per §4, Windows gets no process confinement — the
test suite must assert that residual explicitly rather than skipping the platform.

### Stage 8 — Move the remaining first-party plugins

*Scope.* One PR per plugin, adding its id to the routing SOT.

*What proves it.* Per-plugin e2e, same shape as Stage 6.

*Risk: low per PR, and it declines with each one.* If a plugin needs a marshalling
decision §3 did not anticipate, that decision lands here — visibly, one plugin at a
time, rather than as a surprise in a big-bang cutover.

### Stage 9 — Admit third-party plugins

*Scope.* Marketplace-installed plugins route out-of-process **by default**, confined,
failing closed when confinement is unavailable. Resolve the §7.4 Windows decision.

*What proves it.* An adversarial plugin fixture that attempts each of the four
escapes §1 lists — read `~/.lvis/secrets/`, direct network egress, `require("electron")`,
monkey-patch a host internal — and is denied on each.

*Risk: medium.* This is the stage the red-team asked for, and it should not be
reached until Stages 6–8 have run six real plugins through the path.

### Stage 10 — Remove the in-process loader (conditional)

*Scope.* Only if the §8 amendment is accepted. Delete `importPluginFactory` and the
loopback arm from main.

**Removal trigger, named as the No-Fallback rule requires:** the routing SOT's
in-process list is empty — every installed plugin, first-party included, is
out-of-process. Not a date; a state, and one that is mechanically checkable in CI.

*What proves it.* `importPluginFactory` has no remaining call site; no plugin
JavaScript is evaluated in main.

*Risk: low, gated entirely on the Stage 6 measurement and the owner's answer to §8.*

### A note on the coexistence question

Both loading paths do coexist during Stages 5–9. That is **not** a compatibility
shim and it does not need the No-Fallback exemption, because it is not a runtime
degradation path: no call ever falls back from one to the other, and nothing is
silently retried in-process when the child fails — a failed child fails the call.
It is a per-plugin routing decision made from a host-owned SOT, which is the same
mechanism `LOOPBACK_MIGRATED_PLUGIN_IDS` used to land the loopback migration and
the same hybrid the architecture already ratifies.

The one genuine contract break in this plan is `getSecret` in Stage 4, and it is
handled as a flag-day across all seven repositories rather than as a dual-signature
shim — precisely because a shim there would need a removal plan nobody would ever
execute.
