# Native Linux host

The native launcher runs the shared LVIS host under a bundled standalone Node
runtime. It supports one-shot commands and a persistent server without creating
desktop windows. Desktop-only operations require a desktop capability and fail
when that capability is absent.

## Build the artifact

Run the producer on Linux from the clean source checkout that built the desktop
application. Keep that build's `resources/app.asar`, `app.asar.unpacked`, and
extra resources together. Supply an exact Node 22 runtime for the target
architecture and its matching license; retain their version and checksum with
the build record. The output directory must not already exist.

```sh
node scripts/package-headless-runtime.mjs \
  --app "$DESKTOP_APP_DIR" \
  --node "$NODE_BINARY" \
  --node-license "$NODE_LICENSE" \
  --out "$RUNTIME_DIR"
```

`DESKTOP_APP_DIR` is the unpacked Linux application directory containing
`resources/`; `NODE_BINARY` is the standalone executable; `NODE_LICENSE` is its
license file; `RUNTIME_DIR` is the new artifact directory. The producer checks
the embedded build identity and generated output hashes, extracts the app and
dependencies, and copies extra resources. It creates `bin/node`,
`app/dist/src/main/headless.js`, `resources/`, and the `lvis` launcher. Its native
probe exercises a database, a pseudo-terminal, and packaged resource resolution.
Keep `runtime-manifest.json` and the manifest digest returned on stdout with
the artifact's qualification record.

The launcher supplies production mode and its own resource directory. From the
artifact directory, run this resource diagnostic before host setup:

```sh
./lvis --runtime-check
```

This command runs alone. It checks the packaged UV executable and MCP `uvx`
resolution using a temporary cache before normal boot, key loading, or profile
locking. It does not run a conversation or prove every server feature works.

## Select a profile and external key

Use a dedicated native profile when an existing desktop profile contains
encrypted data:

```sh
export LVIS_HOME="$HOME/.lvis-server"
export LVIS_USER_DATA_DIR="$HOME/.config/lvis-server"
export LVIS_SECRET_KEY_FILE="/path/to/protected/lvis.key"
```

`LVIS_HOME` owns host state such as sessions, permissions, discovery files, and
the host-instance lock. `LVIS_USER_DATA_DIR` owns application settings and the
application secret document. `--user-data-dir=<directory>` overrides that
second path; it does not replace `LVIS_HOME`. Keep both locations stable across
restarts. Only one desktop or native host can own the same `LVIS_HOME` at a time.

Provision the key separately: an absolute path to exactly 32 raw random bytes,
owned by the effective user, with mode `0400` or `0600`, one hard link, and no
final symbolic link. The configured and resolved paths must not contain
`*`, `?`, `[` or `]`. The host protects the configured and resolved key paths
from tools and pins the loaded key for its process lifetime. It does not create,
repair, rotate, or back up the key. Retain the correct key with its encrypted
data; a changed file takes effect only after restart.

The external-key backend uses authenticated encryption and identifies itself
as `external_key`. It is not an OS keychain. An unset key makes encryption
unavailable; an explicitly missing or invalid key file fails startup. Existing
desktop ciphertext, legacy plaintext, and ciphertext for a different key are
not silently migrated, replaced, or treated as missing. Incompatible encrypted
state fails and remains intact. See the
[secret encryption contract](../architecture/headless-secret-encryption.md)
for the precise storage and file checks.

## Prepare a fresh profile

Configure a new profile directly while its host is stopped. Create its two
directories with owner-only access. For a compatible API endpoint, place this
minimal non-secret configuration in
`$LVIS_USER_DATA_DIR/lvis-settings.json`, replacing the example endpoint and
model ID with your configured values:

```json
{
  "llm": {
    "activeChatRuntime": { "kind": "api" },
    "provider": "openai-compatible",
    "vendors": {
      "openai-compatible": {
        "baseUrl": "https://api.example.invalid/v1",
        "model": "MODEL_ID"
      }
    }
  }
}
```

For an existing file, merge these fields while preserving other settings.
Provider IDs and block fields are defined by
[`LLMSettings`](../../src/data/settings-store.ts) and
[`LLMVendorSettings`](../../src/shared/llm-vendor-defaults.ts). Keep credentials
out of this JSON. For the example provider, set
`SECRET_NAME=llm.apiKey.openai-compatible` and supply its credential through
`--set-secret` below.

