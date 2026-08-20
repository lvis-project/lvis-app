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

Rules are stated positively: what a name must be. The process-metadata ban is
one clause of this, not the whole of it. Counts are the evidence each clause
rests on — cite the count instead of arguing taste. Where the tree disagrees
with itself, the majority side is the standard and the minority is listed under
`Known naming divergences`, not quietly tolerated as a second convention.

**Scope.** Every clause and count below is measured over the Electron app —
`src/` — excluding tests, `__mocks__`, and `src/i18n/messages/generated/`. That
is 1111 files. Read it as the standard for `src/`, not as a repository-wide
absolute. The one exception is `Domain labels versus process labels`, which
applies everywhere, including `web/` and `docs/`, because it is about what a
name records rather than how a name is spelled. `web/` has its own conventions
and its own clause below; `scripts/`, `test/`, and `docs/` are unmeasured here
and follow the nearest applicable clause without a count behind it.

**What a count is, and is not.** Every number in this section is the output of
a query in `How the counts were taken` below, run over the file set below at
the commit that last edited the clause. It is a measurement, not an invariant,
and it drifts as the tree changes. A number that no longer reproduces is a
signal to re-measure and update the clause — not evidence that the clause is
wrong, and not licence to leave it stale. A clause with no query behind it has
no number in it: the rule is stated, and the reader is told it is unmeasured.

The file set the counts are taken over, so a clause can be rechecked rather
than trusted. Every query below that says `<file set>` means this pipeline;
`How the counts were taken` records which queries need which tools, and why:

    git ls-files 'src/**' | grep -E '\.(ts|tsx)$' \
      | grep -Ev '(__tests__/|__mocks__/|\.test\.|\.spec\.)' \
      | grep -v '^src/i18n/messages/generated/'

### Casing by kind

- Types, interfaces, and classes are `PascalCase`, with no exceptions: 3018
  top-level `type`/`interface` declarations and 259 `class` declarations, and
  zero of them begin with a lowercase letter.
- Functions, methods, parameters, locals, and object fields are `camelCase`.
- A module-level `const` bound to a fixed literal or frozen table is
  `SCREAMING_SNAKE_CASE`. A module-level `const` bound to a constructed
  instance, singleton, or function stays `camelCase` (`logger`,
  `admissionRegistry`, `backgroundShellManager`, `projectRoot`). The casing
  says which of the two it is; it is not an emphasis marker. Of 2443
  module-level `const` declarations: 1993 screaming, 351 camelCase (184
  distinct names), 82 `PascalCase`, and 17 with a leading underscore.
- A module-level `const` is `PascalCase` only when the binding *is* a type-like
  or component-like thing. All 82 are one of five: a React component or a lazy
  wrapper around one (56, mostly the vendored primitives in
  `src/components/ui/`), a schema object (13, `ReadFileInputSchema`), a
  `createContext` result (5, `ChatContext`), a frozen table standing in for an
  enum or a code registry (7, `A2ATaskState`, `PluginPhase`,
  `StandardJsonRpcErrorDefinition`), and one constructor binding
  (`SonicBoomCtor`). A binding that is none of those is `camelCase` or
  `SCREAMING_SNAKE_CASE` by the clause above.
- A leading underscore marks an export that exists but is not part of the
  module's API — a test seam or an internals bag (`_internal`, `__internals`,
  `__test`). It is a visibility marker, not a casing rule; the rest of the name
  still follows the clauses above.
- `enum` is not the pattern here — one declaration exists in the whole tree
  (`CompressionStatus`, `src/shared/compact-status.ts`). Model a closed set as
  a string-literal union, adding a frozen companion object only when the values
  must be enumerated at runtime.
- Directories are lowercase kebab-case (70 path segments under `src/`), except
  the dunder test directories `__tests__`, `__fixtures__`, `__probes__`.

### Files

- A `.ts` module in `src/` is kebab-case: 945 of 945 hand-written files. The
  192 generated `.ts` files — 121 camelCase, 61 `be_`-prefixed, 10 single-word
  — all sit under `src/i18n/messages/generated/` and belong to their generator,
  not to this rule; do not hand-edit them and do not cite them as precedent.
