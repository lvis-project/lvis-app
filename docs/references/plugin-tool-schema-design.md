# Plugin Tool Schema Design

This reference defines the current plugin Tool contract interpreted by the LVIS
Host. Korean source history is preserved at
[docs/ko/references/plugin-tool-schema-design.md](../ko/references/plugin-tool-schema-design.md).

## Sources Of Truth

`PluginManifest.tools` is one array of pure MCP Tool objects. The manifest Tool
is projected across the plugin loopback MCP boundary without a parallel schema,
action, or governance map.

- `src/plugins/public-contract.ts` owns the complete public TypeScript contract
  and JSDoc.
- `schemas/plugin-manifest.schema.json` owns the accepted manifest shape.
- `src/plugins/runtime/manifest-validation.ts` owns Host cross-field checks and
  materialization.
- `@lvis/plugin-sdk` mechanically mirrors the public module and schema for
  plugin-author builds; it owns no contract policy.

## Tool Shape

| Field | Purpose |
| --- | --- |
| `name` | Stable Tool name using `^[a-zA-Z_][a-zA-Z0-9_]*$`. |
| `description` | English description of what the Tool does and when to use it. |
| `inputSchema` | JSON Schema 2020-12 object used to validate Tool input. |
| `outputSchema` | Optional structured output schema. |
| `title` / `icons` | Optional standard MCP display metadata. |
| `_meta.ui.visibility` | Optional model/app surface declaration; absent uses the SEP-1865 dual default. |
| `_meta["lvisai/pathFields"]` | Optional input fields that represent file or directory paths. |
| `_meta["lvisai/operationPolicy"]` | Optional signed restrictions for a discriminated composite Tool. |

`inputSchema.type` must be `"object"`. App-only Tools use
`_meta.ui.visibility: ["app"]`; model-only Tools use `["model"]`; dual Tools use
`["model", "app"]`. Empty visibility is invalid.

## Host-Owned Risk

Plugins do not declare a per-tool permission category. The Host classifies the
effective risk from the concrete invocation and routes model/plugin calls
through its permission, approval, execution, and audit pipeline.

A Tool-local operation policy may raise a minimum risk floor, narrow
app-visible operations, or require a fresh read before a write. It cannot lower
risk or grant authority. A plugin must not add a top-level operation policy or
action allow-list.

## Path Fields

Tools that accept paths declare them in `_meta["lvisai/pathFields"]`. The
permission manager uses these selectors to detect workspace scope,
out-of-directory access, sensitive paths, and sandbox requirements. Dotted
selectors address nested object fields.

Path fields should be explicit. Avoid accepting arbitrary nested payloads that
may contain paths without declaring them.

## Skill and Tool discovery

Natural-language keywords are not a plugin activation or Tool-selection
contract. Plugin Skills are instruction bundles declared by `manifest.skills`;
callable methods are the pure Tool objects in `manifest.tools`.

The Host owns active plugin scope. When the eligible surface crosses the
deferral ceiling, the model discovers callable Tools through `tool_search`.
There is no keyword compatibility reader or runtime registration alias.

## Input Schema Rules

- Use `type: "object"` at the top level.
- Define `properties` for every accepted field.
- Prefer `required` for fields the Tool cannot run without.
- Use enums for closed option sets.
- Avoid loose `additionalProperties` unless policy accepts the generic payload.
- Keep descriptions English-first and actionable.

## Removed Shapes

The Host rejects `uiTool`, `uiTools`, `uiAction`, `uiActions`, top-level
`operationGovernance`, and top-level `appAllowed`. App/model visibility and
operation restrictions are colocated on the one Tool object. Do not introduce
compatibility aliases.

## Review Checklist

- One pure Tool object owns its schema, visibility, and optional restrictions.
- No plugin-authored category or parallel action/policy map is present.
- Path fields cover every input path.
- Network and shell behavior is explicit in the description and implementation.
- Tests cover schema rejection, cross-field validation, model/app visibility,
  permission behavior, scope carry-forward, and `tool_search` promotion.
