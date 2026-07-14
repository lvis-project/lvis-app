# Marketplace Reference Models

Status: Active research note for the provider/theme/language marketplace split.

This note records the marketplace operating model behind the current goal: LVIS
ships a small default surface, while Marketplace owns expansion. Provider,
theme, and language entries in the repository are seeds only; user-added rows
must be first-class catalog data.

## Current LVIS Contract

- App defaults stay small: only first-run essentials belong in bundled settings.
- Marketplace is the authoritative expansion path for providers, themes, and
  language packs.
- Non-artifact marketplace packages install by toggling app settings, not by
  downloading signed plugin zips.
- Seed definitions are bootstrap data. They must not be treated as the complete
  marketplace catalog.
- The app UI must show that more providers, themes, and language packs are
  available through Marketplace, so users do not infer the built-in list is the
  full support matrix.

Implementation anchors:

- App install state: `src/data/settings-store.ts`
- App install/uninstall UI: `src/ui/renderer/tabs/MarketplaceTab.tsx`
- App provider default split: `src/shared/llm-vendor-defaults.ts`
- App theme default split: `src/shared/theme-bundles.ts`
- App locale default split: `src/i18n/locale.ts`
- App model-list/baseUrl sync tests:
  `src/ui/renderer/tabs/__tests__/LlmTab.top-level-login.test.tsx`
- App marketplace asset install tests:
  `src/ui/renderer/tabs/__tests__/MarketplaceTab.test.tsx`
- Marketplace DB migration:
  `server/alembic/versions/20260706_0023_asset_package_columns.py`
- Marketplace asset authorship migration:
  `server/alembic/versions/20260707_0024_asset_package_authorship.py`
- Marketplace seed source:
  `server/src/lvis_marketplace/asset_catalog.py`
- Marketplace admin/catalog API tests: `server/tests/test_catalog.py`
- Marketplace publisher API tests: `server/tests/test_publisher.py`
- Marketplace admin UI tests: `web/src/__tests__/new-pages.test.tsx`

## External Patterns

VS Code separates extension packaging, publishing, publisher identity, lifecycle
actions, and reporting. Its publishing docs cover marketplace publication,
publisher registration, package upload, unpublish, remove, deprecate, and
acquisition reports. LVIS should keep the same conceptual split: package
identity, catalog metadata, lifecycle state, and install state are separate
concerns.

JetBrains Marketplace exposes plugin upload as an API operation keyed by a
publisher token and plugin identity, with release channel and hidden-update
options. The relevant LVIS lesson is that operator-authored marketplace rows
need lifecycle controls beyond a static seed file.

Chrome Web Store documentation organizes publication around listing setup,
review status, update, rollback, programmatic publish, item state, and upload
state. LVIS should mirror the operational idea even for settings assets:
catalog entries can be visible, hidden, yanked, deprecated, or staged without
requiring an app release.

OpenCode's provider UX uses a connect flow followed by model selection. For
some providers, the catalog is provider-backed rather than manually hard-coded.
This supports the LVIS direction: the provider is installed/configured once,
then available models come from the provider or router API.

OpenRouter exposes a model list API at `/api/v1/models`; the response includes
model IDs, capabilities, context length, pricing, and links to endpoint detail.
It also exposes provider-routing controls such as provider ordering,
fallbacks, and provider allowlists. LVIS should not hard-code an OpenRouter or
router model list when a configured LLM URL can supply the standard model list.

## LLM Router Principle

OpenCode does not make arbitrary commercial models free. It connects users to
providers, gateways, or routers. Free availability comes from the upstream
provider/router policy: a router may expose free variants, subsidized models,
limited promotional access, or provider-sponsored capacity. OpenRouter's model
API currently includes `:free` variants and zero prompt/completion pricing
fields for some models, which the app can interpret as free availability.

LVIS model discovery should therefore be dynamic:

- Read model lists from the configured provider/router URL when the provider
  supports a standard model-list endpoint.
- Preserve custom user-entered model IDs when the endpoint is unavailable.
- Annotate free/router-supplied models from returned pricing and variant
  metadata instead of maintaining a local hard-coded list.
- Keep provider install state separate from model sync state; installing a
  provider unlocks the UI and credentials, while model sync reflects current
  upstream availability.

## Marketplace Data Model Direction

The Marketplace DB-backed asset package shape should remain category-neutral:

- `plugin_type`: `provider`, `theme`, or `language-pack`
- `category`: public storefront grouping, such as `providers`, `themes`, or
  `languages`
- `package_spec`: stable install target, such as `provider:groq`,
  `theme:tokyo-night`, or `language-pack:ko`
- `package_asset_json`: typed settings payload used by the app install UI

The seed catalog is only a starter set. User-authored rows must be accepted
through admin UI/API and surfaced through catalog/detail endpoints exactly like
seeded rows.

## Verification Snapshot

Current app and marketplace mainlines after PR merge:

- App: `a7702240` (`#1536`) merged `fix(marketplace): harden lifecycle and
  keyless providers` into `main` on 2026-07-07.
- Marketplace: `1489c3a` (`#181`) merged `feat(marketplace): cover provider
  asset contracts and authoring` into `main` on 2026-07-07.

Post-merge checks observed on July 7, 2026:

- App PR #1536: `build-and-test`, `Windows permission path tests`, `CodeQL`,
  `naming-gate`, `cluster-detector`, and `Sensitive Area Cluster Check` passed.
  `e2e` and `marketplace-e2e` were skipped by workflow conditions.
