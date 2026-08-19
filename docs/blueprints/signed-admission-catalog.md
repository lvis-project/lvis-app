# Signed Admission Catalog — Design And Staged Plan

Status: design, not implemented. This document is the agreement that has to exist
before any code moves, because the change swaps the *polarity* of a security
control — from "prove this artifact is signed" to "prove the distributor listed
it" — and a half-migrated polarity is a bypass, not a partial improvement.

**Recommendation up front: build it.** The blocker that stops
`keyless-marketplace-signing.md` is commercial and outside our control; this one
has no blocker. It does not compete with that design — it removes a different,
larger defect (attribution) and it removes the signing oracle earlier and more
cheaply. §10 states how the two relate.

Anchors: `docs/architecture/architecture.md` (§9 Plugin System, §14 Deployment
and Governance), `docs/blueprints/keyless-marketplace-signing.md` (the sibling
design; §1 of that document and §1 here describe the same verifier and agree),
and the code named in §1. Where this design asks the architecture to change, the
section is named in §12.

Every claim about current behaviour below was re-checked against the source at
`lvis-app` `main` (`40d5021`) and `lvis-marketplace` `main`. Where a claim could
not be confirmed it is in §11, not in the body.

---

## 1. What is actually true today

### 1.1 The signature does not say what it is signing

`SignatureEnvelope` (`src/plugins/public-contract.ts:567`):

```ts
export interface SignatureEnvelope {
  version: 1;
  iat: number;
  artifact_sha256: string;
  signatures: Array<{ key_id: string; alg: "ed25519"; sig: string }>;
}
```

There is no slug. There is no version. `verifyEnvelope`
(`src/plugins/envelope-verifier.ts`) checks that `artifact_sha256` matches the
bytes and that **at least one** signature verifies against **any** key in the
supplied map. The map for tarballs is `MARKETPLACE_PUBLIC_KEYS`
(`src/plugins/marketplace-keys.ts`), currently the single entry `prod-v1`.

The server envelope has one extra field the client does not model. `signing.py`'s
`sign_artifact_multi` writes:

```python
if artifact_id is not None:
    envelope["artifact_id"] = artifact_id
```

and its own docstring disclaims it:

> If `artifact_id` is provided (e.g. `"meeting@1.2.3"`) it is included as
> diagnostic routing metadata. Signatures cover the raw artifact bytes, not
> this field, so callers must not treat it as replay protection or identity
> proof.

That is exact and it is the whole finding. The ed25519 signature is computed over
`tarball_bytes` alone. `artifact_id` sits *outside* the signed payload, is absent
from the client's TypeScript type, and is never read by any client code — grep
for `artifact_id` in `lvis-app/src` returns nothing. So even the one field that
looks like attribution is unauthenticated decoration.

**Consequence, stated plainly.** The signature asserts "some holder of a trusted
key signed these bytes". It cannot assert "…and these bytes are `meeting@1.2.3`".
Admitting a second signer — the whole point of opening to third parties — would
grant that signer the ability to produce an envelope for an artifact served under
*any* slug, because nothing in the verified statement scopes them to their own.
Third-party opening is not merely unimplemented under this shape; it is
unexpressible.

### 1.2 Rotation is O(catalog)

`poc-v1`'s private half is public by construction — it shipped in the marketplace
repo's test fixtures and was exposed again in a merged public PR. Because
`verifyEnvelope` accepts *any* key in the map, its presence there meant anyone who
could serve an artifact could sign one every LVIS build accepted.

Removing it required re-signing the published catalog first. From
`server/scripts/resign_artifacts.py` and the comment block in
`marketplace-keys.ts`: **804 of 860 version rows** were re-signed to `prod-v1`.
The remaining 56 were safe only because their artifact files no longer exist on
disk (archived `email`/`calendar`, pre-rename `pageindex`/`work-proactive`), so
their download 404s before any signature check runs.

The script is well built — it re-runs the server's own `verify_artifact` over the
bytes on disk before touching a row and aborts the whole run on the first
mismatch. That is the right design for the job. The problem is that the job
exists. Retiring one anchor cost a full pass over the catalog, and the next
rotation costs the same again.

### 1.3 The marketplace server is a signing oracle

`server/src/lvis_marketplace/api/publisher.py:568`:

```python
signing_keys = require_signing_keys()
envelope = sign_artifact_multi(data, signing_keys, artifact_id=artifact_id)
```

`data` is the uploaded bytes. The route
(`@router.post("/plugins/{slug}/versions")`, line 200) is gated by
`require_role("publisher")` — an API key. So code execution on the marketplace
host, or theft of a publisher API key, yields a `prod-v1` signature over
arbitrary bytes that every LVIS build accepts.

Two mitigations exist and neither closes it. `install_policy == "admin"` publishes
land in `approval_state = "pending_review"` and stay out of the catalog until an
admin approves — but that is a *catalog visibility* gate, not a signing gate: the
envelope is already signed and stored by then. And the clock-skew assertion right
after signing catches a broken server clock, not a malicious publisher.

**All three claims hold.** They are not three problems; they are one. The signing
key is a long-lived secret held by an online service, and the statement it
produces is too weak to scope anyone else's use of it.

### 1.4 The fact that makes a catalog viable

