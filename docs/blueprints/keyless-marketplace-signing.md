# Keyless Marketplace Signing — Design And Staged Plan

Status: design, not implemented. This document exists because the alternative —
starting the migration and discovering the crux halfway — leaves the marketplace
with two signature formats and no finished verifier.

**Recommendation up front: not yet — blocked, and the blocker is commercial
rather than technical.**

GitHub artifact attestations are **not available for private repositories on the
GitHub Team plan**. `lvis-project` is on `team`; every plugin repository is
private. §2.3 has the verbatim source and the check. Until that changes there is
nothing to build, and the rest of this document is the design that becomes
correct the day it does.

Everything else came out well, and is worth recording rather than rediscovering:
offline verification **is** workable, for a better reason than expected (§3), and
the migration's real prize is not rotation cost but removing the marketplace
server's ability to sign arbitrary bytes (§5.1). §9 states the recommendation in
full, including the conditions that apply once the blocker clears.

Anchors: `docs/architecture/architecture.md` (Plugin System, §9), and the code
named in §1. Where this design asks the architecture to change, the section is
named in §11.

Every protocol claim below was checked against a primary source, and the source
is cited inline. Where a claim could not be confirmed it is in §8, not in the
body.

---

## 1. What is actually true today

### 1.1 The verifier

`src/plugins/envelope-verifier.ts` is 129 lines and does one thing:

```ts
const pub = publicKeys[sig.key_id];
if (!pub) continue;            // unknown key id
…
if (verify(null, tarball, keyObj, sigBytes)) { matchedKeyId ??= sig.key_id; }
```

An envelope is accepted if **any** signature in it verifies against **any** key
in the supplied map. The map for plugin tarballs is
`MARKETPLACE_PUBLIC_KEYS` in `src/plugins/marketplace-keys.ts`, and it currently
holds exactly one entry, `prod-v1`.

The security of that map is the security of its weakest member. That is not a
hypothetical: `poc-v1` sat in it with a public private-half, and removing it
required re-signing 804 of 860 catalog version rows first
(`server/scripts/resign_artifacts.py`, and the comment block in
`marketplace-keys.ts` that records the count). The 56 rows that stayed on
`poc-v1` were only safe because their artifact files no longer exist on disk.

**A rotation that costs a full catalog re-sign is the structural problem.** It is
not that ed25519 is weak. It is that the anchor is long-lived, singular, and
retiring it is O(catalog).

### 1.2 Where the signature is actually applied — and what it therefore means

This is the fact that changes the shape of the whole design, and it is not
written down anywhere else.

Trace the publish path:

| Step | Location | What happens |
|---|---|---|
| 1 | plugin repo `.github/workflows/publish.yml` | thin caller, `repository_dispatch` only, `uses: lvis-project/.github/.github/workflows/marketplace-publish.yml@10c12345…` (SHA-pinned) |
| 2 | reusable `build` job, `ubuntu-latest`, `permissions: contents: read` | checks out the tag, proves it is annotated and its peeled commit is reachable from `origin/main`, builds, produces `plugin.zip` + `package_sha256`. **Holds no credential of any kind.** |
| 3 | reusable `publish` job, `runs-on: {group: lvis-oracle-publisher, labels: [self-hosted, linux, arm64, marketplace-publisher]}` | re-verifies tag/manifest/provenance *without executing candidate code*, downloads the artifact, checks its sha256 against the build job's output, then `POST http://127.0.0.1:8000/api/v1/plugins/{slug}/versions` with `Authorization: Bearer $MARKETPLACE_API_KEY` |
| 4 | `server/src/lvis_marketplace/api/publisher.py:568` | `envelope = sign_artifact_multi(data, require_signing_keys(), artifact_id=…)` |

Step 4 is where `prod-v1` touches the bytes. **The signature is applied by the
marketplace server, to whatever it was handed, after an API-key check.** It is
not applied by CI and it is not bound to the build.

So the claim a client verifies today is precisely:

> *These bytes were POSTed to the marketplace server by someone holding
> `MARKETPLACE_API_KEY`, and the server signed them.*

It is **not**:

> *These bytes were built from tag `v1.2.3` of `lvis-project/lvis-plugin-meeting`.*

The workflow works very hard to make the second statement true operationally —
annotated-tag check, `merge-base --is-ancestor origin/main`, build/publish job
split, a dedicated low-privilege runner tier, a package-digest handoff check —
and then none of that survives into the artifact. It is enforced at publish time
and discarded. A desktop verifying an install six months later learns none of it.

That gap is the second reason to look at keyless, and it is a bigger one than
rotation cost.

### 1.3 What the installer actually does at install time

`src/plugins/marketplace-installer.ts`:

