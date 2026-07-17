# A2A P4-5 Packaged Live Evidence Runbook

This runbook prepares and verifies the strict, signed evidence bundle for the
non-plugin A2A P4-5 packaged-live gate. It is not a deployment tool and it
does not generate missing evidence. The authoritative contract is implemented
in `scripts/run-a2a-p4-5-packaged-live.mjs`,
`scripts/a2a-p4-5-live/packaged-live-contract.mjs`, and the associated
evidence tests.

Do not use this runbook to reintroduce excluded plugin, Marketplace,
local-indexer, meeting, diarization, or plugin-SDK work. D8 remains a separate
evidence-based decision.

## Pre-flight

Before collecting evidence, establish all of the following:

- The exact app, Agent Hub, and Remote server heads are known and match the
  signed manifest.
- The Windows package is a CI-attested installer, is installed, and has a
  valid Authenticode signature matching the pinned publisher identity. An
  unsigned installer is not formal packaged-live evidence.
- The verifier host has `node`, `bun`, `gh`, `tshark`, `openssl`, `psql`, and
  Windows PowerShell available. Independent GitHub attestation verification
  requires `GH_TOKEN` in the verification environment.
- A real Remote A2A service and a real Agent Hub service are independently
  deployed. The temporary internal Docker PostgreSQL readiness check is useful
  preparation only; it is not formal database evidence.

## Real topology and endpoint identity

Use only real, user-owned configuration. Do not put a guessed hostname, IP
address, certificate, or deployment domain in this document, a commit, or a
manifest.

- Remote and Hub must each use a lowercase canonical DNS hostname and public
  HTTPS on port 443.
- Remote and Hub must have different hostnames and different TLS certificates.
- Client, Remote, and Hub IPv4 addresses must all be distinct. Remote and Hub
  addresses must be public IPv4 addresses.
- The signed DNS result, packet-capture destination address, TLS SNI,
  certificate SAN/fingerprint, and live endpoint check must agree for each
  endpoint.
- The Remote is a separate live A2A receiver, not a Worker substitute or a
  Hub route. Its host identity must be distinct from the client identity.

Cloudflare Tunnel can publish a loopback Hub origin once a real Cloudflare zone
and hostname are selected. It does not remove the separate Remote identity and
distinct-IP requirements.

For a Tunnel-backed Hub, target a loopback-only header-normalizing edge rather
than the Hub Compose ports directly. The edge may forward only to the Hub web
origin on its private network; it must not publish PostgreSQL. Trust
`CF-Connecting-IP` only from the verified immediate connector boundary, then
overwrite `X-Real-IP` and `X-Forwarded-For` instead of forwarding an incoming
chain. Use the matching Agent Hub deployment template from the exact Hub head;
do not put the actual Zone, hostname, Tunnel token, or gateway address in this
runbook or source tree.

## Trust material and secrets

Configure secrets outside the repository and do not paste their values into
shell history, manifests, logs, commits, packet captures, or pull requests.
The verifier consumes these variable names:

- `LVIS_A2A_EVIDENCE_PUBLIC_KEY_FILE`
- `LVIS_A2A_EVIDENCE_SIGNER_SHA256`
- `LVIS_A2A_HUB_DATABASE_URL`
- `GH_TOKEN`

The manifest must have a detached Ed25519 sidecar signature at
`<manifest>.sig`. The database variable must identify one credentialed
PostgreSQL database and use `sslmode=verify-full` as its only URL query
parameter. The verification host must trust the database CA through the normal
PostgreSQL trust store; do not weaken hostname verification or add unsupported
URL parameters.

## Evidence collection

Collect the real evidence before invoking the verifier:

1. Run the actual signed packaged LVIS application through every fixed UI case
   without skips.
2. Produce a raw `pcap` or `pcapng` capture. If an ETL capture is used, include
   its decoded packet capture. Record the exact `TShark (Wireshark) x.y.z`
   version used.
3. Collect a TLS key log from a separately controlled real packaged-app launch.
   The fixed UI driver intentionally does not pass `SSLKEYLOGFILE`; do not
   weaken its environment allowlist to work around this requirement.
4. Capture the client traffic and endpoint identity for both Remote and Hub.
   The capture must bind the signed destination IP and SNI to each endpoint.
   Task traffic goes directly to Remote; Hub-mediated task traffic is a
   failure.
5. Record the live Remote server evidence, wire-conformance result, fault
   matrix, Hub-absence evidence, host identity, endpoint identity, installer
   provenance, attestation, installation receipt, and file hashes.
6. Create the actual Hub control-plane and audit records. The formal query must
   find the signed snapshot, heads, lock/artifact digests, and Remote URL, with
   all prohibited canary counts at zero.

The manifest schema is exact-key and each artifact must be a SHA-256-pinned
regular file confined below the manifest root. Do not copy a partial JSON
example into an evidence bundle; follow the source contract and tests instead.

## Verification

Run the local contract checks first, then verify one signed manifest from a
clean evidence workspace:

```bash
bun run check:a2a-p4-5:evidence
bun run test:a2a-p4-5:packaged-live -- --manifest <signed-manifest-path>
```

The packaged-live verifier accepts exactly `--manifest <signed-manifest-path>`.
It does not accept invented `--capture` or `--keylog` flags, deploy services,
or create missing evidence.

On success it exclusively creates:

```text
artifacts/a2a-p4-5/packaged-live.json
```

Because this output uses exclusive creation, use a clean evidence workspace for
each verification attempt. Treat a verifier failure as a failed proof: repair
the real deployment or evidence, regenerate and re-sign the manifest, then
rerun the same command. Do not relax the verifier, fake an endpoint, or reuse
stale evidence.