`verifyEnvelope` is called from five non-test sites. Three are policy documents
(`whitelist-registry.ts:207`, `:345`; `revocation-registry.ts:182`, `:289`) —
those verify JSON bodies, not tarballs. For **artifacts** there is exactly one:

`src/plugins/marketplace-installer.ts:348`, inside `installFromMarketplace`,
reached only from `PluginArtifactStore.downloadVerifiedArtifact`
(`plugin-artifact-store.ts:428`).

That path is online by construction, and deliberately so. Step 3 of the installer:

```ts
// 3. Fetch sig envelope — always re-fetched, even on cache hits.
//    A cached tarball byte sequence is trusted only when it passes the
//    current envelope signature; never short-circuit this step — a cache
//    hit must not bypass envelope-verifier.
```

A tarball-cache hit skips the *download*, never the envelope fetch; a failure
there throws `ENVELOPE_FETCH_FAILED`. There is no offline install path. The 7-day
offline catalog cache (`offline-cache.ts`) lets the user *browse* offline; it does
not let them install.

Load-time integrity is a separate, unrelated mechanism:
`verifyInstallReceipt` (`plugin-install-receipt.ts:133`) re-hashes a per-file
sha256 manifest recorded at install and is consulted at boot
(`runtime/runtime-integrity.ts:20`), on update recovery, and on contribution
sealing. It never looks at a signature.

**So an artifact never needs to be self-verifying offline.** The bytes on disk are
protected by the receipt; the bytes on the wire are protected by whatever is
checked while the client is online anyway. That is the entire licence for this
design. It is also the assumption that most needs re-checking before Stage 3 — see
§11.

### 1.5 Two smaller defects the catalog subsumes

`plugin-artifact-store.ts:424`:

```ts
const expectedArtifactSha256 =
  !plugin.version || plugin.version === version || version === "latest"
    ? plugin.artifactSha256
    : undefined;
```

The catalog row's hash is cross-checked only when installing the *latest* version.
A pinned or rollback install gets no catalog-hash cross-check at all — it relies
on the `X-Plugin-SHA256` header and the envelope, both served by the same host as
the bytes. And `plugin.artifactSha256` is read from an **unsigned** JSON catalog
response, so even in the latest case it is not evidence, only a consistency check
against the same origin.

A signed catalog makes the same comparison meaningful and makes it apply to every
version.

---

## 2. The document

### 2.1 Shape

Follows `whitelist/` and `revocation/` exactly: a JSON body plus a **detached**
signature sidecar, fetched by `signed-doc-fetcher.ts` (primary → fallback, ETag
conditional GET), cached by `signed-doc-cache.ts`, parsed by a hand-written
fail-closed validator in the style of `revocation-schema.ts` (no AJV, descriptive
per-field errors), verified by `verifyEnvelope` over the body bytes.

```
GET {base}/admission.json
GET {base}/admission.json.sig
```

New module directory `src/plugins/admission/`:
`admission-schema.ts`, `admission-cache.ts`, `admission-fetcher.ts`,
`admission-registry.ts`. No new fetch or cache code — those two already exist and
are already shared by two consumers.

### 2.2 Schema

```ts
export interface AdmissionEntry {
  slug: string;
  version: string;
  /** Hex sha256 of the artifact tarball bytes. */
  artifactSha256: string;
  /** Who the distributor attributes this artifact to. */
  publisher: string;
  /** ISO-8601. When this slug@version was first admitted. */
  admittedAt: string;
}

export interface AdmissionDocument {
  version: 1;
  schemaVersion: 1;
  /** ISO-8601. Monotonicity anchor (rollback guard). */
  issuedAt: string;
  /**
   * ISO-8601. UNLIKE the revocation document's `expiresAt`, this is a HARD
   * enforcement boundary: past it, nothing installs. See §4.
   */
  expiresAt: string;
  /** Every artifact the distributor currently admits for installation. */
  admissions: AdmissionEntry[];
}
```

`(slug, version)` is unique; a duplicate is a parse error, not a
last-writer-wins. `artifactSha256` must match `/^[a-f0-9]{64}$/`. `version` must
match the same loose semver-core check `revocation-schema.ts` uses. Any unknown
root key is rejected — the document is small and hand-written by one issuer, so
strictness costs nothing and a silently-ignored field is how a future signed
statement gets weakened.

### 2.3 What it binds, and why each field is in the signed payload

- `slug` + `version` + `artifactSha256` — **the point of the whole exercise.**
  The signed statement now names *which plugin at which version* these bytes are,
  so a signer's authority can be scoped to a slug set. §9.
- `publisher` — attribution beyond identity. `slug@version → sha256` alone lets
  the issuer scope a *key* to a *slug*; it does not record *who the artifact came
  from*. Without it the install receipt cannot say anything more than "the
  marketplace admitted this", which is exactly the statement we already have, and
  a per-publisher revocation (§8) has no subject to name. It is a distributor
  assertion, not a self-declared author field: it is written by the issuer from
  the publishing API key's owner, never copied from the manifest.
- `admittedAt` — lets a client and an operator distinguish "newly admitted" from
  "carried forward", which is what makes a diffable issuance review (§10.2)
  possible.

