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
**`startAudioCapture(request) → AudioCaptureHandle`.** Returns
`{ captureId, opened, stop(), onFrame(), onEnd() }` — live capture control, and
the same shape as `spawnWorker` for the same reason.

- The host **keeps owning the capture**. It must: the capture needs
  `getUserMedia`, `getDisplayMedia`, an `AudioContext` and an `AudioWorklet`,
  and those exist only in a renderer. A plugin that wants them ships its own
  renderer and loads it outside the sandbox — which is not a boundary a host API
  can mediate, because mediating it would mean running plugin code in a
  privileged context, and that removes the boundary rather than moving it. So
  the renderer, the worklet and the loopback wiring become first-party.
- Reply: `{ handleId, captureId, opened }`. `stop()` releases that registration;
  `onFrame` / `onEnd` register **child-local** listeners fed by host
  notifications keyed by `handleId`.
- *Why a handle and not an event.* Frames are addressed to the ONE plugin that
  started the capture. The host's event bus (`emitHostEvent`) broadcasts to
  every installed plugin, so delivering audio that way would hand all of them
  the microphone. A capability that looks event-shaped is a handle here for that
  reason alone.
- *The PCM crosses as base64.* The wire is JSON and JSON has no bytes; a
  `Uint8Array` put through it arrives as an object with numeric keys, which is
  not an error anywhere — just audio that decodes to noise. The child decodes
  once per frame and fans the result out, rather than once per listener.
- *`opened` is not the request.* It reports which sources actually opened.
  Asking for both and getting one is an ordinary outcome, and a plugin that
  cannot tell the difference will label a microphone-only recording as a full
  one.
- *What the host deliberately does not decide:* no silence detection, no chunk
  boundaries, no mixing policy beyond summing the requested sources. Those are
  decisions about the SUBJECT of a recording, and the subject belongs to
  whoever asked for the audio.

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
  `session`, and `app` become unreachable. Measured, not assumed:
  `confined-plugin-child.test.ts` drives a real confined child and gets
  `MODULE_NOT_FOUND` — while `process.versions.electron` in that same child still
  reports a version, so a plugin gating on the version reaches the call anyway.
  The denial is not uniform across module systems, and each form is asserted
  separately: `import("electron")` resolves to an inert namespace — empty on its
  `default`, where a CJS module reached that way would carry the API — and a
  named import fails to link.
  Shipping the `electron` package does not restore it either: the package's entry
  exports the binary's **path as a string**, so `BrowserWindow` is `undefined`.
  This is a gain **and** an admission constraint — a plugin that owns a window of
  its own is not a migration candidate. See Stage 8.
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

*Correction from doing it.* That set is **ten**, not eight — and **eleven** once
audio capture lands. Alongside `hostFetch`,
`resolveApiKey`, `spawnWorker`, `startAudioCapture`, `storage.read`, `storage.write` and the three
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

*What proves it.* Per-plugin e2e, same shape as Stage 6, **plus the admission
criterion below**. The e2e alone is not enough and that is not hypothetical: two
plugins were judged migratable on a per-plugin census of their `hostApi` surface and
both judgements were wrong, in the same direction, for the same reason.

#### The admission criterion, and why the obvious one fails

The criterion cannot be "does every hostApi member it calls have a wire form",
because §2.2's wire is complete — that question can only answer "ready". A plugin's
capabilities arrive from two places, and the wire preserves only one of them:

- **Mediated** — what the host hands it as `hostApi`. The wire preserves this.
- **Ambient** — what the runtime hands it merely by being loaded in main: the global
  scope, the built-in modules, the identity of the process. Nothing mediates this,
  which is exactly what §4 says the boundary takes away.

So the question that decides admission is *which ambient capabilities does this
plugin use, and does a mediated form of each exist*. Measured over both sets, over
the plugin's **dependencies** as well as its own sources, and against a real confined
child. The axes, with what a child measurably gets — each was driven through the
production spawn rather than reasoned about. **Measured** and **asserted** are not
the same thing, so the last column says which: an assertion is a case that goes red
when the fact stops holding, and two of these six have none.

