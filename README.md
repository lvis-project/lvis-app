# lvis-app

Extensible Electron desktop agent workspace for LVIS chat, plugin workflows, local indexing, meetings, MS Graph, and managed marketplace extensions.

LVIS App brings chat, work mode, tool execution, plugins, local state, permissions, and installable extensions into one desktop host. This repository owns the Electron main/renderer/preload layers, plugin runtime, managed marketplace install flow, Python runtime bootstrap, local/cloud retrieval bridge, and OS installer packaging.

Korean documentation: [docs/ko/app-readme.md](./docs/ko/app-readme.md)

## What This Repository Owns

- Electron main, renderer, preload, and plugin-preload bundles.
- The LVIS chat UI, conversation sessions, branching, export, compaction, and inline user-question cards.
- Manifest-driven plugin runtime with dynamic loading from the local plugin registry.
- Managed marketplace install and refresh for first-party LVIS plugins.
- Host-side retrieval that fuses Local Indexer plugin BM25/vector results with cloud adapters.
- Plugin UI hosting, IPC bridging, event contracts, OS notifications, and overlay-triggered conversation proposals.
- macOS Apple Silicon, Linux, and Windows installer build scripts and GitHub Actions workflows.
- Development, smoke, E2E, packaging, i18n, test-quality, and security guard scripts.

## Core Capabilities

### Desktop Agent Workspace

LVIS is designed as a reliable desktop environment where chat, work mode, tools, plugins, settings, and local status can coexist without visual noise. The UI makes model state, tool calls, plugin activity, file effects, approvals, indexing, and permissions visible enough for repeated daily work.

### Plugin Runtime

Installed plugins live under `~/.lvis/plugins/<id>/plugin.json`, and `~/.lvis/plugins/registry.json` controls the active plugin set. The app no longer relies on an in-tree `plugins/installed/...` layout.

Plugins expose a host entry, methods such as `index_scan` or `meeting_start`, optional UI modules, declared capabilities, emitted events, subscriptions, and notification events. The main app does not import plugin implementations directly; `PluginRuntime` reads manifests, dynamically loads plugin host entries, manages lifecycle, and bridges IPC calls into plugin methods.

Current managed plugin families include:

- `@lvis/plugin-local-indexer`
- `@lvis/plugin-meeting`
- `@lvis/plugin-ms-graph`
- `@lvis/plugin-work-assistant`
- `@lvis/plugin-agent-hub`

### Marketplace And Sideloading

Plugins can be installed through marketplace cards, `lvis://install/<slug>` deep links, or side-loaded with:

```bash
bun run cli install file://<path-to-dist.zip>
```

On boot, managed marketplace plugins are checked and refreshed by `src/boot/managed-marketplace.ts`. Stale registry entries are repaired when the manifest is missing, the plugin runtime restarts after managed changes, and renderer boot progress is emitted through `lvis:bootstrap:status`.

### Local And Cloud Retrieval

The host-side `HybridRetriever` in `src/main/hybrid-retriever.ts` fuses Local Indexer plugin BM25/vector results with cloud adapter results using reciprocal rank fusion. Document indexing and worker lifecycle remain owned by `@lvis/plugin-local-indexer`; the app owns orchestration, IPC, and chat integration.

### Overlay Trigger Surface

Plugins with the `host:overlay` capability may call `hostApi.triggerConversation()` to stage an overlay suggestion. This does not start a conversation automatically. Only after the user accepts the overlay CTA does the request enter the main chat `ConversationLoop` and the normal permission path.

- `source` must use the `overlay:<reason>` format.
- Plugin-authored prompts are sanitized so a leading `/` cannot dispatch a slash command.
- Write, shell, and network tools require user confirmation again when invoked from an overlay-trigger origin.

### Event Bus And Notifications

Proactive features communicate through the asynchronous `emitEvent` / `onEvent` event bus. Plugins declare `emittedEvents`, `subscriptions`, and `notificationEvents` in `plugin.json`; manifest validation checks capability and cross-field consistency during boot.

Plugins can request OS notifications declaratively. The host reads the manifest and registers notifications without hard-coding plugin-specific behavior.

### Chat UX

The renderer includes production chat primitives for:

- Streaming conversation turns and abort.
- Session resume, fork, branch from checkpoint, edit/resend, export, and compact.
- Inline `ask_user_question` cards with stable response routing.
- Suggested replies.
- Status bar visibility for model, mode, tool, permission, and runtime state.

