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
- App model-list/baseUrl sync tests:
  `src/ui/renderer/tabs/__tests__/LlmTab.top-level-login.test.tsx`
- App marketplace asset install tests:
  `src/ui/renderer/tabs/__tests__/MarketplaceTab.test.tsx`
- Marketplace DB migration:
  `server/alembic/versions/20260706_0023_asset_package_columns.py`
- Marketplace seed source:
  `server/src/lvis_marketplace/asset_catalog.py`
- Marketplace admin/catalog API tests: `server/tests/test_catalog.py`
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

Current app mainline after marketplace provider preset hardening:

- App: `40ab4e3f` (`#1534`) merged the provider preset credential-boundary
  hardening on top of the provider/theme/language marketplace asset split.

Post-merge checks succeeded on July 6, 2026:

- `build-and-test`
- `Windows permission path tests`
- `CodeQL`
- `naming-gate`
- `cluster-detector`

The app now has a true Electron settings E2E that clicks through Marketplace
asset installs and then proves the installed provider, theme, and language pack
appear in the live LLM/Appearance pickers:

- `test/e2e/ui/marketplace-assets.spec.ts`

The server-side Marketplace DB/API work lives outside this repository. This app
repository treats built-in provider/theme/language entries as local seed
candidates and treats remote catalog entries as authoritative when returned by
the configured marketplace endpoint.

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