An assertion is also only an assertion **where it executes**, so the last column
says that too. Every case behind these axes needs a live sandbox and returns early
where the backend cannot initialize. That means they run on
**macOS**, including the `macos-permission-tests` job in `ci.yml`, which runs
`confined-plugin-child.test.ts` with `LVIS_REQUIRE_SANDBOX_CASES=1` so a machine
that cannot initialize fails there rather than passing quietly; they **do not run**
on the Linux job that runs the whole suite on every pull request, because that
runner has no bubblewrap — nothing in `.github/` or `scripts/` installs it and ASRT
vendors only seccomp and srt-win; and they do not run on Windows at all, being
`runIf(darwin || linux)`. Installing bubblewrap on the Linux runner is what would
change that, and it would also un-gate two other live-sandbox suites, which is why
it is named as an open item rather than done in passing.

| Ambient axis | What a confined child gets | Mediated form | Pinned by a case, and where it runs |
|---|---|---|---|
| Direct network egress (global `fetch`, `node:http`/`https`/`net`/`tls`/`dgram`, an HTTP client library, a dependency with its own socket) | None. Against an **allow-listed** host: `fetch` fails, DNS fails `ENOTFOUND`, and a raw connect to a literal IP fails `EPERM` at the syscall. The child's env names the loopback listener that enforces the allow-list; `NODE_USE_ENV_PROXY` is absent, so Node's own clients ignore it. What distinguishes this from an offline machine is **per platform**: on macOS the fence is a proxy and denial arrives as `EPERM`, where an unreachable network answers `ENETUNREACH`/`EHOSTUNREACH`/timeout, so the code alone separates them; on Linux the fence is a namespace and a connect inside one returns `ENETUNREACH` itself, the same code an offline machine gives, so the code separates nothing there. What separates them on either platform is that the same connect from the **unconfined** host succeeds. A companion "does an HTTPS request answer" check is not the discriminator: on a TLS-intercepting network the host's own request fails too. | `hostApi.hostFetch`. Declaring the host does **not** help — the request never reaches the allow-list. | **No.** macOS fences through a proxy and Linux through a namespace, so one probe means different things per platform, and an internet probe passes on an offline machine for the wrong reason. Resolved by a per-platform case against a host-controlled listener. |
| Electron main-process APIs — the `electron` specifier by **any** resolution path (static import, bare `require`, a `require` held in a variable, `createRequire`, dynamic `import()`, a dependency's re-export). A literal grep for `require("electron")` misses both first-party plugins that are on this axis. | None — `require` throws `MODULE_NOT_FOUND`, while `process.versions.electron` still answers. Not uniform across module systems: `import("electron")` **resolves** to an inert namespace (`BrowserWindow` `undefined` on it and its `default` an empty object) and a named import fails to link with a `SyntaxError`, so the same absent capability breaks a plugin at resolution, at link, or at the call. Vendoring the package yields the binary path as a string. | Only `openExternalUrl`, `openAuthWindow`, `openAuthPartitionViewer`, `clearAuthPartition`. **No** form of `BrowserWindow`, `screen`, `session`, `ipcMain`. | Yes — asserted by `confined-plugin-child.test.ts`, which runs on macOS (CI's macOS job included) and returns without measuring on the Linux CI runner, which has no bubblewrap. Each module form is asserted separately. |
| Process spawning | A grandchild inherits the child's fence (asserted in both directions). On Windows the sandbox does not confine process creation at all — §4's residual. | `hostApi.spawnWorker`, inside the same confinement envelope. | Yes, in both directions — asserted by `confined-plugin-child.test.ts`, which runs on macOS (CI's macOS job included) and returns without measuring on the Linux CI runner, which has no bubblewrap. |
| Native modules (`.node`, or a dependency that loads one) | They **load**. `process.dlopen` of a prebuilt addon inside the read carve-out succeeds. It is compiled against the child binary's ABI, which is Electron's and not plain Node's, so a plain-Node prebuild breaks — and an addon is ambient code the wire cannot see, so the sandbox is the only thing between it and the OS. | None, and none is wanted. This axis is an argument for the sandbox being mandatory, not for a wire. | **No.** The measurement loaded a prebuilt addon already in this repository's dependency tree for one platform; a case pinned to that path would assert a fixture. Resolved by an addon the suite builds for the platform it runs on. |
| The process's own identity — the values a plugin reads OFF the process to decide where to put things (`os.tmpdir()`, cwd, home). About those values *differing*, not about what may then be done with them; that is the next row, and a plugin can be broken by either alone. | The sandbox **substitutes** the temp root and creates nothing, so `os.tmpdir()` routinely does not exist: `readdirSync`/`mkdtempSync` fail `ENOENT` while a recursive `mkdir` on the same path succeeds. Home is substituted with a granted throwaway; cwd is inherited from the host and is not writable — the next row's answer, not this one's. | None needed — `pluginDataDir` is granted and exists before the child starts. | Yes — asserted by `confined-plugin-child.test.ts`, which runs on macOS (CI's macOS job included) and returns without measuring on the Linux CI runner, which has no bubblewrap. |
| **Filesystem reach** — every path the plugin touches that is not its own: a folder the user picked, an export written somewhere else, a file beside the app, a directory inherited from a version of itself that predates `pluginDataDir`. The **largest** capability the boundary removes. | Removed **asymmetrically**, so both halves have to be measured. **Write** is a real jail, but it is **not** the two paths the spawn names. It is those two — `pluginDataDir` and the throwaway sandbox HOME — **plus the default write paths ASRT merges into every wrap**, which no grant this repository passes can remove (`sandbox-manager.js` composes the allow-list as `[...getDefaultWritePaths(), ...userAllowWrite]`). At ASRT 0.0.73 those are the `/dev` entries, `/tmp/claude`, `/private/tmp/claude`, `<real home>/.npm/_logs` and `<real home>/.claude/debug` — the last two under the user's **own** home, not the substituted one. Not `pluginRoot` either, whose bytes the manifest hash was taken over (the child reads it and is refused `EPERM` writing into it). A path outside the two grants **and** off that default list fails `EPERM`, including paths the plugin built out of values the **host** handed it: a `renameSync` out of a directory under `context.hostRoot` fails with nothing moved. The second named grant is a trap that does not look like one: the sandbox **substitutes** `HOME`, so a plugin rooting its state at `homedir()` is neither denied nor durable — the write **succeeds**, into a directory the same module deletes when the child exits. **Four** outcomes, not two and not three: durable under `pluginDataDir`; `EPERM` outside the grants and off the default list; succeeding-then-vanishing under `homedir()`; and **succeeding and durable outside both grants**, on one of ASRT's default paths — measured on macOS/arm64 with the sandbox active, and now asserted with the host reading the bytes back. That fourth outcome **was** a hole, and the cross-application half is closed. Those paths are per-machine rather than per-plugin, so before the fix two confined plugins shared them — one confined child wrote bytes under the substituted temp root and a second, spawned with a different `pluginRoot` and `pluginDataDir`, read them back — and so did every **other** ASRT consumer on the machine: a confined plugin child listed 141 entries under `/tmp/claude` that were not this app's. The deny floor now carries `/tmp/claude`, `/private/tmp/claude`, `<real home>/.npm/_logs` and `<real home>/.claude/debug`, which ASRT applies as `denyWithinAllow` — asserted, with an **existence control** beside the `~/.npm/_logs` case, because a write to a missing directory also fails and a case that accepted any failure would go green on a machine with no npm cache. What made it possible was doing the temp root first: ASRT pointed `TMPDIR` *at* that list, so denying it also broke every `writeFileSync(join(tmpdir(), …))` in every confined child. The mechanism is `CLAUDE_CODE_TMPDIR`, which ASRT reads from the **wrapping process** rather than from a per-command option — and that is exactly why the remaining half stays open: the root is one directory for all of this app's confined children, and giving each child its own would mean mutating `process.env` around an `await` on the spawn path. **Read** is **not** a jail — ASRT's read model is deny-only, so a covering floor denies the known-sensitive subpaths (the secret store, the credential stores, the Electron userData directory holding every installed plugin) and `allowRead` only re-allows regions inside it. A path not on the floor stays readable. Both halves in one child: the secret file `EPERM`, while a directory under `hostRoot` **lists successfully** — the child sees the file it is then refused permission to move. | `hostApi.storage.*` for the plugin's own state — the wire **does** write on a plugin's behalf and deliberately cannot write anywhere else: its members take relative segments joined under `pluginDataDir`, and the containment guard refuses an absolute path outright and any join that escapes the root, so the write member is this jail expressed as an API rather than a hole through it. For a path the **user** chose there is **none**: no `hostApi` member opens a picker, and none accepts an absolute destination. "Put a file where the user asked" is the same shape as the windowing question below — a host capability with its own consent story, not a marshalling gap. | Yes, in both directions, and all four write outcomes — asserted by `confined-plugin-child.test.ts`, which runs on macOS (CI's macOS job included) and returns without measuring on the Linux CI runner, which has no bubblewrap. |