Deliberately **not** bound here: `minAppVersion`, capabilities, permissions,
manifest hash. Those are properties of the artifact, they are already inside it,
and they are already validated against the host schema at publish and at install.
Restating them in the catalog creates a second source of truth that can disagree
with the first. The catalog answers one question — *may this exact byte sequence
be installed under this name?* — and answers nothing else.

### 2.4 Trust anchor

A **new** key domain, `ADMISSION_PUBLIC_KEYS` with `admission-v1`, in
`marketplace-keys.ts` alongside the existing two.

It must not reuse the whitelist/revocation domain. That domain's own comment
states the invariant it protects: the revocation document is "the thing a defender
reaches for precisely when the artifact-signing key's integrity is in question, so
it cannot share that key's trust domain." The admission catalog **is** the
artifact-trust domain's successor — compromising `admission-v1` means admitting
arbitrary hashes under arbitrary slugs, i.e. exactly what compromising `prod-v1`
means today. Sharing it with revocation would hand the same attacker the ability
to un-revoke.

It must not reuse `MARKETPLACE_PUBLIC_KEYS` either, because the two coexist
conjunctively during migration (§10) and the whole point of the overlap is that
one compromised key is not sufficient.

Rotation of `admission-v1` is O(1): add the new id, re-sign **one** document, drop
the old id after one TTL. `resign_artifacts.py` has no successor because it needs
none.

### 2.5 Where it is issued and hosted

Hosted alongside `whitelist.json` and `revocation.json` on
`lvis-project/marketplace-whitelist` (`v1/admission.json` + `.sig`), primary via
GitHub Pages with the GitHub Release asset as fallback — the topology
`signed-doc-fetcher.ts` already implements and two documents already use.

**The private key is not on the marketplace server.** This is the property that
kills the oracle. `publisher.py` will no longer hold a signing key at all; it
records the artifact and its hash, and admission happens in a separate issuance
step that the API host cannot trigger. §10.2 is where that gets expensive, and it
is the central cost of this design.

---

## 3. The install path, end to end

### 3.1 Registry

`AdmissionRegistry` mirrors `RevocationRegistry`'s lifecycle — `init()` → load
disk cache → verify → fetch remote → verify → monotonicity guard → swap — with a
different decision function and the opposite staleness polarity.

```ts
export type AdmissionDecision =
  | { kind: "admitted"; entry: AdmissionEntry }
  | { kind: "refused"; code: AdmissionRefusalCode; detail: string };

export type AdmissionRefusalCode =
  | "admission-unavailable"     // never obtained a valid document
  | "admission-stale"           // held document is past its own expiresAt
  | "admission-not-listed"      // slug@version absent
  | "admission-hash-mismatch";  // listed, different sha256
```

Unlike the revocation registry, `evaluate()` cannot be the whole story, because
this gate needs a *fresh* document and boot may have run days ago. So the
registry exposes `ensureFresh(signal)`, an async refresh the install path awaits
before evaluating. `init()` at boot is a latency optimisation, not the gate.

`init()` never throws (a network blip must not crash boot). `ensureFresh()` does
not throw either; it resolves to a state that `evaluate()` reads. The *install
path* throws, and does so on every non-`admitted` decision.

### 3.2 Sequence

Inside `PluginArtifactStore.downloadVerifiedArtifact`, before any bytes move:

1. `assertMarketplaceAppUpgradeNotRequired(plugin)` — unchanged.
2. `assertMarketplaceNotRevoked(plugin)` — unchanged. Revocation runs **first**;
   a version that is both admitted and revoked must report as revoked, because
   that is the actionable message.
3. **`await admissionRegistry.ensureFresh(signal)`** — conditional GET; a 304 or
   a still-valid cache within its own `expiresAt` completes without a body
   transfer.
4. **`admissionRegistry.evaluate(slug, version)`** → must be `admitted`.
   Otherwise throw `PluginNotAdmittedError` carrying the refusal code. Nothing
   has been downloaded at this point; the refusal is cheap and the user-facing
   copy is specific.
5. Pass `entry.artifactSha256` into `installFromMarketplace` as
   `expectedArtifactSha256` — **unconditionally**, for every version, replacing
   the latest-only conditional at `plugin-artifact-store.ts:424`. The existing
   `CATALOG_SHA256_MISMATCH` check at `marketplace-installer.ts:282` then becomes
   a signed-statement check rather than a same-origin consistency check, with no
   new code in the installer.
6. Envelope verification proceeds unchanged during the overlap (§10). Both must
   pass. Conjunctive, never disjunctive — for the same reason
   `keyless-marketplace-signing.md` §6 rejects smuggling a second proof into
   `signatures[]`: a disjunction is only as strong as its weakest arm, and that
   property is what made one burned key sufficient.
7. On success, the receipt records the admission (§3.4).

### 3.3 Failure modes

Every row fails the install. There is no row whose remedy is "proceed".

