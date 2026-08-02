# Memory Governance P1 — Long-term Memory Consolidation

## Decision

`user-preferences.md` remains the compact, always-applicable profile for
communication style and durable user preferences. Long-term memory maintenance
is a separate, host-owned derived index:

- consolidation never rewrites or deletes a source note; ordinary user and
  tool saves still update sources through their normal lifecycle;
- maintain at most one generated overview for the global scope and one for the
  exact active project scope;
- only the exact configured default-workspace root aliases into the global
  overview's raw-source input; its source files retain their project scope and
  no other project root aliases there;
- never mix project sources, and never use a project overview outside its
  project;
- exclude candidates, expired notes, and generated overviews from their own
  source set;
- use the overview in its own bounded prompt section (with a reserved share
  for global and exact-project scope), while the existing query-aware selection
  continues to provide detailed source notes;
- make automatic LLM consolidation opt-in because it sends local source memory
  to the configured model provider. Provider prompts do not contain local
  source paths or filenames. Manual consolidation remains available.

Generated overviews carry V1 optional derivation metadata with a canonical
source fingerprint. A write succeeds only if the sources still match the
pre-generation fingerprint while holding the memory-index lock. A changed
source immediately hides the old overview from prompts until a later refresh
succeeds.

Idle maintenance is an in-process `IDLE_SCAN` opt-in while LVIS is running,
not a wall-clock or nightly cron. It handles only eligible active global and
current-project raw sources, not every memory or `MEMORY.md`.

## Fixed implementation order

1. Extend the managed-memory metadata and `MemoryManager` with internal,
   scope-safe snapshot, current-overview, and compare-and-swap upsert seams.
2. Exclude generated overviews from ordinary selected-note injection and add a
   bounded global/current-project overview prompt section.
3. Add a consolidation service that creates only derived overviews, with DLP,
   reference-data fencing, idle throttling, and no automatic deletion.
4. Serialize idle preference refresh and consolidation through one coordinator
   to avoid concurrent provider calls; default the new idle setting to off.
5. Expose a manual, host-guarded refresh action and settings toggle, then cover
   storage, prompt, idle, IPC, and renderer contracts with focused tests.

## Explicit non-goals for P1

- no automatic deletion, merge, promotion, or reclassification of raw notes;
- no cross-project aggregation or scan of inactive projects;
- no candidate auto-approval;
- no feedback loop from generated overviews into user-preference refresh.