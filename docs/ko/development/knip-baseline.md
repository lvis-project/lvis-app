# Knip Baseline

This is the #1410 code-diet baseline. It separates actionable cleanup from
runtime and packaging patterns that static analysis cannot infer.

## Gate

Run:

```powershell
bun run check:knip
```

The gate fails on new unresolved imports, unlisted dependencies, and unlisted
host binaries. Existing file/export/dependency cleanup debt remains visible as
warnings until it is split into removal PRs.

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
- Dependency candidates still reported as warnings:
  `@ai-sdk/devtools`, `baseline-browser-mapping`, `caniuse-lite`, and
  `tw-animate-css`.
- Export/type candidates across shared renderer, runtime, plugin, permission,
  i18n, and work-board surfaces. Treat public API and test seams as separate
  review buckets; do not auto-delete exported symbols from Knip output alone.

## Verified Fixes In This Baseline

- `src/ui/renderer/tabs/__tests__/test-helpers.ts` now imports `HookTrustRow`
  from the actual source module, `src/hooks/hook-trust-commands.ts`, instead of
  the stale `hook-trust-store.js` path.