- A `.tsx` file in `src/` whose reason to exist is one React component is
  `PascalCase` and carries that component's exact name: 135 files, 132 of which
  export a binding of exactly that name. The three that do not are
  `ChatContext.tsx` and `OverlayContext.tsx`, which name the context object
  they build and export it only as a `*Provider` and hooks, and
  `PermissionDecisionCard.tsx`; all three are under `Known naming divergences`.
  This clause is `src/`-only — see `The web workspace`.
- A `.tsx` file that exports several components or helpers, or no component at
  all, is kebab-case: `chat-side-panel-layout.tsx`, `preview-renderers.tsx`.
  `src/components/ui/*` is vendored primitive code and keeps its upstream
  kebab names.
- `export default` is not used in `src/`: 0 declarations in 945 hand-written
  `.ts`, 2 in 166 non-test `.tsx`. So "the file name matches the default
  export" does not arise there: the file name matches the single component the
  file exists to hold. When such a file grows a second exported component,
  either rename the file to kebab-case or move the second component out; never
  leave a `PascalCase` file whose name matches nothing in it. This clause does
  not reach `web/`, where the framework requires default exports, or the
  root-level tooling configs (`playwright.config.ts`,
  `vitest.analysis.config.ts`), where the tool requires one.
- Before adding a file at all, apply the order in `Change and PR discipline`:
  an existing function, then a function in an existing file, then a new file.

### The web workspace

`web/` is the marketing and documentation site: 241 tracked files, Next.js App
Router, built and deployed by its own workflows. Its file and export
conventions are the framework's, not `src/`'s, and applying the `src/` clauses
there breaks the build. Concretely, and measured over `web/`:

- Every `.tsx` and `.ts` file is kebab-case or lowercase — 134 `.tsx`, zero
  `PascalCase`. A single-component file is `hero.tsx`, not `Hero.tsx`. Do not
  rename toward the `src/` clause.
- `export default` is the norm, not a divergence: 102 files declare one. The
  App Router resolves a route from `page.tsx` / `layout.tsx` and a sitemap from
  `sitemap.ts` by default export; removing it removes the route.
- The identifier clauses in `Casing by kind` do apply, as do `Booleans and
  predicates`, `Async`, and `Domain labels versus process labels` — those are
  about identifiers, which the framework does not constrain. The directory
  clause in `Casing by kind` carries a `src/` count and is not measured here.

### Booleans and predicates

- A boolean-valued field is a state adjective or past participle: `enabled`,
  `open`, `truncated`, `active`, `collapsed`, `connected`, `cancelled`. Do not
  prefix stored state with `is` to make it look boolean. Of the 1483
  `boolean`-typed names in the file set, 1310 carry no `is`/`has`/`can`/`should`
  prefix.
- `is`/`has`/`can`/`should` belong on *derived* answers rather than stored
  state — 173 of those 1483, plus the majority of boolean-returning functions.
- A function returning `boolean` is named as a proposition the caller reads as
  a question — `isSensitivePath`, `hasApiKey`, `grantCovers`,
  `pathEntryExists`, `vendorSupportsLengthContinuation`. Subject-first is fine;
  imperative is not. 415 `function` declarations return `boolean` (366 distinct
  names), and 292 of them open with `is`/`has`/`can`/`should`/`are`/`does`.
- A boolean-returning function named as a command leaves the caller unable to
  tell whether `true` means "it is so" or "I did it". Name it for the question
  or return a result object.
- An option is named for what it turns *on*: `allowPrivateNetworks`,
  `includeUnscoped`, `enableThinking`. A `disableX` flag double-negates at
  every call site.

### Async

- Async functions carry no suffix — 502 `async function` declarations, none
  named `*Async`. The return type already says it. The suffix is earned only by
  a binding that disambiguates a same-named synchronous API. All eight `*Async`
  spellings in `src/` are accounted for and none is a divergence: `statAsync`
  (`stat as statAsync`), `execFileAsync` (`promisify(execFile)`) and
  `attemptAsync` (declared beside a synchronous `attempt` in the same function,
  `src/boot/assemble-services.ts`) each disambiguate a real pair; four —
  `installWindowsSandboxAsync`, `checkWindowsSandboxStatusAsync`,
  `checkDependenciesAsync`, `checkWindowsDependenciesAsync` — are the
  `@anthropic-ai/sandbox-runtime` package's own API names, which this
  repository must spell as that package spells them; and
  `getCompressedDataAsync` appears only inside a comment naming a third-party
  function, never as a declaration here. An external API's spelling is not this
  standard's to fix.