A plugin passes when every axis it touches has a mediated form **and already uses
it**. "Could be changed to use it" is a backlog item, not an admission. Per-plugin
status, with assumptions marked as assumptions, lives beside the set in
`src/plugins/isolation/out-of-process-plugins.ts` — that file is the SOT for
*whether*, this section is the SOT for *how it is decided*.

**How to check a plugin for each axis**, since the axes are only useful if a second
person reaches the same verdict from the same sources. For axes 1–4, find the
reaching construct in the plugin's sources **and its dependencies** — the socket, the
`electron` specifier by any resolution path (a `require` held in a variable, a
`createRequire`, a dynamic import, a dependency's re-export — a literal grep for
`require("electron")` misses the plugins that are actually on this axis), the spawn,
the `.node` load — then drive it in a real confined child. Count **call sites**, not
mentions: a member's name also appears in comments, in a type declaration, in the
guard that refuses to start without it and in a bind, so a count taken off a grep can
read a single call as heavy dependence — and the verdict then rests on a number
nobody took from a call. For axis 5, find every
path derived from `tmpdir()`, `homedir()` or `process.cwd()` and ask what happens
when the answer names something absent; an unguarded one in an activation body stops
the plugin from loading rather than degrading a feature. For axis 6, enumerate every
filesystem **write** — `writeFile`, `mkdir`, `rename`, `copyFile`, `rm`, a write
stream, a library handed an output path — and read what each path is *rooted* at.
Then sort each root into the four write outcomes, because three of them are not
`EPERM`: rooted at `pluginDataDir` is durable and the only one that is; rooted at
`homedir()` succeeds and vanishes at exit; on ASRT's default write list —
`/tmp/claude`, `/private/tmp/claude`, `<real home>/.npm/_logs`,
`<real home>/.claude/debug`, the `/dev` entries, and anything derived from
`tmpdir()`, which the sandbox points at that list — succeeds and is **durable**,
into a directory shared with every other confined plugin; and anything else
(`context.hostRoot`, `process.cwd()`, an absolute literal off that list, a path
from the plugin's config, a picker's return value) is **refused** `EPERM`. Check the
middle two by name: they are the cases that pass, and they are why "an absolute
literal is refused" is a **wrong** rule to check by — `/tmp/claude/x` is an absolute
literal and it is not refused. Reads need only the floor question: does it read
a secret store, another plugin's data, or the userData directory. Axis 6 is the one a
source census most often gets wrong in the plugin's favour, because a refusal arrives
as a runtime `EPERM` a `catch` may discard and the `homedir()` case never fails at
all — which is why the last step is always a real child and not a grep.