1. offline tarball cache hit, or network download (`downloadWithRetry`)
2. sha256 cross-check against `X-Plugin-SHA256` and the catalog digest
3. **fetch the signature envelope over the network — always, even on a cache hit**
   (`:290`, "never short-circuit this step — a cache hit must not bypass
   envelope-verifier")
4. clock-skew guard on `envelope.iat` (72h, matched to `signing.py`'s
   `MAX_SKEW_SECONDS`)
5. `verifyEnvelope(body, envelope, opts.publicKeys)`

Note step 3 carefully, because it changes what "offline install" means here.
The **verification** is offline — pure `node:crypto` against a compiled-in key.
The **install** is not: the envelope is a separate network fetch. A fully
disconnected desktop cannot install a new plugin today either. What must keep
working offline is verification of material already in hand, and re-verification
of a cached tarball whose envelope is refetched.

### 1.4 The other trust domain

`WHITELIST_PUBLIC_KEYS` (`whitelist-v1`) signs two documents from
`lvis-project/marketplace-whitelist`: the secret-access whitelist and the
revocation registry (`src/plugins/revocation/`, which imports the whitelist keys
under a `REVOCATION_*` alias). The split from `MARKETPLACE_PUBLIC_KEYS` is
deliberate and the reason is written in the source:

> a revocation document is the thing a defender reaches for precisely when the
> artifact-signing key's integrity is in question, so it cannot share that key's
> trust domain.

§7 says what this design does with that. Short version: nothing, on purpose.

---

## 2. What Sigstore is, checked rather than recalled

### 2.1 The keyless flow

A workflow requests an OIDC ID token from GitHub, presents it to **Fulcio**,
which issues a short-lived X.509 code-signing certificate binding the ephemeral
public key to the token's claims. The signature is made with the ephemeral
private key, which is then discarded. Trust moves from *"we hold this key"* to
*"this artifact was signed by workflow X"*.

The claims are carried as X.509 extensions under Sigstore's IANA Private
Enterprise Number `1.3.6.1.4.1.57264`
([`sigstore/fulcio/docs/oid-info.md`](https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md)).
The ones that matter here, all DER-encoded `UTF8String` from `.1.8` up:

| OID | Name | Value for an LVIS publish |
|---|---|---|
| `…57264.1.8` | Issuer (V2) | `https://token.actions.githubusercontent.com` |
| `…57264.1.9` | Build Signer URI | the **reusable workflow** ref — the thing that signs |
| `…57264.1.10` | Build Signer Digest | commit of that reusable workflow |
| `…57264.1.11` | Runner Environment | `github-hosted` / `self-hosted` |
| `…57264.1.12` | Source Repository URI | `https://github.com/lvis-project/lvis-plugin-meeting` |
| `…57264.1.13` | Source Repository Digest | the tagged commit SHA |
| `…57264.1.14` | Source Repository Ref | `refs/tags/v1.2.3` |
| `…57264.1.15` | Source Repository Identifier | numeric repo id — immutable across renames |
| `…57264.1.17` | Source Repository Owner Identifier | numeric org id |

The `oid-info.md` doc is explicit that `.1.1`–`.1.6` (the GitHub-specific set)
are **deprecated** in favour of the generic `.1.8`+ set, and that `.1.1`–`.1.6`
are raw strings while `.1.8`+ are DER. A verifier written against the old set
would be reading extensions Fulcio is moving away from.

The **SubjectAlternativeName** is the *Build Signer* identity, not the source
repo: for a reusable workflow it is the reusable workflow's ref. That distinction
is the whole of §4.

`oid-info.md` also states the mandatory set for a CI/CD workload identity: `iss`,
Build Signer URI, and Runner Environment are MUST; Source Repository URI /
Digest / Ref / Identifier are SHOULD. Everything we want to pin is at least
SHOULD-level, and GitHub emits all of them.

### 2.2 Two instances — and LVIS is on the one nobody blogs about

This is the single most decision-relevant fact found, and it inverts several
assumptions.

From
[GitHub's artifact attestations concept doc](https://github.com/github/docs/blob/main/content/actions/concepts/security/artifact-attestations.md),
verbatim:

> **Public repositories** that generate artifact attestations use the Sigstore
> Public Good Instance. A copy of the generated Sigstore bundle is stored with
> GitHub and is also written to an immutable transparency log that is publicly
> readable on the internet.
>
> **Private repositories** that generate artifact attestations use GitHub's
> Sigstore instance. GitHub's Sigstore instance uses the same codebase as the
> Sigstore Public Good Instance, but it does not have a transparency log and
> only federates with GitHub Actions.

Every LVIS plugin repository is private — verified against the org:

```
lvis-plugin-meeting          PRIVATE
lvis-plugin-local-indexer    PRIVATE
lvis-plugin-ms-graph         PRIVATE
lvis-plugin-ep               PRIVATE
lvis-plugin-work-assistant   PRIVATE
lvis-plugin-template         PRIVATE
lvis-marketplace             PRIVATE
lvis-app                     PUBLIC
lvis-plugin-sdk              PUBLIC
marketplace-whitelist        PUBLIC
```

Two consequences, and they pull in opposite directions:

- **Good.** Signing does not publish private repository names, tag names, commit
  SHAs, or the internal reusable-workflow path to a globally readable log.
  `lvis-plugin-ep` is an internal-API integration whose *existence* is currently
  gated to the internal network (`_version_publicly_visible`). Putting it in
  public Rekor would defeat that, permanently and unremovably. Public Sigstore is
  therefore not an option for LVIS regardless of anything else.
- **Bad, and it must be said plainly.** *Public auditability is the property
  Sigstore is most famous for, and LVIS does not get it.* There is no Rekor entry
  to monitor, no third party who can observe a rogue signature for
  `lvis-plugin-meeting`, no `rekor-monitor` deployment that would page us. What
  LVIS gets from keyless is (a) no long-lived signing secret and (b) a
  cryptographically-bound build identity. Those are real and they are the whole
  benefit. Anyone arguing for this on transparency-log grounds is arguing for
  something we cannot have.

In place of the log, GitHub's instance supplies a signed timestamp from a
timestamp authority. That is what pins "the signature was made while the
certificate was valid" — see §3.2.

### 2.3 The blocker

`actions/attest-build-provenance`'s own README, verbatim:

> Artifact attestations are available in public repositories for all current
> GitHub plans. They are not available on legacy plans, such as Bronze, Silver,
> or Gold. **If you are on a GitHub Free, GitHub Pro, or GitHub Team plan,
> artifact attestations are only available for public repositories. To use
> artifact attestations in private or internal repositories, you must be on a
> GitHub Enterprise Cloud plan.**

And:

```
$ gh api orgs/lvis-project --jq .plan
{"name":"team","seats":3,"filled_seats":3,…}
```

`lvis-project` is on **Team**. Every plugin repository is **private** (§2.2). The
two facts do not compose.

The escape routes, and why each is closed:

- **Make the plugin repos public.** Not available. `lvis-plugin-ep` is an
  internal-API integration whose catalog visibility is deliberately gated to the
  internal network, and `marketplace-internal-visibility` exists precisely to
  keep its existence off the public catalog. Publishing the repository would
  defeat that more thoroughly than the catalog gate protects it. The same
  argument applies to `lvis-plugin-ms-graph`.
- **Sign against the Sigstore public good instance directly with `cosign`,
  bypassing GitHub's attestation product.** This works technically — Fulcio
  accepts the Actions OIDC token from a private repo — but it writes the
  certificate to public Rekor, which publishes private repository names, tags and
  commit SHAs to an immutable, globally readable, unremovable log. That is
  strictly worse than the disclosure the previous bullet rejects. Closed for the
  same reason.
- **Upgrade `lvis-project` to GitHub Enterprise Cloud.** The only open route, and
  it is an owner decision with a price attached, not an engineering one.

This was not visible from the code, the workflows, or the Sigstore documentation.
It is visible from one `gh api` call and one line of an action's README, and it
determines whether any of the rest is buildable.

### 2.4 `actions/attest-build-provenance`

GA since 2024-06-25, latest `v4.2.2` (2026-08-06). Its README states that as of
v4 it "is simply a wrapper on top of `actions/attest`" and that new
implementations should use `actions/attest` directly — so Stage 3 targets
`actions/attest`, not the wrapper. Required permissions in v4 are
`id-token: write`, `attestations: write`, and `artifact-metadata: write`.

From `action.yml`, the inputs that matter: `subject-path` / `subject-digest` +
`subject-name`, and `github-token`. The output that matters:

```yaml
outputs:
  bundle-path:
    description: "The path to the file containing the attestation bundle."
```

`bundle-path` is the hinge of this design. It means the Sigstore bundle is a
**file on the runner**, not only a record in GitHub's attestation store. LVIS can
read it and ship it through its own marketplace, so a desktop never needs to
call GitHub's attestation API — which matters enormously, because for a private
repo that API requires GitHub credentials the desktop does not have and must not
have.

The same doc also states the SLSA framing:

> Reusable workflows can provide isolation between the build process and the
> calling workflow, to meet SLSA v1.0 Build Level 3.

LVIS already publishes through a SHA-pinned reusable workflow. The shape keyless
wants is the shape that is already there.

---

## 3. The offline verification path, end to end

### 3.1 The crux, stated as a finding

**Offline verification works, and the mechanism is that the trust root is a
plain data file with no expiry.**

From
[GitHub's `verify-attestations-offline` doc](https://github.com/github/docs/blob/main/content/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline.md),
verbatim:

> Artifact attestations uses the Sigstore public good instance for public
> repositories, and GitHub's Sigstore instance for private repositories. You can
> use one command to get both trusted roots:
> `gh attestation trusted-root > trusted_root.jsonl`
>
> The key material in `trusted_root.jsonl` does not have a built-in expiration
> date, so anything signed before you generate the trusted root file will
> continue to successfully verify. Anything signed after the file is generated
> will verify until that Sigstore instance rotates its key material, which
> typically happens a few times per year. **You will not know if key material has
> been revoked since you last generated the trusted root file.**

Read that against §1.1 and the structural claim of this whole document falls out:

- Rotation of the Sigstore trust root **does not invalidate previously signed
  artifacts**. The `TrustedRoot` carries per-authority validity windows, so old
  certificates keep chaining to the authority that was valid when they were
  issued while new ones use the new material. That is the exact property
  `MARKETPLACE_PUBLIC_KEYS` lacks and the reason `poc-v1` cost 804 re-signs.
- The residual is inverted and much cheaper: a *stale* root cannot verify
  *newly* signed artifacts. That is a fail-closed staleness on new installs,
  fixed by an app update — not a re-sign of the catalog.
- The last sentence is a genuine limitation, carried into §5 rather than buried:
  an embedded root cannot learn about revoked key material.

Note also that TUF never enters the offline path. The TUF client is how you
*obtain* a `trusted_root.jsonl`; once you have the file, verification is a pure
function of (bundle, artifact, trusted root). LVIS obtains it at build time in
CI and embeds it. No TUF metadata expiry, no `timestamp.json` refresh, no
network at verify time.

### 3.2 What the verifier actually computes

`gh attestation verify` is not the vehicle — LVIS is an Electron app, not a shell
with `gh` installed. The vehicle is `@sigstore/verify` (sigstore-js). Reading its
source rather than its README, because the README is three lines:

`packages/verify/src/trust/index.ts` exports

```ts
export function toTrustMaterial(
  root: TrustedRoot,
  keys?: Record<string, PublicKey> | KeyFinderFunc
): TrustMaterial
```

A pure function from a `TrustedRoot` protobuf message to trust material. No
fetch, no TUF client, no I/O. `packages/verify/src/verifier.ts`:

```ts
public verify(entity: SignedEntity, policy?: VerificationPolicy): Signer {
  const timestamps = this.verifyTimestamps(entity);
  const signer     = this.verifySigningKey(entity, timestamps);
  this.verifyTLogs(entity);
  this.verifySignature(entity, signer);
  if (policy) { this.verifyPolicy(policy, signer.identity || {}); }
  return signer;
}
```

Also pure. The full end-to-end path on a desktop, with the network column filled
in honestly:

| # | Step | Network? |
|---|---|---|
| 1 | Load embedded `trusted_root.json` from the app bundle → `toTrustMaterial()` | no |
| 2 | Fetch `plugin.zip` from marketplace, or take the offline cache hit | yes, unless cached |
| 3 | Fetch the Sigstore bundle from the marketplace alongside it | yes — same call the `.sig` fetch makes today (§1.3) |
| 4 | `toSignedEntity(bundle, artifactBytes)` | no |
| 5 | `verifyTimestamps` — RFC3161 TSA token verified against the timestamp authorities in the trusted root | no |
| 6 | `verifySigningKey` — build the chain from the leaf to a Fulcio CA **that was valid at the timestamp from step 5** | no |
| 7 | `verifyTLogs` — checkpoint signature, Merkle inclusion proof, and SET, all against the tlog keys in the trusted root | no |
| 8 | `verifySignature` over the DSSE pre-authentication encoding | no |
| 9 | `verifyPolicy` — SAN regex + `extensions.issuer` + exact OID/value pairs (§4) | no |
| 10 | Compare the in-toto subject digest to the sha256 of the bytes actually on disk | no |

Steps 4–10 are the verification. **Every one of them is offline.** The network in
steps 2–3 is transport for material the desktop does not have yet, and it is the
network the installer already uses.

Step 5 answers the "certs live ten minutes, how does a verifier months later
know the signature was made while the cert was valid" problem, and it answers it
without a transparency log: the TSA token is a signed assertion of time from an
authority in the trusted root, and `verifySigningKey` takes that timestamp as the
instant at which the certificate's validity window must contain the signature.
There is no wall-clock dependence and no "cert expired" failure on old artifacts.

Step 7 is worth one precision, because it is easy to overclaim. `verifyCheckpoint`,
`verifyMerkleInclusion` and `verifyTLogSET` (`packages/verify/src/tlog/`) import
nothing but `@sigstore/core` and the trusted root's tlog keys — verified by
reading them; there is no `fetch` in that directory. So an inclusion proof **is**
checkable offline. What is *not* checkable offline, by anyone, is whether the log
served a split view; that needs gossip or a monitor, and it is a property of
transparency logs generally rather than of offline verification. For LVIS the
point is moot in the other direction — §2.2, there is no log at all.

Step 7 needs a decision, not a default, and the defaults are wrong for us in
**two** places rather than one. `VerifierOptions` defaults are
`tlogThreshold: 1`, `ctlogThreshold: 1`, `timestampThreshold: 1`. GitHub's
private instance publishes a trusted root in which **both `tlogs` and `ctlogs`
are empty** — fetched from `https://tuf-repo.github.com` and confirmed: it
carries `certificateAuthorities` for `fulcio.githubapp.com` and
`timestampAuthorities` for `timestamp.githubapp.com`, and nothing else. So its
bundles carry an RFC3161 timestamp, no transparency-log entry, and no embedded
SCT to check.

The `gh` CLI encodes exactly this asymmetry: its GitHub-instance verifier is
constructed with `verify.WithSignedTimestamps(1)` alone, while its public-good
verifier gets `WithObserverTimestamps(1)` + `WithTransparencyLog(1)`
(`cli/cli`, `pkg/cmd/attestation/verification/sigstore.go`). The equivalent for
`@sigstore/verify` is:

```ts
{ tlogThreshold: 0, ctlogThreshold: 0, timestampThreshold: 1 }
```

`ctlogThreshold: 0` is not an optional refinement — leaving the default would
reject every private-instance bundle, and discovering that late is how a
"temporary" relaxation gets written in the wrong place.

This is exactly the shape of thing that becomes a fallback if written carelessly
— "try with a tlog, and if there isn't one, don't require it" is a bypass. Both
thresholds must be **constants selected by the pinned issuer**, decided once at
module scope, never derived from what the bundle happens to contain. A bundle
that presents no tlog entry *and* no TSA timestamp fails `timestampThreshold`,
loudly.

One further consequence of the empty `ctlogs`: certificate transparency is the
mechanism by which Fulcio mis-issuance is *supposed* to be detectable, and
Sigstore's own docs are explicit that "Fulcio itself does not monitor the
certificate transparency log; users are responsible for monitoring". With
GitHub's private instance there is no CT log to monitor either. §5.2 point 2
already says LVIS gets no transparency; this is the second half of that same
loss, and it means the honest description is *no external detectability at all*,
not merely *no Rekor*.

### 3.3 Where the bundle travels

The bundle must reach the desktop without the desktop authenticating to GitHub.
It does, because we control the pipe:

```
build job      → plugin.zip
sign job       → attest-build-provenance → bundle-path → plugin.sigstore.json
publish job    → POST /versions with BOTH files
marketplace    → stores both; serves GET /download and GET /download.bundle
desktop        → fetches both, verifies with the embedded trusted root
```

No call to GitHub's attestation API, no GitHub token on the desktop, no
dependence on the attestation store being reachable. The bundle is self-contained
by construction — that is what the protobuf bundle format is for.

---

## 4. The exact identity claim pinned

`VerificationPolicy` (`packages/verify/src/shared.types.ts`) is:

```ts
export type VerificationPolicy = {
  subjectAlternativeName?: string | RegExp;
  extensions?: { issuer?: string };
  oids?: ObjectIdentifierValuePair[];
};
```

Note `CertificateExtensionName = 'issuer'` — `issuer` is the only named
extension. Everything else is pinned through `oids`, as exact byte-value pairs.
That is better than a named accessor: it is an equality check on the DER value.
It is also a trap, in the direction that fails silently — see uncertainty 3.

**The SAN pattern must be anchored, and this is a security requirement rather
than a style note.** `packages/verify/src/policy.ts` matches with
`signerIdentity.match(policyIdentity)`, coercing a plain string to a `RegExp`.
An unanchored `https://github.com/lvis-project/.github` would match
`https://github.com/lvis-project/.github-evil/...`, and the dots would match any
character. The pattern below is anchored with `^`/`$` and escapes every literal
dot; a test must assert that a near-miss identity is rejected, because the
failure mode of getting this wrong is "accepts more than intended" and nothing
observable goes wrong until it matters.

For `lvis-plugin-meeting@1.2.3` the pinned claim is, in full:

| Field | Pinned to | Why |
|---|---|---|
| `extensions.issuer` | `https://token.actions.githubusercontent.com` | exact. Selects GitHub Actions OIDC and nothing else. |
| `subjectAlternativeName` | `^https://github\.com/lvis-project/\.github/\.github/workflows/marketplace-publish\.yml@refs/heads/main$` — anchored | the **Build Signer**: only the org's reusable publish workflow may sign. A workflow in the plugin repo itself cannot. |
| OID `…57264.1.12` Source Repository URI | `https://github.com/lvis-project/<slug-repo>` | exact, per plugin, derived from the catalog row |
| OID `…57264.1.15` Source Repository Identifier | the numeric repo id | survives renames; `pageindex → local-indexer` and `work-proactive → work-assistant` both happened |
| OID `…57264.1.17` Source Repository Owner Identifier | the numeric `lvis-project` org id | a repo named `lvis-project/lvis-plugin-meeting` in a *different* account cannot match |
| OID `…57264.1.14` Source Repository Ref | `refs/tags/v<version>` — exact, from the catalog version | binds the artifact to the released tag, not to a branch |
| OID `…57264.1.18` Build Config URI | `https://github.com/lvis-project/<slug-repo>/.github/workflows/publish.yml@refs/tags/v<version>` | the **caller**'s top-level workflow, distinct from the Build Signer above. Pins that the thin caller was the entry point. |
| OID `…57264.1.11` Runner Environment | `github-hosted` | see §5.2 |

The Build Signer / Build Config distinction is the reusable-workflow shape and it
is why the SAN alone is not the whole claim: `.1.9` (= the SAN) names the
reusable workflow that signed, `.1.18` names the caller's workflow that invoked
it, and `.1.12` names the repository the run belonged to. Pinning all three
means an attacker needs the reusable workflow *and* the caller *and* the repo to
line up, not any one of them.

Reading that back as a sentence:

> *This artifact was produced by `lvis-project/.github`'s
> `marketplace-publish.yml` reusable workflow on a GitHub-hosted runner, from
> annotated tag `refs/tags/v1.2.3` of repository id `<n>` owned by org id `<m>`,
> and GitHub's OIDC issuer asserted that.*

Compare §1.2. That is a strictly more specific claim than "someone with the API
key POSTed these bytes", and it is checkable on the desktop, months later, with
no network.

### 4.1 What an attacker who reaches that identity can sign

Stated without softening.

**Push access to a plugin repo, without more.** They cannot sign. The publish
path requires an annotated `vX.Y.Z` tag whose peeled commit is reachable from
`origin/main`, and a `repository_dispatch`. If branch protection on `main` holds,
push access to a branch is not enough. If it does not hold, they merge to `main`,
tag, dispatch — and get a **valid signature over their code**, with the pinned
identity intact. Keyless does not change this and does not claim to. It is the
same exposure as today, where the same sequence gets the server to sign.

**Write access to `lvis-project/.github`.** They rewrite `marketplace-publish.yml`
and sign anything. This is the new concentration: the reusable workflow's default
branch becomes the highest-value write target in the org, because the SAN pins to
it. Today that repo is already the publish pipeline, so it is already
high-value — but today rewriting it gets you a publish, whereas after this change
it gets you a *signature that a desktop will accept as build provenance*. Treat
it accordingly: branch protection, required review, and the fact that the SAN
pins `@refs/heads/main` means the protection on that one branch is load-bearing.

**Ability to make the workflow run with attacker-controlled build output.** This
is where the design has to add something that does not exist today, and it is the
sharpest new footgun in the whole migration — see §5.2.

**Compromise of GitHub's OIDC issuer or Fulcio instance.** Total. Nothing in this
design defends against it. It is a trust-surface expansion and it is in §5.3.

---

## 5. The threat model change, honestly

### 5.1 What gets better

1. **There is no long-lived signing secret anywhere.** `prod-v1`'s private half
   is an operator secret sitting in the marketplace server's environment. Keyless
   has nothing to leak: the private key exists for the life of one job and is
   discarded. The `poc-v1` incident is the failure mode this removes by
   construction, not by discipline.
2. **Rotation stops being O(catalog).** §3.1. Sigstore rotates key material a few
   times a year and previously-signed artifacts keep verifying, because the
   trusted root carries validity windows. `resign_artifacts.py` has no successor
   because it needs none.
3. **The marketplace server stops being a signing oracle.** Today
   `publisher.py:568` signs whatever reached it. Code execution on the Oracle
   host, or theft of `MARKETPLACE_API_KEY`, currently yields a `prod-v1`
   signature over arbitrary bytes that every LVIS build accepts. After this
   change the server holds no signing key and can only *relay* a bundle it cannot
   forge. **This is the largest single security improvement in the design**, and
   it is worth more than the rotation story.
4. **The publish-time guarantees survive into the artifact.** The tag/ancestry/
   digest checks the reusable workflow already performs (§1.2) currently
   evaporate at publish. Afterwards they are attested and re-checkable on the
   desktop.
5. **Rename survivability.** Pinning numeric repo and owner ids means a rename
   does not silently loosen the check to a name an attacker could later claim.

### 5.2 What gets worse

1. **`id-token: write` next to candidate code would be a catastrophic
   regression, and the obvious implementation walks straight into it.** Today the
   `build` job holds no credential and runs untrusted build code — `bun install`
   and whatever `package.json` scripts the tagged commit contains. Adding
   `permissions: id-token: write` to that job to sign in place would hand that
   code the ability to request a Fulcio certificate carrying the **trusted**
   `job_workflow_ref` identity, and therefore to sign arbitrary bytes that pass
   every check in §4. This design's answer is a **third job**: build (no
   id-token, runs candidate code) → sign (id-token, downloads the artifact by
   digest, executes no candidate code) → publish (API key, no id-token). It
   mirrors the existing build/publish split for the same reason and must not be
   collapsed.

   GitHub says this itself, in `gh attestation verify`'s own help text, and it is
   worth quoting because it also bounds what §4 may safely pin: *"only the
   `signature.certificate` and the `verifiedTimestamps` properties contain values
   that cannot be manipulated by the workflow that originated the attestation…
   should an attacker gain access to your workflow's execution context, they
   could then falsify the contents of the `statement.predicate`."* Two
   consequences. First, the recommended mitigation is exactly the trusted-builder
   shape — a reusable workflow "whose execution cannot be influenced by input
   provided through the caller workflow" — which is what the sign job must be.
   Second, **§4 pins certificate extensions only, never predicate fields**, and
   that is not an accident of drafting; the predicate is attacker-writable under
   the very compromise this is defending against.
2. **No transparency log, therefore no external observer.** §2.2. Private repos
   get no Rekor entry. A signature issued through a compromised path is
   undetectable by anyone outside the org, forever. The public-good instance is
   not available to LVIS without disclosing private repository and internal-plugin
   existence, which is a worse trade. This is a real loss relative to what
   "Sigstore" usually means, and it should not be papered over in the PR
   description.
3. **The trust surface expands to GitHub.** Today's chain is: our key, our server.
   Tomorrow's is: GitHub's OIDC issuer, GitHub's Fulcio, GitHub's timestamp
   authority, GitHub Actions' control plane. GitHub is already in the trusted path
   (it runs the build), so this is not a new *entity* — but it is a much wider
   *surface* of that entity, and the failure is silent rather than loud.
4. **Verification code grows by an order of magnitude.** 129 lines of
   `node:crypto` ed25519 becomes X.509 chain building, DER extension parsing,
   RFC3161 token verification, DSSE canonicalisation, and protobuf decoding —
   nearly all of it in a new third-party dependency running in the Electron
   **main** process, on attacker-supplied bytes, *before* any trust decision. The
   old verifier's smallness was itself a security property. This one is not
   small, and its input is hostile by definition.
5. **An embedded trusted root cannot learn about revoked key material.** The
   GitHub doc says so directly: "You will not know if key material has been
   revoked since you last generated the trusted root file." An app version pinned
   to an old root keeps trusting authority material that may since have been
   withdrawn.
6. **New coupling between app release cadence and plugin publishing.** A plugin
   published after a Sigstore key rotation will not verify on an app whose
   embedded root predates it. Fail-closed and loud, but it is a support burden
   that does not exist today, and it makes "ship an app release" a prerequisite
   for "publish a plugin" in a way it currently is not.
7. **`Runner Environment` and the publisher tier.** The `publish` job runs
   `self-hosted`. If signing ever moved onto that runner, the pinned
   `github-hosted` value would have to be relaxed — and a self-hosted runner's
   OIDC token is a far softer target. The three-job split in point 1 keeps signing
   on `github-hosted`; this constraint must be recorded, because "just sign in the
   publish job, it is already isolated" is the natural-looking shortcut and it is
   wrong.

### 5.3 What stays the same

- **Revocation is exactly as necessary as before.** GitHub's own doc: attestations
  "are *not* a guarantee that an artifact is secure." A perfectly valid build
  provenance for malicious code is the normal case after a repo compromise. The
  revocation registry remains the only lever that works when the signature is
  valid and the content is not — §7.
- The catalog still decides which version is "latest". Provenance does not.
- Sideload and `local-dev` installs are unaffected; they carry
  `signerKeyId: null` and are governed by `installSource` (see
  `plugin-install-receipt.ts`).
- The compromise path "merge to `main`, tag, dispatch" is unchanged in
  difficulty. It is the same path today.

---

## 6. What replaces the envelope

The envelope does not disappear; it gains a second, differently-rooted proof and
later loses its first one.

`SignatureEnvelope` (`public-contract.ts:567`) stays version `1` and untouched.
A **new** artifact is served alongside it:

```
GET /api/v1/plugins/{slug}/download?version=X         → plugin.zip        (unchanged)
GET /api/v1/plugins/{slug}/download.sig?version=X     → envelope v1       (unchanged)
GET /api/v1/plugins/{slug}/download.bundle?version=X  → Sigstore bundle   (new)
```

Adding a `sigstore` variant *inside* `SignatureEnvelope.signatures[]` was
considered and rejected: `alg` is typed `"ed25519"` and `verifyEnvelope` accepts
if **any** entry verifies, so a bundle smuggled into that array would inherit
disjunctive semantics — the exact property that made a single burned key
sufficient. The two proofs must be **conjunctive** during the overlap, and that
requires them to be separate objects verified by separate code with a caller that
requires both.

`InstalledArtifact.signerKeyId` becomes insufficient as a receipt field, since
"which key" is no longer the identity. The receipt gains a discriminated union;
`signerKeyId` keeps its meaning for envelope-verified installs and a new variant
records the attested identity (repo id, ref, workflow SAN, bundle digest).
`plugin-install-receipt.ts` already validates that marketplace receipts carry a
non-empty `signerKeyId`, so this is a schema version bump with an explicit
migration, not a widening of an existing field.

---

## 7. The whitelist and revocation trust domain: out of scope, and why

**This design covers `MARKETPLACE_PUBLIC_KEYS` only. `WHITELIST_PUBLIC_KEYS` —
and the revocation registry that aliases it — stays on its own ed25519 key.**

Four reasons, in order of weight:

1. **The split exists to survive artifact-key compromise, and merging trust roots
   would undo it.** Both documents would end up rooted in the same Sigstore
   trusted root as the artifacts. The property the source comment defends —
   "a revocation document is the thing a defender reaches for precisely when the
   artifact-signing key's integrity is in question" — is a property of *root
   separation*, and it does not survive a common root.
2. **The revocation registry must verify from cache when the app is old, and
   §5.2 point 6 is a stale-root failure mode.** A revocation document is a
   kill switch. Introducing "this document may stop verifying because the app is
   behind on Sigstore key material" into the kill switch's verification path
   trades a real safety property for consistency. `revocation-registry.ts` is
   deliberately allow-by-default when it has never seen a document, so a new
   verification failure mode there has teeth.
3. **The shapes do not match.** A plugin artifact is a tagged, immutable build.
   `whitelist.json` and `revocation.json` are living documents re-issued out of
   band from a **public** repo, with monotonicity and expiry semantics of their
   own. There is no tag, no build, and no artifact digest to attest.
4. **`marketplace-whitelist` is public**, so it would land on the public-good
   instance while the plugins land on GitHub's private one — two trusted roots and
   two verification configurations, for a document that ed25519 already handles.

Revisit only if all of: the artifact path has run through at least one real
Sigstore key rotation without incident; the trusted-root refresh loop is proven
in an app release; and someone writes down how a kill switch stays trustworthy
when its own trust root can go stale. Until then the split persists and this is
the argument for it.

---

## 8. Uncertainties, and what would resolve each

Named rather than hidden. The first one currently stops the migration outright;
the next two can stop it once the first clears.

1. **Is there any path to artifact attestations for private repos on the Team
   plan?** §2.3 quotes the README and the org plan, and the two do not compose.
   What is *not* certain is whether the restriction is enforced at the API — a
   trial run would either produce a bundle or fail with a plan error, and either
   outcome is worth more than the doc line. **Resolve:** one attestation attempt
   in a scratch **private** repo under `lvis-project`. If it fails, the question
   becomes the plan decision in §9 and nothing else in this list matters yet. Do
   this before anything else; it is ten minutes.
2. **What exactly does `job_workflow_ref` contain when the caller pins the
   reusable workflow by commit SHA?** The callers use
   `@10c12345af6eb1a4c6ec60216909fe722d3abce6`. If GitHub reports the SAN as
   `…/marketplace-publish.yml@10c12345…`, the SAN changes on every pin bump and
   the pinned pattern in §4 must accommodate that — which is a *stronger* claim
   but a rotation problem of its own. If GitHub resolves it to
   `@refs/heads/main`, §4 is correct as written. **Resolve:** Stage 1 — run one
   real attestation in a scratch repo and read the certificate. Do not guess this;
   it is the SAN the entire policy anchors on.
3. **Does GitHub's private Sigstore instance issue bundles that
   `@sigstore/verify` accepts with `tlogThreshold: 0, ctlogThreshold: 0,
   timestampThreshold: 1`?** §3.2 establishes from GitHub's published trusted
   root that `tlogs` and `ctlogs` are both empty and that the `gh` CLI verifies
   with signed timestamps alone, so the configuration follows — but that is
   reasoning about a Go client, not a passing test of the JS one. Two sub-parts
   need checking together: that `toTrustMaterial` maps
   `timestamp.githubapp.com` into `timestampAuthorities`, and that
   `getTSATimestamp` accepts the RFC3161 token GitHub actually emits. If the JS
   path cannot consume it, keyless is off regardless of the plan question.
   **Resolve:** Stage 1 — verify a real private-repo bundle in a Node script
   against a `trusted_root.jsonl` line, offline. Note the file is **JSONL**, one
   `TrustedRoot` object per line, not a single object; the loader must select the
   GitHub-instance line rather than parsing the file whole.

   A related trap worth resolving in the same sitting: `policy.oids` compares
   **raw DER extension bytes**, not decoded strings — `getSigner()` takes
   `ext.subs[ext.subs.length - 1].value`, which for `.1.9`–`.1.24` is a
   `UTF8String` with its `0x0C <len>` header intact. A pinned value written as a
   plain string will silently fail to match, and "silently fails to match" on an
   identity pin is the worst possible failure direction. Confirm the exact
   encoding empirically and assert it in a test.
4. **Does `@sigstore/verify` 4.x run under Electron 43's bundled Node?** The
   package declares `^22.22.2 || ^24.15.0 || >=26.0.0`; `lvis-app` declares
   `node >=22.4` and `electron ^43.0.0`. Engine ranges are advisory, but a real
   API dependency would not be. **Resolve:** Stage 1 — import and verify inside a
   packaged Electron main process, not just under `bun test`.
5. **How large is the bundle, and does it fit the installer's resource
   ceilings?** `readBoundedSignatureEnvelopeBody` bounds the `.sig` fetch;
   a bundle with a full certificate chain is larger by a wide margin.
   **Resolve:** measure in Stage 1 and set the bound from the measurement, not
   from a guess.
6. **What does the `publish` job's self-hosted runner tier do to any of this?**
   §5.2 point 7 keeps signing off that runner, but the publish job must now
   upload a second file, and the runner is deliberately network-restricted to
   loopback. **Resolve:** confirm the artifact handoff carries the bundle the same
   way it carries `plugin.zip`, with the same digest check.
7. **How often does GitHub's Sigstore instance actually rotate, and how long is
   the overlap?** Better than the generic "a few times per year": GitHub's
   published trusted root carries six successive `fulcio.githubapp.com` windows
   from 2023-10-27 to now — roughly a **seven-month cadence with about a month of
   overlap**, and the current window is open-ended. Against that, LVIS ships app
   releases far more often (0.4.x in July, 0.6.2 now), so the coupling in §5.2
   point 6 has real slack. What is *not* established is whether the overlap is a
   guarantee or an observation. **Resolve:** treat it as an observation, and add
   a CI job that diffs the embedded root against a freshly fetched one and fails
   the build when they diverge — so the refresh is forced by tooling rather than
   remembered.
8. **Is there any consumer of `signerKeyId` outside the receipt?**
   `plugin-artifact-identity.ts:62` and `plugin-artifact-store.ts:178` both read
   it. **Resolve:** Stage 2 — the receipt schema change is where this surfaces,
   and it must be an exhaustive union rather than a nullable string.

---

## 9. Recommendation

**Not yet. The reason is §2.3: artifact attestations are unavailable for private
repositories on the GitHub Team plan, and every plugin repository is private.**

This is a clean blocker, not a judgement call, and it should be reported as
"blocked on an org plan decision" rather than as "keyless was investigated and
rejected". Nothing here says the approach is wrong. It says the product is not
sold to us on our current plan, and the two workarounds both require publishing
things we have deliberately kept private (§2.3).

What the investigation established, and what should not have to be redone:

- Offline verification is **workable**, and for a stronger reason than expected:
  the trusted root is an expiry-free data file, verification in `@sigstore/verify`
  is a pure function of it, and the RFC3161 timestamp removes the
  short-lived-certificate problem without needing a transparency log. §3.
- The migration's real prize is **not** rotation cost. It is removing the
  marketplace server's ability to sign arbitrary bytes (§5.1 point 3) and
  upgrading the claim from "the server accepted this upload" to "this workflow
  built this tag" (§1.2 → §4).
- It is **not** a transparency-log story for LVIS, and presenting it as one would
  be false. GitHub's private instance has neither a Rekor log nor a CT log
  (§2.2, §3.2), so the honest description is *no external detectability at all*.

The decision this document actually asks for is therefore narrow:

> Is *"the marketplace server can no longer sign arbitrary bytes, and installs
> carry a checkable build identity"* worth a GitHub Enterprise Cloud plan?

That is an owner call and this design has no standing to make it. If the answer
is no, §1.2 still needs writing into the architecture (§11) and `prod-v1` remains
what it is — a single long-lived anchor whose next rotation costs another
catalog re-sign. Worth pricing that against the plan difference before deciding.

If the answer is yes, the recommendation becomes **proceed with conditions**, and
the conditions are all in Stage 1:

1. Uncertainty 2 (SAN under a SHA-pinned reusable workflow) resolved
   empirically.
2. Uncertainty 3 (private-instance bundle verifies in `@sigstore/verify` with
   `tlogThreshold: 0, ctlogThreshold: 0, timestampThreshold: 1`) resolved
   empirically.
3. The three-job split (§5.2 point 1) is treated as non-negotiable. If it cannot
   be built, **stop** — signing in a job that executes candidate code is worse
   than the status quo, not better.

Independently of all of the above, one thing here is worth doing now and costs
nothing: §11.

---

## 10. Staged plan

Each stage is independently mergeable and leaves the product working. Stage 1 is
where the risk is, and it is deliberately cheap. Stage 5 is where it is
irreversible.

### Stage 1 — Prove the facts that can stop this

*Scope.* No production code, and it starts with the ten-minute check, not the
afternoon one.

**First**, a scratch **private** repo under `lvis-project` running
`actions/attest` once. If the Team plan refuses it (§2.3, uncertainty 1), stop
here and take the plan question to the owner — everything below is wasted until
that is answered.

**Then**, if it produces a bundle: pin the reusable workflow exactly as the
plugin repos pin it, run the attestation through it, and dump the certificate —
the SAN and every `1.3.6.1.4.1.57264.1.x` extension, with their raw DER bytes,
not just the decoded strings. Fetch `trusted_root.jsonl`, select the
GitHub-instance line. Write a Node script using `@sigstore/verify` that loads it
via `toTrustMaterial`, constructs a `Verifier` with
`{ tlogThreshold: 0, ctlogThreshold: 0, timestampThreshold: 1 }`, and verifies
the bundle **with the network interface down**. Run the same script inside a
packaged Electron main process. Measure the bundle size.

*What proves it.* A recorded transcript of the certificate's extensions, and a
verification that passes offline, fails when one artifact byte is mutated, and
fails when the pinned SAN names a different workflow. All three outcomes get
written back into this document — particularly the SAN, which uncertainty 2
cannot resolve any other way.

*Risk: none.* Nothing ships. This is the stage that decides whether the rest
happens.

### Stage 2 — Make the receipt able to describe a non-key signer

*Scope.* `plugin-install-receipt.ts`: bump the receipt schema, replace
`signerKeyId: string | null` with an exhaustive discriminated union over
`{ envelope: { keyId } }` and `{ attestation: { repositoryId, ref, workflow, bundleSha256 } }`.
Migrate existing receipts to the `envelope` variant on read. Update
`plugin-artifact-identity.ts` and `plugin-artifact-store.ts` to switch
exhaustively.

*What proves it.* Existing receipts still load and still gate installs
identically; a receipt with an unknown variant is rejected, not defaulted.

*Risk: low.* No verification behaviour changes. This is the shape every later
stage writes into.

### Stage 3 — Produce and store bundles, verify nothing

*Scope.* Add the **sign** job to `lvis-project/.github`'s reusable workflow,
between build and publish: `runs-on: ubuntu-latest`, permissions
`{ id-token: write, attestations: write, artifact-metadata: write, contents: read }`
(the last two are required by `actions/attest` v4 and are easy to miss), downloads
`plugin.zip` by digest, runs **`actions/attest`** — not
`attest-build-provenance`, whose README says as of v4 it is a wrapper and new
implementations should use `actions/attest` directly — with `subject-path`, and
passes `bundle-path` forward as a second artifact with its own digest handoff
check. **The sign job executes no candidate code** — no `bun install`, no
lifecycle scripts. Publish job uploads both files. Marketplace gains
`store_bundle` and `GET /download.bundle`, and a nullable `attestation_bundle`
column.

*What proves it.* Publishing a plugin produces a bundle that
`gh attestation verify --bundle … --custom-trusted-root …` accepts offline.
Clients ignore it entirely; installs are byte-identical in behaviour.

*Risk: medium* — it touches the credential-bearing workflow. The review question
is exactly one: *can anything from the tagged commit execute in the sign job?*

### Stage 4 — Verify bundles alongside the envelope, conjunctively

*Scope.* Embed `trusted_root.json` in the app build with a CI job that fails when
it diverges from a freshly fetched one. Add `src/plugins/attestation-verifier.ts`
wrapping `@sigstore/verify` with the §4 policy built from the catalog row and
issuer-pinned thresholds as module constants. The installer requires **both**
proofs when a bundle is present, and **the envelope alone when it is not** — the
only asymmetry in the design, and it is what lets already-published versions
stay installable. Both failures are hard, with distinct error codes.

*What proves it.* A plugin published in Stage 3 installs with both proofs; a
mutated bundle fails; a bundle whose SAN names a different workflow fails; a
bundle for a different `slug@version` fails; an artifact with no bundle still
installs and its receipt says so.

*Risk: high.* This is where a new dependency starts parsing hostile bytes in the
main process. It is also the stage a fallback would sneak into. The tolerated
"no bundle" branch must key off the **catalog row**, not off a fetch failing —
"the bundle 404'd so skip it" is the bypass that undoes the entire migration, and
it must be impossible to reach by making the bundle's absence a property of the
catalog rather than of the network.

### Stage 5 — Require a bundle for new versions

*Scope.* Marketplace refuses a publish without a bundle. Catalog rows gain a
non-nullable flag for versions published after the cutover. Client requires a
bundle for any version so flagged and refuses to install without one.

*What proves it.* A publish attempt without a bundle 400s. An install of a
flagged version with the bundle withheld fails closed.

*Risk: medium.* Reversible only by un-flagging rows. This is the point of no
return for the publish path, and it should not be crossed until Stage 4 has been
in a shipped release long enough that the trusted-root refresh loop has run at
least once.

### Stage 6 — Stop signing envelopes server-side

*Scope.* Remove `sign_artifact_multi` from the publish path. `signing.py` keeps
`verify_artifact` for the historical catalog. `MARKETPLACE_SIGNING_PRIVATE_KEY_*`
is removed from the server environment — **this is the stage that delivers §5.1
point 3**, and it is the one that actually retires the long-lived key.

*What proves it.* The server boots with no signing key configured and publishes
successfully. New versions carry a bundle and no envelope.

*Risk: medium*, and precisely bounded: any client older than Stage 4 can no
longer install new versions. That is a minimum-app-version gate, and the
revocation registry's `minVersions` mechanism already expresses it.

### Stage 7 — Remove the `prod-v1` anchor

*Scope.* Delete `prod-v1` from `MARKETPLACE_PUBLIC_KEYS`, delete
`envelope-verifier.ts`'s use in the artifact path, delete `resign_artifacts.py`.
`WHITELIST_PUBLIC_KEYS` and `verifyEnvelope` remain, in service of the whitelist
and revocation documents (§7) — `verifyEnvelope` is not deleted, only its
marketplace-artifact caller.

*What ends the overlap.* Not a date. Two conditions, both measurable:

1. **No installable catalog version lacks a bundle.** Same query shape
   `resign_artifacts.py` used for `signer_key_id`, run against the bundle column.
   Versions whose artifact file no longer exists on disk do not count — that is
   how the last 56 `poc-v1` rows were correctly discharged, and it is the
   precedent.
2. **No supported app version predates Stage 4.** Enforced with the existing
   `minVersions` pin, not assumed.

Until both hold, the envelope path stays. It is a *second* anchor during the
overlap, and §1.1's warning applies to it — which is the argument for making the
overlap short rather than comfortable.

*Risk: low* by the time it is reachable, because both conditions are queries
rather than judgements.

---

## 11. Architecture amendment requested

One, and it is a correction of something the architecture never said.

**`docs/architecture/architecture.md` §9 (Plugin System)** describes marketplace
delivery in terms of a signed artifact without stating *who signs* or *what the
signature asserts*. §1.2 of this document establishes that the signer is the
marketplace server and the assertion is "an authenticated upload was accepted".
That should be written down whether or not this migration proceeds, because it is
currently load-bearing and undocumented, and because every reader who has not
traced `publisher.py:568` assumes the opposite.

If the migration proceeds, the same section gains the §4 claim as the replacement
assertion, and the two-trust-domain split (§7) is stated there rather than living
only in a comment in `marketplace-keys.ts`.

---

## Sources

Primary sources read for this document, not summarised from recall:

- `sigstore/fulcio` — `docs/oid-info.md` (OID directory, CI/CD claim requirements,
  DER vs raw encoding, deprecation of `.1.1`–`.1.6`)
- `sigstore/sigstore-js` — `packages/verify/src/{index,verifier,shared.types}.ts`
  and `packages/verify/src/trust/index.ts` (`toTrustMaterial`, `Verifier.verify`,
  `VerifierOptions` thresholds, `VerificationPolicy` shape)
- `github/docs` —
  `content/actions/concepts/security/artifact-attestations.md` (public-good vs
  GitHub instance; no transparency log for private repositories; SLSA Build
  Level 3 via reusable workflows; attestations are not a security guarantee)
- `github/docs` —
  `content/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline.md`
  (`gh attestation trusted-root`, no built-in expiration, rotation cadence,
  revocation blind spot)
- `actions/attest-build-provenance` — `action.yml` and `README.md` at `v4.2.2`
  (inputs, `bundle-path` output, the v4 wrapper note, required permissions, and
  the plan-availability restriction quoted in §2.3)
- `cli/cli` — `pkg/cmd/attestation/verification/sigstore.go` (the
  `WithSignedTimestamps(1)` vs `WithObserverTimestamps(1) + WithTransparencyLog(1)`
  split between the GitHub and public-good verifiers)
- `https://cli.github.com/manual/gh_attestation_verify` (identity-pinning
  guidance; the predicate-is-attacker-writable warning quoted in §5.2)
- `https://tuf-repo.github.com` — GitHub's published `trusted_root.json`
  (`fulcio.githubapp.com` CA windows, `timestamp.githubapp.com`, empty `tlogs`
  and `ctlogs`)
- `https://docs.sigstore.dev/about/security/` and `/about/threat-model/`
  (OIDC-account compromise is out of scope for Sigstore; users are responsible
  for monitoring certificate transparency)
- `gh api orgs/lvis-project` (org plan, §2.3)
- npm registry — `@sigstore/verify@4.1.2`, `sigstore@5.0.0`, `@sigstore/tuf@5.0.0`
  (versions and engine constraints, as of 2026-08-19)
- LVIS: `lvis-app/src/plugins/{envelope-verifier,marketplace-keys,marketplace-installer,public-contract,plugin-install-receipt}.ts`,
  `lvis-app/src/plugins/revocation/*`,
  `lvis-marketplace/server/src/lvis_marketplace/{signing.py,api/publisher.py}`,
  `lvis-marketplace/server/scripts/resign_artifacts.py`,
  `lvis-project/.github/.github/workflows/marketplace-publish.yml`,
  plugin repo `.github/workflows/publish.yml`
