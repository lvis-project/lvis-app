# Plugin Tool Schema Design

This reference defines how plugin tool schemas are interpreted by the LVIS host.
Korean source history is preserved at
[docs/ko/references/plugin-tool-schema-design.md](../ko/references/plugin-tool-schema-design.md).

## Contract

Plugin tool schemas are both LLM-facing affordances and host-facing security
metadata. A schema must be precise enough for the model to call the tool and
strict enough for the host to classify risk before execution.

## Required Fields

| Field | Purpose |
| --- | --- |
| `name` | Stable tool name exposed to the registry. |
| `description` | English description of what the tool does and when to use it. |
| `inputSchema` | JSON Schema object used to validate tool input. |
| `category` | Permission category used by policy and audit. |
| `pathFields` | Input fields that represent file or directory paths. |
| `capabilities` | Host capabilities required before the tool may execute. |

## Category Guidance

| Category | Use For |
| --- | --- |
| `read` | Reading declared local data without mutation. |
| `write` | Creating, editing, deleting, or moving local data. |
| `network` | Sending data to or retrieving data from external services. |
| `shell` | Running shell commands, scripts, package managers, or process control. |
| `browser` | Driving browser/webview behavior outside simple display. |
| `meta` | Host configuration or permission mutations. |

When a tool can both read and write, declare the higher-risk category. Do not
hide mutation behind a read category.

## Path Fields

Tools that accept paths must declare which input fields are paths. The
permission manager uses these fields to detect workspace scope, out-of-directory
access, sensitive paths, and sandbox requirements.

Path fields should be explicit. Avoid accepting arbitrary nested payloads that
may contain paths without declaring them.

## Input Schema Rules

- Use `type: "object"` at the top level.
- Define `properties` for every accepted field.
- Prefer `required` for fields the tool cannot run without.
- Use enums for closed option sets.
- Avoid loose `additionalProperties` unless the tool is intentionally a generic
  key/value editor and policy accepts that risk.
- Keep descriptions English-first and actionable.

## Permission Interaction

The host resolves permission from the normalized tool definition. The plugin
cannot override the decision once the request reaches the executor. Invalid
schemas, missing categories, or undeclared path behavior can fail closed before
the user is asked.

## LLM Prompting

The schema is visible to the model. Descriptions should explain:

- what the tool does;
- when not to call it;
- required user-visible side effects;
- whether it sends data outside the local app;
- what output shape to expect.

Do not put secrets, credentials, private endpoint details, or process-only
review notes in schema descriptions.

## Compatibility

Schema changes can break existing conversations, plugin tests, and marketplace
catalog expectations. Treat changes to names, required fields, categories, and
path fields as compatibility-affecting.

## Review Checklist

- Category matches the strongest side effect.
- Path fields cover every input path.
- Network tools disclose destination and payload class.
- Shell tools make command execution explicit.
- Descriptions are English and do not contain implementation-only process
  labels blocked by naming-gate.
- Tests cover allow, ask, deny, and manifest-validation behavior for the tool.