- Marketplace PR #181: `test`, `Alembic upgrade - empty Postgres DB`,
  `Alembic upgrade - populated fixture`, and `naming-gate` passed.

Local verification on the merged mainlines:

- App targeted tests:
  `bun run test:vitest -- run src/shared/__tests__/llm-vendor-defaults.test.ts src/shared/__tests__/marketplace-package-assets.test.ts src/ui/renderer/__tests__/marketplace-asset-registry.test.ts src/ui/renderer/tabs/__tests__/MarketplaceTab.test.tsx src/ui/renderer/theme/bundles/__tests__/bundles.test.ts src/i18n/__tests__/i18n.test.ts`
  passed: 6 files, 162 tests.
- Marketplace targeted tests:
  `uv run pytest --no-cov tests/test_catalog.py tests/test_publisher.py tests/test_bootstrap.py tests/test_migrations.py`
  passed: 90 tests.
- The same Marketplace target without `--no-cov` passed all 90 tests but failed
  the repository coverage threshold because it was a partial suite.

Current verified default split:

- Providers visible by default: `openai`, `claude`, `gemini`, `openrouter`,
  `openai-compatible`.
- Themes visible by default: `moonstone`, `gallery`.
- Locale visible by default: `en`.
- Long-tail providers, non-default themes, and non-English locales are
  marketplace-eligible assets rather than first-run defaults.

The app now has a true Electron settings E2E that clicks through Marketplace
asset installs and then proves the installed provider, theme, and language pack
appear in the live LLM/Appearance pickers:

- `test/e2e/ui/marketplace-assets.spec.ts`

The Marketplace server now has DB-backed provider/theme/language asset packages
with admin and publisher authoring APIs. Seed rows are starter catalog data only;
user-authored rows use the same `package_spec` and `package_asset_json`
contract.

The next architecture boundary is provider metadata authority. The app still
keeps legacy long-tail provider metadata in `src/shared/llm-vendor-defaults.ts`
so old settings and secrets keep working. The intended next step is to move the
rich provider package metadata into Marketplace seed/user rows and make the app
consume catalog metadata first, with static app metadata serving only as a
legacy compatibility fallback.

## Current Big PR Slice

Title target:

- `feat(marketplace): promote catalog-owned asset metadata`

Scope under way:

- Enrich Marketplace provider seed `package_asset_json` with label, base URL,
  default model, optional model choices, model discovery policy, keyless support,
  capabilities, and trust metadata.
- Preserve DB/user ownership: bootstrap may insert or backfill seed rows but must
  not overwrite user-authored asset packages.
- Teach the app to prefer catalog-provided provider metadata when installing
  marketplace provider packages, while preserving known legacy provider IDs and
  secret keys.
- Keep current five-provider/two-theme/English defaults locked by tests.
- Add tests that prove seed rows and user-authored provider rows travel through
  the same catalog/detail/install path.

Current working-tree progress:

- Marketplace provider seeds now carry catalog-owned metadata for default model,
  model options, discovery policy, credential behavior, and trust labels.
- Existing bare provider seed rows are covered by an Alembic backfill that only
  updates exact old bootstrap payloads for known seed slugs.
- Local keyless providers such as Ollama and LM Studio are marked keyless/local
  instead of requiring an API key.
- App catalog parsing now preserves provider metadata for known marketplace
  provider IDs instead of reducing them to `providerId` only.
- Known provider marketplace installs now materialize catalog `baseUrl` and
  `defaultModel` into the app's LLM vendor settings patch when present.
- Added focused tests for rich provider seed metadata and known-provider
  metadata parsing.

Follow-up slimming candidates:

- Move non-English generated locale catalogs behind language-pack artifacts once
  missing-pack fallback UX is explicit.
- Move non-default theme token bundles behind theme package artifacts once theme
  package loading is runtime-safe.
- Add typed Marketplace sections and trust badges for Providers, Themes,
  Languages, Plugins, MCP, Agents, and Skills.
- Annotate router/free model lists from dynamic provider model metadata instead
  of hard-coding availability.

## Sources

- VS Code, Publishing Extensions:
  https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- VS Code, Extension Manifest:
  https://code.visualstudio.com/api/references/extension-manifest
- VS Code, Color Theme:
  https://code.visualstudio.com/api/extension-guides/color-theme
- VS Code, Language Extensions Overview:
  https://code.visualstudio.com/api/language-extensions/overview
- JetBrains Marketplace, Plugin upload API:
  https://plugins.jetbrains.com/docs/marketplace/plugin-upload.html
- JetBrains, Install plugins:
  https://www.jetbrains.com/help/idea/managing-plugins.html
- Chrome for Developers, Publish in the Chrome Web Store:
  https://developer.chrome.com/docs/webstore/publish
- Obsidian, Community plugins:
  https://help.obsidian.md/Extending+Obsidian/Community+plugins
- Obsidian, Themes:
  https://help.obsidian.md/Extending+Obsidian/Themes
- OpenCode, Providers:
  https://opencode.ai/docs/providers/
- OpenRouter, model list API:
  https://openrouter.ai/api/v1/models
- OpenRouter, Models:
  https://openrouter.ai/docs/guides/overview/models
- OpenRouter, provider routing:
  https://openrouter.ai/docs/guides/routing/provider-selection
- OpenRouter, model fallbacks:
  https://openrouter.ai/docs/guides/routing/model-fallbacks
