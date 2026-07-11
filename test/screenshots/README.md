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

## Real plugin UIs (side-loaded)

`plugin-seed.ts` side-loads the **real** built UI bundles of the sibling plugin
repos (`../lvis-plugin-<id>/dist/`) into the isolated `~/.lvis/plugins/` so a
scenario captures the plugin's *actual* panel — not the inert `"E2E Plugin UI"`
stub the shared E2E seeder (`test/e2e/ui/fixtures.ts`) writes for lifecycle
tests. A scenario declares its needs with `plugins: ['<manifest-id>']` in
`matrix.ts`; the fixture copies that plugin's `dist/` tree, writes the registry
+ install receipt + a signed marketplace-whitelist snapshot (for any declared
`hostSecrets.read`), and the host loads it as a **local-dev** install (unlocked
by `LVIS_DEV=1` + the unpackaged build).

Two harness-only details make the panels actually render:

- **`python` field stripped** from the seeded manifest (same as the E2E seeder's
  `delete base.python`) so a plugin that declares host-managed Python does not
  block lifecycle start on a missing lockfile.
- **Reviewer disabled** (`permissions.reviewer.mode: "disabled"` in the
  `LVIS_HOME/settings.json`, with the `disabledMigratedAt` marker so it is not
  migrated back to `strict`). A plugin panel calls its read-category tools on
  mount; with the placeholder LLM key the default `mode:"llm"` reviewer errors
  and defers those to the "Approve Tool Execution" modal, which would cover the
  panel. `plugin-permission-grant` opts *back in* (`keepReviewer: true`) because
  that modal IS its capture target.

Navigation to a panel goes through the current app path (Ctrl/Cmd+K command
popover → `plugin` category → the plugin's row), since #1311 removed the
standalone plugin-grid button. In **work mode** (the harness default) the panel
opens inline, so it is screenshottable; the plugin's own bundle renders inside
an Electron `<webview>`.

## Skip list

### App screens the harness cannot seed (marked `skip` in matrix.ts)

| Key(s) | Reason |
|---|---|
| `chat-todo-queue`, `chat-tool-thinking`, `chat-permission-llm-review`, `chat-permission-directory`, `chat-permission-risk`, `chat-question-card` | Require an **in-flight LLM turn** (tool calls, reviewer deferrals, thinking-token streaming, ask-user cards). No deterministic mock-provider turn exists in this repo today — would need a scripted fake-provider fixture. |
| `local-indexer-*` (7 keys) | The real bundle side-loads and *loads*, but its compiled `hostPlugin` `start()` hard-throws without a provisioned Python interpreter (`pythonExecutable` unset — `PythonRuntimeBootstrapper` is not run here, and the bundle needs the kiwi/FTS5 Python worker even to expose its UI provider). The runtime tears the plugin down after the start failure, so no UI provider registers. Provisioning a real Python runtime + native deps is out of scope for a screenshot harness. |
| `meeting-minutes` (3 keys), `meeting-record`, `meeting-record-stt`, `meeting-outlook-mail*` (2 keys) | The real meeting panel loads (see `meeting-upcoming`), but the minutes tab / recorder widget live inside the plugin `<webview>` (Playwright cannot click through it) **and** need a completed STT recording / live audio / Outlook OAuth to populate — infeasible to seed. |
| `outlook-login-trigger`, `outlook-login-window`, `outlook-login-after`, `outlook-logout` | The real ms-graph bundle side-loads, but its manifest declares `auth.loginTool`, so selecting the Outlook panel goes straight to the live Microsoft OAuth window; every reachable state past that needs real credentials. |
| `work-assistant-*` (6 keys) | These are **host-rendered notification cards** (OS toast + host overlay) emitted when a detector fires, **not** plugin-panel screens. Firing a detector needs a real external signal (ms-graph / meeting events); the plugin has no dev/test trigger tool to synthesize one. The plugin's own detector-toggle *panel* is captured under `chat-plugin-panel`. |
| `agent-hub-my-work`, `agent-hub-team-board` | **No agent-hub plugin bundle exists** in this workspace — there is no `lvis-plugin-agent-hub` repo and no plugin.json declares such a ui extension. Nothing to side-load. |

### Capturable today

| Key | Notes |
|---|---|
| `chat-app-update` | Seeded via the real `lvis:update:state` IPC channel (`app.evaluate` → `webContents.send`), matching the shape in `src/shared/update-state.ts`. Captures the `[data-testid="app-update-badge-available"]` element. |
| `chat-plugin-panel` | The **real** `lvis-plugin-work-assistant` detector-toggle panel (its own bundled UI in a webview), loaded via `plugins: ['work-assistant']`. |
| `plugin-permission-grant` | The real "Approve Tool Execution" host modal fired by the meeting panel's mount-time `meeting_list_preps` read call (reviewer kept ON via `keepReviewer`). Cropped to `[data-testid="tool-approval-dialog"]`. |
| `meeting-upcoming` | The **real** `lvis-plugin-meeting` panel, default "예정 회의" (upcoming) tab, empty state (no seeded calendar events). |
| `_smoke-settings-llm` (not a docs key — smoke-only) | Opens the native settings window via `window.lvisApi.openSettingsWindow('llm')` and captures the whole settings window. |

**Current count: 4 real docs-site keys + 1 smoke-only settings capture pass
end-to-end** (up from 1 + 1). The remaining plugin-UI keys are skipped for
*substantive* reasons — a missing Python runtime, live STT/OAuth/external
signals, or a plugin bundle that does not exist — not because the harness cannot
load real plugins (it now does). Honesty over coverage inflation: a skipped key
with a precise blocker beats a misleading placeholder capture.

### Out of scope: web/server keys

`mp-*` (marketplace), `ah-dashboard`/`ah-workboard`/`ah-worklog`/`ah-inbox`/
`ah-report`/`ah-subscription` (Agent Hub **server** dashboard — distinct from
the `agent-hub-my-work`/`agent-hub-team-board` **plugin** panel keys, which
render inside this Electron app), and `ep-*` (internal EP portal) are
**web/server screens** rendered by a separate Next.js app, not the Electron
host. They are intentionally absent from `matrix.ts`'s `scenarios` map
entirely (listed separately in `WEB_SERVER_KEYS_OUT_OF_SCOPE` for
completeness) — this harness has no way to launch or seed that app, and doing
so was explicitly out of scope for this task.

## Re-running after theme changes

This branch (`feat/ui-depth-tokens`) changes `src/styles.css` / theme bundles /
shadcn primitives. This harness does not touch any of those files — it just
needs `bun run build` run first so the current theme is compiled into the
bundle before capture (the plugin-panel captures show the moonstone default).
Re-run the full matrix (`node scripts/capture-screenshots.mjs`) after any theme
change to refresh the PNGs against the final theme.