#### The inbound-listener question, answered

A second first-party plugin is refused on the **inbound** half of the egress axis:
its interactive sign-in binds a loopback listener to catch the OAuth redirect, and a
confined child does not get one. Unlike the windowing question below, this one has a
mediated form, and the reason is that the request underneath it is *one* request
rather than three: **something has to answer at the redirect URI**. Nothing about the
plugin's own code needs to run there.

So `hostApi.authRedirect` is a host capability with a narrow shape — `open`, `wait`,
`close`. The host binds `127.0.0.1:0`, answers the redirect, and hands back the query
parameters. The plugin chooses *when*, and nothing else: not the interface, not the
port, not the accepted method, not the response body. In particular the success page
is the host's, because a caller-supplied template would be plugin markup rendered by
the user's browser on a loopback origin — a capability nobody asked for, arriving
through a hole opened for a courtesy page.

Two details are load-bearing rather than cosmetic:

- The URI is reported as `http://localhost:<port>`, **by host name**. Identity
  providers register loopback redirect URIs by host and allow any port; `127.0.0.1`
  is a *different*, unregistered URI. Getting this wrong fails the sign-in at the
  provider, not in our code.
- A second `open` for the same plugin is **refused**, not granted by replacing the
  first. Replacing would strand a sign-in already in flight, whose redirect would then
  arrive at a closed port *after* the user had entered their password — which is the
  same post-authentication failure the capability exists to prevent.

