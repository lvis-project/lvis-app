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
3. **Catalogued (per turn)** — only each skill's **name + description** are
   injected into the system prompt as an untrusted-metadata catalog. Bodies stay
   hidden. This is the always-present fixed cost, so it MUST be bounded (see
   Policy §1–§3).
4. **Loaded on demand** — the model calls `skill_load({skillName})`. First load
   is approval-gated with a sha256 body hash binding (TOCTOU-safe,
   `src/tools/skill-load.ts`); the body then renders inside a fenced
   `<lvis-skill>` overlay for the next round and is **cleared at the turn
   boundary** (`src/engine/turn/run-turn.ts`) so it never becomes ambient
   context.

The model selects the relevant skill by name from the catalog; the body lives
only for the turn that needs it. This mirrors the tool `catalog → tool_search →
promote` loop.

## Reference Basis

- **Anthropic Agent Skills — progressive disclosure.** Each skill costs only a
  few dozen tokens when summarized (name + description); the full `SKILL.md`
  body loads only when a task matches the description, and bundled resources load
  on demand. The name/description load into *every* session whether or not the
  skill is used — a **fixed cost** — which is why that metadata must be bounded
  and why the description is the load-decision signal.
  - `https://www.anthropic.com/news/skills`, `https://agentskills.io`
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

### 2. Catalog Is Token-Budgeted

The catalog is bounded by an **estimated token budget**
(`SKILL_CATALOG_TOKEN_BUDGET`), not only an entry count. The projection (§tool
policy §6) records skill-catalog tokens alongside tool-schema tokens so the
combined system-prompt cost is visible. The existing entry cap is retained as a
cheap pre-filter; the token budget is the authoritative bound.

### 3. Over-Budget Selection Is Ranked, Not Truncated

When the in-scope catalog exceeds the budget, entries are selected by
**relevance**, not alphabetical order + hard cut. Ranking reuses the lexical
scoring already used by `tool_search` (exact-name, prefix, token, description
matches; short tokens ignored) against the turn's query, then falls back to a
stable order for ties. Overflow beyond the budget is reachable through
`skill_list` (enumerate-then-load), so nothing becomes unreachable — it is
deferred, exactly like a deferred Tool.

### 4. Bodies Stay Turn-Scoped And Gated

Unchanged and load-bearing:

- First `skill_load` of a body is approval-gated with a sha256 hash binding.
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
- A skill body loads only via `skill_load` with a matching sha256 hash and, for
  plugin skills, an active generation lease.
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
- Symmetry: the same active-plugin scope drives both tool schemas and the skill
  catalog in one turn.
- Bodies: approval-gate + hash binding + turn-boundary clearing unchanged.
