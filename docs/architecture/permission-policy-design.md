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

### Route-neutral execution foundation

Shell authorization and execution location are separate decisions. The
route-neutral contract in
[execution-router.ts](../../src/permissions/execution-router.ts) defines three
possible substrates:

| Route | Intended boundary | Current availability |
| --- | --- | --- |
| `workspace-sandbox` | OS-enforced workspace-scoped shell | Mapped from a full ASRT shell plan. |
| `disposable-container` | Disposable Linux guest | Available through either strict same-process operator attestation or the host-native workload broker. These are distinct authorities. |
| `host` | Current-user host shell | Mapped from a legacy plain-shell plan. Existing approval rules remain authoritative. |

The Host hashes the normalized request into an immutable `EffectEnvelope`,
issues a generation-bound `ExecutionCapability`, and produces an immutable
`ExecutionPlan` with the chosen route, decision and fallback. Raw command text
does not enter the route projection. Stable identities cover the effect digest,
cwd, unresolved requirements, runtime limits, capability generation and final
decision, so a changed request or capability generation cannot reuse the same
identity. Structural lookalikes are not host-issued capabilities, plans or
grants.

`workspace-sandbox` requires the issued legacy plan to declare both filesystem
and process confinement as `true`; an omitted legacy `confines` field is not
treated as full confinement by the route-neutral layer. The capability
generation is captured with the legacy plan at issuance and must match the
route capability. A later sandbox generation cannot be paired with that stale
plan, and a grant cannot be issued after its generation becomes stale.

The legacy `HostShellExecutionPlan` still supplies workspace-sandbox and
plain-child mechanics. Without a workload broker, the router orders a full
workspace sandbox first, a live operator-attested disposable guest second, and
an unconfined host last. An active workload broker is exclusive: it advertises
only `disposable-container`, so a broker outage or rejected capability cannot
become local execution.

After normal authorization, each disposable invocation receives an immutable
one-shot `ExecutionGrant`. A shell grant binds the final command, resolved cwd,
runtime limits, legacy plan and capability generations. A canonical-file grant
binds the exact host-created tool instance, schema-normalized input, guest cwd,
broker identity and generation. The consumer checks object identity, route,
effect digest and current generations, then consumes the grant once. Missing,
forged, replayed, mismatched, expired or stale grants fail closed. Audit metadata
records the chosen route and a public-safe capability projection.

Shell path results distinguish a hard policy boundary from an
`analysis-uncertain` requirement. An uncertain default request may not select
the host route automatically. The same-process operator-attested route can
satisfy dynamic, recursive and guest path-boundary uncertainty, but it retains
the host shell grammar, structural and sensitive-path checks before spawning in
that already-confined process.

The host-native broker route has a different boundary. The controller cannot
open the workload filesystem directly, and the workload is created without
host binds, devices, Compose secrets/configs, added Linux capabilities or
controller environment. The executor therefore does not canonicalize guest
paths against the host filesystem and does not run the host Bash structural
parser on a command that the broker executes inside the guest. Guest paths are
normalized with POSIX semantics against the capability-bound guest cwd or HOME.
Normal tool authorization, reviewer policy, audit, request bounds and deadlines
remain mandatory. PowerShell has no broker backend and fails closed.

The [Linux workload resource controller](linux-workload-resource-controller.md)
is a separate unwired foundation. Its cgroup-v2 leaf limits and OOM evidence do
not issue either disposable authority. The Docker broker independently binds
and revalidates the exact container cgroup's `memory.events` for OOM evidence.

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
analysis. Outside an operator-attested guest, host mode selects plain execution
without OS confinement and requires a fresh exact-action `allow-once`, including
in allow mode or when sandboxing was already disabled. Sensitive-path,
directory, command and dynamic-syntax checks remain mandatory on that route.

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

Inside a live operator-attested disposable one-shot, `executionMode: "host"`
means the strongest shell authority reachable by that process, which is still
the disposable guest. The router therefore selects `disposable-container` and
does not present or require an approval for an unconfined host it cannot reach.
If reacquisition fails or the capability changes before grant issuance, the
invocation fails closed instead of degrading to a plain host child.

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
session grant. `getBuiltinShellReadPolicy` composes invocation reads for both
shell dialects. It omits redundant read grants strictly above HOME, which
otherwise cause the native runtime to reapply the HOME deny after narrower
grants. Surviving read candidates cannot reopen another protected deny; write
grants and the sensitive write-deny floor remain intact.
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

