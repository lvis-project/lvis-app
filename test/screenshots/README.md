# Screenshot capture harness

Automated Playwright-driven capture of the Electron app screens used by the
docs site (`lvisai.xyz/lib/screenshots.ts`, 71 keys total). Captures the
Electron **host app** screens only — see "Out of scope" below for the rest.

## Why a separate config

This harness lives entirely under `test/screenshots/**` (plus the standalone
runner `scripts/capture-screenshots.mjs`) and does **not** modify the
repo-root `playwright.config.ts` or the `test/e2e/**` UI E2E suite it sits
next to. It has its own `test/screenshots/playwright.config.ts` so it never
runs as part of `bun run test:ui-e2e` / CI's `ui-e2e.yml` — this is a docs
asset generator, not a regression suite.

It does, however, **import and reuse** helpers from `test/e2e/ui/seeded-electron.ts`
(`buildE2eBaseSettings`, `buildE2eSecrets`, `buildIsolatedElectronEnv`) so the
settings-seeding shape stays in lockstep with the E2E suite instead of
drifting via a second hand-maintained copy.

## Running

```bash
# from the worktree root — builds the app, then runs the full matrix
node scripts/capture-screenshots.mjs

# only re-run one or a few keys (Playwright --grep passthrough)
node scripts/capture-screenshots.mjs --grep chat-app-update

# skip the rebuild step if dist/src/main/main.js is already fresh
node scripts/capture-screenshots.mjs --skip-build
```

Output lands in `test/screenshots/out/<key>.png` (gitignored via
`test/screenshots/.gitignore` — these are generated artifacts, not source).

You can also invoke Playwright directly:

```bash
bunx playwright test --config test/screenshots/playwright.config.ts
bunx playwright test --config test/screenshots/playwright.config.ts --grep chat-app-update
```

### Environment variables

| Var | Purpose | Default |
|---|---|---|
| `LVIS_DEMO_ACTIVATION_CODE` | Passed through to the Electron launch env for scenarios that need a demo-gated vendor login. **Never hardcode a real code here or in the harness** — export it in your shell before running if a scenario you add needs it. | unset |

No scenario in the current matrix actually requires this (the matrix's
capturable entries only need a seeded LLM API key, which the harness already
seeds via `buildE2eSecrets()` — the same "plain:sk-e2e-\<vendor\>" placeholder
key the E2E suite uses, not a real key).

## How keys map

`test/screenshots/matrix.ts` exports `scenarios: Record<string, ScenarioEntry>`,
keyed by the exact same string keys as `shots` in
`lvisai.xyz/lib/screenshots.ts`. `test/screenshots/capture.spec.ts` generates
one Playwright test per entry (`capture: <key>`), so:

- `bunx playwright test --config test/screenshots/playwright.config.ts --grep local-indexer-home`
  re-runs (or, today, skip-reports) exactly one key.
- Adding a new docs-site key means adding one matrix entry — no spec-file
  editing required.

Each entry is one of:

- **Capturable** — `steps(ctx)` navigates/seeds state, optional `locator`
  scopes the capture to one element (omit for a full-window shot).
- **Skipped** — `skip: "<reason>"`. Surfaces as Playwright's native "skipped"
  status in the report (not silently dropped from the run).

## Window size

Fixed at **1600x1000** (`CAPTURE_VIEWPORT` in `fixtures.ts`). This was *not*
picked to match any single existing screenshot — inspecting a sample of
`lvisai.xyz/public/screenshots/*.png` showed **inconsistent aspect ratios**
per file (e.g. `chat-todo-queue.png` is 1600x830 ≈1.93:1, `chat-plugin-panel.png`
is 484x889 ≈0.54:1, `ah-dashboard.png` is 1130x325 ≈3.48:1) — each existing
asset was clearly cropped to its own target element/region after capture, not
captured at one fixed app window size. 1600x1000 is wide enough to show the
expanded work-mode rail + full chat column without clipping, and gives full
per-key crops (`locator`-scoped captures) plenty of source resolution.

Animations/transitions are globally killed via `page.addStyleTag` in the
`mainWindow` fixture (`transition-duration:0ms`, `animation-duration:0ms`,
`caret-color:transparent`) for deterministic frames.

