# LVIS App coding-agent contract

This file is the canonical repository contract for coding agents. Keep it lean:
state durable constraints here and put detailed designs in their owning docs.

## Scope and sources of truth

- Work only in the repository and task scope the user names.
- For non-trivial architecture work, read `docs/architecture/architecture.md`
  and the feature blueprint or design document named by the task.
- A task-specific blueprint and explicit owner decisions override general
  guidance. If the design conflicts with code reality, report the conflict;
  do not silently redesign the feature.
- For host-agent product and UX precedent, start with official documentation
  and current shipped behavior of comparable CLI and desktop coding-agent
  hosts. IDE/workspace products are secondary references: use them for generic
  editor or filesystem conventions, not as the primary model for agent-host
  lifecycle or interaction behavior.
- Plugin integration is defined by `src/plugins/types.ts`, manifests, schemas,
  and HostApi self-registration. Do not add plugin-specific host branches.
- Permission behavior follows `docs/architecture/permission-policy-design.md`
  plus `Tool Governance` and `Security And Audit` in
  `docs/architecture/architecture.md`. Release work follows
  `docs/development/release-process.md`.
- `resources/AGENTS.md` is packaged runtime guidance for the in-app assistant.
  It is not the developer or coding-agent contract and does not override this
  file.

## Autonomy and communication

- Inspect, edit, and run relevant non-destructive local validation without
  asking when the requested change clearly authorizes it.
- Ask only when authority is missing for a destructive or irreversible action,
  an external production write, credential use that cannot be recovered, or a
  choice that materially changes scope or product behavior.
- Do not pause for approval between ordinary local edit-test-fix steps.
- Give concise updates only at meaningful boundaries: discovered constraint,
  material implementation result, failed gate, or external blocker.
- Use subagents only for independent, bounded work that can run concurrently.
  Keep shared-file edits under one owner and integrate results in the lead lane.

## Git and workspace safety

- Run repository commands as `git -C <absolute-repo-path> ...`; do not depend on
  accumulated shell `cd` state in this multi-repository workspace.
- Before editing, check `git status --short --branch`.
- Treat an unexpected branch or dirty shared tree as owned by another session.
  Use a fresh clone or isolated worktree and a dedicated branch instead of
  changing, stashing, resetting, or cleaning another session's work.
- Preserve unrelated user changes. Never use destructive reset/checkout to
  clear them.
- Keep text files LF at the blob level.
- Do not bypass hooks with `--no-verify`, hook-skip environment variables, or
  equivalent mechanisms.
- Never push directly to `main`. Deliver changes through a PR and merge with
  `gh pr merge --merge`; squash merge is not allowed.

## External product names

- Do not commit external product or vendor names as explanatory text. This
  covers code comments, JSDoc, module headers, `description` fields, test names
  and `describe`/`it` strings, documentation prose, and **commit messages** —
  messages travel with every clone and are permanent in `git log` and `blame`.
- Keep the reason, drop the attribution. A comment that justifies a decision by
  pointing at what another product does states the property that makes the
  decision right instead. If the reasoning cannot survive without the name, it
  was doing citation work rather than explanation: state the property directly.
- A name stays only where the code would be wrong or ambiguous without it: a
  literal the runtime needs, a provider discriminant, a secret-store key, an
  endpoint or package name, or a feature that names what it integrates with
  (`openai-compatible`, `llm.apiKey.anthropic`, `@anthropic-ai/sandbox-runtime`,
  the desktop config importer). A name that identifies something the code talks
  to stays; a name that justifies a decision goes.
- PR bodies and GitHub issues are out of scope: they are not committed, and
  sourcing is genuinely useful there.
- Sweep added lines, not changed files (`git diff origin/main HEAD -U0`, `+`
  lines). Scanning whole files yields a larger, plausible-looking diff that
  breaks provider resolution and secret lookups while appearing to comply.
- Before deleting a document, grep for inbound references
  (`git grep -l "<basename>" -- src/ docs/`). A document referenced by section
  anchor from shipped code is a specification, not a record: its comparison
  section is removable, the document is not.

## Naming

Apply these conventions to hand-written `src/` code. Generated files and vendored
primitives keep their generator or upstream conventions. Follow the framework's
conventions in `web/`; do not rename unrelated code during another task.

### Casing by kind

- Types, interfaces, classes, components, contexts, schemas, and constructor
  bindings use `PascalCase`. Functions, locals, parameters, and fields use
  `camelCase`.
- Module-level fixed literals and frozen tables use `SCREAMING_SNAKE_CASE`;
  constructed instances, singletons, and functions use `camelCase`. Type-like
  registries may use `PascalCase`.
- Prefer string-literal unions for closed sets; add a runtime table only when
  values must be enumerated.
- Directories and `.ts` modules use kebab-case, except conventional test folders.

### Files

