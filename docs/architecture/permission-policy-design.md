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

## Reviewer Failure

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
