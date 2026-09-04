# Tailnet Observer Configuration Surface Redesign

> Status: **Proposal** (issue #2112, part 3 of 3). Source files and tests are
> authoritative when this prose and implementation disagree.

## 1. Current state: env-only configuration

The Tailnet observer — the separate, default-OFF loopback listener over the
shared conversation projection — is configured exclusively through boot
environment variables. The single resolver is `resolveTailnetObserverConfig`
(`src/main/tailnet-surface-server.ts:69-114`):

| Env var | Meaning | Validation |
|---|---|---|
| `LVIS_TAILNET_OBSERVER` | enable (`"1"`) | anything else → observer OFF |
| `LVIS_TAILNET_OBSERVER_CAP` | expected app-capability key (required when ON) | `isCapabilityKey` (length ≤ 512, no control chars, no proto-pollution keys); missing/invalid → throw `tailnet-observer-capability-missing-or-invalid` |
| `LVIS_TAILNET_OBSERVER_PORT` | listener port | `parseFixedPort`; default `DEFAULT_TAILNET_OBSERVER_PORT` = 46173 |
| `LVIS_TAILNET_CONTROLLER` | enable controller commands | must be `"1"` if set, else throw |
| `LVIS_TAILNET_PAIRED_SHARING` | enable P2 paired sharing | must be `"1"` if set, else throw |
| `LVIS_TAILNET_WEB` | enable web surface | requires paired sharing; else throw |
| `LVIS_TAILNET_WEB_ORIGIN` | web origin | `isTailnetWebOrigin`; missing/invalid → throw |

Seven env vars, one resolver, two read sites:

1. `src/main.ts:194` — boot pre-resolve; when `pairedSharingEnabled`, main
   constructs the paired-sharing runtime and the owner service
   (`createTailnetSharingOwnerService`). A throw here sets
   `tailnetPairedSharingBootstrapUnavailable = true` (`main.ts:205`) and the
   owner controls stay silently unavailable.
2. `src/main.ts:327` → `maybeStartTailnetObserverServer`, which re-resolves
   inside `startForBoot` (`tailnet-surface-server.ts:144`). A start failure
   is logged (`main.ts:340`) and boot continues.

Lifecycle: idempotent start, shutdown via `stopTailnetObserverServer` ordered
after the local API in `src/main/app-shutdown.ts:111`. Contract tests:
`src/main/__tests__/tailnet-surface-server.test.ts` (config matrix,
fail-closed throws, lifecycle races).

The renderer side already has a Tailnet tab —
`src/ui/renderer/tabs/TailnetAccessContent.tsx` under the `remote-surfaces`
settings group (`src/shared/settings-tabs.ts:60`), backed by the
`src/ipc/domains/tailnet-sharing.ts` domain and
`src/main/tailnet-sharing-owner-service.ts` — but it manages *shares and
invitations only*. The observer's own configuration is invisible to it.

### Why this hurts

- **Invisible configuration.** A desktop-app user cannot see, set, or verify
  any of the seven variables without relaunching the process with a modified
  environment.
- **Silent partial failure.** Misconfiguration throws kebab-case errors that
  land only in the main-process log; the tab renders as if paired sharing
  simply does not exist (`tailnetPairedSharingBootstrapUnavailable` has no
  renderer surface).
- **No diagnosis surface.** "Is the observer listening, on which port, with
  which capability, and why not" is unanswerable in-app.

The one property worth keeping is stated in the resolver's own doc comment:
the renderer never supplies the capability value, *so a webpage cannot widen
Tailnet policy by editing ordinary settings*. Any redesign must preserve that
invariant, not merely move the values into the ordinary settings store.

## 2. Design

### 2.1 Host-owned configuration file

Persist the observer configuration as a host-owned file under the storage
chokepoint: `openFeatureNamespace("tailnet")`
(`src/main/storage/feature-namespace.ts`; `0o700` dir / `0o600` file per the
repository contract) → `~/.lvis/tailnet/observer.json`. The schema mirrors
`TailnetObserverConfig` exactly: `{enabled, port, expectedAppCapability,
controllerEnabled, pairedSharingEnabled, webOrigin?}`. The file is read and
validated by the main process only, with the *same* validators the env path
uses today (`isCapabilityKey`, `parseFixedPort`, `isTailnetWebOrigin`) so the
two sources cannot drift. It is deliberately **not** part of
`settings-store.ts`: the ordinary settings pipeline is renderer-writable by
design, which is exactly what the capability invariant forbids.

### 2.2 Host approval gate on mutation

The renderer (Tailnet tab) may *propose* a configuration change over a new
IPC domain handler; the main process validates it and raises an explicit host
approval before persisting — the same posture as the existing Tailnet trust
machinery (controller receipts in
`src/api/tailnet-controller-receipt-store.ts`, paired-share authorization in
`src/main/tailnet-paired-share-authorizer.ts`). Rules:

- Enabling the observer, changing the port, changing the capability key, or
  widening scope (controller, paired sharing, web origin) each require an
  approval whose prompt displays the full proposed values — the user
  approves the *content*, not an opaque "apply settings" action.
- Narrowing or disabling persists without a modal (fail-safe direction) but
  is still audited.
- The IPC channel ships as one coherent change: handler, preload bridge,
  shared types, sender guard, and tests together; handler errors use stable
  kebab-case codes mapped to localized text in the renderer
  (`src/ui/renderer/format-ipc-error.ts` convention).

Applying a change to a *running* listener follows the existing lifecycle:
stop via `stopTailnetObserverServer`, restart via
`maybeStartTailnetObserverServer` with the new resolved config — no hot
mutation of a live server.

### 2.3 Env demoted to override

`resolveTailnetObserverConfig` gains a layered resolution: read the
host-owned file first, then apply env vars as an **override layer** (present
env var wins per key, preserving today's deployments and test rigs). Two
consequences are deliberate:

- The boot log and the diagnostics surface (§2.4) must mark each key whose
  effective value came from env (`source: "env-override"`), so a stale shell
  profile cannot masquerade as the approved configuration.
- Env-originated widening (e.g. file says observer OFF, env says ON) is
  accepted — an environment-setting principal already owns the process — but
  it is what the diagnostics tab exists to make visible. A later phase can
  gate env overrides behind a build flag once the file surface has been the
  default for a release.

### 2.4 In-tab self-diagnostics

Extend `TailnetAccessContent.tsx` with a read-only diagnostics section fed by
a snapshot IPC query (main → renderer, no mutation authority):

- **Effective config + provenance**: each key with its value (capability key
  fingerprinted, not echoed in full) and source (`file` / `env-override` /
  `default` / `off`).
- **Listener state**: not-configured / listening on `127.0.0.1:<port>` /
  failed, with the resolver's kebab-case error code (e.g.
  `tailnet-observer-capability-missing-or-invalid`,
  `tailnet-web-requires-paired-sharing`) rendered as localized text.
- **Runtime availability**: paired-sharing runtime state — surfacing what is
  today only the boolean `tailnetPairedSharingBootstrapUnavailable` and a
  log line — plus controller receipt-store presence.

This replaces log-diving with an in-app answer to "why is my observer not
up", without granting the renderer any new authority: the snapshot is
descriptive, and every mutation still crosses the §2.2 approval gate.

### 2.5 Invariants preserved

- OFF remains side-effect free: no file, no port, no runtime is touched when
  neither file nor env enables the observer.
- The listener binds `127.0.0.1` only; reverse-proxy exposure to the tailnet
  stays a deployment-admin action outside this process, exactly as the
  current module header states.
- Fail-closed resolution: an invalid file is an error surfaced in
  diagnostics, never a partially-applied config; the resolver keeps throwing
  rather than guessing.

### 2.6 Guided setup

The form above is complete and, for a first-time owner, over-asked: six of its
seven questions have exactly one defensible answer, and the two values that
genuinely differ per machine — the loopback port and the web origin — are
things the host can read rather than ask about. `guidedSetup` is that whole
configuration as one host-side operation, and it is the only thing the
`remote-tailnet-observer` position asks for once the probe says the environment
is ready: a collapsed card carrying that state, the account and node the probe
named, and one button that runs it. That button is also the probe — it re-reads
the environment before it commits, so a "ready" that went stale since the
section mounted can never be the state guided setup acts on, and no separate
re-check control exists to ask the reader to do that verification themselves.

**What the host decides.** The authorization boundary is `tailnet-identity`
(the pairing code is what turns an identity into a share; an app capability
needs a tailnet administrator, so it cannot be a default). Paired sharing and
the web surface are ON because they are what the owner came for; the controller
stays OFF because accepting remote commands is a separate decision nobody was
asked to make. The web origin is derived from MagicDNS exactly as `apply`
derives it. Serve runs unless the probe already reports it forwarding to this
same port.

**What stays manual.** Everything, on request: a quiet "set up manually" beside
the connect button reveals the full form inline, and a configured desktop can
still reveal it from the status card. An app capability, a hand-picked port, and
the controller are only reachable there.

**The port rule.** Preference order is the port already in the file, then
`DEFAULT_TAILNET_OBSERVER_PORT`, then whatever the OS hands out for
`127.0.0.1:0`. The listener binds one fixed port with no fallback, so an
occupied port is otherwise a start failure with nothing on screen that would
fix it. The chosen port is persisted: a port re-rolled at each launch would
move the target out from under Tailscale Serve every restart. A port this
process is already listening on is kept without probing, because the restart
releases it. If nothing binds, guided setup refuses with
`tailnet-guided-setup-port-unavailable` rather than writing a configuration
that cannot come up.

**Gate.** The channel is `apply` plus `configureServe` in one press, so it
carries exactly their gate — host-renderer sender plus a fresh local keyboard
intent — and takes nothing from the payload.

## 3. Migration and validation

Phase A ships the file + resolver layering + diagnostics with env fully
honoured (pure addition; existing `tailnet-surface-server.test.ts` matrix
extended with file/env-precedence cases). Phase B ships the tab's propose +
approve mutation path. Targeted tests: resolver layering unit tests, IPC
domain tests (`src/ipc/domains/__tests__/tailnet-sharing.test.ts` pattern),
owner-service tests, and one renderer spec for the diagnostics section; full
gate at publish.

## Related Entry Points

- [Architecture](../architecture.md) — Security And Audit
- [Permission policy design](../permission-policy-design.md)
