# Skill Loading Policy

> Status: target policy for LVIS `manifest.skills` instruction discovery. It is
> the skill-side twin of `docs/development/tool-loading-policy.md` and complements
> `docs/architecture/architecture.md` §4.5/§6.4. Where the tool policy governs
> *callable* schemas, this governs *instruction* bytes. Callable routing lives in
> Tools only; Skills never invoke a Tool (keyword routing was retired in SDK v12,
> lvis-plugin-sdk#229).

## Decision

Skills use **progressive disclosure**, the same discipline the tool policy
applies to schemas, applied to instruction bytes:

1. **Installed** — skill bytes sit on disk (`~/.lvis/skills`, plugin bundles);
   nothing enters the prompt (`src/skills/skill-installer.ts`).
2. **Activated** — when a plugin generation is active (or a user skill exists),
   the skill is reflected into the in-memory catalog
   (`src/main/skill-store.ts`). Activation tracks the *current active
   generation*, not merely "installed".
3. **Catalogued (per turn)** — only each skill's **name + description +
   triggers** are injected into the system prompt as an untrusted-metadata
   catalog. Bodies stay hidden. This is the always-present fixed cost, so it
   MUST be bounded (see Policy §1–§3). `triggers` are the author's keyword
   hints from the front matter; they are dispatch metadata read by the model,
   not a router — keyword routing stays retired — and they are bounded at
   8 entries of 48 characters where the skill record is built, so every
   consumer inherits the same cap.
4. **Loaded on demand** — the model calls `skill_load({skillName})`. First load
   is approval-gated with a sha256 binding over the skill's approval **material**
   (TOCTOU-safe, `src/tools/skill-load.ts`) — the body for a flat skill, and the
   body plus the resource manifest for a skill carrying bundled files, so adding
   or resizing a bundled file re-prompts; the body then renders inside a fenced
   `<lvis-skill>` overlay for the next round and is **cleared at the turn
   boundary** (`src/engine/turn/run-turn.ts`) so it never becomes ambient
   context.

The model selects the relevant skill by name from the catalog; the body lives
only for the turn that needs it. This mirrors the tool `catalog → tool_search →
promote` loop.

## Reference Basis

- **Progressive disclosure — the established Agent Skills discovery pattern.**
  Each skill costs only a few dozen tokens when summarized (name + description);
  the full `SKILL.md` body loads only when a task matches the description, and
  bundled resources load on demand. The name/description load into *every*
  session whether or not the skill is used — a **fixed cost** — which is why
  that metadata must be bounded and why the description is the load-decision
  signal.
  - `https://agentskills.io`
- **Tools-Tax / dynamic-toolset evidence** (see tool-loading-policy §Reference
  Basis): the per-turn cost that matters is *tokens*, paid on every round. A
  skill catalog that is unscoped and unbudgeted re-pays that cost each turn just
  like an oversized `tools[]` payload does.

## The gap this policy closes

Skill loading *timing* is already correct (progressive disclosure, turn-boundary
clearing, approval-gated bodies). Two **budget asymmetries** vs the tool policy
remain and are the target of this document:

- **Scope asymmetry.** Tool schemas/catalog are filtered by `activePluginIds`
  per turn (`system-prompt-builder.ts`), but the skill catalog is **global**
  (`getAvailableSkills: () => listCatalogSync()`, `src/boot.ts`) — every user
  skill and every active plugin generation's skills are surfaced every turn,
  including plugins that are out of the current tool scope.
- **Budget asymmetry.** The tool surface has a token budget and a bounded
  scored `tool_search`; the skill catalog has only a flat 80-entry alphabetical
  cap (`system-prompt-builder.ts`) with no token accounting and no relevance
  ranking.

## Policy

### 1. Catalog Scope Mirrors Tool Scope

The per-turn skill catalog is filtered to the **same active-plugin scope** used
to build provider tool schemas, unioned with user-owned (non-plugin) skills:

```text
turnSkillCatalog = userSkills ∪ { skill | skill.pluginId ∈ activePluginIds }
```

A skill whose owning plugin is not in the current turn scope is not catalogued
(it remains installed and becomes catalogued again when `request_plugin` brings
its plugin into scope). This removes the case where the model sees skill
metadata — or loads a skill body — that references Tools it currently cannot
call. Registry/execution authority is unchanged; this is exposure, not removal.

The "or loads" half is ENFORCED, not merely catalogued: `skill_load` of a
`plugin:<id>:<localId>` selector is admitted by the SAME per-turn plugin scope
that admits that plugin's tools, at the same deny point (see
`src/tools/pipeline/plugin-turn-scope.ts`). A user skill has no plugin owner and
is never turn-scoped. A turn that declares no plugin scope at all (an
unrestricted caller) is unaffected.