The default project is `$LVIS_HOME/workspace`, created during normal host boot;
use that path as `PROJECT_DIR` for an initial run. To authorize another project,
merge its absolute directory into the separate
`$LVIS_HOME/settings.json` permission document before starting the host:

```json
{
  "permissions": {
    "additionalDirectories": ["/absolute/path/to/project"]
  }
}
```

This is an operator-granted scope. Existing permission entries and protected
paths still apply; adding a project does not disable the other tool checks.

## Run commands

Run these from the artifact directory with the profile environment above.
`PROJECT_DIR` must already be an authorized project directory. The default
workspace is also allowed; choosing another path does not grant access to it.

```sh
./lvis --set-secret="$SECRET_NAME" < "$SECRET_INPUT_FILE"
./lvis --exec="Summarize this project." --exec-cwd="$PROJECT_DIR"
printf '%s' "$PROMPT" | ./lvis --exec --exec-cwd="$PROJECT_DIR" --exec-output=json
./lvis --serve
```

`--exec=<prompt>` supplies an inline prompt; `--exec` or `--exec=-` reads it
from stdin. `--exec-cwd` defaults to the launch directory and resolves relative
paths against it. Streaming JSON lines are the default output;
`--exec-output=json` emits one final result. `--exec-max-rounds=<n>` sets the
turn's round budget. `--exec-approve=allow` selects allow mode but preserves
protected-path checks and directory grants. Requests that still require
unavailable consent are denied once.

`--set-secret=<key>` accepts a valid settings-secret name in `SECRET_NAME` and
reads its value from stdin, never from an argument. The example uses an
operator-provided input file. `--set-secret` and `--exec` may share a launch
only when the prompt is inline, because the secret consumes stdin. The secret
write runs first. Configure the desired provider and model in the selected
profile before executing a turn.

One-shot commands exit after completion. `--exec-keep-alive` requires streaming
output and retains a successful turn's host and session-owned background
services until SIGINT or SIGTERM. It emits
`{"kind":"exec.completed","exitCode":0}` before waiting and starts no further
model turn. It does not turn the process into a server. Exit codes are `0` for
completion, `1` for failure, `2` for requested input, `64` for invalid usage, and
`75` when another host owns the profile. Shutdown failure can produce exit `1`.

`--serve` accepts only an optional `--user-data-dir=<directory>` alongside it;
it cannot share a launch with `--exec` or `--set-secret`. It enables the
authenticated Local API on an OS-assigned loopback port and emits a
`server-ready` JSON record containing `port` and `pid`. Local clients discover
the current port and per-boot bearer secret in
`$LVIS_HOME/local-api/server.json`, protected with mode `0600`. The bearer secret
is not printed in the ready record. SIGINT or SIGTERM stops the host through
normal session and child-process cleanup.

`--exec` starts a host; it does not attach to a running `--serve` process. Use a
Local API client or an authorized remote surface to submit commands to the
server that already owns the profile.

## Shared sessions and remote surfaces

The persistent server owns one service graph, command port, and conversation
surface runtime. Its Local API and configured Tailnet clients reach the same
active main conversation and ordered event source. Mutating commands share one
lease; simultaneous clients do not obtain independent conversation loops.
Every transport keeps its own actor, authorization, and data projection.
Configured Tailnet surfaces, including Web, support bounded canonical replay
in memory. Local API `/v1/events` SSE is live-only.

Tailnet remains separately opt-in through the host's Tailnet configuration.
`--serve` does not enable pairing, controller access, web access, or external
network ingress by itself. Controller and web access require paired sharing;
web access also requires the configured origin. Remote clients receive the
authorized safe projection and retain the existing consent boundary. Configure
ingress and access using the
[Tailnet surface contract](../architecture/multisurface-conversation-runtime.md#implemented-tailnet-observercontroller-and-p2-owner-sharing).

The native entry exposes no public owner interface for issuing invitations or
approving pairings and conversation shares. A fresh native profile therefore
has no guided remote-access setup; enabling the listener alone creates no grants.

The desktop still runs its own embedded host. Its UI is not yet a detached
client of this server, and the shared protocol does not reconnect that UI or
preserve its embedded runtime after a fatal desktop process failure. A native
server launched separately has its own process lifetime. Installed Linux
qualification must exercise the intended server features and process lifecycle
in addition to the packaging probes.