- `*Sync` is reserved for the synchronous sibling of an operation that is
  otherwise async — the `node:fs` convention, whose own pairs are `readFile` /
  `readFileSync` and `stat` / `statSync`. It has no `ensureDir`; this
  repository's nearest instance of the shape is its own `ensureDir`
  (`src/main/storage/feature-namespace.ts`) against `ensureDirSync`
  (`src/memory/session-search-index.ts`), which is two helpers in two modules
  rather than one module's pair. A `*Sync` name with no async counterpart
  carries no information — drop the suffix. Eleven such names are in `src/`,
  listed under `Known naming divergences`; `node:fs` and other third-party
  `*Sync` names are out of scope for the same reason the `*Async` clause gives.

### Events and handlers

- A callback slot — a prop, an option field, a subscription argument — is
  `on<Event>`: `onError`, `onProgress`, `onToolStart`. It names the event, not
  the reaction: `onPluginsChanged`, never `onRefreshList`.
- The local function supplied to that slot is `handle<Event>` — 182
  declarations under 161 distinct names. The pair is what makes direction
  readable at the call site.
- Bus event ids are `<namespace>.<noun>.<pastTenseVerb>`, lowercase and
  dot-separated, where the namespace is a plugin id or a host domain:
  `calendar.event.created`, `host.theme.changed`, `assistant.round.completed`.
- IPC channels are `lvis:<domain>:<action>` with kebab-case segments: 331 of
  the 338 distinct `"lvis:…"` channel literals in the file set are kebab in
  every segment. The seven that are not are under `Known naming divergences`.
- A React component is named for the role it plays in the window tree. Name
  app shells `*Window`, reusable bodies `*Content`, and modals `*Dialog`.
- The three plugin namespaces each have their own shape: manifest plugin id
  `^[a-z][a-z0-9-]*$`, LLM tool name `^[a-zA-Z_][a-zA-Z0-9_]*$` (underscore
  form, `meeting_start`), and the event id above. That they must survive
  end-to-end without runtime conversion is an invariant, not a naming rule —
  see `Architecture and security invariants`.

### Errors and audit keys

- An error class is `<Domain><Condition>Error` and ends in `Error`:
  `PluginStartupTimeoutError`, `SecretDocumentDecryptionError` — 69 of the 70
  classes extending an `Error` type. The suffix is what lets a `catch` read as
  a sentence.
- Stable IPC error codes are kebab-case. What the renderer must then do with
  a code is an invariant, not a naming rule — see `Architecture and security
  invariants`.
- Audit `type` keys are `snake_case`: `tool_call`, `mcp_apikey_set`,
  `kill_switch`, `sandbox_gate` — 11 of the 12 values the two audit-entry
  interfaces in `src/audit/audit-logger.ts` admit.
- An audit key is a persisted value, not just an identifier. Changing one is a
  log migration that strands historical rows, so treat shipped keys as frozen
  and add rather than rename.

### Test doubles

- No *file* outside a test directory is named for being a double. All four
  `real-`/`mock-`/`fake-`/`stub-`-prefixed filenames in the tree live under
  `__tests__/` or `test/`.
- Three *identifiers* spelled `Mock*` do live in production paths, and they are
  the whole of it — 44 lines across six files, reproduced by the `Test doubles`
  query in `How the counts were taken`. Two of the three are legitimate and one
  is not:
  - `MockMarketplaceFetcher` (`src/plugins/marketplace.ts`, 8 lines) is a
    backend kind, the same axis as `CloudMarketplaceFetcher`: it serves the
    catalog from a local file for development, and its constructor throws in a
    packaged build (`assertMockMarketplaceAllowed`). The word names what the
    fetcher reads, not a test seam.
  - `MockShell` (`web/components/landing/workday.tsx`, 33 lines) is a
    mock-*up* frame on the marketing page — an `aria-hidden` card the section
    draws its illustrations in. It is the same mock-*up* vocabulary as
    `web/components/docs/mockup-frame.tsx`, in a different directory, not a
    file beside it. A different word that shares four letters.
  - `MockCloudIndexAdapter` (`src/main/cloud-index-adapter.ts`, 3 lines) is the
    one that really is named for what it is not: it is the only implementation
    of `CloudIndexAdapter`, it returns no hits, and it reports itself
    unavailable. It is constructed in exactly one place — `src/boot/tools.ts`,
    inside the branch that runs only when a plugin declaring the
    `worker-client` capability is installed *and* exposes `getWorkerClient()`,
    so on an install with no such plugin it is never constructed at all. It is
    listed under `Known naming divergences` to be renamed for the behavior it
    has.
