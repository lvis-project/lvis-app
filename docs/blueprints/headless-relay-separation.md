# Headless Relay Separation — Chat Relay / Response Server as a Headless SSOT

> Status: **Design** (not implemented). This document is a plan others implement
> against; it lands with exactly one normative code change (Step 0) and no
> refactor.
>
> Extends — does not restate — `docs/architecture/architecture.md`
> "Layer Map", "Process Boundaries", and "Tool Governance". Where this document
> and the architecture SSOT disagree, the SSOT wins; where this document and the
> source disagree, the source wins.
>
> Predecessor: `docs/blueprints/host-structure-alignment.md` landed the
> transport-agnostic core, the loopback local API (`api/http-server.ts`,
> `POST /v1/dispatch` + `GET /v1/events` SSE), the CLI over that contract, and
> approval-gate-mediated external mutation. Its own "remaining follow-ups"
> named the two things this design formalizes: authenticated non-renderer
> authorization for the rest of the gesture-gated surface, and running the host
> beyond a window-bound process. This document turns that follow-up into a
> reviewable, ordered plan.

## 1. Problem, stated as two axes

The request path and the consent path are separable, and only one of them is
still entangled with Electron.

- **Axis 1 — request path (already clean).** The modules that receive a chat
  request, run the turn, execute tools, and stream the response carry no
  Electron import. Measured at the branch point (§Appendix A): `src/api`,
  `src/engine`, and `src/cli` contain zero `electron` imports of any kind, and
  the one host-owned command entrypoint every interactive surface reaches —
  `src/main/conversation-command-port.ts` — imports no Electron. So the relay
  is **unexpressed structure, not entanglement**: the separation already exists
  in the dependency graph but is not named anywhere, so nothing keeps it from
  regressing and no entrypoint exercises it without a window.

- **Axis 2 — consent path (not yet an SSOT).** With the app window closed, an
  external-origin *mutating* request that reaches the approval chokepoint is
  denied for that call, because the chokepoint's liveness gate is a live
  Electron `WebContents`. This is correct fail-closed behavior, but it means a
  windowless host process cannot approve anything a human would have approved —
  the consent surface, not the request path, is what is bound to Electron.

The goal is to make the relay a first-class **headless SSOT**: a host process
that can run the request path with no Electron window, where consent is resolved
through a surface *port* rather than a hard `WebContents` dependency, and where
the current deny-when-no-surface semantics are preserved exactly.

### 1.1 A naming hazard to avoid

The engine already has a per-turn boolean named `headless`
(`src/engine/turn/types.ts`, consumed in `src/engine/turn/query-loop.ts`). It
means "background/routine loop: write tools must ask and cannot rely on
auto/allow cache" — a routine running *inside* the full Electron app with a
window still present. That is a different axis from this document's
*process-level* headlessness (no Electron window exists at all). The design must
not overload the existing flag; where a new term is needed, prefer
"windowless host process" or "surface-detached", and keep the per-turn
`headless` attention flag untouched.

## 2. What is already true (verified, not assumed)

Each claim below was read at the branch point; the reproducing commands are in
Appendix A. Symbols are cited instead of line numbers because line numbers
drift.

1. **No runtime Electron on the request path.** Across `src/engine`, `src/api`,
   `src/permissions`, and `src/data`, the only runtime (value) `electron`
   import is `src/data/settings-store.ts` importing `safeStorage`. Every other
   Electron reference on this path is `import type` (erased at compile time),
   including `ApprovalGate`'s `import type { WebContents }` and `IpcDeps`'
   `import type { BrowserWindow }`.

2. **The consent port already exists in embryo.** `ApprovalGate` exposes
   `observePendingApprovals(observer)` and
   `resolve(requestId, decision, answeredBy)`. `answeredBy` is a member of a
   closed set, `ApprovalAnswerer` = `{ desk, away-authority, parent-agent,
   platform-bridge }`, keyed off the single `APPROVAL_ANSWERER_AUDIT_TOKENS`
   table so the type cannot gain a surface kind without also declaring its
   audit token. `answeredBy` is **host-derived** — fixed by the caller of
   `resolve`, never read from the decision payload — so a compromised renderer
   cannot claim a different actor.

