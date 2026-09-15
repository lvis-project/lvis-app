# Permission Policy Design

This document describes the current permission-policy contract for LVIS tool
execution. Korean source history is preserved at
[docs/ko/architecture/permission-policy-design.md](../ko/architecture/permission-policy-design.md).

## Purpose

The permission system prevents tools from executing merely because an LLM or a
plugin requested them. The host classifies the request, applies hard safety
rules, asks the user or reviewer where required, and records the result.

## Policy Inputs

| Input | Meaning |
| --- | --- |
| Tool source | Builtin, plugin, or MCP. Used for display and audit; not a bypass. |
| Tool category | Read, write, shell, network, browser, meta, or other declared categories. |
| Trust origin | User keyboard, LLM tool argument, plugin UI, local API, routine, or headless task. |
| Project context | Normalized project root/name used for scope and audit. |
| Policy mode | Default, strict, auto-review, or allow mode. |
| Execution surface | Foreground chat, background routine, inline plugin/MCP surface, or local API. |

## Decision Order

1. Validate the tool exists in the registry.
2. Validate the schema, category, and path fields declared by the provider.
3. Apply hard-deny rules: sensitive paths, invalid manifests, sandbox limits,
   explicit deny policies, and unsafe origin combinations.
4. Resolve policy mode.
5. If reviewer mode is active, request a reviewer verdict for eligible calls.
6. Route to user approval, inline allow, deferred queue, or deny.
7. Execute only after the decision is resolved.
8. Write audit data for allow, ask, deny, deferred, reviewer unavailable, and
   reviewer failure outcomes.

Hard-deny rules always run before reviewer or user approval. A user approval
does not make an invalid tool definition valid.

