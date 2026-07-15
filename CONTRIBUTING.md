# Contributing to LVIS

Thanks for your interest. LVIS is an Electron-based personal AI assistant
desktop app. Contributions of all sizes are welcome — bug reports, small
fixes, new plugins, architecture proposals.

## Language

Contributions are welcome in any language. Issues, pull request descriptions,
review comments, design notes, and questions do not need to be written in
English or Korean to be accepted.

Use the language that lets you explain the problem clearly. Maintainers may add
short translations or ask follow-up questions when shared context is needed, but
language should not be a barrier to participation.

## Development setup

```bash
# Prerequisites: Node.js >= 22.4 and bun (https://bun.sh)
git clone https://github.com/lvis-project/lvis-app.git
cd lvis-app
bun install            # runs electron-rebuild + uv binary fetch
bun run build          # TypeScript + esbuild renderer + Tailwind
bun run start          # build + Electron launch
```

Standalone Node.js is required even though `bun` is the script runner —
Electron's embedded Node is not on `PATH`, and the `postinstall` +
`scripts/run-electron.mjs` invoke the system `node` binary directly.

## Testing

```bash
bun run test:vitest -- run path/to/affected.test.ts  # targeted tests while iterating
bunx playwright test path/to/flow.spec.ts # changed UI flow only
```

The Vitest wrapper runs through Electron's Node mode so tests and the desktop
runtime use the same native-module ABI. Do not rebuild `better-sqlite3` for
standalone Node in place; that would replace the binary used by Electron.
Direct `bunx vitest` and `bun test` invocations fail fast by design; use the
canonical wrapper command above for both full and targeted tests.

Use the smallest affected checks while iterating. For code-bearing changes and
runtime, instruction, workflow, or sensitive-contract Markdown, the pre-push
hook is the sole local full gate: it runs `bun run typecheck`, the full
`bun run test`, and `bun run build` once. Only Markdown accepted by the
hook's explicit review-only Markdown allowlist may skip those expensive gates; a `.md`
suffix alone does not qualify. Do not duplicate the full trio around a
successful push. If a check fails, fix it and rerun only the failed or
invalidated checks before pushing again. Full Playwright E2E runs in CI/release
validation; UI changes require the targeted local flow check above. Never
bypass hooks with `--no-verify` or a hook-skip environment variable.

## Architecture

Read `docs/architecture/architecture.md` (v4 Final) before making non-trivial
changes. The host app is plugin-agnostic — all plugin integration flows
through the `HostApi` interface declared in `src/plugins/types.ts`. Adding
plugin-specific code to the host is not accepted.

Key sections:
- §4.2 — Boot sequence (8 steps)
- §4.5 — Conversation query loop (11-step message lifecycle)
- §5 — Memory system (`~/.lvis/` file-based)
- §6 — Core engines (keyword, route, tool registry, permissions)
- §9 — Plugin system (manifest, UI slots, MCP protocol)

Plugin development guide: `docs/guides/plugin-development.md`.

## Branch + PR conventions

- Branch from `main`. Branch names: `feat/<scope>`, `fix/<scope>`,
  `chore/<scope>`, `docs/<scope>`.
- One logical change per PR. Merge with `gh pr merge --merge`; do not squash.
- PR description should explain *why* (motivation) more than *what*
  (the diff already shows what).
- All PRs go through automated CI (typecheck + vitest + lint).
- UI changes require a Playwright e2e check before merge.

## Code style

- TypeScript strict mode. No `any` unless explicitly justified.
- Prefer named exports. No default exports for app code.
- No comments explaining *what* the code does; comments only for *why*
  (hidden constraint, subtle invariant, workaround for a specific
  upstream issue). Well-named identifiers self-document the what.
- Follow the surrounding file's import order and style. The codebase has
  no formal linter rule for ordering — match the neighbors.

## Reporting bugs

Open an issue with:
- LVIS version (`Help → About`)
- OS + version (macOS / Windows / Linux)
- Steps to reproduce
- Expected vs actual behavior
- Logs from `~/.lvis/audit/` if relevant (redact sensitive data)

## Security vulnerabilities

Do **not** open a public issue for security-sensitive reports. See
[SECURITY.md](./SECURITY.md) for the private disclosure channel.

## Code of conduct

By participating, you agree to abide by the
[Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree your contributions will be licensed under the
project's [MIT License](./LICENSE).