Process-level approval availability is a separate host capability. Native
`--exec` keeps the normal main-chat tool and egress scope rather than setting
the routine `headless` flag. When its policy outcome still requires explicit
authorization, the host emits a typed `authorization-required` terminal and
does not let the model retry the denied action. Out-of-directory requests may
still be recorded in the deferred queue, but the one-shot turn terminates with
the same control outcome because it has no UI in which to settle that request.
Routine loops keep their existing `headless` deny/defer/reviewer semantics even
when the containing process also lacks an approval surface.

Closing a deferred modal does not grant permission and does not delete the audit
record. It leaves the item pending or closed according to the queue state.

An unanswered approval that expires is distinct from a user or parent refusal.
Host-owned expiration and rejected-request outcomes propagate through
[approval-outcome.ts](../../src/tools/pipeline/approval-outcome.ts) to tool and
directory approval results and audit reasons. Expiration does not grant access,
change the approval deadline or alter command timeouts and cancellation.

### Headless operator container attestation

A Linux one-shot launch may name an operator-produced attestation with
`--exec-operator-attestation=<absolute-path>`. An explicit attestation is
verified before the service graph, model connection, or installed plugins
start. Absence preserves the ordinary headless behavior. The option is invalid
without `--exec`, with `--set-secret`, or on a non-Linux host.

The JSON document is limited to 64 KiB, rejects duplicate and unknown members,
and has these exact top-level fields: `version`, `audience`, `keyId`,
`issuedAt`, `notBefore`, `expiresAt`, `claims`, and `signature`. Version is
`lvis-operator-container-attestation/v1`; audience is `lvis-headless-exec`.
The host opens one regular-file descriptor and bounds the read to 64 KiB plus
one rejection byte, so a metadata race cannot cause an unbounded read. The
validity window is at most five minutes. `signature` is an Ed25519 signature
over the canonical JSON encoding of the other seven fields: object keys are
sorted recursively by UTF-16 code units, arrays retain their input order,
strings and the schema's safe integers use `JSON.stringify` encoding, and the
result is signed as UTF-8 bytes.

`keyId` selects only
`/etc/lvis/operator-trust.d/<keyId>.pub`. The document cannot carry a public
key. The trust directory must resolve to that fixed canonical path, be owned by
root, exclude group and other writes, and reside on a read-only mount. The host
opens the directory and PEM public-key file without following their final path
components, resolves the opened descriptors through `/proc/self/fd`, and
requires both descriptors to identify the same read-only mount. It obtains
metadata and bytes from that one opened key descriptor. The key must resolve
within the directory, be root-owned, have no write bits, and contain an Ed25519
public key. Tests may inject a different root into the non-authoritative
verifier, but the production issuer cannot select one from the command line or
environment.

The signed `claims` object contains exact fields for:

- operator-established `disposable`, `noHostMounts`, `noHostNamespaces`, and
  `noInheritedSecrets` assertions, all set to true;
- the current mount, PID, network, IPC, UTS, cgroup, and user namespace links;
- the cgroup v2 membership path and finite `memory.max`, `pids.max`, and
  `cpu.max` values, read through descriptors on one read-only cgroup v2 mount;
- a normalized mount-info digest and normalized root-mount tuple;
- the boot ID, PID, and `/proc/self/stat` start-time ticks;
- the normalized `uid_map` and `gid_map`, each fixed to the full host identity
  mapping `0 0 4294967295`;
- all four real/effective/saved/filesystem user IDs plus `NoNewPrivs`, `Seccomp`,
  `CapInh`, `CapPrm`, `CapEff`, `CapBnd`, and `CapAmb` from `/proc/self/status`.

The verifier reads those facts from the current process and requires an exact
match after signature verification. `NoNewPrivs=1`, seccomp filter mode,
non-root real, effective, saved, and filesystem user IDs, full host identity
maps, and finite resource limits are mandatory. Every signed capability set
must exclude
`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`, `SYS_ADMIN`,
`SYS_PTRACE`, `SYS_MODULE`, `SYS_RAWIO`, `NET_ADMIN`, `BPF`, `PERFMON`, and
`CHECKPOINT_RESTORE`; other signed bits remain visible to later policy rather
than being rejected implicitly. The membership path is interpreted relative to
the cgroup namespace root; the host does not compare it with mountinfo's
host-relative cgroup root. It opens the membership directory and each limit
file, then rejects any descriptor whose mount ID differs from the selected
cgroup v2 mount or whose kernel filesystem type is not cgroup v2.

