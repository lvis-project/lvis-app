# Marketplace Artifact Trust Operations

LVIS uses a single marketplace artifact trust gate.

1. Plugin authors build a zip containing `plugin.json`, `dist/`, and any static
   assets.
2. The marketplace upload API validates the zip, manifest schema, plugin id,
   version monotonicity, install policy, dependencies, and plugin access grants.
3. The marketplace server signs the final artifact envelope.
4. `lvis-app` downloads the artifact, verifies the envelope with host-owned
   marketplace public keys, extracts the zip, and writes an install receipt with
   file hashes.
5. Runtime boot verifies the install receipt before parsing `plugin.json` or
   importing plugin code.

Plugin repositories do not generate detached manifest sidecar signatures. The
SDK does not carry marketplace trust keys.

## Key ownership

- Marketplace private signing keys are server-side only.
- Marketplace public trust anchors are host-owned in `lvis-app`.
- `@lvis/plugin-sdk` is a type/source-only authoring contract.

## Local tamper detection

The install receipt records:

- plugin id and version
- artifact SHA-256 from the verified envelope
- signer key id
- per-file SHA-256 values for files extracted from the artifact

If any recorded file is missing or modified, the runtime rejects that plugin and
emits `plugin_integrity_rejected`.
