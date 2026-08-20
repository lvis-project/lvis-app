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

The file set the counts are taken over, so a clause can be rechecked rather
than trusted:

    git ls-files 'src/**' | grep -E '\.(ts|tsx)$' \
      | grep -Ev '(__tests__/|__mocks__/|\.test\.|\.spec\.)' \
      | grep -v '^src/i18n/messages/generated/'

### Casing by kind

- Types, interfaces, and classes are `PascalCase`, with no exceptions. Over
  the file set above, 3018 top-level `type`/`interface` declarations and 259
  `class` declarations, and zero of them begin with a lowercase letter:

      <file set> | xargs grep -hoE \
        '^(export )?(declare )?(abstract )?(class|interface|type) [A-Za-z_$][A-Za-z0-9_$]*'

- Functions, methods, parameters, locals, and object fields are `camelCase`.
- A module-level `const` bound to a fixed literal or frozen table is
  `SCREAMING_SNAKE_CASE` (588). A module-level `const` bound to a constructed
  instance, singleton, or function stays `camelCase` (55: `logger`,
  `admissionRegistry`, `backgroundShellManager`, `projectRoot`). The casing
  says which of the two it is; it is not an emphasis marker.
- A module-level `const` is `PascalCase` only when the binding *is* a type-like
  or component-like thing: a React component, a schema object
  (`ReadFileInputSchema`), or a frozen map standing in for an enum
  (`A2ATaskState`, `PluginPhase`). All 25 today are one of those three.
- A leading underscore marks an export that exists but is not part of the
  module's API — a test seam or an internals bag (`_internal`, `__internals`,
  `__test`). It is a visibility marker, not a casing rule; the rest of the name
  still follows the clauses above.
- `enum` is not the pattern here — one declaration exists in the whole tree.
  Model a closed set as a string-literal union, adding a frozen companion
  object only when the values must be enumerated at runtime.
- Directories are lowercase kebab-case (70), except the dunder test
  directories `__tests__`, `__fixtures__`, `__probes__`.

### Files

- A `.ts` module in `src/` is kebab-case: 945 of 945 hand-written files. The
  192 camelCase and `be_`-prefixed `.ts` files all sit under
  `src/i18n/messages/generated/` and belong to their generator, not to this
  rule; do not hand-edit them and do not cite them as precedent.
- A `.tsx` file in `src/` whose reason to exist is one React component is
  `PascalCase` and carries that component's exact name (135 files; 134 hold a
  same-named export). This clause is `src/`-only — see `The web workspace`.
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
- Everything in `Casing by kind`, `Booleans and predicates`, `Async`, and
  `Domain labels versus process labels` does apply — those are about
  identifiers, which the framework does not constrain.

### Booleans and predicates

- A boolean-valued field is a state adjective or past participle: `enabled`,
  `open`, `truncated`, `active`, `collapsed`, `connected`, `cancelled` — 1169
  of 1483 boolean fields. Do not prefix stored state with `is` to make it look
  boolean.
- `is`/`has`/`can`/`should` belong on *derived* answers rather than stored
  state (174 fields, and the majority of boolean-returning functions).
- A function returning `boolean` is named as a proposition the caller reads as
  a question — `isSensitivePath`, `hasApiKey`, `grantCovers`,
  `pathEntryExists`, `vendorSupportsLengthContinuation`. Subject-first is fine;
  imperative is not. 375 functions declare a `boolean` return.
- A boolean-returning function named as a command leaves the caller unable to
  tell whether `true` means "it is so" or "I did it". Name it for the question
  or return a result object.
- An option is named for what it turns *on*: `allowPrivateNetworks`,
  `includeUnscoped`, `enableThinking`. A `disableX` flag double-negates at
  every call site.

### Async

- Async functions carry no suffix — 502 `async function` declarations, none
  named `*Async`. The return type already says it. The suffix is earned only by
  a binding that disambiguates a same-named synchronous API: of the eight
  `*Async` names in `src/`, `statAsync` (`stat as statAsync`) and
  `execFileAsync` (`promisify(execFile)`) do that and the other six are listed
  under `Known naming divergences`.
