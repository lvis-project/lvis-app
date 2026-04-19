# S4b + S16 Kickoff Decision Memo

Status: Proposed • Owner: Platform • Related: AP-2 D1/D2/D4/D6/D9

## S4b — dev-v1 signing key retirement

**Current state.** Marketplace catalog and plugin envelopes are dual-signed with `dev-v1` and `prod-v1` (D1). Clients accept either. Retirement removes `dev-v1` from the signer set and eventually from client trust roots.

**Retirement trigger (measurable).** All four must hold over a 14-day observation window:
1. `signature.verify.prod_v1.success` / total verifications ≥ 99.5%.
2. `signature.verify.dev_v1.only_path` (envelopes where only dev-v1 matched) = 0 across all active client versions.
3. ≥ 95% of DAU clients on a release that was itself signed prod-v1-first (dual-sign ordering flipped).
4. Zero open P0/P1 incidents tagged `signing` in the preceding 7 days.

**Procedure.**
1. **T-28d:** Flip signer to `prod-v1` primary, `dev-v1` secondary. Catalog regenerated nightly.
2. **T-14d:** Stop signing new envelopes with `dev-v1`. Existing envelopes remain valid.
3. **T-0:** Publish catalog where 100% of envelopes are prod-v1-only. Client release R ships with `dev-v1` removed from trust root, gated behind feature flag `signing.trust.dev_v1=false` (default on for ≥R, off for <R via remote config).
4. **T+14d:** Revoke `dev-v1` in KMS; archive public key with audit note.

**Rollback.** If `signature.verify.failure_rate` > 0.5% for any 1h window post-T-0, remote-config flip `signing.trust.dev_v1=true`, re-enable dual-sign at signer, republish catalog. Revocation (step 4) is the point of no return; do not execute until T+14d quiet period confirmed.

**Blocker:** D9 prod key ceremony must be complete and attested. Without it, prod-v1 has no cold-storage-backed root and retirement is unsafe.

**Go/no-go:** **Go**, conditional on D9 completion. Single strongest blocker: **D9 prod key ceremony**.

## S16 — Next.js migration of marketplace web

**Current stack (verify at kickoff).** Marketplace web is plain TS + bundler (assumption — executor must confirm against `lvis-marketplace/package.json`). Target: **Next.js 15 App Router**, React 19, RSC enabled.

**Scope (proposed).**
- **In:** public catalog browsing, plugin detail pages, search, publisher dashboard, auth middleware.
- **Out of v1:** admin UI (separate app, defer to S17), signing envelope generation (stays server-side worker).

**Benefits.** SSR/SEO for catalog pages, RSC streaming reduces TTFB, route-level code-split shrinks publisher dashboard bundle, middleware.ts replaces hand-rolled auth guard.

**Risks.**
1. Auth middleware rewrite — current session model may assume full CSR; Edge runtime constraints on crypto.
2. API contract compat — any direct fetch from client components must move to server actions or route handlers.
3. Signing envelope client — if any envelope work runs in-browser today, RSC boundary must be drawn explicitly (envelope ops → server-only).
4. Build/deploy pipeline change (static export → Node/Edge runtime).

**Effort:** **M** (4–6 engineer-weeks).

**Sequence.** **Independent of S4b**, but start **after S4b T-0** to avoid concurrent catalog-generation churn.

**Go/no-go:** **Go**, but gate kickoff on a 3-day spike validating (a) current auth flow under Edge middleware and (b) envelope boundary. Single strongest blocker: **auth middleware Edge-runtime compatibility unknown**.

## Summary

| Item | Decision | Blocker |
|---|---|---|
| S4b | Go (conditional) | D9 prod key ceremony |
| S16 | Go (post-spike) | Auth middleware Edge compat |

## Open questions before kickoff
- D9 prod key ceremony scheduled date
- Exact signing telemetry counter names in current stack
- Any in-browser envelope signing today?
- Publisher dashboard existence/scope in lvis-marketplace
- Confirmed current marketplace web stack (package.json inspection)