3. **A second consent surface already relays into the same chokepoint.**
   `src/main/telegram-remote-approval.ts` observes the pending set through
   `observePendingApprovals` and answers through
   `gate.resolve(requestId, decision, "platform-bridge")` — the *same* resolve
   path the desk's IPC handler calls, under the same nonce/HMAC and
   allowed-choice checks. It holds no `WebContents`. This is the precedent for
   a surface that is not the Electron window.

4. **The `WebContents` coupling is the desk surface's outbound leg only.**
   `ApprovalGate` uses its `webContents` field in exactly two runtime ways:
   `webContents.isDestroyed()` (liveness gate → deny-once) and
   `webContents.send(IPC_APPROVAL_REQUEST, …)` (push the parked request to the
   desk). The desk is the only surface that receives a *push*; Telegram is
   offered *reactively* through the observer. So "present a request to the
   desk" and "is the desk alive" are the two behaviors a port must re-express.

5. **The deny-when-no-surface semantics, precisely.** In `requestAndWait` the
   ordering is: sensitive-path hard-block → deny-once; read-only auto-approve →
   allow-once; **`webContents.isDestroyed()` → deny-once**; away-authority
   consume; parent adjudication; park + `webContents.send`. A second
   deny-once guards the send itself (a `try/catch` for the window dying between
   the check and the send). Two consequences matter for the port:
   - It is external-origin **mutating** requests that deny-once with no
     surface; read-only requests short-circuit to allow-once *before* the
     liveness gate, so a windowless process still serves reads.
   - The liveness gate sits **before** the away-authority and parent-agent
     short-circuits. Today, therefore, a destroyed window denies-once *even
     when an away-authority is armed*. See §5.5 — this is a latent tension the
     port must resolve deliberately, not inherit by accident.

6. **`resolve` is first-writer-wins by construction.** `resolve` runs
   synchronously from `pending.get(requestId)` through
   `pending.delete(requestId)` with no `await` between them. On the single
   main-process event loop, two surfaces answering the same request serialize;
   the second finds no entry and returns `null`. No double decision is
   reachable through `resolve`.

## 3. The four coupling points — essential vs incidental

The task is to separate what the security model *requires* from what is merely
an Electron accident. Where the evidence is not decisive, both readings are
given and the call is deferred to the implementing review.

| # | Coupling | Verdict | Evidence |
|---|---|---|---|
| A | **Consent** — `ApprovalGate` constructor takes a `WebContents` | **One essential requirement, incidental mechanism** | Essential: a mutating external-origin request must reach a live surface that a principal can answer, or be denied. Incidental: that surface being an Electron `WebContents` — Telegram already answers through `resolve` with no `WebContents` (§2.3). |
| B | **IpcDeps** — non-optional `getMainWindow` | **Incidental** | Consumed at one site, `broadcastPermissionModeChanged` in `src/ipc/handlers/permissions.ts`, via `deps.getMainWindow?.()` and `deps.getAppWindows?.()`; `sendToWindow(null, …)` returns `false` (a no-op). It is a renderer cache-refresh notice, not on the request-execution path. The Electron import here is `import type { BrowserWindow }` (erased). |
| C | **Secret store** — `safeStorage` value-imports | **Incidental for the seam'd runtimes; unresolved for `settings-store`** | The `SecretEncryption` interface (`src/data/secret-document-store.ts`) imports no Electron. Three optional relay runtimes already inject it: `tailnet-paired-sharing-runtime.ts`, `a2a-remote-runtime.ts`, `telegram-platform-runtime.ts` each default `options.encryption ?? safeStorage`. But `src/data/settings-store.ts` hardwires `encryption: safeStorage` and does not expose the seam — a fourth value-import the design must account for, not paper over (§4, Step 3). |
| D | **Placement / entry** — relay modules in `src/main`, sole entry is Electron boot | **Incidental** | The relay ingress modules are Electron-free or type-only (`local-api-server.ts` only `import type { BrowserWindow }`; `conversation-command-port.ts` imports no Electron). The one true runtime value-import that forces a window is the entry itself: `src/main.ts` imports `app` from Electron. |

## 4. The six steps

Ordering principle: the norm leads (Step 0), the behavior-neutral mechanics
follow (Steps 1–4), and the one behavioral, security-sensitive change lands
last with adversarial review (Step 5). Sizes are relative effort, not line
counts.