- A `.tsx` file dedicated to one component uses that component's `PascalCase`
  name. Files with multiple components or helpers use kebab-case.
- Prefer named exports in `src/`. Tooling configs and framework contracts may
  require default exports. Do not hand-edit generated files.
- Reuse existing functions before introducing another implementation. Extract a
  module when it creates a real responsibility or test boundary.

### The web workspace

Use lowercase or kebab-case files and preserve framework-required default exports
and route filenames. The identifier conventions still apply.

### Booleans and predicates

Stored state uses adjectives such as `enabled` or `connected`. Derived predicates
use questions such as `isSensitivePath` or `grantCovers`. Name options for what they
enable. If a function performs an action, use a result object when a boolean would
make its meaning ambiguous.

### Async

Use `Async` or `Sync` suffixes only to distinguish actual asynchronous and
synchronous counterparts. Preserve external API spellings. Spell synchronization
as a domain concept clearly rather than implying a synchronous operation.

### Events and handlers

- Callback slots use `on<Event>`; their local handlers use `handle<Event>`.
- Bus events use lowercase `<namespace>.<noun>.<pastTenseVerb>`.
- IPC channels use `lvis:<domain>:<action>` with kebab-case segments.
- Name app shells `*Window`, reusable bodies `*Content`, and modals `*Dialog`.
- Plugin IDs use `^[a-z][a-z0-9-]*$`; tool names use
  `^[a-zA-Z_][a-zA-Z0-9_]*$`; event IDs use the separate event convention.

### Errors and audit keys

Error classes end in `Error`; stable IPC error codes use kebab-case. New audit
`type` keys use snake_case. Shipped audit keys are persisted values: changing one
requires a migration decision, not an incidental naming cleanup.

### Test doubles

Shared test support belongs in `src/__tests__/support/` and must not be imported
by production code. Name helpers for what they provide. Test-only production
seams use a leading underscore and the `ForTest` suffix.

Do not name production files or identifiers for being test doubles. Domain words
such as realpath results, compaction stubs, or the marketing `MockShell` mock-up
are distinct. The naming gate owns its exact allowlist and the documented
`Why <prefix>:` header exception for deliberately shipped simulations; do not
expand an exception to avoid fixing a misleading name.

### Domain labels versus process labels

Names, comments, and shipped documents describe behavior. Domain labels resolvable
from a shipped specification may remain; review-round labels, work-plan coordinates,
PR-derived identifiers, and orphaned version suffixes do not belong there.
Commit messages, PR descriptions, and issues may record process history.

`.github/scripts/naming-gate.sh` and its self-test own automated matching, paths,
and exceptions. Check added lines and renamed paths, including manually checking
areas the gate does not cover. Do not treat excluded paths as permission to add
process metadata. When changing the rule, keep its enforcement and tests aligned.

### Organizational identifiers

This repository is public. Keep private organization names, internal hosts,
network coordinates, colleagues' names, and identifying screenshots out of tracked
content and commit history. Runtime-required identifiers may remain where the
contract needs them; explanatory prose uses generic terms.

Prefer derived temporary/home paths in tests; fixed examples use synthetic
accounts. Derive identifiers from the artifact under test when possible.
The naming workflow owns deidentification and home-path checks. Their coverage is
not a substitute for reviewing public content, including binaries and commit text.

### Known naming divergences

Existing departures are not precedents. Check the current code before proposing a
rename, and coordinate consumers of IPC, serialized values, and exported names.
Keep task-specific inventories in issues rather than in this instruction file.

## Architecture and security invariants

- Keep core logic vendor-neutral through the `GenericMessage` abstraction.
- Preserve the three plugin namespaces without runtime conversion. Their
  shapes are in `Naming` > `Events and handlers`.
- Cross-boundary input is untrusted. Preserve sender/frame/origin checks,
  manifest allow-lists, DLP handling, audit records, and fail-closed defaults.
- Non-user-origin content must not dispatch privileged slash commands.
- Tool execution must pass the active recipient's own permission and approval
  gates; do not introduce fallback paths around them.