### 2. Catalog Is Token-Budgeted

The catalog is bounded by an **estimated token budget**
(`SKILL_CATALOG_TOKEN_BUDGET`), not only an entry count. The projection (§tool
policy §6) records skill-catalog tokens alongside tool-schema tokens so the
combined system-prompt cost is visible. The existing entry cap is retained as a
cheap pre-filter; the token budget is the authoritative bound.

### 3. Over-Budget Selection Is Deterministic; Query-Relevance Stays Reactive

**Decision (reference-backed): the resident catalog is NOT re-ranked in place by
the turn query.** When the in-scope catalog exceeds the budget, entries are kept
by a deterministic priority — user skills first, then plugin skills, alphabetical
within each band — and the overflow is reachable through `skill_list`
(enumerate-then-load). Nothing becomes unreachable; it is deferred exactly like a
deferred Tool. Query-relevance selection lives where the reference agents put it:
the **reactive** path — the model narrows by calling `skill_load` (or, for Tools,
`tool_search`, which already lexically scores against the query it is handed),
not by the host re-ordering an always-present catalog.

**Host-side query pre-ranking of the resident catalog was evaluated across the
mainstream agent hosts and deliberately NOT implemented.** This is a decision,
not an oversight — do not implement it without revisiting all three reasons
below:

- **No precedent for lexical in-place re-ranking.** The mainstream design is a
  bounded catalog in a stable order, with the model deciding; query scoring
  happens only inside a model-invoked search step. The one shipped analogue of
  pre-ranking (opt-in vector *subset retrieval*, not in-place ranking) was
  removed by its own maintainers as too slow to be worth it. Where a host does
  pre-select by query it uses embedding semantics plus candidate *promotion*,
  never lexical re-ordering of the resident set.
- **Prompt-cache stable prefix.** Re-ordering the resident catalog every turn
  changes the cached prefix and invalidates KV/prompt caching — a real per-turn
  cost paid on every round, against a speculative relevance gain. Published
  tool-search guidance leaves the prefix untouched for exactly this reason, and
  hosts that do re-order their catalog disable it for cache-sensitive backends.
- **Lexical ranking hides.** A lexical pre-rank can drop a skill the model would
  have picked (synonym/paraphrase miss) — which is why the pre-selecting design
  reached for embeddings instead. The reactive `skill_load`/`tool_search` seam
  has no such failure mode: the model chooses.

Because the catalog is already plugin-scoped (§1) and token-budgeted (§2), the
always-present set stays below the size where catalog degradation is reported to
bite (~100+ resident tools). If a future need arises, the only cache-safe shape
is a **semantic** promotion block placed *after* the stable cached prefix, or a
shared semantic extension of the reactive
`tool_search`/`skill_load` scorer — never an in-place re-order of the resident
catalog. This is shared future work with the tool side, not a gap in this policy.

### 4. Bodies Stay Turn-Scoped And Gated

Unchanged and load-bearing:

- First `skill_load` is approval-gated with a sha256 hash binding over the
  approval material (body, plus the resource manifest for a bundled skill).
  Bundled approvals live in their own record-key namespace (`<name>#bundled`),
  so the two material encodings can never be confused for one another.