The verifier resolves `/proc/self` once to `/proc/<pid>` and uses only that
numeric path for process observations. The process files `mountinfo`, `cgroup`,
`status`, `stat`, `uid_map`, and `gid_map` must be opened on the procfs mount
covering that numeric directory; namespace and `fdinfo` paths must use that same
mount rather than a nested proc bind. Independent `statfs` checks require the
kernel's procfs magic before mount-table contents are trusted. The boot ID may
reside on another procfs submount. These checks and the host identity maps stop
an unprivileged user namespace from substituting a namespace-local UID-0 trust
root. A privileged host administrator remains inside the operator trust
boundary. The signed mount digest exposes the remaining procfs view to the
operator.

The signer must run outside the attested process's namespaces, keep its private
key unavailable to the process, and observe the exact target PID from the host
side after creation. It must independently establish the no-host-mounts,
no-host-namespaces, no-inherited-secrets, disposable-lifecycle, and limit
claims. The signer also owns termination and disposal enforcement. The host
verifier cannot derive those host-relative properties from inside the
container.

Successful production verification issues a frozen, host-owned capability
tracked by weak identity. Injectable verification used by tests returns only
inert evidence and cannot invoke the private capability issuer. Public and
audit projections contain only an ID, generation, expiry, fingerprints, the
four boolean isolation assertions, and resource limits. They contain no
signature, public-key bytes, process fields, namespace links, paths, or mount
inventory. The signed v1 expiry remains an authority deadline: production
checks it before publication, at every acquire, again after the asynchronous
process/confinement observation, and synchronously when a one-shot lease is
consumed. Every acquire also re-reads and matches the exact process identity,
namespaces, cgroup, mounts, status and limits. A long-lived operator must obtain
a newly signed attestation; renewal semantics must use an explicit new contract
if they differ from v1. Each
grant-minting acquire returns a nominal lease bound to that exact capability
generation, and execution-grant issuance consumes the lease once. A forged,
replayed, or stale lease cannot mint a grant. Controller termination revokes
the in-memory capability and all leases; attested-process termination changes
the observed process identity and makes the next acquire fail. These lifecycle
events and the signed expiry are the v1 revocation boundaries.
The grant-minting acquire runs after asynchronous PreToolUse hooks, plugin
admission, rate checks, and audit-readiness checks. The handler receives the
grant at the final effect boundary, with no intervening await that could make
the observed confinement stale before dispatch.

The execution router consumes this capability only for builtin shell work in
the same attested Linux one-shot. The capability does not itself authorize a
tool,
skip structural command checks, alter reviewer outcomes, or make a non-attested
process disposable. The v1 profile remains strict: the four isolation claims,
including no host mounts and no inherited secrets, are all mandatory. Workloads
that need a bounded artifact mount or a different capability set require a
separately specified profile/version and cannot weaken v1 by convention.
The benchmark Docker `main` process therefore uses the separate broker contract
below rather than presenting itself as this attested process.

### Terminal permission-audit proof

The native runtime exposes one internal pre-boot command,
`--verify-permission-audit=<challenge>`, for a stopped host. The 64-lowercase-
hex challenge binds a public `lvis-permission-audit-proof/v1` receipt to its
collector. The verifier requires explicit absolute `LVIS_HOME` and protected
`LVIS_SECRET_KEY_FILE` inputs, opens the existing encrypted audit HMAC secret
read-only, and never creates, repairs, or replaces audit authority.

Every permission-audit-looking directory entry must have the canonical
`YYYY-MM-DD.permission-audit.jsonl` name. The verifier stable-opens each
owner-only 0600 regular single-link file, verifies its complete HMAC chain and
the separately stored daily seal for every nonempty file, and rejects directory
or file changes during the read. Success writes exactly one public JSON receipt
with basename/date/SHA-256/byte/entry metadata. Secret material, stored seals,
paths, rows, and entry fields never cross this boundary. `AuditLogger.close()`
stops new permission appends and drains the accepted append tail before this
proof may freeze the files.

The packaged launcher removes the inherited Node preload/module-search and
Node/Electron process-role variables named by
`lvis-headless-launch-environment/v1` before starting the runtime. The native
dispatcher reserves bare, malformed, and duplicate proof forms, so none can
fall through into normal host boot. Failure output is one stable public error
code (`invalid-arguments` before verification or `verification-failed` after
it starts); raw filesystem and decryption errors remain inside the process.

### Host-native workload broker

The brokered Linux route keeps the LVIS controller, controller profile,
encrypted provider secret, external key, broker credential, receipts and logs
on the host. Harbor's incoming mounts and persistent controller environment are
discarded. Task files and role logs cross later through Docker copy; `main`
receives no host bind, Docker socket, capability file, Unix socket, receipt or
controller environment.

