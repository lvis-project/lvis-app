# Evidence-Absent HIGH Re-Adjudication

> Status: **Proposal** (issue #2112, part 2 of 3). Source files and tests are
> authoritative when this prose and implementation disagree.

## 1. The problem shape

Most HIGH verdicts on plugin invocations are not findings of danger — they are
findings of *absent evidence*. The classifier stack is deliberately
default-strict: when nothing proves a call is contained or read-only, it
rates HIGH, and HIGH is the harshest UX tier (one-shot approvals only, no
durable record, no parent adjudication). That is the correct *prior*. What is
missing is a way for the human reviewer at the approval surface to resolve the
absence with evidence the host already possesses — first-party integrity
verification, host-observed effect history, sandbox containment — and to have
that resolution recorded instead of re-litigated on every invocation.

This document (a) inventories where static HIGH is produced and where it
bites, and (b) proposes an evidence-carrying re-adjudication flow that keeps
the static HIGH as prior while letting the reviewer sustain or lower it with
named, host-verified inputs.

## 2. Where static HIGH is produced today

### 2.1 Rule lane (`src/permissions/reviewer/risk-classifier.ts`)

`RuleBasedRiskClassifier` returns HIGH exactly on evidence-absence shapes:

- `"write path not declared"` — a write with no resolvable path argument.
- `"write outside allowed dirs"` — path escapes `allowedDirectories`
  (containment via `isPathAllowed`, the enforced Layer-1 predicate).
- `"network untrusted host"` — network target not in the trusted-host set.
- `"read outside allowed dirs"`.

Compositional invariants that make these *sticky*:

- `final = max(rule, llm)` (`maxVerdict`, security M1) — the model lane can
  never downgrade a rule HIGH.
- LLM failure paths fail closed to HIGH when `fallbackOnError === "deny"`
  (`"llm parse failure — fallbackOnError=deny"`, `"llm error —
  fallback=deny"`).
- `StrictRiskClassifier` is defer-all HIGH by definition.
- Weak conversation context (`isContextMissingIntent`) blocks LLM downgrades
  of rule MEDIUM/HIGH.

### 2.2 Category lane (upstream of the reviewer)

`inspectHostRisk` (`src/permissions/reviewer/host-risk-inspector.ts:199`) is
default-strict in the same way: no positive read-only proof → `"write"`;
external MCP source → `"network"` unconditionally. Every plugin tool also
*registers* at the write baseline (`src/mcp/plugin-tool-from-mcp.ts:157`), so
an evidence-absent plugin call is write-equivalent before the reviewer ever
sees it.

### 2.3 Where HIGH bites (enforcement of the prior)

- `src/shared/permissions-events.ts:49-60` `resolveUserApprovalVerdict` —
  the host-sealed verdict at approval time (reviewer level if present,
  else `shell=high / read=low / rest=medium`).
- `src/permissions/approval-gate.ts:2012` — `highRiskOneShot =
  verdictAtApproval === "high"`; at line 2146 it forces `allowedChoices` to
  `["allow-once", "deny-once"]` (no "always allow"), and at line 1505 it makes
  the request ineligible for parent adjudication.
- Durable approval records: `src/permissions/user-approval-store.ts` records
  `verdictAtApproval`; HIGH requests never reach it because the one-shot
  choice contract excludes a durable record
  (`durableApprovalRecordAllowed`, `approval-gate.ts:2021`).
- Transcript/UI surfaces: `verdictLevel` in
  `src/shared/permission-review-status.ts`,
  `src/ui/renderer/components/PermissionReviewStatusCard.tsx`, and the
  approval dock (`reviewerVerdict` in
  `src/ui/renderer/__tests__/ApprovalDock.test.tsx` fixtures).

Net effect: an evidence-absent plugin write re-asks on every single
invocation, forever, with no path to accumulate trust — even for a plugin the
host itself verified at load.

## 3. Design

### 3.1 Principle

**Static HIGH is a prior, not a verdict of record.** No code path
auto-downgrades it (M1 stands; plugin self-claims stay out — the #885
"annotations untrusted" rule). Only the human reviewer at the host approval
surface may re-adjudicate, and only with host-verified evidence attached; the
re-adjudication is durable, descriptor-bound, and revocable.

### 3.2 Trust inputs (host-verified evidence)

1. **First-party integrity verification.** At plugin load,
   `verifyPluginIntegrity` (`src/plugins/runtime/runtime-integrity.ts:14`)
   verifies the install receipt via `verifyInstallReceipt`
   (`src/plugins/plugin-install-receipt.ts`) and — on success — the audit log
   receives a `plugin_integrity_verified` event carrying `{pluginId,
   installSource, artifactSha256, signerKeyId}`
   (`runtime-integrity.ts:63`, called from
   `src/plugins/runtime/runtime-state.ts:351` and
   `src/plugins/runtime/runtime-lifecycle.ts:122`). The receipt's
   `signerKeyId` originates from marketplace envelope verification against
   the client's trusted public-key set, where the production signer key id is
   `"prod-v1"` (`src/plugins/__tests__/marketplace-installer.test.ts`;
   receipt written by `src/plugins/plugin-artifact-store.ts:426`).
   `local-dev` receipts are rejected in packaged builds unless dev mode is
   unlocked (`runtime-integrity.ts:25`). **Specification:** the evidence
   panel treats "current generation has a `plugin_integrity_verified` event
   with `installSource === "marketplace"` and a production `signerKeyId`" as
   the integrity input. First-party status alone is *not* evidence; the
   verified event is. A `plugin_integrity_rejected` event, or no event,
   means the input is absent and HIGH stands untouched.
2. **Host-observed effect history.** The effect shadow dataset
   (`emitEffectShadowLog`, `src/permissions/reviewer/risk-shadow-log.ts:115`)
   records, per invocation, `hostObservable` and the host-mediated
   `hasMutatingEffect`. A tool whose observed history is consistently
   non-mutating is evidence toward lowering; `hostObservable:false`
   (external MCP) is *never* evidence — the documented fail-closed rule for
   the read-recognition gate applies here identically.
3. **Sandbox containment.** The reviewer SOT `SandboxCapability`
   (`src/permissions/sandbox-capability.ts`) and the per-tool
   `isActiveSandboxFilesystemContainedForPluginEffects` signal already used
   by the read relaxation: a filesystem-contained worker substrate bounds the
   blast radius the HIGH prior assumes unbounded.

### 3.3 Flow

1. A HIGH-rated ask reaches the approval surface as today. The request
   payload additionally carries an **evidence summary** assembled host-side
   (never by the plugin): integrity event presence + `signerKeyId` +
   `artifactSha256` prefix, effect-history digest, sandbox containment for
   this tool. Renderer text is display-only; the decision inputs live in the
   main process.
2. The reviewer chooses: **sustain HIGH** (today's one-shot behaviour,
   unchanged default) or **re-adjudicate down** to medium/low *for this
   descriptor* (tool + plugin generation + evidence hash).
3. A re-adjudication is a durable, revocable record: extend the
   user-approval store entry with `evidenceRef` (the integrity event's
   `artifactSha256` + `signerKeyId` and the generation id). The
   `highRiskOneShot` gate in `approval-gate.ts` admits a durable record
   *only* when a host-verified evidence bundle is attached — absent
   evidence, the one-shot contract is unchanged.
4. Invalidation is automatic and fail-closed: a new plugin generation, a
   changed `artifactSha256`, a `plugin_integrity_rejected` event, or loss of
   sandbox containment invalidates the record and restores the HIGH prior
   (same shape as the verdict-cache identity rules in
   `src/permissions/reviewer/verdict-cache.ts`, where the sandbox root
   already participates in cache identity).

### 3.4 Non-goals

- No automatic downgrade of any HIGH — every lowering is a human decision.
- No plugin-supplied evidence: manifests, wire `_meta`, and tool results
  never enter the evidence summary.
- No change to the classifier stack itself: the rules of §2.1 keep producing
  the same priors; only the *disposition* of a HIGH at the approval surface
  gains a second, evidence-carrying option.

## 4. Touch points for the implementing change

`src/permissions/approval-gate.ts` (one-shot contract + evidence admission),
`src/permissions/user-approval-store.ts` (record schema), the audit query
path for `plugin_integrity_verified` (`src/audit/audit-logger.ts`),
`src/shared/permissions-events.ts` (verdict payload), approval dock renderer
components, and IPC/preload types for the evidence summary — moved as one
coherent change with sender guards and tests, per the repository contract.

## Related Entry Points

- [Architecture](../architecture.md) — Security And Audit
- [Permission policy design](../permission-policy-design.md)
- [Plugin declared-category legacy removal](./plugin-declared-category-legacy-removal.md)
  (part 1; shares the host-classification inventory)