Key IPC domains live under `src/ipc/domains/*.ts`. Representative channels include:

- Chat/session: `lvis:chat:send`, `lvis:chat:abort`, `lvis:chat:sessions`, `lvis:chat:session-resume`, `lvis:chat:fork`, `lvis:chat:branch-from-checkpoint`, `lvis:chat:edit-resend`, `lvis:chat:export`, `lvis:chat:compact`
- Workflow: `lvis:ask-user-question:respond`
- Meeting: `lvis:meeting:start`, `lvis:meeting:push-chunk`, `lvis:meeting:stop`, `lvis:meeting:transcript`
- Governance: `lvis:audit:search`, `lvis:dlp:stats`, `lvis:agents:list`, `lvis:agents:install`

## Tech Stack

- Electron for the desktop shell.
- React for renderer UI.
- TypeScript across app, renderer, preload, and tooling.
- webpack for renderer/preload/plugin-preload bundles.
- esbuild for main/shared TypeScript bundles.
- Tailwind CSS and product tokens for styling.
- Bun as the package manager and script runner.
- Node.js for Electron launch, postinstall scripts, and build tooling.
- Vitest, Playwright, Storybook, and custom quality gates.

## Development Requirements

- Bun.
- Node.js `>=22.4`.
- Git submodules, including `packages/plugin-sdk` (`lvis-plugin-sdk`).

Clone and install:

```bash
git clone <repo-url>
cd lvis-app
bun install
```

Although Bun is the default package manager and script runner, Electron launch and several postinstall/build scripts call the system `node` CLI directly. Electron's embedded Node runtime does not replace a local Node.js installation.

## Development Commands

```bash
# Incremental development loop
bun run dev

# Build, then launch Electron
bun run start

# Type check
bun run typecheck

# Unit tests
bun run test

# Main app flow smoke
bun run test:main-flow

# Electron binary smoke
bun run test:electron-smoke

# UI/E2E tests
bun run test:ui-e2e

# Production app build
bun run build
```

`bun run build` performs the main esbuild bundle, renderer/preload/plugin-preload webpack bundles, Tailwind CSS output, asset copy, i18n catalog validation, sunset inventory checks, TLS bypass guard, opacity token checks, color token checks, and IPC channel guard checks.

Type checking is intentionally separate. Run `bun run typecheck` before relying on a build for release readiness.

## Plugin Registry CLI

The registry CLI manages installed plugin registry entries. Installation itself is handled by marketplace cards, `lvis://install/<slug>` deep links, or `lvis-cli install file://<path-to-dist.zip>`.

```bash
bun run plugins:list
bun run plugins:add -- <plugin-id> <manifest-path>
bun run plugins:remove -- <plugin-id>
bun run plugins:enable -- <plugin-id>
bun run plugins:disable -- <plugin-id>
```

If an installed plugin provides a `ui` extension in `plugin.json`, the host can mount that UI in the app. `ui.displayName` is preferred for labels, with `title` as fallback. `kind: "embedded-module"` UI extensions are dynamically imported from plugin package assets and rendered by the LVIS host.

Plugin settings are saved only through sender-guarded IPC. Values must be plain JSON-compatible objects, arrays, or primitives; dangerous keys such as `__proto__`, `constructor`, `prototype`, and `"*"` are blocked.

## Packaging

Installer builds use `scripts/build-installers.mjs` as the single entry point. Native dependency rebuilds, signing/notarization tools, and installer formats differ by OS, so each installer should be built on its native runner.

```bash
# Current OS installer
bun run dist

# Native OS installers
bun run dist:mac
bun run dist:linux
bun run dist:win
```

Outputs are written under `release/`.

| OS | Artifacts |
| --- | --- |
| macOS Apple Silicon | `LVIS-<version>-mac-arm64.dmg`, `LVIS-<version>-mac-arm64.zip` |
| Linux | `LVIS-<version>-linux-<arch>.AppImage`, `.deb`, `.rpm` |
| Windows | `LVIS-<version>-windows-<arch>-setup.exe`, `LVIS-<version>-windows-<arch>.zip` |

Unsigned internal verification builds are opt-in:

```bash
node scripts/build-installers.mjs --current --skip-code-sign
```

The GitHub Actions Build Installers workflow creates macOS, Linux, and Windows artifacts. Use `skip_code_sign=true` only for internal unsigned validation. Production release builds require signing/notarization secrets and `skip_code_sign=false`.

macOS installer and macOS development support Apple Silicon only. Intel Mac (`darwin/x64`) is not supported and fails fast during `uv` bootstrap or installer build.