| Condition | Where | Code | Behaviour |
|---|---|---|---|
| Catalog unfetchable, no cache ever | `ensureFresh` | `admission-unavailable` | Install fails. Message names the catalog host and says retry when online. |
| Catalog unfetchable, cache within its `expiresAt` | `ensureFresh` | — | Proceed on the cached document. It is a signed, unexpired statement; the CDN being down does not unmake it. |
| Catalog unfetchable, cache past `expiresAt` | `ensureFresh` | `admission-stale` | Install fails. §4. |
| Signature invalid (fresh or cached) | registry | treated as no document | Never swapped in. Audited. If it was the cache, the cache is discarded. |
| `issuedAt` older than high-water mark | registry | rejected | Fetched document discarded, previous snapshot retained, audited. §5. |
| `issuedAt` implausibly in the future | registry | rejected | Same. §5. |
| Malformed / unknown-field document | schema | throws | Parse failure is "no valid document", never "empty catalog". A catalog that parses to zero admissions and a catalog that fails to parse must not converge on the same in-memory state. |
| Slug absent | `evaluate` | `admission-not-listed` | Install fails. This is also how withdrawal is expressed (§8). |
| Version absent for a listed slug | `evaluate` | `admission-not-listed` | Same. Rollback to an un-admitted old version is refused. |
| Hash mismatch | `evaluate`, then installer | `admission-hash-mismatch` / `CATALOG_SHA256_MISMATCH` | Install fails. Checked twice: once before download against the catalog row, once after download against the bytes. |

`admission-not-listed` and `admission-hash-mismatch` deserve different copy. The
first is ordinary ("this version is no longer offered"); the second is an
integrity event ("the marketplace served bytes the distributor did not admit")
and should be audited at a severity that reaches an operator, because on the
happy path it never happens.

### 3.4 Receipt

`PluginInstallReceipt` (`plugin-install-receipt.ts`) gains, at
`schemaVersion: 3`:

```ts
admission: {
  issuedAt: string;        // the catalog document that authorised this install
  documentSha256: string;  // digest of the exact admission.json body
  publisher: string;
} | null;                  // null for local-dev installs, as signerKeyId already is
```

Two reasons. A receipt that records only `signerKeyId` cannot answer "under whose
authority is this on disk" once the key stops being the authority. And a
`documentSha256` makes an after-the-fact audit possible: given a receipt, an
operator can fetch the archived catalog issuance and confirm the statement was
really made.

`verifyInstallReceipt` already normalises v1 to v2; v3 follows the same shape.
Existing v2 receipts stay valid — this field is additive and its absence means
"installed before admission was enforced", which is a true statement, not a
fallback.

---

## 4. Staleness — the decision, and the argument

**A stale admission catalog blocks installs. There is no grace window.**

This is the opposite of `revocation-schema.ts`, whose `expiresAt` "never causes
the document to stop being enforced… a revocation list is a BLOCK list, so the
safe default on staleness is to keep blocking". Copying that here would be a
bypass with a comment on it. An ALLOW list that keeps allowing after the issuer
stopped attesting turns "we withdrew that version" into "that version is
installable forever, on every device that ever cached the catalog".

The revocation registry's fail-open-when-never-seen has the same inversion.
There, an absent document must not brick every installed plugin — being offline
is not a reason to disable the user's software. Here, an absent document means
we have no statement that anything may be installed, and *not installing* is a
perfectly survivable state. **No catalog never permits an install.** Not on first
run, not offline, not on a fetch timeout, not on a 500. There is no branch in
this design that reads "could not fetch the catalog, so proceed".

It is also different from the whitelist's 7-day grace, and the difference is
worth naming because the whitelist is the closer-looking precedent.
`whitelistRegistry.isAllowed` is on the synchronous `hostApi.getSecret` hot path
of an already-running plugin; denying there breaks working software mid-session,
so a grace window buys real robustness. Installing is user-initiated, already
network-bound (§1.4), and trivially retryable. A grace window there buys nothing
a retry does not, and costs the withdrawal guarantee.

**Therefore `expiresAt` is short: 24 hours, re-issued every 6.** The issuer emits
a fresh document on that schedule whether or not anything published — a heartbeat.
Three things follow:

- Withdrawal by omission takes effect within one TTL, everywhere, without a
  revocation entry.
- The cached-document window in §3.3 is bounded to a day, so "proceed on cache"
  is a genuinely narrow allowance and not a soft failure mode.
- A missed heartbeat is loud within a day. If issuance breaks, installs stop, and
  that is the correct direction for the failure to fall — but it does mean
  issuance availability is now install availability. §7.1.

The TTL is the tuning knob, and 24h/6h is a starting point to be revisited with
the fetch-success data from Stage 1, not a constant to be defended.

---

## 5. Rollback and `issuedAt` monotonicity

The revocation registry already guards this and calls the guard "load-bearing,
not a defense-in-depth extra". It is more load-bearing here, and for a second
reason.

Against revocation, replaying an older signed document un-revokes something.
Against admission, replaying an older signed document does two things: it
un-admits recently published versions (annoying, fails closed, self-correcting)
**and it re-admits versions that were withdrawn by omission** (dangerous, fails
open, persistent). Withdrawal by omission is only as strong as the rollback
guard, so the guard is not adjacent to the withdrawal mechanism — it *is* the
withdrawal mechanism's enforcement.

The rules:

1. `highestSeenIssuedAt` persists in the cache meta, exactly as
   `revocation-cache.ts` does. A fetched document with
   `issuedAt < highestSeenIssuedAt` is discarded; the previous snapshot is
   retained; the event is audited and counted.