- Bodies render only inside the fenced `<lvis-skill>` overlay and are cleared at
  the turn boundary; they never persist as ambient context.
- A plugin skill is loadable only while its plugin generation is active
  (lease-checked).

### 5. Projection And TPM Are Part Of The Contract

Before a request is sent, projection must include skill-catalog tokens and any
loaded skill-overlay tokens, alongside the tool figures, so a turn's true
system-prompt cost (tools + skills) is one number. TPM protection must not rely
on auto-compact; compaction does not shrink the active catalog.

## Security invariants

- Catalog scoping never invokes a Tool and never loads a body.
- A skill body loads only via `skill_load` with a matching sha256 hash over its
  approval material and, for plugin skills, an active generation lease.
- A bundled resource is readable only via `skill_read`, only for a path the
  manifest listed, and only under the same bundle root the catalog resolved — the
  containment check is a single chokepoint (`isBundleRoot` + `isSafeResourcePath`),
  not a per-caller convention.
- Ranking/selection operate on metadata only; they cannot promote a body.
- Skill metadata is injected as `trust="untrusted-metadata"` and bodies inside a
  fenced overlay — a skill cannot escalate its own trust or scope.

## Implementation Direction

Client-side, Host-owned, cross-vendor (no embedding infrastructure): scope
filtering in the skill-catalog accessor (`src/boot.ts` /
`src/main/skill-store.ts`), token budgeting + ranking where the catalog is
rendered (`src/prompts/system-prompt-builder.ts`), reusing the existing
`tool_search` scorer for relevance. Embedding-based semantic ranking (reported
~97% hit@3 for tools) remains future work and is shared with the tool side.

## Verification

- Scope: an out-of-scope plugin's skill is absent from the catalog until
  `request_plugin`, then present.
- Budget: a synthetic over-budget catalog is ranked + trimmed to budget, with
  overflow reachable via `skill_list`.
- Symmetry: the same active-plugin scope drives tool schemas, the skill catalog,
  and `skill_load` admission in one turn — an out-of-scope plugin's skill is
  refused at the same deny point that refuses that plugin's tools.
- Bodies: approval-gate + hash binding + turn-boundary clearing unchanged.

## Front Matter

A SKILL.md header is YAML, and is parsed as YAML. The fields it may carry are
the SDK's `$defs/skillComponent` — `name` and `description` required,
`triggers`, `license`, `compatibility`, `metadata` and `allowed-tools`
optional — snapshotted at `schemas/sdk/skill-package.schema.json`. All of them
are kept on the skill record; the host does not re-validate the header against
the schema, because admission belongs where publication is.

`allowed-tools` is carried and surfaced but **not enforced**. A skill cannot
widen its own reach by declaring it; the permission layer does not read it.

Names must match `SKILL_NAME_ALLOWLIST` (`^[a-zA-Z0-9_-]+$`), which is the
schema's charset. The schema's 64-character ceiling is an admission rule the
marketplace applies at publication; the host enforces no length of its own.

### Headers that a real YAML parser rejects

The header used to be read line by line, which accepted things YAML does not.
A header that no longer parses does not load — the skill is skipped with a
diagnostic in the log, and on the plugin path only that skill is dropped, not
the plugin. The shapes that change:

| header | why it fails | fix |
| --- | --- | --- |
| `description: use when: deploying` | a colon *followed by a space* opens a nested mapping (`3:1` with no space is fine) | `description: "use when: deploying"` |
| `description: @mention first` | `@` is a reserved indicator | `description: "@mention first"` |
| `description: [draft] notes` | reads as a sequence, not text | `description: "[draft] notes"` |
| indentation with tab characters | YAML forbids tabs for indentation | indent with spaces |

One shape parses but reads short: an unquoted `#` starts a comment, so
`description: cost #1 priority` is the value `cost`. That is YAML behaving
correctly, and quoting fixes it — the loader compares the parsed value against
the raw line and logs a warning naming the skill and the field when the two
disagree, so the loss is visible rather than silent.
