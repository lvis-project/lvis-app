# Tool-Level Deferral (host scope + `tool_search`)

> Status: current Host contract. Rooted in
> `docs/architecture/architecture.md` §4.5/§6.4 and
> `docs/development/tool-loading-policy.md`.

## Contract

- Natural-language keywords do not activate plugins, select Tools, or preload
  schemas.
- Plugin Skills are instruction bundles declared by `manifest.skills`; they do
  not provide a callable route.
- Callable methods are manifest `Tool` objects. The Host selects the active
  plugin scope and the model discovers deferred Tools through `tool_search`.
- `request_plugin`, explicit host configuration, and carried session scope are
  the only activation inputs. A disabled plugin is removed from model exposure
  even if it remains loaded for settings/auth/UI operations.

## Exposure policy

`resolveToolScope()` computes the active plugin IDs first, applies the
allowed/forced and enabled predicates, then counts model-visible plugin/MCP
Tools.

### Below `EAGER_TOOL_EXPOSURE_CEILING`

All eligible Tool schemas are sent eagerly:

- active plugin Tools;
- in-scope MCP Tools for non-headless turns;
- builtins and meta Tools.
The deferred catalog is empty and the model needs no discovery round.

### At or above `EAGER_TOOL_EXPOSURE_CEILING`

Deferral is inclusive (`eligible >= ceiling`):

- builtins/meta Tools remain eager;
- carried or explicitly forced Tool names remain eager when still in scope;
- all other eligible plugin/MCP Tools enter the catalog;
- `tool_search` promotes selected names for the next model round.

There is no implicit natural-language preload. The first deferred round may
therefore expose only `tool_search` plus builtins.

## State transitions

- A successful `request_plugin` activation adds the plugin to the session scope.
- Tool names promoted by `tool_search` carry forward only while their owner
  remains in scope and enabled.
- `onPluginDisabled(pluginId)` removes the plugin and its carried Tool names.
- Builtin-inventory questions reset plugin/tool carry-forward so the answer
  cannot be contaminated by a prior plugin turn.
- Headless turns exclude MCP Tools and still honor the same plugin-enabled and
  ceiling rules.

## Security invariants

- Scope selection never invokes a Tool.
- App-only Tools are absent from model-visible inventory and cannot be promoted.
- A forced Tool name is ignored unless it is currently registered and
  model-visible.
- `tool_search` results are filtered by the same active-plugin/MCP scope used to
  build provider schemas.
   - Registry execution authority, app visibility, and model exposure remain
  separate Host-owned decisions.

## Verification

Primary tests:

- `src/engine/__tests__/tool-search-loop.test.ts`
- `src/engine/__tests__/request-plugin.test.ts`
- `src/plugins/runtime/__tests__/tool-visibility-invariant.test.ts`

They cover eager exposure, the inclusive ceiling, promotion, carry-forward,
disable pruning, app-only exclusion, and headless MCP isolation.
