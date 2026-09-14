# Claude Code subscription runtime

The main process launches a user-selected official CLI executable. Its auth
commands use a separate application-owned home and `CLAUDE_CONFIG_DIR`; LVIS
does not read OAuth tokens, reuse API keys, or forward auth output to the renderer.
The status projection accepts the CLI's `claude.ai` first-party authentication
with subscription metadata. Missing or contradictory metadata remains unavailable.
Executable selection, browser login, cancellation, logout, and verification use
the existing subscription service and UI contracts. Model selection and native
image attachments are not supported by this transport.

`SubscriptionLlmProvider` sends the complete controlled conversation envelope for
each LVIS model round. A print invocation receives that envelope on stdin and runs
with `--no-session-persistence`. No native session is resumed: LVIS owns history,
tool results, compaction, and the next model round. Session ids in the output are
validated within the invocation rather than persisted as a second history owner.

The CLI disables built-in tools with `--tools ""`. The separately configured MCP
bridge receives exact named approvals; `--allowedTools` is not an exclusive tool
catalog. Strict MCP configuration and the validated `system/init` catalog limit
the expected tools to this bridge. Tool deferral and account-connected remote MCP
servers are disabled. Only an authenticated bridge invocation becomes
an LVIS tool call. A stdout tool announcement cannot execute a host tool or finish
the round. The CLI's `EndConversation` control is allowed when present because the
CLI retains it while MCP tools exist; it is never exposed as an LVIS tool call.

User and project settings sources, slash commands, Chrome integration, and hooks
are disabled for the invocation. The runtime uses an isolated working directory.
These controls are not an OS sandbox: administrator-managed CLI policies still
apply and may require hooks that the CLI will not let a caller override. Unexpected
catalog entries, plugins, or hook records fail the host stream; detecting a hook
record is not proof that a managed hook did not run. `--bare` is unsuitable here
because it excludes subscription OAuth authentication. Administratively managed
installations need their own compatible policy; LVIS does not bypass that policy.

The shared `JsonLineReader` frames stdout. The transport additionally bounds actual
stdout/stderr bytes and queued events, validates UTF-8, and checks the native
result. A successful text round requires a consistent session, a successful
structured result, and successful process/stdio completion. Malformed or truncated
output, a failed result, unknown execution events, and extra records after the
result fail explicitly. Raw stderr is drained without retention or UI projection.

Verification performs version/auth checks and one short print request under the
same stream contract without tools. Every tool-enabled invocation also validates
its actual bridge catalog. Failures revoke the subscription service's verification
proof; another session must verify again. User cancellation stays cancellation.

One managed child owns each invocation. POSIX children receive an owned process
group so cancellation includes the CLI's MCP descendants. Setup, cancellation,
stream errors, timeouts, and consumer exit all clean the request's temporary MCP
configuration. Those files use the feature namespace's private atomic writer and
are never retained as an auth store.

The external protocol is documented in the official [CLI reference](https://code.claude.com/docs/en/cli-reference),
[programmatic usage guide](https://code.claude.com/docs/en/headless), and
[tools reference](https://code.claude.com/docs/en/tools-reference).
The [MCP guide](https://code.claude.com/docs/en/mcp) defines the tool-discovery controls.