- The gate carries those three names as a closed allow-list so their lines stay
  editable, and blocks every other `Mock*`/`Fake*` identifier — including a new
  name that merely starts with an allowed one, and a new name sharing a line
  with an allowed one. Adding a fourth entry is a review decision, not a way
  around the rule: justify the domain word or pick a different one.
- Shared test support that several suites import lives in `src/testing/` and is
  named for what it provides — `sign-envelope-fixture.ts`,
  `host-shell-sandbox-fixtures.ts` — never for being fake. Nothing outside
  tests imports it (0 inbound production imports).
- A production seam that exists for tests is suffixed `ForTest` and carries a
  leading underscore marking it as outside the module's API:
  `__resetSessionStoreForTest`, `_resetForTest`. One suffix spelling; see
  `Known naming divergences` for the two others still in the tree.
- `real` and `stub` are ordinary domain words here and stay. In `src/`,
  `real*` is a POSIX `realpath` result in 6 of its 8 spellings — `realRoot`
  (11), `realFile` (9), `realDir` (5), `realParent` (3), `realAsset` (2),
  `realEntry` (1) — and `stub*` is a compaction stub, the placeholder that
  replaces dropped content: `stubMessage` (4), `stubRemovedMessages` (3),
  `stubLen` (2), `stubFreedTokens` (2), `stubEstimatedAfter` (2), plus
  `BOUNDARY_STUB_TEMPLATE` and `src/shared/tool-result-stub.ts`. Neither is a
  double. The test is what the word denotes: a name meaning "not the production
  thing" is banned; a name denoting a thing production code builds is not.
- The gate therefore matches only `mock` and `fake` as identifiers. A lone
  `Real*`/`Stub*` production identifier that really is half of a double split
  is a reviewer call, not a gate finding — the gate cannot separate it from
  `realpath` and compaction vocabulary, and a check that cannot separate them
  only teaches authors to argue with grep. The reviewer question is whether a
  `Mock*`/`Fake*` counterpart exists; without one there is no split and the
  name stays.
- The filename check is deliberately stricter than the identifier check: it
  still rejects a leading `real-`, `mock-`, `fake-`, or `stub-` on a new or
  renamed file. As a filename prefix those words are adjectives and the
  contrast to some other file is the whole meaning; in an identifier they are
  nouns here. A file whose subject really is a stub says so in noun position,
  the way `tool-result-stub.ts` does. The hatch for a simulation the product
  deliberately ships is a `Why <prefix>:` header in the first 30 lines. No file
  in this tree uses the hatch; the only place the literal appears is the
  fixture in `.github/scripts/naming-gate-selftest.sh` that proves it works.
- Both checks are reproducible; the queries are in `How the counts were taken`.

### Domain labels versus process labels

Applied to any numbered or lettered label, the question is: **can a reader
resolve this label from a document the repository ships?**

- Yes — it is a domain label and it stays. `Layer 0`–`Layer 8` (permission
  policy design, 191 uses), `Tier A`–`Tier D` and `Tier 1`–`Tier 4` (plugin
  permission tiers), `§4.5` architecture anchors (633), `#811` issue anchors
  (834). Those three counts are over the files the gate scans, not the `src/`
  file set — this clause is the one that applies everywhere.
- No — it resolves only against a work plan, a review round, or PR history, so
  it is a process label and does not enter an identifier, filename, comment,
  audit key, or shipped document: `H2`, `Phase 2b`, `PR-A4`, `Wave F`,
  `Sprint 3-C`, `R-2`, `§M9`, `round3`, `pr1114`. Measured over every file the
  gate scans, exactly one such line survives outside this document — a
  review-round list in `.omc/plans/open-questions.md`, a planning artifact
  rather than shipped code. That measurement is over the gate's scope, which
  is narrower than "shipped document": `docs/blueprints/` and `docs/ko/` are
  shipped and excluded, and 24 of those 69 files carry a `Phase N` label. The
  rule still binds there; only the enforcement stops at the gate's edge.
- A `-v2` suffix is a process label unless the earlier version is a live
  sibling in the same directory. If `foo-v2.ts` exists and `foo.ts` does not,
  the suffix records when the file was written, not what it is.
