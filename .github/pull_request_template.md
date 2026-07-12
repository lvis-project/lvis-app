## Summary

-

## Title Check

- Expected format: `<type>(<scope>): <summary>` (for example, `feat(marketplace): add user package install flow`).

## Scope

-

## User Impact

-

## Plugin / IPC Impact

- [ ] No plugin manifest, capability, event, notification, or registry behavior changed.
- [ ] No IPC channel, preload bridge, permission, or sender-guard behavior changed.
- [ ] Plugin/app compatibility notes are included when behavior changes.

## UI / Localization Impact

- [ ] No user-facing UI text changed.
- [ ] New or changed UI text is reflected in the i18n catalog and generated locales.
- [ ] Desktop layout was checked for the affected viewport(s).
- [ ] Screenshots, trace links, or E2E evidence are included below when UI changed.

## Validation

- [ ] Targeted checks run while iterating (commands/results below):
- [ ] Pre-push full gate passed, or the hook accepted this as allowlisted review-only Markdown with no runtime, instruction, workflow, or sensitive-contract impact:
- [ ] Targeted changed-flow Playwright check, when UI behavior changed:
- [ ] Full E2E is delegated to CI/release unless explicitly required locally:
- [ ] Installer or packaged-app smoke, when packaging behavior changed:

## UI Evidence

- Screenshots / traces / viewport notes:

## Risk / Rollback

- Risk:
- Rollback:

## Linked Work

- Issues:
- Related app/plugin/marketplace PRs:

## PR Discipline

- Title uses a conventional prefix such as `feat(scope):`, `fix(scope):`, `test(scope):`, or `docs(scope):`.
- This PR is a cohesive feature bundle rather than a small CI-churning fragment.
- Related app/server/marketplace changes are linked here when they cannot live in the same repository PR.
