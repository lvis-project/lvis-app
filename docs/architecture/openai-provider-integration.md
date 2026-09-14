# OpenAI provider integration

The provider boundary adapts two connection contracts to the same LVIS engine:
an API-key connection using the existing SDK transport and a Codex subscription
connection using the governed native App Server. The common provider layer owns
the model-visible request projection. It removes host-only tool-call metadata
while retaining tool identity, input, result error status, and image provenance.
It does not introduce another agent loop.

## Connection ownership

| Responsibility | Owner |
|---|---|
| Engine input/output | `GenericMessage`, `StreamTurnParams`, `StreamEvent` |
| API-key provider creation | `src/engine/llm/provider-factory.ts` |
| Subscription provider creation | `src/main/subscription-llm-provider.ts` |
| Common OpenAI request contract | `src/engine/llm/openai/` |
| API HTTP and SDK mapping | Existing SDK provider transport |
| Native account, thread, turn, and dynamic-tool protocol | Codex App Server clients |
| Other subscription protocols | Their own protocol adapters |
| UTF-8 JSONL framing | `src/lib/json-line-reader.ts` |
| Pending RPC identities and timers | `src/lib/json-rpc-pending-request.ts` |
| Tool execution, approval, memory, and broadcasts | LVIS host services |

An API-key connection resolves the configured secret and API endpoint through
the existing factory. A subscription connection resolves its active native
profile and receives its session-opening service from the main process. The
shared engine-facing module does not import a desktop runtime or read native
credentials. Authentication and billing stay attached to the selected route.
It neither falls back between routes nor converts subscription authentication
into an API credential.

The [Claude Code subscription runtime](claude-code-subscription-runtime.md)
uses the same engine contract and JSONL reader with its own CLI authentication,
print-stream validation, and MCP bridge adapter.

## Request and stream semantics

Both connections use the common model-visible projection before their wire
mapping. Stored history is unchanged. Tool-call IDs and inputs survive the
projection; host execution provenance and scheduling fields do not enter model
input. Tool-result failures and retained images survive transport mapping.
Existing image selection and count/byte limits remain authoritative.

The API transport applies its configured numeric output and thinking controls.
The native transport uses its selected profile and supported native effort.
Those controls are distinct contracts: sharing the provider layer does not
translate a numeric thinking budget into a native effort or change the model.

Registered dynamic tool requests return through the governed LVIS tool path.
LVIS executes the tool and supplies the next round through its ordinary engine.
Both account and conversation processes explicitly disable native shell,
snapshot, connector, browser, computer, subagent, and other optional execution
features. Hosted web search is separately disabled because the native sandbox's
network setting does not remove it.

The App Server does not expose a complete native-tool allowlist. Its patch tool
can remain in the native catalog, and `unified_exec` can report enabled despite
the disable flag; `shell_tool=false` is the command-tool control. Unsupported
native execution still triggers the existing interrupt and transport shutdown,
and native approval requests are declined. These flags do not replace that
enforcement boundary. Native command and patch execution additionally receive a
read-only filesystem policy with network access disabled. LVIS dynamic tools
execute in the host callback under their own permission policy, outside that
native sandbox. The host stages image inputs before native turn startup; the
App Server needs to read those files, not create them. Native IDs and
interruption remain transport state. Text,
reasoning, tool, usage, completion, cancellation, and sanitized error events
retain their existing stream contract.

## Shared child-process transport

Each child-process transport owns one incremental JSONL reader. A line may span OS chunks,
and a chunk may hold several lines. The byte ceiling applies to the individual
line rather than to the delivery chunk. Invalid JSON or an oversized line closes
that reader once. Closing from a message callback suppresses later messages in
the same chunk.

The pending registry allocates monotonically increasing numeric IDs, stores
request methods with pending promises, and clears timers when replies settle.
Late or duplicate responses cannot settle a different request. Timeout callbacks
apply the adapter's existing close policy; conversation prompts and account
probes are not assigned one universal timeout. Envelope validation, server
requests, session state, process management, and safe error projection belong to
the protocol adapter.

## Adding a connection

Reuse a protocol adapter when the external endpoint implements that protocol.
Add a distinct adapter when authentication, framing, session lifecycle, or tool
delivery differs. Supply the existing engine contract and shared projection;
do not add provider branches to tool governance or plugin integration. Tests
must cross the provider entry and transport boundary, including images, tool
results, cancellation, explicit completion, and late responses.