- Commit messages, PR bodies, and issues are outside this rule and are the
  right place for schedule coordinates.
- The gate is `.github/scripts/naming-gate.sh`, run by
  `.github/workflows/naming-gate.yml` on pull requests targeting `main` or
  `dev`. It blocks new process labels in the PR diff, and it is narrower than
  the prose above in six ways that are the gate's design, not gaps to be relied
  on:
  - It checks file *names* only on added and renamed paths, so a grandfathered
    name never becomes a standing ban on editing that file. A rename *into* a
    prohibited name is still caught.
  - In `AGENTS.md` and `CLAUDE.md` only, inline code spans are stripped before
    matching, because those two files have to be able to write `H2` and
    `Phase 2b` in order to ban them. Every other shipped `.md` is matched
    with its backticks intact — a backticked label in an ordinary document is
    a use, not a mention, and that is exactly how these fossils appear in
    prose.
  - Fenced blocks are never stripped, in any file. A document quoting a build
    log or a git history that contains a process label inside a fenced block is
    blocked; paraphrase the quote or move it to the PR body.
  - `Mock*`/`Fake*` identifiers are matched against a closed allow-list of the
    three domain names in `Test doubles`; everything else is blocked.
  - It reads only `.ts`, `.tsx`, `.py`, `.js`, `.mjs`, `.cjs` and `.md`, and it
    skips `docs/blueprints/`, `docs/ko/`, `.github/`, every `__tests__/` and
    `__mocks__/` directory, `test/`, `tests/`, `*.test.*`, `*.spec.*`,
    lockfiles and `CHANGELOG`. A label in any of those is out of the gate's
    reach but not out of the rule's.
  - Its trigger is `pull_request` against `main` or `dev`. A PR stacked on
    another feature branch is never checked by it; run
    `.github/scripts/naming-gate.sh <base-sha> HEAD` locally instead.
  Prose and gate are kept honest by `.github/scripts/naming-gate-selftest.sh`,
  which runs in the same workflow and pins each of those behaviors to a
  synthetic diff. Change one, change the other.

### Organizational identifiers

`lvis-project/lvis-app` is a public repository: this file, every file beside
it, and the whole commit history are readable by anyone. The plugin
repositories that integrate with an internal system are private — the SDK is
public, the integrations are not — so "the integration details stay private" is
already the boundary. A name committed here crosses it permanently, in a clone
that cannot be recalled. Check a repository's visibility rather than assuming
it from the pattern of the ones around it.

- The employer's name and brand, its internal system and product names, its
  internal hostnames and network coordinates, and colleagues' names do not
  belong in any tracked file: source, comment, test, fixture, documentation,
  commit message, or image. A screenshot leaks more than a sentence does and is
  harder to notice.
- Refer to a specific plugin by the generic noun — "plugin", "an internal
  portal plugin", "the intranet search plugin" — not by the organization it
  integrates with. The plugin id in a manifest, a catalog record, or a routing
  table is a literal the runtime needs and stays; the prose around it does not
  need to say whose intranet it is.
- This is the same test as `External product names`, applied to the
  organization rather than to a vendor: a name that identifies something the
  code talks to stays, a name that decorates an explanation goes. The
  difference is the consequence — a vendor name is an attribution problem, this
  one is a disclosure.
- Enforcement belongs in a diff-scanning CI job — `deidentification-gate` in
  `.github/workflows/naming-gate.yml`, beside the process-label job that
  `Domain labels versus process labels` describes, because both answer the same
  question about a token in a diff. The pattern list lives with that job and
  deliberately not here: writing the literals into this file in order to ban
  them would republish exactly what the rule removes, and a second copy of a
  pattern list is the split this file exists to prevent. This clause owns the
  rule; the job owns the patterns. Where no job is matching yet, the clause
  still binds as a reviewer rule — the same split this document uses for
  everything grep cannot decide.
- Deriving an assertion from a manifest or a bundle beats copying a literal
  into a test. A test that hard-codes the identifier both leaks it and pins one
  value; reading it from the artifact under test does neither.

### Known naming divergences

Backlog, not permission. Each is the minority side of a rule above; fix
opportunistically when already editing the file, and do not cite any of them as
precedent.

- `src/ui/renderer/contexts/i18n-settings-provider.tsx` exports exactly one
  component, `I18nSettingsProvider`, under a kebab-case name.
