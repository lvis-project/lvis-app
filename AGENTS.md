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

## Architecture and security invariants

- Keep core logic vendor-neutral through the `GenericMessage` abstraction.
- Preserve the three plugin namespaces without runtime conversion: manifest
  plugin ID, underscore-form LLM tool name, and literal-ID event name.
- Cross-boundary input is untrusted. Preserve sender/frame/origin checks,
  manifest allow-lists, DLP handling, audit records, and fail-closed defaults.
- Non-user-origin content must not dispatch privileged slash commands.
- Tool execution must pass the active recipient's own permission and approval
  gates; do not introduce fallback paths around them.
- New IPC handler errors and main-process throws use concise English messages.
  Stable IPC error codes use kebab-case; renderer code maps codes to localized
  user-facing text instead of exposing raw errors.
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
- UI edits start with `grep` before editing. Name app shells `*Window`, reusable
  bodies `*Content`, and modals `*Dialog`.
- Private or non-indexed assets use the marketplace API, `gh`, or local sources,
  not WebSearch. After three identical failures, change approach.
- Top-level package imports used by unbundled runtime code (main, preload, CLI,
  or worker) belong in `dependencies`, not `devDependencies`. Renderer/UI-only
  packages bundled into `dist` by webpack/esbuild may remain in
  `devDependencies`.
- Runtime dependency changes update the lockfile and run the relevant
  packaged-app smoke so missing packages cannot reach an installer.

## Cross-Cutting Review Gate

- Sensitive cross-cutting work identified by `.github/workflows/cluster-detector.yml`
  or task scope requires independent architect, critic, and security reviews.
- The PR template records architect, critic, and security verdicts, reviewed
  HEAD SHAs, and blocking findings. Each visible role row and hidden marker
  agrees on the exact current PR HEAD SHA and verdict; a `GO` row has blocking
  findings exactly `None`.
- `cluster-review-passed` is valid only when the workflow finds exactly one
  consistent current-HEAD row and marker per role. Only a fresh application of
  that label can pass the gated run.
- The required check evaluates trusted-base policy through read-only repository
  and pull-request data access and never checks out or executes pull-request
  content. Pull-request write is scoped only to invalidating the fixed
  `cluster-review-passed` label; status write is scoped only to the fixed
  `Sensitive Area Cluster Check` context on the event PR head.
- `.github/workflows/cluster-detector.yml` is the sole workflow allowed to use
  `statuses: write` or the fixed status context. Branch protection pins the
  GitHub Actions app rather than workflow identity, so peer workflows must not
  share either write surface.
- A new commit, any PR edit, base change, or reopen makes any retained label
  insufficient until all three roles review the current evidence. A missing
  label, invalid evidence, or failing workflow blocks merge. Never bypass the
  gate.

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
