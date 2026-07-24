# Plugin Development Guide

This guide describes how to build LVIS plugins against the current host
runtime. Korean source history is preserved at
[docs/ko/guides/plugin-development.md](../ko/guides/plugin-development.md).

## Plugin Model

An LVIS plugin is an installable package with a manifest, optional UI bundle,
optional tools, optional settings schema, and declared host capabilities. The
host owns installation, policy, loading, UI containment, and tool execution.

Plugins should add workflow capability without assuming direct filesystem,
network, or process access. Those operations must be declared and routed through
host APIs or tool execution.

## Manifest Basics

Every plugin package needs a `plugin.json` manifest. The Host owns the canonical
shape in `schemas/plugin-manifest.schema.json` and the complete TypeScript/JSDoc
authoring contract in `src/plugins/public-contract.ts`. `@lvis/plugin-sdk`
publishes generated mirrors of those two Host files.

The manifest should include:

- stable plugin id;
- display name and version;
- runtime entry point and optional UI declarations;
- pure MCP `Tool[]` objects with colocated input schemas;
- required capabilities;
- settings schema if configurable;
- marketplace metadata if published.

`tools[]` is the only callable surface. The retired `uiTool`, `uiTools`,
`uiAction`, `uiActions`, top-level `operationGovernance`, and top-level
`appAllowed` shapes are rejected. App/model visibility belongs on each Tool at
`_meta.ui.visibility`; operation restrictions belong on the same Tool at
`_meta["lvisai/operationPolicy"]`.

`manifest.skills` optionally declares instruction bundles. The Host exposes
their catalog metadata and loads an instruction body only through the Skill
lifecycle; a Skill does not activate a plugin, select a Tool, or invoke a Tool.
Host-selected plugin scope and `tool_search` control model-visible Tool
discovery.

## HostApi Boundaries

Plugin code receives a host bridge. It must use that bridge for operations such
as:

- reading declared preferences;
- opening approved auth windows;
- calling host methods;
- requesting tool execution;
- subscribing to allowed events;
- rendering UI in declared slots.

The caller plugin identity is bound by the host factory. Plugins must not pass
or spoof another plugin id.

## UI Plugins

Plugin UI loads in a host-owned shell. The host resolves the plugin entry URL,
pre-paints theme tokens, and calls the plugin mount function. A plugin UI should
render within the provided root and use the bridge for host interaction.

If the entry cannot load, the shell shows English fallback errors. A blank plugin
surface is considered a regression.

This is the host-mounted **sidebar panel** surface (`ui[]` in the manifest). It is
not the only one: a plugin can also ship an **MCP App** — an interactive `ui://`
card the host renders next to a tool result, built on the standard
`@modelcontextprotocol/ext-apps` library rather than a LVIS bridge. See
[Authoring an MCP App](./mcp-app-authoring.md).

## Tool Plugins

Plugin tools are normalized into the host tool registry. A tool definition must
provide:

- name;
- description;
- input schema;
- `_meta.ui.visibility` when the SEP-1865 dual-surface default is not intended;
- `_meta["lvisai/pathFields"]` where file access is possible;
- execution handler;
- required capabilities.

The Host classifies risk for each invocation. A plugin cannot assign its own
permission category or lower a Host verdict. Tools are executed only after
permission resolution; the plugin runtime does not own the approval gate.

## Settings

Plugins may expose a settings schema. The renderer displays settings through the
host settings UI and persists values through host storage. Secret values should
use secret fields and should not be copied into logs, audit output, or docs.

## Marketplace And Installation

Marketplace installation should verify package metadata, manifest validity, and
managed-plugin policy. Managed plugins cannot be removed or downgraded by normal
user-installed plugin paths.

Local development install paths are useful during plugin authoring, but
production install flows should go through the marketplace or an approved local
package source.

## Auth Windows

Plugins that need interactive login should use the host auth-window service.
The host creates the partition, collects cookies or tokens according to policy,
and clears the partition when requested. Plugins must not embed arbitrary auth
flows in renderer code.

## Testing Checklist

Before publishing or merging a plugin change:

- validate `plugin.json` with manifest tests;
- run tool-schema lint where applicable;
- verify settings schema rendering;
- verify install, update, remove, and managed-plugin behavior;
- verify permission prompts for write, shell, network, and out-of-directory
  reads;
- verify plugin UI error fallback and theme token application.

## Language Policy

Default plugin examples, docs, logs, and visible fallback copy should be English.
Korean plugin docs may live under `docs/ko` or plugin-local localization files.
Runtime Korean support should be implemented through locale catalogs or explicit
keyword/intent support, not by making English default docs Korean-only.