### Step 0 — Name the relay/ingress layer in the architecture SSOT *(this PR)*

**What changes.** A "Relay and ingress" row is added to the Layer Map and a
paragraph to Process Boundaries in `docs/architecture/architecture.md`, and that
section points here for detail (mirroring how "Sub-agent Messaging (A2A)"
points to its blueprint).

**Why it leads.** The later refactor PRs need a norm to converge on. Without a
named layer, "these modules are Electron-free relay" is a fact nobody is
accountable to; with it, a reviewer can reject a new Electron import into the
relay as a boundary violation. This is the only change made in code in this
lane.

**Size.** Small (documentation only). No behavior, no runtime import.

### Step 1 — Placement: give the relay an ingress home

**What changes.** Relocate the Electron-free relay/ingress modules out of
`src/main` into a named home (candidate: `src/relay`, or extend the existing
`src/api` surface — the implementing PR picks one and states why), leaving
compatibility re-exports where boot composition still imports them. Candidates
are the modules identified in §3.D and Appendix A; the exact set is enumerated
in the Step 1 PR after re-running the classification at its own HEAD.

**Why.** Placement is what makes the boundary enforceable: a directory the
`check:import-cycles` and lint config can hold to "no Electron runtime import".
Today the relay is discoverable only by grep.

**Size.** Large by file count, near-zero by logic: moves plus re-exports, each
proven behavior-identical by the existing suite. No new state store, IPC
channel, or policy path (the "Current Large-Module Ownership" rule in the SSOT
applies).

**Open question (flag for the PR).** Whether the home is a new top-level
`src/relay` or an extension of `src/api`. New-file rule (`CLAUDE.md`) applies:
prefer extending `src/api` unless a real domain boundary or a test-isolation
reason justifies a new root. Do not create a second command entrypoint —
`conversation-command-port.ts` stays the one seam.

### Step 2 — Headless entry: a windowless host composition

**What changes.** Add a boot entry that composes host services and the relay
ingress **without** importing Electron `app` — reusing the staged `BootContext`
and the own-property readiness assertion the SSOT already mandates, so a missing
producer is still named rather than leaking `undefined`. The Electron `main.ts`
remains one entry among two, not the only one.

**Why.** This is what turns "the request path happens to be Electron-free" into
"the request path runs without Electron", and it is where the deny-when-no-
surface behavior (§2.5) becomes reachable in production.

**Size.** Medium. Mostly wiring an existing composition through a new top; the
hard content is deciding what a windowless composition legitimately omits
(no tray, no window manager) versus what it must still provide.

**Sequencing constraint (hard).** The headless entry must not be advertised for
mutating flows until Step 5 lands. Before Step 5, a windowless process denies
every mutating external-origin request (fail-closed, but useless for anything
but reads). This is safe, not shippable-as-complete; do not paper over it with
an auto-approve.

### Step 3 — Secret-store injection

**What changes.** Thread a `SecretEncryption` implementation from the headless
entry into the three runtimes that already accept `options.encryption`
(§3.C), and **decide `settings-store` explicitly**: either expose the same
injection seam on `SettingsServiceOptions` (preferred — it makes the last
hardwired `safeStorage` value-import injectable and consistent with the other
three) or document why the windowless entry still supplies Electron
`safeStorage`.

**Why.** `safeStorage` is the OS-keychain-backed encryption; a windowless host
process still needs *some* `SecretEncryption`. The seam exists for three
callers; settings-store is the gap.

**Size.** Small in code (three existing seams plus one new one), but carries a
real security decision: what `SecretEncryption` a non-Electron process uses.
**No fallback:** if the chosen implementation reports
`isEncryptionAvailable() === false`, secret reads/writes must fail closed
(the current `secret-document-store.ts` contract), never silently downgrade to
plaintext.

### Step 4 — IpcDeps: an honest, optional surface-broadcast

**What changes.** Make the window accessor honest about a windowless world:
either mark `getMainWindow` optional on `IpcDeps` or replace the single
consumer (`broadcastPermissionModeChanged`) with a surface-broadcast port that
fans out to whatever surfaces are attached and no-ops with zero. Behavior is
already null-safe (§3.B); this step removes the *type* obligation that a window
exists.

**Why.** So the headless entry need not fabricate a `BrowserWindow` to satisfy
`IpcDeps`. This is a type-honesty change, not a behavior change.