- `*Sync` is reserved for the synchronous sibling of an operation that is
  otherwise async, matching the `node:fs` convention (`ensureDir` /
  `ensureDirSync`). A `*Sync` name with no async sibling carries no
  information — drop the suffix.

### Events and handlers

- A callback slot — a prop, an option field, a subscription argument — is
  `on<Event>`: `onError`, `onProgress`, `onToolStart`. It names the event, not
  the reaction: `onPluginsChanged`, never `onRefreshList`.
- The local function supplied to that slot is `handle<Event>` (161
  declarations). The pair is what makes direction readable at the call site.
- Bus event ids are `<pluginId>.<noun>.<pastTenseVerb>`, lowercase and
  dot-separated: `calendar.event.created`, `host.theme.changed`,
  `email.invite.detected`.
- IPC channels are `lvis:<domain>:<action>` with kebab-case segments (259 of
  266).
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
  classes extending `Error`. The suffix is what lets a `catch` read as a
  sentence.
- Stable IPC error codes are kebab-case. What the renderer must then do with
  a code is an invariant, not a naming rule — see `Architecture and security
  invariants`.
- Audit `type` keys are `snake_case`: `tool_call`, `mcp_apikey_set`,
  `kill_switch`, `sandbox_gate` — 11 of 12.
- An audit key is a persisted value, not just an identifier. Changing one is a
  log migration that strands historical rows, so treat shipped keys as frozen
  and add rather than rename.

### Test doubles

- No *file* outside a test directory is named for being a double. All four
  double-prefixed filenames in the tree live under `__tests__/` or `test/`.
- Three *identifiers* spelled `Mock*` do live in production paths, and they are
  the whole of it — 44 lines across six files, all reachable by the queries
  below. Two of the three are legitimate and one is not:
  - `MockMarketplaceFetcher` (`src/plugins/marketplace.ts`) is a backend kind,
    the same axis as `CloudMarketplaceFetcher`: it serves the catalog from a
    local file for development, and a packaged build throws rather than
    construct it. The word names what the fetcher reads, not a test seam.
  - `MockShell` (`web/components/landing/workday.tsx`, 33 lines) is a
    mock-*up* frame on the marketing page, sibling of `mockup-frame.tsx`. A
    different word that shares four letters.
  - `MockCloudIndexAdapter` (`src/main/cloud-index-adapter.ts`) is the one
    that really is named for what it is not: it is the only implementation of
    `CloudIndexAdapter`, constructed unconditionally at boot, and it returns
    no hits. It is listed under `Known naming divergences` to be renamed for
    the behavior it has.
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
  deliberately ships is a `Why <prefix>:` header in the first 30 lines; no file
  in this tree carries one.
- Both checks are reproducible (with a PCRE-capable grep — GNU grep, not the
  BSD grep macOS ships):

      # the 44 production-path lines the identifier rule is about
      git ls-files | grep -E '\.(ts|tsx|py|js|mjs|cjs|md)$' \
        | grep -Ev '^(docs/blueprints/|docs/ko/|\.github/|.*/__tests__/|.*/__mocks__/|test/|tests/|.*\.test\.|.*\.spec\.)' \
        | xargs grep -nP '\b[Mm]ock[A-Z]|\b[Ff]ake[A-Z]'

      # the domain vocabulary the identifier rule deliberately spares
      git ls-files 'src/**' | grep -E '\.(ts|tsx)$' \
        | grep -Ev '(__tests__/|__mocks__/|\.test\.|\.spec\.)' \
        | xargs grep -hoE '\breal[A-Z][A-Za-z0-9]*|\bstub[A-Z][A-Za-z0-9]*' \
        | sort | uniq -c | sort -rn

### Domain labels versus process labels

Applied to any numbered or lettered label, the question is: **can a reader
resolve this label from a document the repository ships?**

- Yes — it is a domain label and it stays. `Layer 0`–`Layer 8` (permission
  policy design, 189 uses), `Tier A`–`Tier D` and `Tier 1`–`Tier 4` (plugin
  permission tiers), `§4.5` architecture anchors (632), `#811` issue anchors
  (855).
