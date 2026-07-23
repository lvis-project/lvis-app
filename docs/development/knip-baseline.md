# Knip Baseline

This is the reviewed dead-code baseline. It separates actionable cleanup from
runtime and packaging patterns that static analysis cannot infer, while
rejecting any new issue outside the snapshot.

## Gate

Run:

```powershell
bun run check:knip
```

The command verifies and runs the exact installed `knip@6.23.0` devDependency,
then compares normalized issues with `knip-baseline.json`. The snapshot records
issue type, file, and symbol name; source line movement does not create false
drift.

The gate fails on:

- every new file, export, type, duplicate, or dependency issue outside the
  reviewed snapshot;
- every unresolved import, unlisted dependency, or undeclared host binary —
  these issue types can never be written into the baseline;
- Knip config-load errors, version drift, malformed JSON, or an unsupported
  baseline schema.

Run the deterministic proof that a new unused file is rejected:

```powershell
bun run test:knip-gate
```

The proof uses an isolated temporary project and removes it afterward, so it
cannot race with a concurrent repository scan. Only after reviewing intentional
debt changes should a maintainer run `bun run check:knip:update`. That command
flushes a same-directory staging file and atomically replaces the snapshot, so
an interrupted update cannot truncate the reviewed baseline.

The current snapshot contains 644 accepted findings: 25 files, 235 exports,
370 types, 7 duplicate-export groups, and 7 dev dependencies. Resolved entries
do not fail the gate; the command asks maintainers to shrink the snapshot.

`vitest.config.ts` remains the runtime assertion boundary. Knip reads the pure
`vitest.analysis.config.ts` instead, so static analysis cannot bypass or trigger
the Electron-only Vitest contract. The nested `web` package is modeled as a
separate workspace. Its `next` binary is installed from `web/bun.lock`, so root
desktop workflows analyze the declarations without requiring `web/node_modules`.

## Whitelisted Runtime And Packaging Usage

- `better-sqlite3` is rebuilt in `postinstall`, staged by
  `scripts/packaged-runtime-assets.mjs`, guarded by package footprint tests, and
  kept external by `scripts/build-main-esbuild.mjs`.
- `electron-updater` is dynamically required by `src/main/auto-updater.ts` so
  tests can run without loading the native Electron updater implementation.
- `pino-pretty` is selected by `src/lib/logger.ts` as a runtime transport and
  must remain a real `node_modules` entry for Pino worker resolution.
- `@sentry/electron` is optional crash-reporting integration loaded by guarded
  dynamic `require()` in `src/main/crash-reporter.ts`.
- `electron-builder` is invoked through `bunx electron-builder` from
  `scripts/build-installers.mjs`.
- `shadcn` is retained as the registry/tooling source for the design-system
  primitives recorded in `components.json` and `docs/development/theme-system.md`.

The OS binaries in `ignoreBinaries` are host tools intentionally invoked by
platform-specific scripts/tests.

## Current Removal Candidates

Split these into separate PRs with focused regression checks before deleting:

- Files currently reported by Knip: dormant scripts, test fixtures,
  `src/plugin-ui-shell.js`, `src/shared/host-font-stack.ts`,
  `src/ui/renderer/components/LvisLogo.tsx`, and
  `src/ui/renderer/hooks/use-auth-progress.ts`.
- Dependency candidates still reported as warnings include
  `@ai-sdk/devtools`, `baseline-browser-mapping`, `caniuse-lite`, and
  `tw-animate-css`. Packaging or CSS-only usage must be verified before removal.
- Export/type candidates across shared renderer, runtime, plugin, permission,
  i18n, and work-board surfaces. Treat public API and test seams as separate
  review buckets; do not auto-delete exported symbols from Knip output alone.

## Verified Fixes In This Baseline

- `src/ui/renderer/tabs/__tests__/test-helpers.ts` now imports `HookTrustRow`
  from the actual source module, `src/hooks/hook-trust-commands.ts`, instead of
  the stale `hook-trust-store.js` path.
- The unused web `accordion`, `card`, `scroll-area`, and `separator` primitives
  and four unused Radix dependencies were removed after workspace-aware analysis.