**Size.** Small. One type and one function; the runtime already tolerates a
missing window.

### Step 5 — Consent-surface port *(the hard step — full analysis in §5)*

**What changes.** `ApprovalGate` stops taking a `WebContents` in its
constructor. The desk becomes a `ConsentSurface` that owns its own
`WebContents` and subscribes through the observer mechanism the gate already
has, doing its own `send`. The gate holds a set of attached surfaces; "present
to the desk" and "is the desk alive" become surface methods; the liveness gate
becomes "no reachable surface → deny-once", preserving §2.5 exactly.

**Why.** This is the one coupling whose removal changes behavior, because it
changes *who can be asked* when there is no window. It is also the coupling that
makes axis-2 an SSOT: after it, consent is a port with N surfaces (desk,
platform-bridge, and any future one), not a hard dependency on one.

**Size.** Medium-to-large and behavioral. It touches the security-critical
`requestAndWait`/`resolve` core and requires the adversarial review in §5.

## 5. Consent-surface port — the security analysis a review will demand

The recommended shape reuses what exists: the gate already fans `onPending` to a
`pendingObservers` set and already accepts answers through `resolve(…,
answeredBy)`. The port makes the **desk** one more observer-backed surface
instead of a privileged `WebContents` field. The four questions below are the
ones a security review will ask; each is answered against the current code and,
where the answer is a design choice rather than a fact, marked as such.

### 5.1 The window-destroyed race

**Today (N = 1 surface).** Two guards: a pre-park `isDestroyed()` check and a
`try/catch` around `send` for the window dying *between* the check and the send.
Both resolve deny-once. The window can die at any instant; the `try/catch` is
what makes the check-then-send sequence safe.

**Under the port (N ≥ 1 surfaces).** A surface may report reachable and then
die during `present`. The design rule:
- A per-surface `present` failure removes that surface from the live set *for
  this request* but does **not** deny if another surface presented
  successfully.
- If the live set for a parked request becomes empty before any answer
  arrives, the entry resolves **deny-once** — the N = 1 case is exactly today's
  behavior.

**Open question (flag).** Today reachability is knowable synchronously
(`isDestroyed()`). A surface whose reachability is only knowable
asynchronously (a remote bridge) needs a bounded *present-ack* window, and
"no surface acknowledged presentation within the window" must resolve
deny-once. The port must define that window rather than block forever; a
never-acked request that also never times out would be a liveness hole. This is
a decision the Step 5 PR owns; it is not settled here.

### 5.2 Multiple surfaces approving (or splitting) concurrently

**Fact, not choice.** `resolve` is synchronous from `get` to `delete` (§2.6),
so first-writer-wins holds unchanged: if the desk approves while a bridge
denies in the same tick, one runs to completion and deletes the entry; the
other finds nothing and returns `null`. No double decision.

**Invariant the port must keep.** Surfaces *present* a gate-minted entry; they
do not *create* entries. A second surface showing the same request must carry
the same `requestId`/`nonce`/`hmac` the gate minted, so a surface cannot forge a
parallel decision with fresh integrity material — the existing
`verifyApprovalIntegrity` check in `resolve` already forces deny-once on a
mismatch, and that check must remain the only door.

### 5.3 Per-surface actor identity

**Today.** `ApprovalAnswerer` names a surface *kind* (desk / away-authority /
parent-agent / platform-bridge), host-derived and audited through the single
`APPROVAL_ANSWERER_AUDIT_TOKENS` table. Two app windows both answer as `desk`
and are indistinguishable in the audit row.

**The choice.** Does the port need per-*instance* identity (which window, which
device)?
- For it: a multi-surface or remote future may want to know which surface a
  human used.
- Against it: the model deliberately partitions by *where the owner was* (desk
  vs bridge), not *which device*; per-instance identity widens both the audit
  vocabulary and the trust-derivation surface a compromised caller could try to
  spoof.

**Recommendation (under-claimed).** Keep the closed-kind set. A genuinely new
surface (for example a windowless remote console) earns its *own* token in the
one table — the `keyof` typing forces that — and instance-level attribution is
added only if a specific review demands it. This document does **not** assert
per-instance identity is required.

### 5.4 Fail-closed when zero surfaces are attached

