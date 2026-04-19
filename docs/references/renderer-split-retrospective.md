# Renderer Split Retrospective — Phase 1 ~ 4.6

> **Status**: ✅ Complete (2026-04-17 → 2026-04-18)
> **Scope**: `src/renderer.tsx` 2911-line monolith → 13-line entry + composed `src/ui/renderer/` tree.
> **Related**: architecture.md §4.6 Source Tree Layout; TODO.md §31.

---

## 1. Why the split happened

Pre-split `src/renderer.tsx` had accumulated **2911 lines** covering:
- Settings orchestration (7 vendors × per-key reducer state)
- Chat stream state + tool-use transcripts + edit-resend / retry / cancel
- Briefing card lifecycle (dismiss, snooze, settings toggle)
- Approval dialog queue + permission rule editor
- Task list view, starred messages, session loader, search overlay
- Cost preview, context budget HUD, usage dashboard, sparklines
- Plugin install/uninstall dialogs, HTML preview sandbox, role presets

Risks that forced the split:
1. **Impossible review** — PRs touching the monolith produced 500-line diffs where real logic changes hid inside formatting churn.
2. **Stale closure bugs** — re-entrancy and unmount guards were repeatedly re-introduced because patterns were not factored.
3. **Test coverage gap** — exactly 7 smoke tests existed for a file driving the entire chat experience.
4. **Ownership fragmentation** — every feature sprint ended up editing the same file; merge conflicts were the default, not the exception.

---

## 2. Phases and line trajectory

| Phase | PR | Commit | Outcome |
|---|---|---|---|
| **1** — test infra | #82 | `092cdf7` | RTL + jsdom + App smoke tests land; safety net jumps from 7 → 15 |
| **2** — extract standalones | #83 | `b31620b` | `types.ts`, `constants.ts`, `utils/*`, pure components leave the monolith |
| **2.5** — integration tests | #85 | `8e1b731` | edit-resend · retry · stream · briefing · star · redact; net = 29 tests |
| **3.1** — use-settings | #84 | `534ffb1` | Settings reducer → hook |
| **3.2** — use-chat-state | #86 | `b3510a6` | Chat stream + history merging → hook |
| **3.3** — use-briefing | #90 | `c85c326` | Briefing lifecycle → hook |
| **3.4** — use-approval | #91 | `42fd5f3` | Approval queue consumer → hook |
| **3.5** — use-search | #92 | `9081a01` | Search overlay → hook |
| **4** — App decomposition | #94 | `7664a57` | `ChatView` / `Sidebar` / `SettingsDialog` extracted from `App.tsx` |
| **4.6** — entry shrink | #95 | `21279c9` | `App.tsx` < 300 (later 414 after follow-ups); `TaskView` / `StarredView` / `MainToolbar` / `dialogs/*` out |
| **Hardening** | #97 · #98 | `2bf01f2` · `9b148a9` | unmount guards · re-entrancy · IPC result-shape · CSP · architect follow-ups; extracts `use-sessions`, `use-starred`, `use-cost-estimate`, `use-context-budget`, `composeOutgoing` |
| **Follow-ups** | #105 · #106 · #107 | — | OpenAI reasoning temperature drop · `process.env` guard · ReasoningCard auto-collapse |

Final tree:
```
src/
  renderer.tsx (13 lines — entry)
  ui/renderer/
    App.tsx (414)
    ChatView.tsx (347) · Sidebar.tsx (53) · SettingsDialog.tsx (522) · MainToolbar.tsx (120)
    types.ts (208) · constants.ts (85) · api-client.ts (16)
    hooks/         # 9 domain hooks
    components/    # 12 extracted components
    dialogs/       # 3 dialogs
    tabs/          # 2 settings tabs
    utils/         # 4 utility modules
```

Safety net: **7 smoke → 38 tests** (RTL + integration coverage).

---

## 3. Architectural patterns adopted

Patterns that emerged during the split and are now baseline for all renderer work:

1. **`aliveRef` unmount guard** — every `async` subscriber / timer checks `aliveRef.current` before calling `setState`. Prevents the "state update on unmounted component" class of bugs that the monolith continuously re-introduced.

2. **`inFlightRef` re-entrancy guard** — any handler that may be triggered while already running (retry, edit-resend, stream-cancel) short-circuits via `inFlightRef.current`. Caught by PR #97 review.

3. **Discriminated union IPC results** — all `window.lvis.*` IPC handlers return `{ ok: true; value } | { ok: false; error }` instead of throwing or returning `any`. Forces exhaustive handling in the hook layer.

4. **CSP-strict `HtmlPreview`** — sandboxed iframe + explicit `sandbox` attribute + no `javascript:` URLs. Reviewed by security-reviewer, landed in PR #97 round 2.

5. **`sessionStorage` over `localStorage`** (§5.1) — plugin admin key and similar credentials persisted only for the window lifetime. Mirrors marketplace web UI decision.

6. **Functional `setState` + `useRef` combo** — whenever a hook crosses async boundaries it reads the latest state via `useRef` to avoid stale closures, then writes via functional `setState` so React's reconciliation stays correct.

7. **`composeOutgoing` util** — the 300-line inline "build outgoing message" block became a pure function with its own tests; hook logic no longer mixes formatting with IPC dispatch.

---

## 4. Remaining debt (Sprint X-B candidates)

- `SettingsDialog.tsx` (522) — still the largest file; break into per-tab files (LLM / Permissions / Plugins / Roles).
- `App.tsx` (414) — composition root could shrink further if context providers are grouped.
- Additional hook extraction: settings orchestration across tabs, tool-stream pump, notification dispatch.
- Renderer E2E physical click-through (Playwright-electron) — the one layer the 38-test safety net does not cover.
- `MainToolbar.tsx` (120) + `Sidebar.tsx` (53) — small, but their prop surfaces are wide; could be narrowed via context.

---

## 5. Lessons learned

1. **Safety net first, extraction second.** Phase 1 exclusively added tests before touching a single line of production code. Every subsequent extraction ran against those tests; regressions surfaced the same day they were introduced.

2. **Hooks extract cleaner than components.** Splitting state first (use-settings → use-chat-state → …) made component extraction nearly mechanical. The reverse order would have forced prop-drilling marathons.

3. **Architect + security review catches integration failures unit tests miss.** PR #97 / #98 architect follow-ups found the aliveRef + re-entrancy bugs; unit tests had been passing with the bugs present because they never simulated unmount-during-stream.

4. **13-line entry is the goal, not a milestone.** Keeping `src/renderer.tsx` trivially small enforces that *any* future change has to land in a proper module. This is the main architectural deterrent against re-growing the monolith.

5. **Patterns must be documented to propagate.** `aliveRef` / `inFlightRef` / discriminated-union IPC were re-discovered multiple times during the split. They are now captured here so the next sprint doesn't re-derive them.

6. **Line-count is a trailing indicator, not a target.** The useful metric was "how many domains touch the same file"; the line count collapsed naturally once domains were separated.