- No — it resolves only against a work plan, a review round, or PR history, so
  it is a process label and does not enter an identifier, filename, comment,
  audit key, or shipped document: `H2`, `Phase 2b`, `PR-A4`, `Wave F`,
  `Sprint 3-C`, `R-2`, `§M9`, `round3`, `pr1114`. Measured over every file the
  gate scans, exactly one such line survives outside this document — a
  review-round list in `.omc/plans/open-questions.md`, a planning artifact
  rather than shipped code. Source and shipped docs are clean.
- A `-v2` suffix is a process label unless the earlier version is a live
  sibling in the same directory. If `foo-v2.ts` exists and `foo.ts` does not,
  the suffix records when the file was written, not what it is.
- Commit messages, PR bodies, and issues are outside this rule and are the
  right place for schedule coordinates.
- The gate is `.github/scripts/naming-gate.sh`, run on every PR by
  `.github/workflows/naming-gate.yml`. It blocks new process labels in the PR
  diff, and it is narrower than the prose above in four ways that are the
  gate's design, not gaps to be relied on:
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
  Prose and gate are kept honest by `.github/scripts/naming-gate-selftest.sh`,
  which runs in the same workflow and pins each of those behaviors to a
  synthetic diff. Change one, change the other.

### Known naming divergences

Backlog, not permission. Each is the minority side of a rule above; fix
opportunistically when already editing the file, and do not cite any of them as
precedent.

- `src/ui/renderer/contexts/i18n-settings-provider.tsx` exports exactly one
  component, `I18nSettingsProvider`, under a kebab-case name.
- `src/ui/renderer/components/permissions/PermissionDecisionCard.tsx` is
  `PascalCase` but exports a set of helpers with no `PermissionDecisionCard` in
  it. Three modules import it for those helpers.
- Two remaining `export default` sites: `SlashPickerPanel.tsx`,
  `CommandPopoverPanel.tsx`.
- Three spellings of the test-seam suffix: `ForTest` (36), `ForTests` (28),
  `ForTesting` (19).
- Seven camelCase IPC channel leaves against 259 kebab: `lvis:attach:openFile`,
  `openExternal`, `readImage`, `saveClipboardImage`, `discardClipboardImage`,
  and `lvis:dev:getPreflightStatus`, `setPreflightOverride`. These strings
  cross the preload boundary, so renaming is a coordinated change.
- `ManifestIntegrityViolation` is the only error class without the `Error`
  suffix.
- The audit `type` value `diagnostics-export` is kebab among eleven
  `snake_case` siblings. It is a persisted key, so this is a log migration
  rather than a rename.
- Nine `*Sync` functions have no async sibling, so the suffix carries nothing:
  `copyOpenFileSync`, `findLastCompleteJsonlBoundarySync`,
  `publishOpenFileArchiveSync`, `readFrontmatterSync`,
  `readLastCompleteLineSync`, `readLastNonEmptyLineSync`,
  `writeUtf8FileAtomicSync`, `fsyncDirectorySync` (`src/audit/audit-logger.ts`),
  and `readPersistedAppModeSync` (`src/main/persisted-app-mode.ts`). The last
  two are the sharpest cases: each has a same-named sibling that is itself
  synchronous, so the suffix distinguishes nothing at all.
- Six `*Async` names have no synchronous counterpart to disambiguate from:
  `installWindowsSandboxAsync`, `checkDependenciesAsync`,
  `checkWindowsSandboxStatusAsync`, `checkWindowsDependenciesAsync`,
  `getCompressedDataAsync`, and `attemptAsync`
  (`src/boot/assemble-services.ts`). Of the eight `*Async` names in `src/`,
  only `statAsync` and `execFileAsync` earn the suffix.
- `managedPreStartSync` (`src/boot.ts`) is a local `const` holding a promise
  that the next line awaits — the suffix says the opposite of what the binding
  is.
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
  implementation of `CloudIndexAdapter` and is constructed unconditionally at
  boot, so the name promises a double that does not exist. Rename it for what
  it does — it reports unavailable and returns no hits — rather than for what
  it is not. The gate allow-lists it meanwhile so the rename is not blocked by
  its own edits, and that entry comes out with the rename.

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