2. A fetched document with `issuedAt` more than the clock-skew allowance in the
   **future** is also discarded. The revocation registry does not check this; the
   installer checks the equivalent on `envelope.iat` and this design keeps that
   property when the envelope goes away. Without it, one bad document with a
   far-future `issuedAt` poisons the high-water mark and refuses every genuine
   document after it — a denial of service that survives restarts because the
   mark is on disk.
3. `expiresAt > issuedAt` is a parse-time requirement, as in
   `revocation-schema.ts`.

**The residual, stated rather than buried.** `highestSeenIssuedAt` is per-device
state in `userData`. A fresh profile, a new machine, or a cleared cache has no
high-water mark and will accept any correctly-signed document whose `expiresAt`
has not passed. The short TTL from §4 is what bounds that window — a replayed
catalog older than 24 hours is refused on freshness even with no mark to compare
against. This is a second, independent reason the TTL is short, and it is why the
TTL is a security parameter rather than a caching preference.

---

## 6. Relationship to the revocation registry

**Revocation stays. It is not made redundant, and it is not doing the same job
more slowly.**

| | Admission catalog | Revocation document |
|---|---|---|
| Polarity | ALLOW list | BLOCK list |
| Consulted at | Install only | Install **and** load (`runtime-state.ts:1323`) |
| Staleness | Hard fail (§4) | Keep enforcing, warn only |
| Never obtained | Refuse everything | Allow everything |
| Reaches installed plugins | No | **Yes** |
| Carries a reason | No | Yes, required per entry |
| Trust domain | `admission-v1` | whitelist domain, deliberately separate from the artifact key |

Omitting a version from the catalog is **withdrawal**: it stops new installs
within one TTL. It does nothing to the copies already extracted under
`~/.lvis/plugins/`, which keep loading and keep passing `verifyInstallReceipt`
forever. Revocation is the only lever that reaches those, and it is the lever a
defender reaches for when the artifact-trust key itself is in question — which,
after this change, is the admission key. An attacker holding `admission-v1` can
admit anything; they must not thereby be able to un-revoke anything.

So the two documents stay separate, on separate keys, with separate polarities.
Concretely:

- **Do not add a `blocked` list to the admission catalog.** One document cannot
  carry both polarities under one `expiresAt`, because §4 requires the allow side
  to stop on staleness and `revocation-schema.ts` requires the block side not to.
  A single `expiresAt` governing both would either resurrect blocked versions or
  brick installs, depending which rule won.
- **Do not fold admission into the revocation document.** Same reason, and it
  would put the allow list on the key that must survive an allow-list compromise.
- **Revocation's `minVersions` keeps its independent job.** It expresses "nothing
  below X, ever, including on disk", which is a floor, not an enumeration, and
  which the catalog cannot say at all.

What *does* change is emphasis. Today revocation is the only lever that exists;
after this it becomes the *emergency* lever, and routine end-of-life stops
consuming blocklist entries. The revocation document should get smaller, which
is a good sign about whether this landed.

One gap the catalog partially covers: revocation fails open when it has never
been obtained. After Stage 3, that hole is closed at the install boundary — a
device that has never reached the network installs nothing — but it remains open
at the load boundary, where it should remain open.

---

## 7. What gets worse

A design that only lists benefits is not finished. In rough order of how much
they should worry a reviewer.

### 7.1 Availability of one document becomes availability of installing

Today an install needs the marketplace host: two requests, `/download` and
`/download.sig`, to the same origin. After migration it needs the marketplace
host *and* the issuance host — a **second origin**, on a different platform,
operated by a different pipeline. The honest framing is not "one more fetch"; the
overlap actually costs a third request and the end state returns to two. It is
that the install now has **two independent availability dependencies instead of
one**, and the new one is on the critical path of a foreground user action.