- New IPC handler errors and main-process throws use concise English messages,
  and renderer code maps an error code to localized user-facing text instead of
  exposing the raw error. The code's spelling is in `Naming` > `Errors and
  audit keys`.
- A new IPC channel is one coherent change: handler, preload bridge, shared
  types, caller, sender guard, and tests move together.
- A shared payload field or enum literal requires a same-PR field-addition
  sweep: update the shared SoT, validators, producers, consumers, fixtures, and
  tests; search for residual inline copies before publishing.
- New persisted state under `~/.lvis/<feature>/` uses `openFeatureNamespace`;
  never hand-roll `mkdir` or mode bits outside its `0o700` directory / `0o600`
  file chokepoint.
  Secrets require an encrypted-at-rest store; mode bits alone are not encryption.
- Tool and MCP timeouts come from `src/shared/tool-timeout-policy.ts` and
  `TOOL_TIMEOUT_POLICY`; never hardcode them. Wire `runWithCeiling` cancellation
  through its `AbortController`.
- ASRT is staged default-on for `darwin` and opt-in for `linux`/`win32`.
  On `darwin`/`linux`, explicit `LVIS_SANDBOX_ENABLED=1` activation failure
  aborts; default/settings mode may gracefully degrade. Windows always
  degrades non-brickingly when unavailable. Preserve
  relaxation/effect-boundary coupling.
- No Fallback Code: a plugin manifest field updates its schema and SDK in the
  same PR; a HostApi change bumps every plugin dependency pin in the same PR.
- UI edits start with `grep` before editing. Component-name shapes are in
  `Naming` > `Events and handlers`.
- Private or non-indexed assets use the marketplace API, `gh`, or local sources,
  not WebSearch. After three identical failures, change approach.
- Top-level package imports used by unbundled runtime code (main, preload, CLI,
  or worker) belong in `dependencies`, not `devDependencies`. Renderer/UI-only
  packages bundled into `dist` by webpack/esbuild may remain in
  `devDependencies`.
- Runtime dependency changes update the lockfile and run the relevant
  packaged-app smoke so missing packages cannot reach an installer.

## Cross-Cutting Change Advisory

- Sensitive cross-cutting work identified by `.github/workflows/cluster-detector.yml`
  or task scope is advisory. It never requires an external reviewer, collaborator,
  label, attestation, or additional merge approval.
- The owner chooses proportionate architecture, critique, and security review and
  records material decisions, findings, and residual risk in the PR when useful.
  Parallel review, fixed roles, round counts, and cluster labels are optional,
  never prerequisites for implementation or merge.
  Owner self-review and automated review are valid evidence.
- The detector evaluates only the trusted `main` base of this repository through
  read-only repository and pull-request data access and never checks out or
  executes pull-request content.
  It uses only `contents: read` and `pull-requests: read`; it does not write commit
  statuses, labels, or pull-request metadata.
- Detector process failures (API, checkout, or schema validation) remain failures
  to investigate. A sensitive-area or cluster finding emits a warning and step
  summary only, and never blocks merge.

## Validation: proportional during work, complete once at publish

Use the smallest check that can disprove the current change while iterating:

- Review-only Markdown: only the pre-push hook's explicit allowlist may skip
  expensive gates; still run diff/path/policy checks. A `.md` suffix alone does
  not qualify; runtime/instruction/workflow/sensitive-contract Markdown and
  mixed changes get relevant targeted checks plus the full pre-push gate.
- Types or isolated logic: affected unit test file(s) and the narrowest useful
  typecheck. Do not run overlapping broad suites after every small edit.
- Cross-module or shared contract: targeted tests for each changed boundary,
  then one relevant integration test where behavior crosses the boundary.
- Renderer or user flow: targeted unit coverage plus the specific Playwright
  spec for the changed flow. Record screenshot/trace evidence when visual
  behavior changes.
- Packaging, permissions, IPC, sandbox, or release paths: add the focused
  security or packaged-app check required by the owning design.

For code-bearing and runtime/instruction/workflow/sensitive-contract Markdown,
pre-push runs `bun run typecheck`, full `bun run test`, and `bun run build`
once. Only allowlisted review-only Markdown takes the static-policy path. Do not
manually duplicate the full trio. After failure, rerun only failed or invalidated
checks; the next push performs the complete gate. Full Playwright E2E belongs to
CI/release; locally run only changed-flow specs unless the task requires more.

### CI job composition

Keep repository-hygiene checks after compilation and tests, or in independent
jobs, so stale bookkeeping does not hide product verification. Build-integrity
checks that inspect source or generated bytes remain with their owning build.
The current scripts and `src/__tests__/packaging-discipline-source.test.ts` own
exact command membership and ordering.

Before moving a required check into another job, inspect current branch protection
and preserve its required status. Do not infer protection from historical check
names. Avoid dependency edges that cause hygiene failures to skip product tests.

## Change and PR discipline

- Keep a PR cohesive and reviewable; prefer existing utilities and patterns over
  new abstractions or dependencies.
- Update `../TODO.md` and task documentation only when the change completes,
  discovers, or alters a tracked item. Do not touch them mechanically.
- PR descriptions state motivation, scope, risk, targeted validation, pre-push
  gate result, UI/E2E evidence when applicable, and companion repository PRs.
- Merge only after fresh CI and relevant local verification pass, with material
  findings addressed. Review requests and fixed review loops are not merge gates.
  Inspect current branch protection and unresolved conversations; never use `--admin`.
- Never claim completion without fresh evidence for the changed behavior. State
  any validation gap or remaining risk directly.