## Skip list

### App screens the harness cannot yet seed (marked `skip` in matrix.ts)

| Key(s) | Reason |
|---|---|
| `chat-todo-queue`, `chat-tool-thinking`, `chat-permission-llm-review`, `chat-permission-directory`, `chat-permission-risk`, `chat-question-card` | Require an **in-flight LLM turn** (tool calls, reviewer deferrals, thinking-token streaming, ask-user cards). No deterministic mock-provider turn exists in this repo today — would need a scripted fake-provider fixture. |
| `chat-plugin-panel`, `plugin-permission-grant`, `local-indexer-*` (7 keys), `meeting-*` (6 keys), `meeting-outlook-mail*` (2 keys), `outlook-login-trigger`, `agent-hub-my-work`, `agent-hub-team-board`, `work-assistant-*` (6 keys) | **Plugin UI screens.** The shared E2E plugin seeder (`test/e2e/ui/fixtures.ts` `seedRepositoryPlugins`) stubs a plugin's UI with inert placeholder text (`"E2E Plugin UI"`) — it exists to test host-side plugin lifecycle wiring, not to render real plugin screens. Capturing it would produce a **misleading** screenshot, not a real one. Real capture needs the actual plugin repo's built UI bundle side-loaded (e.g. `lvis-plugin-local-indexer`, `lvis-plugin-meeting`, `lvis-plugin-work-assistant`, `lvis-plugin-agent-hub`), which is out of this harness's scope. |
| `outlook-login-window`, `outlook-login-after`, `outlook-logout` | Live Microsoft OAuth popup / session — cannot be seeded deterministically or without real credentials, and doing so would require live network access this harness should not depend on. |
| `meeting-record-stt` | Requires a real STT audio pipeline streaming chunks — explicitly called out in the task as infeasible to seed. |

That is **35 of the 36 app-scoped docs-site keys skipped today**, all for the
two structural reasons above (needs a live LLM turn, or needs a real plugin
UI bundle) — not because the harness is incomplete, but because those states
are genuinely not reproducible without additional fixtures this pass does
not build (a fake LLM provider harness, and/or vendored plugin UI bundles).

### Capturable today

| Key | Notes |
|---|---|
| `chat-app-update` | Seeded via the real `lvis:update:state` IPC channel (`app.evaluate` → `webContents.send`), matching the shape in `src/shared/update-state.ts`. Captures the `[data-testid="app-update-badge-available"]` element. |
| `_smoke-settings-llm` (not a docs key — smoke-only) | Opens the native settings window via `window.lvisApi.openSettingsWindow('llm')` and captures the whole settings window. Proves the settings surface renders; not part of the 71-key docs catalog. |

That leaves the matrix at **1 of 36 real docs-site keys + 1 smoke-only
settings capture** genuinely capturable end-to-end today. The honest count
matters more than a high number here — the gap closes with a fake-provider
turn fixture (unlocks the 6 in-flight-LLM-turn keys) and vendored plugin UI
bundles (unlocks the 25 plugin-UI keys), neither of which this pass builds.

### Out of scope: web/server keys

`mp-*` (marketplace), `ah-dashboard`/`ah-workboard`/`ah-worklog`/`ah-inbox`/
`ah-report`/`ah-subscription` (Agent Hub **server** dashboard — distinct from
the `agent-hub-my-work`/`agent-hub-team-board` **plugin** panel keys, which
render inside this Electron app), and `ep-*` (LGE internal EP portal) are
**web/server screens** rendered by a separate Next.js app, not the Electron
host. They are intentionally absent from `matrix.ts`'s `scenarios` map
entirely (listed separately in `WEB_SERVER_KEYS_OUT_OF_SCOPE` for
completeness) — this harness has no way to launch or seed that app, and doing
so was explicitly out of scope for this task.

## Re-running after theme changes

Another workstream on this branch (`feat/ui-depth-tokens`) is actively
changing `src/styles.css` / theme bundles / shadcn primitives while this
harness was built. This harness intentionally does not touch any of those
files — re-run the full matrix after that work lands to get pixel-accurate
captures against the final theme; today's run only proves the pipeline
(launch → seed → navigate → capture → write file) works end-to-end.