Shell policy consumes the canonical [typed analysis and prepared execution
contract](architecture.md#process-boundaries). The path and
structural checks inspect every declared command-bearing field using the same
original command, interpreter facts and statement scopes. They do not infer
execution from a second scan of dequoted text. A `grep` pattern remains text
even when it contains path separators, regular-expression escapes, or dollar
anchors. Input files, pattern files supplied with `-f`/`--file`, exclusion files,
and redirection targets remain subject to path checks. Shell substitutions are
checked separately because they execute commands before argument passing.

For `git commit`, the operand classifier in
[shell-path-policy.ts](../../src/tools/shell-path-policy.ts) recognizes message
values as data, including attached option values. Path-like text in a literal
message does not request filesystem access. Directory options, file-backed
messages, templates and pathspec files retain path checks. Unsupported option
arity is refused rather than used to infer later operand roles. Classification
preserves the original command bytes; substitutions, redirections and commit
mutation still receive their normal checks.

Literal dollars and percent markers remain exact filename bytes in Bash,
including quoted `$PWD` and `%CD%`. Only typed active expansions use the
prepared environment and point-of-use bindings. A known expansion is checked
as its exact result; an unknown path or executable remains unresolved. Path
resolution follows symlinks before parent components and refuses unresolved
links. The four exact standard-stream operands `/dev/null`, `/dev/stdin`,
`/dev/stdout` and `/dev/stderr` are recognized before host descriptor resolution.
Other descriptor paths receive ordinary checks.

Pure output data does not acquire a path role because it contains a slash or
dollar. Its executed substitutions and expansion effects are still inspected.
Supported default/alternate parameter operands preserve conditional evaluation;
simple arithmetic output is admitted only when its dependency values are known
numeric data and no mutation or nested execution is present. Its computed value
is not inferred for path authority. Unknown command outcomes preserve possible
states through conditions and loops; a pre-execution filesystem observation
cannot decide a later cwd after a possible shared filesystem mutation.

The structural pass follows command text supplied through a child shell's
`-c`, heredoc or here-string. It does not read a script file or infer its
contents from an earlier write. Script-file execution remains subject to
write-risk classification, path authority, approval and the execution sandbox.
Opaque loading into the current shell through `source` or `.` is explicitly
unsupported because it could replace the state used for later path decisions.

Read-only evidence comes from the existing risk contract. Unknown executables
and mutating commands retain the write boundary, including an absolute command
path; widening reads never supplies a read-only proof for execution. Redirect
targets carry their own effect independently of the command's argument roles.

Debugger command options (`-ex`, `-iex`, `-eiex` and their documented long
forms) carry program text. Executable, symbol, core, directory and command-file
options remain path operands. After an argument-forwarding option or a possible
abbreviation, later arguments receive no debugger option exemptions because
they may belong to the child program.
Potential abbreviations of value-taking options consume their value
conservatively so that an option-looking filename cannot claim a later operand.
Program-text classification does not make debugger execution read-only: tool
risk review and the execution sandbox govern the program's internal effects,
as they do for other interpreters. Shell substitutions are still checked before
the debugger receives the resulting argument.

The `sqlite3` [argument contract](../../src/tools/shell-sqlite-arguments.ts)
defines the supported options and consumes their values before assigning positional roles.
Role assignment first requires a fixed argument count after shell expansion.
Unknown quoted scalar data may occupy one value slot; unresolved word splitting,
globbing or array multiplicity cannot shift subsequent option or positional roles.
The database operand and `-init` file remain paths; later operands and `-cmd`
values carry SQL or dot-commands. Formatting and numeric option values are data.
Database URI filenames are decoded before normal sensitive-path, symlink and
directory checks. SQL length does not affect its role or grant authority.
Literal filenames in supported SQL and dot-command operations receive the same
path checks. SQL table names are recognized in their structural context, including
single-quoted, qualified and grouped sources, joins and `IN` table forms.
Expression strings and aliases keep their data role. Explicit `.shell` and
`.system` commands re-enter structural and path inspection using the CLI's
argument construction for its POSIX system shell;
the Windows system-shell dialect is unsupported. Computed filenames,
extension loading, file-backed virtual tables, command pipes, cwd changes,
unknown options and unsupported dot-command forms are refused before approval
or execution. Database URIs combined with alternate file-opening modes are also
refused because those modes can interpret filename bytes differently. Conditional
home-directory expansion is unresolved; file-loading modes keep `:memory:` as a path.
Positional script-file detection is unsupported when it can change later argument
roles; explicit `-init` and `.read` keep their program-file path checks.
Those program files and database-resident code are not read or evaluated
by this pass; they retain write-risk review and execution sandbox controls.
This contract does not establish read-only execution or change permission grants.
Shell redirects and substitutions remain independently checked.

For `find`, starting points and file-valued primaries remain paths. Name/path
patterns, regular expressions, timestamps, numeric tests, and output formats
are expression values. In particular, `-printf` takes one format, while
`-fprintf` takes an output file followed by a format. Each primary consumes
its documented operands before the next primary is read. Unsupported or
incomplete expression syntax keeps conservative path checking. The shared
operand classifier consumes canonical argv, so interleaved redirections do
not consume expression operands. File redirect targets remain independently
checked; descriptor duplication/closing consumes no argv operand. A missing
redirect target is a parse failure, distinct from an explicitly empty word.
This role classification does not relax recursive mutation/execution restrictions
or shell redirection and substitution checks.

Compiler path options preserve the complete value: `-Iinclude/sub` names
`include/sub`, and `-ooutput/tool` names `output/tool`. Known options consume
one argument; unknown and sysroot-dependent forms retain conservative checking.
The same operand classifier checks redirects separately.

HTTP and HTTPS query values remain URL data. An equals sign does not create
a local path operand. Output options, redirects and shell substitutions keep
their normal checks.

The [archive-listing parser](../../src/shared/shell-tar-listing.ts) supplies
both risk and path classification. Only recognized listing options with
explicit local archive files establish a read operation. Entry names select
archive contents; archive files retain sensitive-path and optional read-boundary
checks. Mutation, unknown options, file- or environment-supplied options,
remote transports and expandable option words remain conservative.
Redirects and hidden execution still affect risk.

Supported grammar is not the same as supported authority analysis. Arithmetic
commands, C-style loops, unsupported declaration or shell-state operations,
dynamic shell programs and unproven expansion effects are explicitly declined.
The strict grammar also declines an unfinished heredoc and a variable-shaped
literal delimiter accepted by some native Bash forms; it does not return an
earlier partial command. Version-dependent arithmetic command endings with a
continuation between their closing parentheses are also declined rather than
assigned arithmetic authority. These are documented limits, not native-equivalence
claims. [shell-policy-unsupported.test.ts](../../src/tools/__tests__/shell-policy-unsupported.test.ts)
retains these refusal cohorts, while
[shell-authority-native.test.ts](../../src/tools/__tests__/shell-authority-native.test.ts)
compares supported argv, state and owned filesystem effects with the actual
native shell. PowerShell's separate function/method restriction and public
lifecycle coverage are described in the architecture contract.

## Shell Execution And Explicit Host Approval

Execution location, configuration, authentication and OS identity are separate
properties. ASRT launches processes on the current host with a temporary HOME
and configuration profile for each invocation. It does not inherit the user's
terminal login state. Plain execution uses the host HOME and filtered child
environment. Both run as the current OS user; selecting host execution grants
no administrator privileges. The final host-owned execution plan determines
confinement; a temporary HOME alone is not an OS sandbox.

Bash and PowerShell accept `executionMode: "default" | "host"` and an optional
`justification`. Omission keeps the default route. An explicit host request
requires a nonblank justification and foreground execution. The host selects
the final plan after input hooks and before environment capture and path
analysis. Host mode selects plain execution without OS confinement and requires
a fresh exact-action `allow-once`, including in allow mode or when sandboxing
was already disabled. Sensitive-path, directory, command and dynamic-syntax
checks remain mandatory.

Only a response from the verified local desktop renderer can authorize this
explicit request. The approval displays the exact command, cwd and justification
and states that the command runs once as the current user without the OS sandbox.
Headless and remote-controller requests are denied before approval. Automatic,
remembered, plugin, platform and parent-agent decisions cannot authorize host
mode. The signed approval receipt binds the final action; an opaque permit is
consumed once before spawn. Changed commands, cwd, plans or request fields and
replayed permits fail closed. The parser and plan in
[host-shell-execution-plan.ts](../../src/permissions/host-shell-execution-plan.ts),
the [approval gate](../../src/permissions/approval-gate.ts) and
[execution permit](../../src/permissions/host-shell-execution-permit.ts) own this
contract.

Every plain-shell call requiring one-shot consent exposes its complete command
and resolved working directory before the decision. If sensitive-data masking
would change its arguments or working directory, the gate rejects the request
before parking it. Masking is retained; hidden command bytes cannot receive an
execution permit through a redacted display.

Host execution is not a credential broker. Programs may consult host
configuration, but the environment filter does not forward token variables or
the SSH agent, and authentication success is not guaranteed. Without OS
confinement, this feature cannot guarantee that arbitrary programs never read
credential files. The actual environment remains owned by
[safe-env.ts](../../src/tools/safe-env.ts) and the prepared invocation.
[shell-execution-environment.ts](../../src/shared/shell-execution-environment.ts)
provides shared descriptions for the system prompt and approval UI; the prompt
describes the default route, while the approval describes the final call's plan.

## Saved-Session Reads

Tool policy permits reads of the configured primary session store and denies
write and delete effects. Its root comes from
[sessionStorePath](../../src/shared/session-store-path.ts) under the application
data root resolved by `lvisHome()`; `LVIS_HOME` relocation applies to storage and
read policy together. This grants no access to another session-store namespace,
credentials, audit or routine state.

The per-turn environment context publishes the exact application root and
primary session-store path as JSON through the same path helpers. These are
operational tool inputs; audit path redaction does not apply to them. The model
uses the absolute store path with `list_files` and `read_file` rather than
inferring it from a shell's temporary HOME. Publishing a path does not grant
access or change shell expansion and permission checks.

[sensitive-paths.ts](../../src/permissions/sensitive-paths.ts) owns the namespace
classification and canonical-path checks. Supported file reads and shell
commands with proven read effects can reach this root even when ordinary reads
are confined to working directories. A linked session root or an escaping path
cannot widen that grant, and other sensitive-path rules still apply inside it.
Only the builtin shell wrapper receives that root through
`getBuiltinShellSessionReadPolicy` in
[asrt-sandbox.ts](../../src/permissions/asrt-sandbox.ts). The global read-deny
floor still protects sessions from confined plugin, MCP and terminal processes.
The builtin projection retains other sensitive paths, nested exclusions and
trusted custom read denies; a conflicting protected ancestor suppresses the
session grant. The sensitive write-deny floor remains intact.
Removing a read-deny pattern alone
does not establish this contract: both the file gates and actual sandboxed reads
must enforce the same boundary. Structured transfers retain their write-effect
checks on both endpoints.

## Structured File Transfers

`copy_path` declares `sourcePath` and `destinationPath`; `extract_archive` declares `archivePath` and `destinationPath`. Both tools are builtin writes, and both endpoint fields are declared in `pathFields`. The executor resolves these paths for the existing scope checks and write approval. Approval reuse is bound to the semantic operation and both resolved paths.

At execution, [file-access-policy.ts](../../src/tools/file-access-policy.ts) applies the existing FileTool gate with a write effect to both endpoints and every reached child. A transfer's source therefore remains confined to the invocation's admitted `cwd` and extra allowed directories even when ordinary reads are unfenced. Sensitive-path checks, canonical resolution and existing path grants retain their usual authority. Outside requests use the existing approval route; the tools do not grant themselves access or widen the roots. Allow mode does not bypass these checks.

The [structured transfer contract](architecture.md#structured-file-transfers) defines the absent exact destination, ownership, supported entries and cleanup limits. These tools add no shell exemption: recursive shell copying, archive creation and shell extraction remain denied. Guidance can recommend `copy_path` for supported copying or `extract_archive` for tar/gzip extraction; ZIP extraction and archive creation remain unavailable.

## Policy Modes

| Mode | Behavior |
| --- | --- |
| Default | Allows low-risk workspace reads; asks for mutation, network, shell, and out-of-scope access. |
| Strict | Asks for reads as well as mutation. Useful for high-control sessions. |
| Auto-review | Uses the reviewer for eligible write/network/shell calls and host-built-in `meta` calls declared with `decisionOverride: "ask"`. The same configured enabled threshold (low or medium) applies to every eligible call; higher verdicts ask or defer, while `off` keeps the explicit foreground approval path. |
| Allow | Allows after hard gates and audit. It does not bypass sensitive paths, invalid manifests, or sandbox rules. |

## Foreground And Headless Behavior

Foreground requests use one bottom-floating, non-modal approval dock because the user is present.
The dock shares the routed canvas, does not create a backdrop or focus trap, and
keeps the surrounding page readable and operable while execution remains
blocked on an explicit decision. Headless requests must not interrupt the user
with a surprise foreground surface. Non-low headless requests move to the
deferred queue and surface through a queue button or history view.

Closing a deferred modal does not grant permission and does not delete the audit
record. It leaves the item pending or closed according to the queue state.

An unanswered approval that expires is distinct from a user or parent refusal.
Host-owned expiration and rejected-request outcomes propagate through
[approval-outcome.ts](../../src/tools/pipeline/approval-outcome.ts) to tool and
directory approval results and audit reasons. Expiration does not grant access,
change the approval deadline or alter command timeouts and cancellation.

## Reviewer Failure

Reviewer input separates host-computed policy facts from OS isolation. The host
supplies the existing rule verdict, execution directory, and canonical declared
path checks using the same resolver and containment predicates as the rule
classifier. These facts describe declared operands; they do not attest that a
plugin or custom tool has no other effects. A builtin file operation running
inside the host process has no OS sandbox, but its file-path gates still apply.
Weak isolation or missing conversational purpose preserves the rule floor and
does not alone establish an out-of-scope or destructive write. The model can
still raise risk for additional effects or uncertainty, and the host retains
the maximum of the rule and model verdicts. Reviewer framework changes invalidate
cached verdicts. DLP filtering applies to the policy-fact projection as well as
tool arguments and conversation context.

Reviewer failure is not a silent allow. If the provider is missing, times out, or
returns malformed output, the host fails closed:

- foreground calls ask the user with explicit reviewer-unavailable context;
- headless calls defer or deny according to configured failure behavior;
- audit records include the reviewer failure path.

## Plugin And MCP Tools

Plugins and MCP servers use the same path as builtin tools. The tool provider
must declare schemas. Manifest categories are optional provider metadata; the
host derives the effective category per invocation and policy logic remains
host category- and origin-driven.

Low-trust MCP tools cannot lower their risk solely through a reviewer verdict
when hard policy requires explicit approval.

## Local API Permission Mutation

Local API calls that mutate permission mode route through the approval gate as
agent actions. The renderer-facing reason defaults to English. The gate owns the
final explicitness requirements and denial behavior.

## Audit Requirements

Audit records should include:

- tool name and source;
- category and permission mode;
- trust origin;
- project identity when available;
- decision and decision reason;
- reviewer verdict or reviewer failure state;
- deferred queue state for headless requests.

Audit records must not contain raw secrets or unnecessary private payload data.

## Test Coverage

The permission scenario board and unit tests under `src/permissions/__tests__`
encode the expected behavior for default, strict, auto-review, reviewer
failures, invalid plugin manifests, MCP tools, overlay prompt imports, and
headless deferred queue behavior.