- `src/ui/renderer/components/permissions/PermissionDecisionCard.tsx` is
  `PascalCase` but exports a set of helpers with no `PermissionDecisionCard` in
  it. Three modules import it for those helpers.
- `src/ui/renderer/context/ChatContext.tsx` and `OverlayContext.tsx` are
  `PascalCase` files named for the context object each builds, which each keeps
  module-private; what they export is `*ContextValue`, `*ContextProvider` and
  the hooks. The name is truthful about the file's subject but is not a
  same-named export, so it is the minority side of the `.tsx` clause.
- Two remaining `export default` sites: `SlashPickerPanel.tsx`,
  `CommandPopoverPanel.tsx`.
- Three spellings of the test-seam suffix, by distinct name over the file set:
  `ForTest` (26), `ForTests` (16), `ForTesting` (5). `ForTest` is the standard;
  the other two are the backlog.
- Seven camelCase IPC channel leaves against 331 kebab: `lvis:attach:openFile`,
  `openExternal`, `readImage`, `saveClipboardImage`, `discardClipboardImage`,
  and `lvis:dev:getPreflightStatus`, `setPreflightOverride`. These strings
  cross the preload boundary, so renaming is a coordinated change.
- `ManifestIntegrityViolation` is the only error class without the `Error`
  suffix.
- The audit `type` value `diagnostics-export` is kebab among eleven
  `snake_case` siblings. It is a persisted key, so this is a log migration
  rather than a rename.
- Eleven `*Sync` names this repository declares itself have no async sibling,
  so the suffix carries nothing. Nine have no sibling of any kind:
  `copyOpenFileSync`, `findLastCompleteJsonlBoundarySync`,
  `publishOpenFileArchiveSync`, `readLastCompleteLineSync`,
  `readLastNonEmptyLineSync` (all `src/audit/audit-logger.ts`),
  `readFrontmatterSync`, `listCatalogSync`, `scanCatalogDirSync` (all
  `src/main/skill-store.ts`) and `writeUtf8FileAtomicSync`
  (`src/lib/atomic-file.ts`). The other two are the sharpest cases:
  `fsyncDirectorySync` (`src/audit/audit-logger.ts`, sibling `fsyncDirectory`
  in `src/audit/hmac-chain.ts`) and `readPersistedAppModeSync`
  (`src/main/persisted-app-mode.ts`, sibling `readPersistedAppMode` in
  `src/main/main-window.ts`) each have a same-named sibling that is itself
  synchronous, so the suffix distinguishes nothing at all.
- `managedPreStartSync` (`src/boot.ts`) is a local `const` holding a promise;
  boot awaits it further down in a `Promise.all`, not on the following line, so
  the suffix reads as the `node:fs` synchronous-sibling marker on a binding
  that is asynchronous. `Sync` here is the domain noun from the
  `mode: "pre-start-sync"` argument it passes — *synchronization*, not
  *synchronous* — which is how it survived review. Spell the domain word out
  rather than abbreviating it into the reserved suffix.
- Boolean-returning functions named as commands: `loadSession`,
  `verifyEntryHmac`, `repairSecretFileMode`, `migrateLegacyDisabledMode`,
  `focusPendingQuestion`.
- `realFs` and `realFsPromises` in `src/permissions/manifest-integrity.ts` are
  the two `real*` names that are not `realpath` results — each contrasts an
  unwrapped module with its `Proxy`. `target` is the `Proxy` vocabulary for
  both.
- `docs/architecture/session-model-v2.md` carries a `-v2` suffix with no
  earlier sibling in `docs/architecture/`.
- `MockCloudIndexAdapter` (`src/main/cloud-index-adapter.ts`) is the sole
  implementation of `CloudIndexAdapter`, so the name promises a double that
  does not exist — there is no other one for it to stand in for. Rename it for
  what it does: it reports unavailable and returns no hits. `src/boot/tools.ts`
  constructs it only inside the branch guarded on a `worker-client`-capability
  plugin being present and exposing `getWorkerClient()`, so the rename touches
  that one call site. The gate allow-lists the name meanwhile so the rename is
  not blocked by its own edits, and that entry comes out with the rename.

### How the counts were taken

Every number in `Naming` is the output of one of these, run from the repository
root. `<file set>` is the pipeline in `Scope`; `<gate scan>` is the first query
printed below, which is the set the gate itself reads. Re-run the query before
disputing a number, and update the clause when it has drifted.

