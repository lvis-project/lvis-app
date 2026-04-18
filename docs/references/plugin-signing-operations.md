# Plugin Signing Operations

Operational runbook for LVIS plugin manifest signing, key management, and
rotation. Authoritative design reference: `../architecture/architecture.md`
§9.6 (Plugin deployment model) and §14.2 (Governance / signing pipeline).

## 1. Publisher identity

A **publisher** is any organization trusted to distribute managed plugins into
the LVIS marketplace (typically the LGE IT Platform org). Each publisher owns
one or more **ed25519 signing keypairs**:

- **Private key** — lives only in the LGE IT secrets vault and is injected
  into CI as `LVIS_PUBLISHER_SIGNING_KEY` at release time.
- **Public key** — bundled into the host at
  `src/plugins/publisher-keys.ts` (`BUNDLED_PUBLISHER_PUBLIC_KEYS`).

The host's `PluginSignatureVerifier` accepts a signature if it matches **any**
bundled public key, which is what makes rotation possible without breaking
already-signed plugins.

## 2. Key generation

```bash
bun run keygen:publisher
# or: node scripts/keygen-publisher.mjs
```

This prints two PEM blocks to stdout: the PKCS8 private key first, then the
SPKI public key. Never commit either block. Paste the private key into the
LGE IT secrets vault; paste the public key into `publisher-keys.ts`.

## 3. Key storage

- **Private key**: LGE IT secrets vault (production) / GitHub Actions org
  secret `LVIS_PUBLISHER_SIGNING_KEY` (CI). Never on disk in plaintext. Never
  in a repo, even gitignored.
- **Public key**: version-controlled in `src/plugins/publisher-keys.ts` with
  an annotation noting purpose and issue date, e.g.
  `// production (issued 2026-04-18)`.
- **Dev key**: `DEVELOPMENT_PUBLISHER_PUBLIC_KEY_PEM` in the same file.
  Clearly labelled "NOT FOR PRODUCTION". Used for local builds + fixtures.

## 4. Signing pipeline

Per-plugin repo (meeting / pageindex / email / calendar):

1. `npm run build` in the plugin repo compiles artifacts and runs
   `postbuild` which invokes `scripts/sign-manifest.mjs`.
2. The script reads `plugin.json` bytes, signs with
   `LVIS_PUBLISHER_SIGNING_KEY`, writes `plugin.json.sig` (base64).
3. If `LVIS_PUBLISHER_SIGNING_KEY` is unset (local dev), the script warns and
   exits 0 — unsigned builds are fine locally because the host falls back to
   `LVIS_DEV_SKIP_SIG=1` during development.
4. CI uploads the tarball plus the sibling `.sig` file to the marketplace.

Host-side (this repo):

- `scripts/sign-manifest.mjs` is the reference signer for any host-owned
  manifests (e.g. re-signing bundled fixtures).
- `scripts/sign-manifest.mjs --check <manifest>` verifies a signature against
  `LVIS_PUBLISHER_PUBLIC_KEY`, useful as a CI gate.

## 5. Host verification

On plugin install, `boot.ts` hands the manifest path to
`PluginSignatureVerifier`. Verifier iterates every entry in
`BUNDLED_PUBLISHER_PUBLIC_KEYS` (to avoid a timing side-channel revealing
which key matched) and accepts iff at least one produces `verify() === true`.

Managed plugins that fail verification are **not loaded** (fail-closed), unless
`LVIS_DEV_SKIP_SIG=1` is set. User plugins with missing `.sig` still load but
the host logs a warning.

## 6. Rotation procedure

Rotation is a **multi-key overlap** window — add the new key before removing
the old so already-signed plugins keep working:

1. **Generate** new keypair via `bun run keygen:publisher`.
2. **Add** the new public key to `BUNDLED_PUBLISHER_PUBLIC_KEYS` in
   `src/plugins/publisher-keys.ts`. Annotate with issue date. Do **not**
   remove the old one yet.
3. **Ship** a host release containing both keys. Wait for the release to
   propagate to all fleets.
4. **Re-sign** every managed plugin with the new private key and publish the
   updated `.sig` files to the marketplace.
5. **Switch** CI secret `LVIS_PUBLISHER_SIGNING_KEY` to the new private key.
6. **Remove** the old public key from `BUNDLED_PUBLISHER_PUBLIC_KEYS` in a
   later host release (one release cycle after step 4 completes).

Minimum overlap window: one host release cycle (≈2 weeks). Longer is fine.

## 7. CI signing pipeline sketch (GitHub Actions)

```yaml
# .github/workflows/release.yml (sketch — per plugin repo)
name: release
on:
  push:
    tags: ["v*"]
jobs:
  sign-and-publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Build + sign manifest
        env:
          LVIS_PUBLISHER_SIGNING_KEY: ${{ secrets.LVIS_PUBLISHER_SIGNING_KEY }}
        run: bun run build   # postbuild invokes sign-manifest.mjs
      - name: Verify signature (guard)
        env:
          LVIS_PUBLISHER_PUBLIC_KEY: ${{ secrets.LVIS_PUBLISHER_PUBLIC_KEY }}
        run: node scripts/sign-manifest.mjs --check plugin.json
      - name: Upload to marketplace
        env:
          LVIS_MARKETPLACE_TOKEN: ${{ secrets.LVIS_MARKETPLACE_TOKEN }}
        run: bun run publish:marketplace   # repo-specific uploader
```

Key points:
- Private key is **never** written to the runner disk — passed via env only.
- The `--check` step catches signer misconfiguration before artifacts leave CI.
- Marketplace uploader bundles `plugin.json` + `plugin.json.sig` + build
  tarball into one release asset.

## 8. Incident response — compromised key

If a private key is suspected compromised (leaked credential, vault breach,
insider incident):

1. **T+0h**: revoke the CI secret. Block marketplace uploads using that key.
2. **T+2h**: generate a new keypair (§2). Add its public key to
   `publisher-keys.ts`. Keep the compromised key in the array temporarily —
   yanking it immediately would leave previously-shipped plugins unverifiable
   and users stranded.
3. **T+6h**: re-sign every managed plugin with the new key and publish.
4. **T+12h**: ship a host patch release that **removes** the compromised
   public key. Ship the new `publisher-keys.ts` so any plugin still bearing a
   signature from the compromised key is rejected.
5. **T+24h**: audit marketplace for any rogue uploads made with the
   compromised key between breach and revocation; pull them.
6. Write a post-mortem referencing `architecture.md §14.2` and file it in
   `docs/references/incidents/`.

Rotation SLA: **full rotation within 24h** of confirmed compromise.

## Cross-references

- `docs/architecture/architecture.md` §9.6 — plugin deployment model
- `docs/architecture/architecture.md` §14.2 — signing / governance
- `docs/architecture/plugin-deployment-model.md`
- `src/plugins/signature-verifier.ts` — host verify implementation
- `src/plugins/publisher-keys.ts` — bundled public keys
- `scripts/sign-manifest.mjs` / `scripts/keygen-publisher.mjs` — tooling