**The invariant to preserve, verbatim in effect.** With no reachable consent
surface, a mutating external-origin request resolves **deny-once**, audited with
the existing `[approval:send-failed] … → deny-once` marker (or an equivalent
`no-surface` reason). This must fire for *every* such request in a windowless
process with no bridge attached — which is exactly the current behavior the
problem statement describes.

**The anti-pattern to forbid.** Absence of a surface is a **denial**, never a
deferral that later auto-resolves, and never an auto-approve. A "queue until a
surface appears, then approve" path would convert fail-closed into fail-open and
is out of scope by construction. (This is the `CLAUDE.md` no-fallback rule
applied to the consent surface: fail closed and loudly.)

**Scope of the claim.** Read-only requests are unaffected — they short-circuit
to allow-once *before* the surface is consulted (§2.5), so a windowless process
still serves reads while denying mutations.

### 5.5 The latent tension the port must resolve deliberately

Verified in §2.5: the liveness gate today sits **before** the away-authority
and parent-agent short-circuits. So a destroyed window currently denies-once
*even when an away-authority is armed* — despite the away-authority's own audit
comment describing it as "no window was involved … a local gesture the owner
made in advance", i.e. conceptually window-independent. Two readings, both
supported by the code:
- **The position is intentional:** the away-authority is armed by a desk
  gesture and is meant to answer only while a desk exists.
- **The position is incidental:** the liveness gate predates the away-authority
  and simply sits early; the away-authority *should* be consultable headlessly.

**Recommendation (under-claimed).** The first Step 5 PR **preserves the
position** — "no reachable surface → deny-once" stays *before* away/parent, so
the change is provably behavior-identical for the window case and adds no new
authority to a windowless process. Whether to move the no-surface denial
*after* the away-authority/parent short-circuits — letting a pre-armed
authorization answer headlessly — is a **separate, explicitly-reviewed policy
change**, because it widens what a windowless process can approve. This
document does not decide it; it names it so the port does not change it by
accident.

## 6. Non-goals

- **No remote or multi-user exposure.** The loopback + paired-bridge trust model
  is unchanged; this is about window-independence, not network exposure.
- **No new consent policy.** Steps 1–5 must be decision-preserving; §5.5 is
  called out precisely so it is *not* changed silently.
- **No second command entrypoint, state store, IPC channel, or policy path.**
  The relocation in Step 1 is placement only.
- **The per-turn `headless` flag is untouched** (§1.1).

## Appendix A — Reproducing the measurements

Run from the repository root at the branch point. These commands are the source
of every count and claim above; numbers are stated as "measured at branch
point" because they drift as the tree changes.

```bash
# §2.1 — request path carries no Electron import (expect: empty)
grep -rlE "from ['\"]electron['\"]|require\(['\"]electron['\"]\)" src/api src/engine src/cli

# §2.1 — only runtime (value) Electron import on the request/consent path
#         (expect: src/data/settings-store.ts only)
grep -rn "from ['\"]electron['\"]" src/engine src/api src/permissions src/data \
  --include="*.ts" | grep -v "import type" | grep -v "__tests__"

# §3.C — the three seam'd secret-store runtimes (expect: 3 files, 4 hits)
grep -rn "options.encryption ?? safeStorage" src --include="*.ts" | grep -v __tests__

# §3.C — the fourth, hardwired value-import without the seam
grep -n "encryption: safeStorage" src/data/settings-store.ts

# §3.D / §4 Step 1 — Electron-free share of top-level src/main modules
#          (measured at branch point: 82 of 114)
total=0; free=0
for f in src/main/*.ts; do case "$f" in *__tests__*) continue;; esac
  total=$((total+1))
  grep -qE "from ['\"]electron['\"]|require\(['\"]electron['\"]\)" "$f" || free=$((free+1))
done; echo "$free of $total electron-free"

# §2.4 — WebContents in the gate: 3 lines = 1 constructor assignment + the
#         2 runtime reads (isDestroyed, send)
grep -n "this.webContents" src/permissions/approval-gate.ts

# §2.2 / §2.3 — the consent port and its second surface
grep -n "observePendingApprovals\|APPROVAL_ANSWERER_AUDIT_TOKENS" src/permissions/approval-gate.ts
grep -n "gate.resolve\|platform-bridge" src/main/telegram-remote-approval.ts
```