`signed-doc-fetcher.ts` already fails over primary → fallback on 5xx and network
error, and treats 4xx as terminal on purpose ("a missing document on the primary
host means it is intentionally absent… falling back would mask that signal").
Conditional GET plus a boot-time prefetch keeps the common case near-free. A
still-valid cached document covers a short outage. None of that is a fallback in
the prohibited sense — each path still requires a signed, unexpired statement —
but none of it helps if issuance itself stalls, and §4 makes a stalled issuer
into a global install outage within 24 hours.

That is a deliberate trade: an install outage is recoverable, a permanently
installable withdrawn version is not. It still needs monitoring on issuance
freshness with an alert well inside the TTL, and that monitoring is part of the
deliverable, not an operational afterthought.

### 7.2 Frequent issuance and an offline key pull in opposite directions

This is the design's central unresolved tension and it should be read before the
benefits.

§2.5 removes the oracle by keeping the key off the marketplace host. §4 demands a
re-issue every 6 hours. An automated signer that runs every 6 hours *is a new
oracle* — a smaller one, on a different host, but code execution there again
yields arbitrary admissions. Moving a hot key from the marketplace host to a
different host is an improvement in blast radius (that host runs no
publisher-supplied code and accepts no uploads) but it is not the categorical win
that "the server no longer signs" makes it sound like, and it should not be sold
as one.

The shape that keeps most of the win:

- Issuance runs in a **restricted GitHub Actions environment** on
  `lvis-project/marketplace-whitelist`, holding the key as an environment secret
  scoped to one workflow. That host runs no candidate plugin code and takes no
  uploads — the distinction `keyless-marketplace-signing.md` §5.2 draws between
  its build and sign jobs, applied here.
- The workflow's **input is a committed file**, not an API response. Admissions
  are added by a reviewed commit to the whitelist repo; the marketplace database
  is the source of hashes but not the trigger. Adding a plugin becomes a pull
  request, and "what am I signing" is answerable by reading a diff.
- Heartbeat re-issuance re-signs the **unchanged** committed content on a
  schedule. It bumps `issuedAt`/`expiresAt` and nothing else. A heartbeat that
  changed content would be an unreviewed admission path.
- The scheduled job asserts the admission set is byte-identical to `HEAD` before
  signing, and fails loudly otherwise.

Even so, the workflow can sign whatever is in the repo at the moment it runs, so
write access to that repo is now equivalent to admission authority. That is a
smaller and more auditable surface than "any publisher API key plus the app
host", but it is a real surface and it is new.

### 7.3 Freshness becomes a security property, and clocks are now in scope

Today a device with a wildly wrong clock installs fine — the only time check is
`envelope.iat` not being *far in the future*, which a backwards clock passes.
After this, a device more than a day behind sees every catalog as expired and can
install nothing, and a device far ahead trips the future-`issuedAt` guard in §5.

This fails closed and loudly, which is correct, but it converts a class of
user-environment problem that was previously invisible into a class of support
ticket. The error copy must name the cause explicitly ("this device's clock reads
X; the catalog was issued Y") rather than reporting a generic verification
failure, or every skewed clock arrives as "plugins are broken".

### 7.4 One document, and it grows monotonically

860 version rows at roughly 150 bytes each is about 130 KB — fine today, fetched
conditionally, and not a concern at this size. But the catalog must list **every
installable version**, not just the latest, or rollback breaks. It therefore grows
with publish volume and never shrinks on its own.

Pruning is not a maintenance task; pruning is un-admitting, and un-admitting a
version silently removes a rollback target. So pruning has to be a deliberate
policy tied to the existing retirement machinery
(`plugin-retirement-journal.ts`, the server's retirement contract), not a size
threshold. Until that is defined, the catalog only grows.

If it ever becomes a real problem the answer is per-slug documents with a signed
index, which is a materially larger design (index freshness, per-slug TTLs, N
fetches) and should be avoided until measurement forces it. §11 lists the
threshold that would force it.

### 7.5 Publishing stops being instant

Today `POST /plugins/{slug}/versions` returns and the version is installable.
After Stage 3 a version is stored but **not installable** until the next issuance
— up to 6 hours, and longer if the reviewed-commit model in §7.2 puts a human in
the path.

For first-party plugins on a weekly-ish cadence this is acceptable and arguably
desirable: it is the same shape as the existing `pending_review` gate for
`install_policy == "admin"` publishes, extended to everything. For hotfixes it is
not, so an expedited issuance path has to exist and must be an ordinary
run-the-workflow-now, never a bypass that admits without signing.

### 7.6 The artifact stops being self-describing

Today a tarball plus its `.sig` sidecar is a portable, self-contained proof —
anyone holding both can verify offline, forever. After Stage 6 there is no
per-artifact proof at all; authorisation lives only in a document with a 24-hour
life.

This matters most where it is least visible. `project_marketplace_internal_visibility`
established that `lge-api` and `ms-graph` are internal-network-only. Those installs
must now reach GitHub Pages (or the Release fallback) from inside that network, in
addition to the marketplace host. An air-gapped or strictly-egress-controlled
deployment that works today because the artifact carries its own proof will not
work after Stage 6 without an explicit mirroring story for the catalog. That
story is not designed here and is a genuine prerequisite for Stage 6 rather than
a footnote — see §11.

### 7.7 New code in the pre-trust path

Modest, but real: a new schema validator and a new registry parsing
attacker-reachable JSON before any trust decision. It is far smaller than the
X.509/DSSE surface `keyless-marketplace-signing.md` §5.2 weighs (hand-written
validators in an established house style, no new dependency, and the fetch/cache/
verify layers are already shared and tested) — but "the old verifier's smallness
was itself a security property" applies to this design too, and the answer is to
keep `admission-schema.ts` in the same shape as `revocation-schema.ts` and resist
adding fields.

---

## 8. What this does not fix

- **A validly admitted malicious artifact.** Admission says the distributor
  listed it, nothing more. Review quality, the effect-boundary classification,
  and the sandbox are what make that statement worth anything.
- **Compromise of the issuance path.** §7.2.
- **Anything already on disk.** §6. Revocation remains the only lever.
- **Publisher account compromise.** An attacker with a publisher API key can
  still upload; after Stage 3 they can no longer make it installable without
  passing issuance, which is an improvement, but the artifact is in the catalog
  database either way.
- **The `X-Plugin-SHA256` header's irrelevance.** It is served by the same origin
  as the bytes and never was evidence. The catalog hash replaces it as the actual
  check; the header can stay as a cheap early mismatch signal.

---

## 9. What third-party opening would then require

Removing the attribution gap is the point of §2.3, so it is worth being precise
about what that buys and what it does not.

**Unblocked by this design.** The verified statement names the slug. That makes
*scoping* expressible for the first time: a signer can be granted authority over
`acme-*` without thereby gaining authority over `meeting`. Under the envelope
shape that sentence has no representation — the verifier has no slug to compare
against — which is why "just add their key to `MARKETPLACE_PUBLIC_KEYS`" was never
a viable first step, and why this document, not a permissions change, is the
prerequisite.

It also gives per-publisher accountability a subject (`publisher`, §2.3) and
makes bulk withdrawal cheap: dropping every entry for one publisher takes effect
in one TTL.

**Still required, and not designed here.**

1. **A delegation record.** The root issuer signs a statement binding a publisher
   key to a slug set; the publisher signs their own admissions within it; the
   client verifies the chain. This is TUF's targets-delegation shape, and it is a
   larger document design than this one — delegation expiry, revocation of a
   delegation independent of the artifacts under it, and what happens when a slug
   moves between publishers.
2. **Namespace ownership.** Who may claim `acme-*`, how a claim is proven, and
   what happens on dispute or transfer. The catalog can only *record* the answer.
3. **Publisher key custody and enrollment.** Generation, rotation, loss, and the
   support path when a third party loses their key.
4. **Per-publisher revocation.** Distinct from per-version. The revocation
   document has no publisher dimension today.
5. **The gate that actually matters.** Whether a third-party plugin may run at
   all is the effect-boundary and sandbox question
   (`project_plugin_effect_boundary_classification`,
   `docs/blueprints/plugin-process-isolation.md`), and it is untouched by
   anything here. Admission answers "may this install"; isolation answers "what
   may it do once installed". Shipping the first without the second would be a
   worse position than today, because it would look like the door was ready.

The honest summary: this design removes the *representational* blocker to
third-party opening and none of the others.

---

## 10. Staged plan

Both schemes verify during the overlap, conjunctively. Each stage names the
measurable condition that ends it. No stage may begin before its predecessor's
condition is met, and every stage is independently revertible until Stage 5.

### Stage 1 — Issue the catalog; verify nothing

Build the generator (reads `plugin_versions`, emits `admission.json` for every
row that is `approved`, not `yanked`, and has an artifact file on disk), the
issuance workflow, and `admission-v1`. Ship the client modules and wire
`init()` into boot alongside `revocation-bootstrap.ts`. The install path does not
consult the registry.

Telemetry only: fetch outcome, parse outcome, signature outcome, and — for every
install that happens — whether the catalog *would* have admitted it, with the
refusal code when not.

**Ends when:** for 7 consecutive days, the catalog covers 100% of installs that
actually occurred with a matching hash; document fetch success ≥ 99.5% across the
telemetry population; zero unexplained `admission-hash-mismatch` shadow results.
A single unexplained mismatch stops the stage and is triaged as an integrity
event, in the spirit of `resign_artifacts.py` aborting rather than skipping.

### Stage 2 — Enforce at install, alongside the envelope

Wire §3.2 steps 3–5. Both proofs are now mandatory. Refusals are fatal and carry
the codes from §3.1. Receipt schema goes to v3.

Shipping this requires the 56-row situation from §1.2 to be reconciled first:
rows with no artifact on disk are not admitted, which is correct, and their
`/download` already 404s, so nothing regresses — but that must be confirmed
against production storage before the flip, not assumed.

**Ends when:** the app version carrying enforcement is the floor for marketplace
installs, pinned via the revocation document's `minVersions`, and install success
rate is within noise of the pre-flip baseline for 14 days.

### Stage 3 — Admission becomes required for publish

`publisher.py` stops treating a stored version as installable. New versions are
recorded and their hashes exported for issuance; `/download` and `/download.sig`
404 until the version appears in an issued catalog. This is the stage that makes
withdrawal real, because until now the catalog has been a mirror of the database
rather than an authority over it.

**Ends when:** median publish→installable latency is inside the agreed target
(proposed: 6h, matching the heartbeat) for 30 days, and the expedited path from
§7.5 has been exercised at least once in a drill.

### Stage 4 — Server stops signing

Remove `require_signing_keys()` / `sign_artifact_multi` from the publish path and
the signing private key from the marketplace host's environment. `/download.sig`
keeps serving envelopes already stored on existing rows; new rows have none.

**Ends when:** `MARKETPLACE_SIGNING_PRIVATE_KEY_*` is absent from the production
environment, verified by the boot banner, and no new row has a
`signature_envelope`.

This is the stage that closes §1.3, and it is worth noting it lands three stages
before the envelope is removed — the oracle dies as soon as the catalog is
authoritative, not when the old format is deleted.

### Stage 5 — Client stops requiring the envelope

Drop the envelope check from `installFromMarketplace`. `verifyEnvelope`,
`envelope-verifier.ts`, and the whitelist/revocation/admission document paths are
untouched — this removes one caller, not the primitive.

**Ends when:** every app version that can still reach the marketplace enforces the
catalog, pinned as in Stage 2. This is the first irreversible stage: older clients
requiring an envelope that Stage 4 stopped producing can no longer install.

### Stage 6 — Retire the artifact key

Remove `MARKETPLACE_PUBLIC_KEYS`, `resign_artifacts.py`, `poc-v1.pub` and
`prod-v1.pub` from `schemas/keys/`, the `/download.sig` route, and the
`signature_envelope` / `signer_key_id` columns' remaining readers.

**Blocked on** the internal-network mirroring story from §7.6. Do not begin this
stage while any deployment reaches the marketplace but not the issuance host.

**Ends when:** grep for `MARKETPLACE_PUBLIC_KEYS` returns nothing outside history,
and the only ed25519 trust anchors in the client are `whitelist-v1` and
`admission-v1`.

---

## 11. Uncertainties, and what would resolve each

1. **Is install genuinely online-only in every path?** §1.4 rests on a
   single-call-site grep plus the installer's step-3 comment. It is the load-
   bearing assumption of the whole design. **Resolves by:** a test that runs the
   full install path with `fetch` stubbed to reject and asserts it cannot
   succeed — added in Stage 1, before anything depends on it. If a path is found
   that installs with no network, this design must gain an offline story or stop.
2. **Does any deployment install from behind egress rules that permit the
   marketplace host but not GitHub Pages?** Directly determines whether Stage 6
   is reachable and whether §7.6 is a footnote or a blocker. **Resolves by:**
   asking operations, before Stage 3.
3. **Is 24h/6h the right TTL?** Chosen for the argument in §4, not from data.
   **Resolves by:** Stage 1 fetch-success telemetry. If real-world fetch success
   is meaningfully below 99.5%, the TTL argument survives but the availability
   cost in §7.1 is higher than assumed and the stage plan should pause.
4. **Does the reviewed-commit issuance model (§7.2) survive contact with the
   publish cadence?** If it turns every plugin release into a second pull request
   on another repo it will be routed around, and a routed-around control is
   worse than none. **Resolves by:** running it manually for first-party
   publishes through Stage 1 before automating anything.
5. **At what size does one document stop working?** §7.4 asserts 130 KB is fine
   and offers no threshold. **Resolves by:** recording document size in the Stage
   1 telemetry; revisit the per-slug split if it passes 1 MB or if conditional-GET
   hit rate falls below 90%.
6. **Interaction with `plugin-process-isolation.md` Stage 9 ("Admit third-party
   plugins").** That stage and §9 here are the same gate approached from two
   sides. **Resolves by:** whichever lands second reading the other first; they
   must not ship independently.

---

## 12. Architecture amendment requested

`docs/architecture/architecture.md`:

- **§9 Plugin System** — the plugin distribution trust model currently describes
  a per-artifact signature verified against an embedded key map. Amend to state
  that install authorisation comes from a signed admission catalog binding
  `slug@version → sha256 + publisher`, that the artifact signature is a
  transitional second proof during migration, and that load-time integrity
  remains the install receipt (unchanged).
- **§9** — add the third signed-document trust domain (`admission-v1`) to the
  existing enumeration of `MARKETPLACE_PUBLIC_KEYS` / `WHITELIST_PUBLIC_KEYS`,
  with the separation rationale from §2.4.
- **§14 Deployment, Governance, Feature Flags** — record that publishing is a
  two-party action after Stage 3: the marketplace stores, the issuer admits, and
  neither alone makes a version installable.

`docs/blueprints/keyless-marketplace-signing.md` needs no amendment. The two
designs are compatible and complementary: that one replaces *how the bytes are
proved authentic* (and is blocked on GitHub plan availability); this one replaces
*what the proof asserts and who may install it*. If both land, the catalog binds
`slug@version → sha256` and the attestation proves the provenance of those bytes,
verified conjunctively — and neither is a substitute for the other, because
provenance without attribution still cannot scope a third-party signer, and
attribution without provenance still trusts whoever computed the hash.

---

## Sources

Primary source for every current-behaviour claim is the code, read at
`lvis-app` `main` (`40d5021`) and `lvis-marketplace` `main`:

- `lvis-app/src/plugins/public-contract.ts:567` — `SignatureEnvelope`
- `lvis-app/src/plugins/envelope-verifier.ts` — `verifyEnvelope`
- `lvis-app/src/plugins/marketplace-keys.ts` — trust anchors, the 804/860 note
- `lvis-app/src/plugins/marketplace-installer.ts:200,282,294,348` — the install path
- `lvis-app/src/plugins/plugin-artifact-store.ts:104,410,424` — revocation gate, download, the latest-only hash conditional
- `lvis-app/src/plugins/plugin-install-receipt.ts:133` — load-time integrity
- `lvis-app/src/plugins/revocation/revocation-schema.ts`, `revocation-registry.ts` — polarity, monotonicity, fail-open
- `lvis-app/src/plugins/whitelist/whitelist-registry.ts:90,307` — the 7d grace window this design declines
- `lvis-app/src/plugins/signed-doc-fetcher.ts`, `signed-doc-cache.ts` — the reused transport
- `lvis-marketplace/server/src/lvis_marketplace/signing.py` — `sign_artifact_multi`, `verify_artifact`, the `artifact_id` disclaimer
- `lvis-marketplace/server/src/lvis_marketplace/api/publisher.py:200,206,568` — the publish route and the oracle
- `lvis-marketplace/server/src/lvis_marketplace/api/catalog.py:824` — `/download.sig`
- `lvis-marketplace/server/scripts/resign_artifacts.py` — the rotation cost