The packaged app includes the `lvis://` deep link protocol and the target-specific `uv` binary for Python bootstrap. Development `postinstall` prepares only the current platform binary under `resources/uv/<platform>-<arch>/uv`; installer builds stage the target binary under `resources/uv-runtime/` immediately before packaging.

## Windows Development Notes

`scripts/run-electron.mjs` simplifies first-run Windows development by:

- Running through the locally installed Electron CLI.
- Injecting safe GPU fallback flags unless `LVIS_KEEP_GPU=1` is set.
- Defaulting `PYTHONIOENCODING=utf-8` and `LANG/LC_ALL=en_US.UTF-8` to avoid cp949 mojibake in Korean or emoji logs.

Node.js `>=22.4` must still be installed because `scripts/run-electron.mjs` calls the system `node` CLI.

Recommended flow:

```bash
git clone <repo-url>
cd lvis-app
bun install
bun run start
```

If PowerShell output is corrupted, switch the session to UTF-8 before launching:

```powershell
chcp 65001
bun run start
```

PowerShell 5.x may also require `[Console]::OutputEncoding` updates because `chcp` alone does not refresh the cached encoding. See [docs/guides/windows-setup.md](./docs/guides/windows-setup.md).

### ASRT sandbox access denied (`CreateProcessWithLogonW`, `0x80070005`)

If `src/permissions/__tests__/asrt-sandbox.test.ts` logs a `[asrt-sandbox] Windows OS sandbox cannot spawn as \`srt-sandbox\`` warning and **skips** its live-init tests on Windows — the sandbox provisioned but `CreateProcessWithLogonW(srt-sandbox)` is `Access is denied (0x80070005)`, so it provides no OS isolation — use the following recovery sequence to enable it (the tests then run for real instead of skipping):

1. Ensure Secondary Logon is running:
   - `Get-Service seclogon`
   - `Start-Service seclogon` (or `Restart-Service seclogon`)
2. Force-refresh local policy:
   - `gpupdate /force`
3. Verify the sandbox account and group mapping:
   - `net user srt-sandbox`
   - confirm `srt-sandbox` is active and remains in `sandbox-runtime-users`
4. Re-run validation:
   - `bunx vitest run src/permissions/__tests__/asrt-sandbox.test.ts`

Known-good verification for this incident: after policy refresh, the test file passed (`46 passed`).

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `LVIS_DEV` | `1` when unpackaged | Relaxes plugin root boundary checks for development paths such as `../../../node_modules/@lvis/*`. |
| `LVIS_KEEP_GPU` | unset | Set to `1` to skip Windows GPU safe-flag injection. |
| `LVIS_EXTRA_ELECTRON_FLAGS` | unset | Appends extra Electron flags, for example `--foo --bar`. |
| `PYTHONIOENCODING` | `utf-8` on Windows dev launch | Keeps Python subprocess logs UTF-8 encoded. |
| `LANG`, `LC_ALL` | `en_US.UTF-8` on Windows dev launch | Keeps locale-sensitive subprocess output UTF-8 encoded. |

Example Local Indexer validation:

```bash
# 1) Install the Local Indexer plugin through marketplace or sideloading.
# 2) Set OPENAI_API_KEY before launch.
OPENAI_API_KEY=... bun run start
```

## Quality Gates

Use the smallest validation that proves your change, then broaden when the touched surface crosses shared contracts.

```bash
bun run typecheck
bun run test
bun run build
```

Useful targeted checks:

```bash
bun run check:i18n-catalog
bun run check:test-quality
bun run check:knip
bun run test:electron-smoke
bun run test:packaged-smoke
```

A retired historical E2E script is no longer the source of truth. Current host-side validation sources of truth are `bun run test:main-flow`, `bun run test:electron-smoke`, and `bun run build`. Related mentions in `docs/blueprints/*` are legacy implementation records.

## Documentation

- Korean app README: [docs/ko/app-readme.md](./docs/ko/app-readme.md)
- Korean documentation hub: [docs/ko/README.md](./docs/ko/README.md)
- Architecture: [docs/architecture/README.md](./docs/architecture/README.md)
- Production release checklist: [docs/references/production-release-checklist.md](./docs/references/production-release-checklist.md)
- Windows setup: [docs/guides/windows-setup.md](./docs/guides/windows-setup.md)
- Plugin development: [docs/guides/plugin-development.md](./docs/guides/plugin-development.md)