The environment binds the route to exactly one Docker Compose service
`main` container. The published workload identity contains the 64-hex container
ID, `sha256:` image ID, fresh generation, boundary fingerprint, guest cwd and
guest HOME. The broker's host-only binding additionally pins Docker `StartedAt`,
the trial ID and Compose project/service/container-number labels. Startup
rejects effective Compose configuration with host binds,
devices, device rules, `cap_add`, Compose secrets/configs, privileged mode,
host PID/IPC/UTS/network/user namespaces or controller transport environment.
Before every effect, the broker rechecks the exact container and image,
`StartedAt`, labels, running state, no binds or devices, private cgroup
namespace, finite memory/swap/PID limits, `no-new-privileges`, non-host
namespaces and no-restart policy. It also pins the container's cgroup-v2
`memory.events` device/inode and `memory.max`.

The host publishes `lvis-workload-broker-capability/v1` only after Docker event
monitoring and identity evidence are live. The document contains the absolute
socket path, a random bearer token of at least 32 bytes, UTC expiry, exact
workload identity, ordered allowed operations and request/response byte limits.
It is one owner-owned mode `0400` regular file in a host-only mode `0700`
control directory. The socket is mode `0600` in a separate owner-owned mode
`0700` directory. LVIS rejects symlinks, changed inode metadata, wrong owners or
modes, an unbound socket path, expiry and handshake field/order mismatches before
constructing host services. The capability read holds its real parent directory
open and rechecks both the directory and file path bindings before accepting the
document. It repeats the exact handshake before every operation.

Only host-created builtin Bash and canonical file-tool instances can receive
broker grants. Canonical file operations are `read`, binary read, list, glob,
grep, write, edit, patch, move, copy, extract and delete. Background Bash start,
read and kill retain the same broker capability and session ownership. A plugin
or MCP tool that copies a builtin name or schema is not canonical and receives
no grant. Once broker mode is active, missing or invalid authority returns a
typed broker error and never calls a host shell, host path resolver or local
file implementation.

Foreground and background shell terminals use the closed statuses `exited`,
`signaled`, `timed-out`, `cancelled`, `oom-killed`, `transport-failed` and
`cleanup-unproven`. A terminal result carries exit code, signal, timeout and
cancellation flags, cgroup OOM delta, `ownedResourcesZero` and the hash-chained
receipt digest. `oom-killed` requires an increased cgroup-v2 OOM counter; exit
137 or `SIGKILL` alone is insufficient. Timeout, cancellation, transport
failure or unproven identity triggers fail-closed removal when the broker cannot
otherwise prove the Docker exec is gone. `cleanup-unproven` is the only terminal
status allowed to report `ownedResourcesZero=false`.

The host controller runs under a separate Linux child subreaper. After the turn,
the supervisor terminates and reaps the controller process group and adopted
descendants, and publishes its own zero-resource receipt. Broker release then
stops accepting requests, proves that broker-owned exec handles are zero,
removes the bearer capability and socket, and records `broker_released` while
retaining the exact running `main` container for the shared verifier. If that
proof fails, the broker removes `main` and verification is suppressed. Final
environment teardown force-removes the exact container, proves its absence,
records `cleanup_completed` and `broker_stopped`, and then removes remaining
Compose resources. These receipts validate lifecycle ownership; they do not
claim a benchmark score or task correctness.

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

A windowless host reports `authorization-required` only after a completed
policy outcome actually needs human consent. Missing reviewer wiring, timeout,
malformed output, and provider failure remain ordinary failed assessments;
exit `77` does not claim that approval can repair them.

An unavailable or failed assessment does not prevent the user from remembering
an ordinary request. The approval gate derives `persistentAllowAllowed` from
host-owned request context and typed reviewer outcomes. The dispatcher issues
exact-input-bound evidence from its existing raw-input rule trace; the gate
uses this evidence without reclassifying display data. A conservative HIGH
display during assessment failure is separate from a completed HIGH judgment.
Completed HIGH judgments, changed sandbox state and mandatory one-shot requests
retain their restrictions, including explicit host execution, remote controllers
and sealed rationale approvals.

“Always allow” stores the exact tool, canonical arguments, source, trust origin
and invocation working-directory identity. Existing tool-specific identity and
the host shell's sealed execution plan remain part of the key. The versioned
directory scope prevents reuse across projects. Older unscoped allows no longer
match scoped requests; existing policy rules and exact denials retain their
identity and precedence. Exact rejections remain independent of cwd. The host
captures the canonical directory before displaying its scope and recording its
frozen identity. The UI does not create a wildcard rule. Recording
requires fresh user intent and a live host approval snapshot. On subsequent
calls, hard denies and per-invocation approval requirements still run before the
remembered-decision lookup. Both memory consumers compare current deterministic
risk with the stored reuse ceiling, separately from conservative display risk.

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
