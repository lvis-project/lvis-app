# Vercel AI SDK Migration — Bundle-Size Baseline

Companion to `docs/references/vercel-ai-sdk-migration.md`.
Captured on branch `feat/vercel-ai-sdk-p0`.

## Baselines

| Snapshot | `dist/` total | Notes |
|---|---|---|
| Pre-deps (main @ 8ba8db8) | 3.0M | `bun run build` on main before adding `ai` / `@ai-sdk/*` |
| Post-deps (P0 stubs, flag=none) | 1.2M | After installing deps + P0 stubs. Delta is negative because the build is not deterministic across runs (renderer bundle chunking differs); the Vercel packages are NOT yet imported by any bundled entry point, so this number reflects bundler-level noise rather than real impact. Real delta lands at P1. |

The Vercel packages live in `node_modules` and are only imported from
`src/engine/llm/vercel/*`. Because the feature flag defaults to `"none"` and
nothing in the hot path imports the stubs yet, the main `dist/` build output
should be effectively unchanged until P1 wires the adapter into
`conversation-loop.ts`.

Re-measure at these checkpoints:

- After P0 stubs (this branch) — expect ≈ no change
- After P1 (Gemini path live) — expect the `ai` + `@ai-sdk/google` code
  to enter the Electron main bundle
- After P2 (OpenAI path live) — expect `@ai-sdk/openai` to enter the bundle
- After P3 (Claude path live; all vendors migrated and legacy providers
  deleted) — net delta vs. the Anthropic/OpenAI/Google SDKs we remove

## Top-10 heaviest modules

Run (one-off, not committed):

```bash
bun run build
npx source-map-explorer 'dist/**/*.js' --only-mapped --no-border-checks
```

Results go here as the migration progresses. Not captured in P0 because the
stubs are not imported by the main bundle.

## Pinned versions (final)

Installed on P0 branch:

- `ai@6.0.168` (satisfies `~6.0.168`, includes #11688 fix merged in 6.0.132)
- `@ai-sdk/anthropic@3.0.71`
- `@ai-sdk/openai@3.0.53` (latest)
- `@ai-sdk/google@3.0.64` (latest)
- `@ai-sdk/openai-compatible@2.0.41`
- `@ai-sdk/devtools@0.0.15` (devDep)

Note: `^6.1.x` of `ai` does not exist yet; pin stays at `~6.0.168` until a
compatible 6.1 ships.
