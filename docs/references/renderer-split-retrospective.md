# Renderer Split Retrospective — Phase 1 through 4.6

Cross-reference: [`docs/architecture/architecture.md` §4.6](../architecture/architecture.md) — canonical source-tree layout.

## Why the split happened

Pre-split, `src/renderer.tsx` was a monolithic React entry file that absorbed every
concern the UI grew over time: settings, chat state, briefing, approval flow, session
management, plugin marketplace, role presets, search, cost estimation, and a long list
of inline components and dialogs. The file crossed the threshold where changes in one
domain regularly broke another, tests had no seams to hang on to, and diff review was
dominated by "where does this live again?" spelunking rather than logic. The goal was
not a line-count target — it was restoring **single-responsibility seams** so that
feature work stops reaching across unrelated concerns.

## Phase-by-phase summary

| Phase | Scope | PR |
| --- | --- | --- |
| 1 | Test infrastructure — React Testing Library + jsdom + App smoke tests | #82 |
| 2 | Extract `types.ts`, `constants.ts`, `utils/`, and standalone presentational components | #83 |
| 2.5 | Integration tests: edit-resend, retry, stream, briefing, star, redact | #85 |
| 3.1 | Extract `use-settings` hook | #84 |
| 3.2 | Extract `use-chat-state` hook | #86 |
| 3.3 | Extract `use-briefing` hook | #90 |
| 3.4 | Extract `use-approval` hook | #91 |
| 3.5 | Extract `use-search` hook | #92 |
| 4 | App decomposition + entry file shrink (`renderer.tsx` becomes a minimal mount) | #94 |
| 4.6 | `App.tsx` composition — TaskView / StarredView / MainToolbar / dialogs split | #95 |
| Hardening | Unmount guards, re-entrancy protection, IPC result-shape fix, HtmlPreview label | #97 |
| Follow-up | Domain hooks extraction + `compose` util (architect review) | #98 |
| Fix | Guard `process.env` reference that threw on every stream event | #106 |
| Final debt | `setEntries` encapsulation, `ChatContext`, `CommandPaletteDialog`, App composition root trimmed to a clean size | #111 |

## Safety net evolution

The split was deliberately **test-first**. Phase 1 stood up the test harness before any
code moved. Phase 2.5 added integration coverage for the high-risk flows (edit-resend,
retry, stream, briefing, star, redact) so subsequent hook extractions had a
regression net. By the end of Phase 4.6 / #111 the renderer suite carries 43 tests
spanning smoke, integration, and targeted unit tests for hooks and utilities. Every
phase landed with green tests — no phase merged on "TODO: tests later."

## Architectural patterns adopted

- **`aliveRef` for async lifecycle safety.** Long-running streams and IPC callbacks
  check a `aliveRef` before touching React state, eliminating the "setState after
  unmount" class of bug that was latent in the monolith.
- **`inFlightRef` for re-entrancy protection.** Submit / retry / edit-resend paths
  guard against overlapping invocations so rapid user interaction cannot produce two
  concurrent streams writing to the same entry.
- **Discriminated-union IPC result shapes.** IPC boundaries return
  `{ ok: true, value } | { ok: false, error }` rather than loose objects — callers
  exhaustively narrow, and the TypeScript compiler catches unhandled branches at the
  renderer edge.
- **CSP-scoped `HtmlPreview`.** The HTML preview component renders untrusted tool
  output inside a sandboxed iframe with a strict Content-Security-Policy, so tool
  results cannot reach the host DOM, cookies, or IPC bridge.
- **`useMemo` for Context values.** `ChatContext` and other providers memoize their
  value object so consumer subtrees do not re-render on every parent render.
- **`ChatContext` instead of prop drilling.** The ChatView subtree (messages list,
  composer, toolbar, search overlay) reads shared state from `ChatContext`, keeping
  component signatures narrow and avoiding 8-deep prop chains.
- **Domain hooks as the state contract.** Each of the 12 domain hooks owns its slice
  of state + side-effects (settings, chat-state, briefing, approval, search,
  context-budget, cost-estimate, sessions, starred, plugin-marketplace, role-presets,
  app-bootstrap, indexed-docs, marketplace-updates). `App.tsx` composes them; it does
  not itself manage domain state.
- **`renderer.tsx` as a minimal entry.** The top-level entry simply mounts
  `ui/renderer/App.tsx`. All composition lives in the renderer tree, not at the
  bootstrap boundary.

## Remaining debt

None tracked against the renderer split after #111. The composition root is clean,
domain hooks are the state contract, tests cover the high-risk flows, and the entry
file is a minimal mount. Future renderer work should extend the existing seams rather
than re-introduce cross-cutting state in `App.tsx` or `renderer.tsx`.

## Lessons learned

1. **Tests first, then seams.** Phase 1 (test infra) before any code movement was
   non-negotiable in hindsight — every later phase leaned on that harness to move
   fast without breakage.
2. **Extract hooks before components.** State was the real coupling; presentational
   components were mostly already separable once the state they consumed lived in a
   named hook.
3. **Don't chase line counts, chase responsibilities.** Earlier drafts of this doc
   carried hard-coded line counts; they kept drifting against reality. The useful
   invariants are "minimal entry," "composition root," "one hook per domain" — not
   numbers.
4. **A `Context` is not prop drilling's only alternative, but it is the right one
   when a subtree shares a coherent domain.** `ChatContext` landed late (#111)
   because earlier phases proved the ChatView subtree really did share one domain.
5. **Architect review catches what phased PRs miss.** The #98 follow-up and #111
   final-debt pass each caught cross-phase smells (duplicated state shapes,
   unencapsulated setters, dialog ownership) that no single phase PR would have
   flagged on its own.
6. **Hardening lands in the same era as the split.** #97 and #106 fixed real bugs
   (unmount leaks, re-entrancy, `process.env` reference in renderer) that only
   became visible once the seams were clean enough to see them.