`openAuthWindow` looks like it could already do this and cannot. Completion is
checked on `did-navigate` and deliberately **not** on `will-redirect` ("pre-commit
redirect intent — not yet observed by server"), so catching a redirect to a port
where nothing listens would rest on Chromium committing an error page for a refused
connection — and no response would be served, which the provider's flow expects.
Resting a credential path on error-page commit semantics is the kind of thing that
works until a Chromium upgrade.

#### The windowing question, answered rather than deferred

One first-party plugin is refused on the Electron axis: its primary tool opens a
floating recorder window. The obvious next move is "build a windowing wire". That
move is **not worth making**, and the reason is that "the plugin needs a window" is
three requests wearing one coat:

1. **Window lifecycle and geometry** — create, position from the primary display's
   work area, always-on-top, frameless, fixed size, close. This part marshals
   cleanly: a declarative window spec crosses, the host owns `screen` and
   `BrowserWindow`, an opaque handle comes back. Nothing here is hard.
2. **The window's contents** — plugin-authored markup and script, with a
   plugin-authored preload, in a renderer. This part is where a windowing wire
   would undo the stage. Shipping plugin code into a renderer is a **second
   evaluation of plugin JavaScript in a process the child does not control and the
   sandbox does not wrap**, and its preload holds an `ipcRenderer` channel to main.
   The boundary exists because plugin JS should not run beside host authority;
   re-admitting it through a window is the same defect at a different address.
   The host already has the safe version of this: `ui[]` `embedded-module` slots,
   loaded by the renderer out of the plugin root, which is why the recorder's
   sidebar entry is unaffected by the move at all.
3. **System-audio capture** — a partition-bound session whose display-media request
   handler the plugin installs, plus the platform flag for the OS audio tap. This is
   not windowing in any sense. The display-media handler decides *what the user's
   machine records*; letting a confined plugin install one would hand it a
   capability strictly more dangerous than `getSecret`, through a hole opened for
   window frames.

So the answer is not a windowing wire. It is that a recorder surface has to become a
**host capability**: the host owns the window, the partition and the display-media
handler behind its own declared permission and its own consent, and the plugin
contributes a UI module through the mechanism that already exists plus ordinary tool
calls. That is a host feature with a user-facing consent story, not a plugin
migration — and until it exists, the plugin **stays in-process** and its id stays out
of the routing SOT. Recording something the boundary cannot express is a better
outcome than a migration that silently ends it.

*Risk: low per PR, and it declines with each one.* If a plugin needs a marshalling
decision §3 did not anticipate, that decision lands here — visibly, one plugin at a
time, rather than as a surprise in a big-bang cutover. What raises the risk is not
marshalling but the ambient axes above, and those are why the criterion is a gate
rather than a checklist.

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

---

## 10. The two plugins no wire can admit, and why

*Added 2026-08-25, from measurement rather than from estimate. The routing SOT
carries the per-plugin verdicts; this section carries the reason the last two
are a different KIND of problem from the first three, so a future reader does
not spend a quarter building the wire that cannot work.*

`work-assistant`, `ms-graph` and `local-indexer` were admitted the same way
each time: an ambient axis had a mediated form, and the plugin was changed to
use it. `authRedirect` replaced a socket. `pickFolders` replaced `dialog`.
`pluginSocketDir` replaced a loopback bind. `userHome`/`lvisHome` replaced a
`homedir()` that a confined child answers wrongly. `resolveMappedDriveRoot`
replaced a `powershell.exe` spawn. Each is a small, host-owned answer to a
narrow request.

What they have in common is worth naming, because it is the test a proposed
capability has to pass: in every one of them the plugin contributes **data** and
the host contributes **code**. A drive letter, a partition name, a config key —
never a command, a script, or a function body. That is why each of these could
be added without moving the boundary, and it is exactly what the two plugins
below cannot be reduced to.

`ep-api` and `meeting` do not fit that shape, and the reason is the same for
both. **Neither is blocked on a missing host API. Both ship code that is
written to run somewhere the boundary does not reach.**

- `ep-api` drives portal pages with Playwright. Of its 40 `evaluate` call
  sites, 31 pass a **function body** that is compiled and run inside an
  authenticated page.
- `meeting` opens a recorder `BrowserWindow` whose `preload` and renderer are
  the plugin's own files, loaded into a renderer outside the sandbox.

A wire cannot mediate that. To mediate it, the host would have to accept
plugin-authored code and execute it in a privileged context on the plugin's
behalf — which removes the boundary rather than enforcing it. **Mediating
`evaluate` mediates nothing.** So there are exactly two ways out, and both are
migrations rather than wires:

1. **The code moves to the host** and becomes first-party — reviewed, signed
   and released with the app, rather than installed from a marketplace.
2. **The need is met by data instead of code** — a REST call, a parameter, a
   declarative spec — so nothing needs to execute anywhere privileged.

### `ep-api` — one id, three unrelated problems

Measured per client file, which is what shows they are not one problem:

| client | Playwright sites | `hostFetch` | what it means |
| --- | ---: | ---: | --- |
| `attendanceClient` | 0 | 2 | already route (2) |
| `approvalClient` | 0 | 2 | already route (2) |
| the internal REST client | 0 | 3 | already route (2) |
| `parkingClient` | 40 | 2 | route (2), **started** |
| `videoConferenceClient` | 13 | 2 | route (2), **started** |
| the internal chat-assistant client | 38 | 0 | genuinely open |
| the directory-identity client | 0 | 0 | not a browser problem at all |

Three clients have already completed route (2), which is the existence proof
that the route works for this portal. Two more have begun it — the `hostFetch`
calls in `parkingClient` and `videoConferenceClient` are not decoration, they
are the first endpoints of the same migration. So the bulk of `ep-api` is not a
design question; it is unfinished work with a proven pattern.

What is left after that is two things the browser question never covered:

- **the chat-assistant client** — an internal chat UI with no API behind it. Route (2) needs an
  endpoint that does not exist yet; route (1) needs the driving code to become
  host first-party. This is the only part of `ep-api` that is genuinely undecided.
- **the directory-identity client** — `spawn`s a shell interpreter and a
  directory-lookup binary to resolve a
  user identity. Ambient axis 3, reachable from the plugin's entry, and **the
  routing SOT does not name it**. It needs a mediated identity lookup and is
  unaffected by whatever happens to the browser flows.

### `meeting` — the window is not the request

The floating recorder looks like "a plugin needs a window". It is three
requests wearing one coat, and the code says which is which:

1. **Chrome and placement** — frameless, transparent, `alwaysOnTop`, positioned
   from `screen.getPrimaryDisplay().workArea`. Parameters. A host that owned the
   window would take them as data.
2. **Capture** — the renderer exists for Web APIs that only exist in a renderer:
   `getUserMedia`, `getDisplayMedia`, `AudioContext`, `AudioWorklet`, with the
   system-audio leg routed through a partition-scoped `session` and
   `electron-audio-loopback`'s handler. This is the irreducible part, and it is
   irreducible in the HOST's favour: only the host has a renderer inside the
   trust boundary.
3. **The plugin's own UI code** — `recorder-window-preload.cjs` plus a
   1247-line renderer, loaded from `pluginRoot`.

The protocol between them is **already data-shaped**: ten `ipcMain` channels,
and nine of them are `get-init`, `get-theme`, `get-detail`, `get-levels`,
`resize`, and the four lifecycle verbs. Only `push-chunk` carries a payload,
and it carries audio.

That is the whole design. A host-owned recorder capability serves (1) and (2),
answers the `get-*` channels from data the plugin supplies over the existing
boundary, and delivers chunks back to it. The plugin stops owning a window and
becomes the consumer of a recording. **Do not build a windowing wire** — a wire
that let a plugin open a BrowserWindow and load its own preload would hand back
exactly the reach isolation removed, with more steps.
