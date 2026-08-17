# Plugin Declared-Category Legacy Removal

> Status: **Proposal** (issue #2112, part 1 of 3). Inventory reflects the code
> as of this branch; source files and tests are authoritative when this prose
> and implementation disagree.

## 1. Why this legacy exists and why it can go

Host-side risk classification replaced plugin self-declared tool categories as
the enforcement authority (the "a server can lie" principle:
`src/permissions/reviewer/host-risk-inspector.ts` derives the effective
`ToolCategory` from host-owned signals only). The migration shipped behind the
`hostClassifiesRisk` feature flag with a shadow-reconciliation dataset, and the
flag is now **default ON on every platform**
(`src/data/settings-defaults.ts:173`, pinned by
`src/data/__tests__/settings-store.test.ts` "ships hostClassifiesRisk ON
all-platform").

The declared category is meanwhile already dead at its source:

- A first-party plugin tool registers at the write-equivalent baseline
  unconditionally — `src/mcp/plugin-tool-from-mcp.ts:157` hardcodes
  `category = "write"` and `isReadOnly: () => false`, ignoring any
  `_meta["lvisai/category"]` on the wire (completed for the out-of-process
  stdio path by #1582; see
  `docs/references/plugin-contract-v6-final-report.md`).
- An external MCP tool registers as `"network"`
  (`src/mcp/mcp-tool-adapter.ts:89`).
- The per-tool manifest `category` key was removed from the manifest schema in
  the v6 contract work (#885).

What remains is the *machinery* that still treats "declared category" as a
live alternative: the flag's OFF lane, the declared-category parameter chain,
and the shadow log that compares declared vs host-derived per invocation. This
document inventories all of it and proposes a staged removal.

## 2. Inventory

### 2.1 Flag definition and persistence (5 sites)

| Site | Role |
|---|---|
| `src/data/settings-store.ts:297` | `FeatureFlags.hostClassifiesRisk?: boolean` |
| `src/data/settings-defaults.ts:173` | shipped default `true` (all platforms) |
| `src/data/settings-normalization.ts:1223` | boolean pass-through on settings load |
| `src/ui/renderer/types.ts:369-374` | renderer-visible `FeatureFlags` copy (no dedicated toggle UI exists; the knob is settings-file only) |
| `src/data/__tests__/settings-store.test.ts:762` | pins the ON default |

### 2.2 Live flag reads / providers (6 sites)

1. `src/boot/steps/plugin-tool-executor.ts:119` — provider handed to the
   plugin-surface `ToolExecutor`.
2. `src/engine/conversation-loop.ts:255` — provider for the conversation
   loop's executor.
3. `src/boot/steps/plugin-runtime.ts:273` — `hostClassifiesRiskEnabled`,
   threaded into `host-api-factory`.
4. `src/boot/steps/plugin-runtime/host-api-factory.ts:156/224` — factory
   dependency; read per call at the effect gates (below).
5. `src/boot/steps/sandbox-init.ts:334` — boot interlock warning read.
6. `src/tools/executor-implementation.ts:130` — constructor default
   `hostClassifiesRiskProvider ?? (() => false)`: an executor constructed
   without a provider silently runs the OFF lane. This default is itself a
   removal hazard (see stage 2).

### 2.3 Enforcement fork points where the ON/OFF lanes diverge (7 sites)

1. **Enforced-category resolution** —
   `src/tools/pipeline/risk-classification.ts` `resolveEnforcedCategory`:
   flag OFF returns the declared category unchanged; flag ON returns the
   host-derived category from `inspectHostRisk`
   (`src/permissions/reviewer/host-risk-inspector.ts:199`).
2. **Plugin read auto-allow coupling** —
   `src/tools/invocation-authorization.ts:424-440`: flag ON converts a
   layer-6 read auto-allow into a pre-exec ask when the active sandbox is not
   filesystem-contained; flag OFF skips the coupling.
3. **Foreground plugin pre-exec ask relaxation** —
   `src/tools/invocation-authorization.ts:545-621`: flag ON (plus
   `sandboxFsContainedProvider(tool)`) flips a foreground plugin ask to allow
   and defers gating to the effect boundary, after running the operator
   `perm-*.sh` hook.
4. **Effect-boundary enforcement** — `src/permissions/effect-enforcement.ts`
   (`flagEnabled` read per call, line 261): flag OFF is a documented
   zero-behaviour-change pass-through of every gated hostApi chokepoint.
5. **`hostFetch` inline gate** —
   `src/boot/steps/plugin-runtime/host-api-factory.ts:839` (and the generic
   wiring at line 1337): flag OFF short-circuits `gateMutatingEffect` before
   the approval await.
6. **Effect-gate context binding** — `src/tools/invocation-execution.ts:686`:
   binding is inert when the flag is OFF.
7. **Sandbox interlock warning** — `src/boot/steps/sandbox-gate.ts:79`
   `shouldWarnHostClassifyInterlock` fires only for flag ON + sandbox
   inactive (`src/boot/steps/sandbox-init.ts:339`).

### 2.4 Declared-category reads (the parameter chain)

- `src/tools/invocation-services.ts:61-71` — packages `declaredCategory` into
  the `resolveEnforcedCategory` call together with the live flag value.
- `src/tools/pipeline/risk-classification.ts:32/67/87-90` — OFF-lane baseline
  return; `maxOperationRisk(declaredCategory, hostDerivedCategory,
  operationFloor)` still takes the declared value as an input.
- `src/tools/invocation-runner.ts:685` — `declaredCategoryForEffectShadow`
  captured from the invocation category.
- `src/tools/invocation-execution.ts:96/147/898` — threads it into the
  post-exec effect shadow record.
- `src/permissions/reviewer/risk-shadow-log.ts:40/59` —
  `RiskShadowRecord.declaredCategory` and
  `EffectShadowRecord.declaredCategory` (record schema).

### 2.5 Shadow-log (classification comparison) code

- `src/permissions/reviewer/risk-shadow-log.ts` — `emitRiskShadowLog`
  (pre-exec declared vs host-derived, `diverged` field) and
  `emitEffectShadowLog` (post-exec host-observed effects vs declared).
- Producers: `src/tools/pipeline/risk-classification.ts:70` (category
  shadow), `src/tools/invocation-execution.ts:893` (effect shadow, plugin/MCP
  only, `hostObservable:false` for external MCP).
- Sink: `src/audit/audit-logger.ts:599` `getPermissionShadowLogFile` →
  `~/.lvis/audit/<date>.permission-shadow.jsonl`, the dedicated plain
  (non-HMAC) shadow channel; wired in
  `src/tools/executor-implementation.ts:161`.
- Tests: `src/permissions/__tests__/risk-shadow-log.test.ts`,
  `src/tools/pipeline/__tests__/risk-classification-producer.test.ts`,
  `src/tools/__tests__/executor-effect-ledger.test.ts`,
  `src/tools/__tests__/executor-mcp-plugin-parity.test.ts:377-388`,
  `src/audit/__tests__/audit-writer.test.ts:177`.

### 2.6 Tests that pin the OFF lane

`src/boot/__tests__/bootstrap-integration.test.ts:98`,
`src/boot/__tests__/subscription-chat-wiring.test.ts:57`,
`src/boot/__tests__/sandbox-init-runtime-probe.test.ts:56`,
`src/boot/__tests__/sandbox-gate.test.ts:88-117`,
`src/tools/__tests__/executor.test.ts:4703`,
`src/tools/__tests__/executor-plugin-read-relaxation.test.ts`,
`src/tools/pipeline/__tests__/risk-classification-producer.test.ts:108`
(enforcement-off case), `src/mcp/__tests__/stdio-child-transport.test.ts:50`.

Inventory size: the flag identifier appears at ~30 non-test locations across
~15 source files, plus ~10 test files; the ON/OFF fork is concentrated in the
7 enforcement points of §2.3.

## 3. Removal order

Each stage is independently shippable and leaves the tree green.

### Stage 1 — pin always-host-classified (remove the knob)

Replace every settings read with the constant ON semantics; drop the
`hostClassifiesRisk` field from `FeatureFlags`.

- Files: `settings-store.ts`, `settings-defaults.ts`,
  `settings-normalization.ts`, `src/ui/renderer/types.ts`, the 6 provider
  sites of §2.2 (providers become `() => true` or disappear), plus
  `settings-store.test.ts`.
- Risk: a user who deliberately toggled OFF gets ON semantics. This is
  behaviour-preserving in the safe direction on degraded hosts (the
  relaxation of §2.3-3 additionally requires filesystem containment, so
  non-contained hosts keep the pre-exec ask), but it removes the emergency
  opt-out. Mitigation: land after one release with no divergence regressions
  reported; the settings normalizer should ignore, not reject, a stale
  persisted key.

### Stage 2 — retire the OFF lane in enforcement code

Collapse the 7 fork points of §2.3: delete the flag conditions in
`invocation-authorization.ts`, make `effect-enforcement.ts` unconditional
(drop `flagEnabled` from `EffectEnforcementDeps`), remove the `hostFetch`
short-circuit, and reduce `shouldWarnHostClassifyInterlock` to a pure
`!sandboxActive` warning.

- Files: `invocation-authorization.ts`, `effect-enforcement.ts`,
  `host-api-factory.ts`, `invocation-execution.ts`, `sandbox-gate.ts`,
  `sandbox-init.ts`, `executor-implementation.ts`,
  `invocation-services.ts`, plus every §2.6 test.
- Risk (highest of the four stages): the
  `executor-implementation.ts:130` default `() => false` means embedded and
  test executors constructed without a provider currently run the OFF lane;
  making gates unconditional changes their behaviour. Sweep all
  `new ToolExecutor(...)` call sites and test fixtures in the same PR.
  The effect-gate's "flag OFF = zero behaviour change" guarantee comments
  must be rewritten, not left stale.

### Stage 3 — remove declared-category reads

With enforcement always host-derived, the declared value only feeds shadow
records and `maxOperationRisk`. Rename the concept: the registration values
(`"write"` plugin baseline, `"network"` MCP) are *host-assigned baselines*,
not declarations. Drop the `declaredCategory` parameter from
`invocation-services.ts` → `risk-classification.ts`;
`maxOperationRisk` composes host-derived + operation floor only. Remove
`declaredCategoryForEffectShadow` from `invocation-runner.ts` /
`invocation-execution.ts`.

- Files: `invocation-services.ts`, `risk-classification.ts`,
  `invocation-runner.ts`, `invocation-execution.ts`, and their tests.
- Risk: low; `Tool.category` itself stays (the category × source × trust
  matrix still consumes it), so this stage must not touch tool registration.

### Stage 4 — shadow-log cleanup

The category shadow (`emitRiskShadowLog`) exists to reconcile a divergence
that can no longer occur once stage 3 lands; delete it and its producer in
`risk-classification.ts`. Keep `emitEffectShadowLog`: it is the dataset the
future read-recognition gate consumes, but drop its `declaredCategory` field
(schema change to the JSONL records).

- Files: `risk-shadow-log.ts`, `risk-classification.ts`,
  `risk-shadow-log.test.ts`, `risk-classification-producer.test.ts`,
  `executor-mcp-plugin-parity.test.ts`; `audit-logger.ts` keeps the shadow
  channel for the effect records.
- Risk: any external tooling parsing
  `<date>.permission-shadow.jsonl` sees `risk-shadow` rows stop and the
  `effect-shadow` schema lose a field. The channel is documented as
  non-audit-grade reconciliation data, so no retention contract is broken;
  note the schema change in the release notes.

## 4. Validation

Stages 1-2 are cross-module contract changes: run the executor, permissions,
and boot suites named in §2.6 plus one integration pass
(`bootstrap-integration.test.ts`). Stage 4 additionally re-runs the audit
writer tests. Full gate at publish per the repository contract.

## Related Entry Points

- [Architecture](../architecture.md) — Tool Governance, OS Execution Sandbox
  And Plugin Workers
- [Permission policy design](../permission-policy-design.md)
- [Plugin contract v6 final report](../../references/plugin-contract-v6-final-report.md)