These were last taken with GNU grep 3.11 and git 2.47 on Linux, the same pair
CI runs, and the `grep -E` queries were cross-checked against BSD grep 2.6 on
macOS with identical results. Three queries below depend on the toolchain. The
two spelled `grep -P` need PCRE, which stock macOS grep does not have — it
rejects the option and exits 2, so that one fails loudly. The audit-key query
is spelled `sed -E` because the basic-regex `\|` alternation it used to carry
is a GNU extension that BSD sed matches literally, printing nothing and exiting
0 — a silence indistinguishable from a real zero. State a number only for the
scope you ran it over; a query that cannot run is not a query that returned
zero.

    # <gate scan> — every file the naming gate reads (1640)
    git ls-files | grep -E '\.(ts|tsx|py|js|mjs|cjs|md)$' \
      | grep -Ev '^(docs/blueprints/|docs/ko/|\.github/|.*/__tests__/|.*/__mocks__/|test/|tests/|.*\.test\.|.*\.spec\.|.*\.lock|.*lock\.json|CHANGELOG)'

    # Casing: 3018 type/interface + 259 class, 0 lowercase-initial
    <file set> | xargs grep -hoE \
      '^(export )?(declare )?(abstract )?(class|interface|type) [A-Za-z_$][A-Za-z0-9_$]*'

    # Casing: 2443 module-level const declarations, split 1993 / 351 / 82 / 17
    <file set> | xargs grep -hoE '^(export )?const [A-Za-z_$][A-Za-z0-9_$]*' \
      | sed -E 's/^(export )?const //'
      #   screaming   grep -cE '^[A-Z][A-Z0-9_]*$'
      #   camelCase   grep -cE '^[a-z]'
      #   PascalCase  grep -E '^[A-Z]' | grep -vcE '^[A-Z][A-Z0-9_]*$'
      #   underscore  grep -vcE '^[A-Z]|^[a-z]'

    # Files: 945 of 945 .ts kebab; 166 .tsx of which 135 PascalCase
    <file set> | grep '\.ts$'  | xargs -n1 basename | grep -cE '^[a-z0-9]+(-[a-z0-9]+)*\.ts$'
    <file set> | grep '\.tsx$' | xargs -n1 basename | grep -cE '^[A-Z]'

    # Files: of the 135 PascalCase .tsx, 132 export a binding of the same name
    for f in $(<file set> | grep -E '/[A-Z][^/]*\.tsx$'); do
      n=$(basename "$f" .tsx)
      grep -qE "export (const|function|class) $n\b|export \{[^}]*\b$n\b|export default $n\b" "$f" \
        || echo "no same-named export: $f"
    done

    # Files: 192 generated .ts — 121 camelCase, 61 be_-prefixed, 10 single-word
    git ls-files 'src/i18n/messages/generated/**' | grep '\.ts$' | xargs -n1 basename

    # Files: export default — 0 in .ts, 2 in .tsx
    <file set> | xargs grep -lE '^export default'

    # web/: 241 tracked, 134 .tsx none PascalCase, 102 files with a default export
    git ls-files 'web/**' | wc -l
    git ls-files 'web/**' | grep '\.tsx$' | xargs -n1 basename | grep -cE '^[A-Z]'
    git ls-files 'web/**' | grep -E '\.(ts|tsx)$' | xargs grep -lE '^export default' | wc -l

    # Booleans: 1483 boolean-typed names, 173 is/has/can/should-prefixed
    <file set> | xargs grep -hoE '\b[a-zA-Z_$][A-Za-z0-9_$]*\??: boolean' \
      | sed -E 's/\??: boolean//'
      #   prefixed   grep -cE '^(is|has|can|should)[A-Z]'

    # Booleans: 415 boolean-returning function declarations, 366 distinct,
    # 292 of the declarations opening with a question word
    <file set> | xargs grep -hoE 'function [a-zA-Z_$][A-Za-z0-9_$]*\([^)]*\): boolean' \
      | sed -E 's/^function ([A-Za-z0-9_$]*).*/\1/'
      #   question-opening   grep -cE '^(is|has|can|should|are|does)[A-Z]'

    # Async: 502 async function declarations, 0 named *Async; 8 *Async spellings
    <file set> | xargs grep -hoE 'async function [a-zA-Z_$][A-Za-z0-9_$]*'
    <file set> | xargs grep -hoE '\b[a-z][A-Za-z0-9_$]*Async\b' | sort | uniq -c

    # Handlers: 182 handle* declarations, 161 distinct names
    <file set> | xargs grep -hoE '\b(const|function|async function) handle[A-Z][A-Za-z0-9_$]*'

    # IPC: 338 distinct lvis: channel literals, 331 kebab in every segment
    <file set> | xargs grep -hoE '"lvis:[a-zA-Z0-9:_-]+"' | sort -u

    # Errors: 70 classes extending an Error type, 69 ending in Error
    <file set> | xargs grep -hoE 'class [A-Za-z0-9_$]+ extends [A-Za-z0-9_$.]*Error\b'

    # Audit: the 12 admitted type keys, 11 snake_case and 1 kebab.
    # `sed -E`, not a BRE with `\|`: alternation in a basic regex is a GNU
    # extension that BSD sed matches literally, so the BRE spelling prints
    # nothing at all on macOS and the query reports zero keys instead of 12.
    sed -E -n '/export interface (AuditEntry|SandboxGateAuditEntry)/,/^}/p' \
      src/audit/audit-logger.ts | grep -E '^  type: ' | grep -oE '"[a-z0-9_-]+"' | sort -u

    # Test doubles: the four double-prefixed filenames, all under a test dir
    git ls-files | while read -r f; do case "$(basename "$f")" in \
      real-*|mock-*|fake-*|stub-*) echo "$f";; esac; done

    # Test doubles: the 44 production-path Mock*/Fake* lines in six files.
    # AGENTS.md and CLAUDE.md are excluded for the same reason the gate strips
    # their code spans — a rule document has to name what it bans.
    git ls-files | grep -E '\.(ts|tsx|py|js|mjs|cjs|md)$' \
      | grep -Ev '^(docs/blueprints/|docs/ko/|\.github/|AGENTS\.md$|CLAUDE\.md$|.*/__tests__/|.*/__mocks__/|test/|tests/|.*\.test\.|.*\.spec\.)' \
      | xargs grep -nP '\b[Mm]ock[A-Z]|\b[Ff]ake[A-Z]'

    # Test doubles: the domain vocabulary the identifier rule deliberately spares
    <file set> | xargs grep -hoE '\breal[A-Z][A-Za-z0-9]*|\bstub[A-Z][A-Za-z0-9]*' \
      | sort | uniq -c | sort -rn

    # Test-seam suffix spellings: 26 / 16 / 5 distinct names
    <file set> | xargs grep -hoE '\b[A-Za-z0-9_$]*ForTest(s|ing)?\b' | sort -u

    # Directories: 73 path segments under src/, 70 kebab + 3 dunder
    git ls-files 'src/**' | xargs -n1 dirname | tr '/' '\n' | sort -u

    # Domain labels: 191 Layer N, 633 section anchors, 834 issue anchors
    <gate scan> | xargs grep -hoE '\bLayer [0-9]'
    <gate scan> | xargs grep -hoE '§[0-9]+(\.[0-9]+)*'
    <gate scan> | xargs grep -hoE '#[0-9]+\b'

    # Process labels surviving anywhere the gate reads. Every pattern in the
    # gate's `patterns=(...)` array is run, not just one; the two test-double
    # patterns are appended to that array separately and are measured by the
    # test-double query above instead. This document is excluded for the same
    # reason that query excludes it — a rule document has to name what it bans,
    # which is why the gate strips its code spans. Exactly one line survives:
    # a review-round list in .omc/plans/open-questions.md, a planning artifact.
    sed -n '/^patterns=(/,/^)/p' .github/scripts/naming-gate.sh \
      | grep -oE "'[^']+'" | tr -d "'" \
      | while IFS= read -r pat; do
          <gate scan> | grep -Ev '^(AGENTS|CLAUDE)\.md$' | xargs grep -nP "$pat"
        done

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

## Change and PR discipline

- Keep a PR cohesive and reviewable; prefer existing utilities and patterns over
  new abstractions or dependencies.
- Update `../TODO.md` and task documentation only when the change completes,
  discovers, or alters a tracked item. Do not touch them mechanically.
- PR descriptions state motivation, scope, risk, targeted validation, pre-push
  gate result, UI/E2E evidence when applicable, and companion repository PRs.
- Never claim completion without fresh evidence for the changed behavior. State
  any validation gap or remaining risk directly.
