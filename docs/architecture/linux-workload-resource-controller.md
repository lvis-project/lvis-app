# Linux Workload Resource Controller

## Scope and status

This slice is understood as a resource-isolation foundation for future execution
routes. It does not change the current shell, plugin, MCP, or sub-agent spawn
path. It also does not make the route-neutral `disposable-container` substrate
available.

The controller has one purpose: keep the LVIS controller process outside a
per-invocation cgroup while a workload receives bounded memory and process
counts plus explicit swap and CPU settings. Swap or CPU can be configured as
unbounded. It records kernel evidence after the workload stops so an OOM can be
distinguished from an ordinary exit 137, signal, timeout, or cancellation.

A cgroup is not a filesystem, network, credential, or system-call security
boundary. It must not be advertised as the disposable execution sandbox.

## Launcher-owned delegation

The packaged process must not create or discover its own authority from an
environment variable, a model argument, or the ambient presence of Docker.
An external launcher or service manager owns the cgroup-v2 hierarchy and gives
the host an explicit delegated root plus a fresh generation value. This is
necessary because packaged processes commonly see `/sys/fs/cgroup` as read-only
and because the controller process must remain outside every workload leaf.

Before issuing a capability, the host verifies all of the following:

- the operating system is Linux and the resolved root is on a writable cgroup2
  mount;
- the current controller cgroup is outside the delegated workload root;
- the root is a `domain` cgroup with no direct processes, live descendants, or
  existing named descendants; transient kernel-owned dying descendants do not
  grant launch authority and do not block a new generation;
- `cpu`, `memory`, and `pids` are both available and enabled for children;
- the directory, `cgroup.procs`, and `cgroup.subtree_control` are writable;
- a temporary child can actually accept the limit files used by the backend and
  accepts the exact `cgroup.kill=1` write used by cleanup, then can be removed;
- the root device/inode identity and controller membership still match when an
  invocation is created.

Capability issuance and invocation creation are serialized for each canonical
delegated root. Issuance repeats the empty-root check after removing its probe
and before activating the new generation. A rotation therefore cannot pass an
empty-root check while an older generation concurrently creates a leaf.

The resulting capability is immutable, generation-bound, and accepted only by
object identity from the issuing host module. A structural copy is not
authority. A generation value cannot be reused, so rotating through `G1`,
`G2`, and back to `G1` cannot revive an older capability.

The external launcher must reserve enough memory for the controller and bound
the delegated workload subtree. Per-invocation limits alone do not provide
aggregate admission control across concurrent calls. That admission policy is a
required part of the future integration slice. Keeping the controller outside
each leaf is insufficient if the controller and workload subtree still share a
tighter memory-limited ancestor: aggregate subtree pressure could then kill the
controller. The launcher must preserve a separately budgeted controller reserve
above the bounded workload delegation.

## Invocation lifecycle

For each invocation, the backend creates a host-named, unique leaf and writes:

- `memory.max`;
- `memory.swap.max` (zero by default);
- `pids.max`;
- `cpu.max`;
- `memory.oom.group=1` when the kernel exposes it.

It captures baseline `memory.events`, optional `memory.peak`, `pids.events`, and
`cpu.stat` counters before returning a lifecycle handle.

The handle builds a fixed `/bin/sh` trampoline with an empty environment. The
shell is trusted pre-attachment code. The leaf path and target argv are
positional arguments; neither is inserted into shell source. The trampoline
writes its own PID to the leaf's `cgroup.procs` and then runs `exec "$@"`.
The target argv begins only after a successful attachment and is not joined or
reparsed as a command string.

This unwired slice does not carry a target environment. Serializing credentials
as positional arguments would expose them through process listings, while
inheriting a target-controlled loader or shell environment would activate it
before attachment. Runtime integration therefore requires a native supervisor
or another protected environment handoff that attaches before `execve` without
placing secret values in argv.

This trampoline is sufficient for the resource-controller foundation, but it
does not stop a same-UID adversarial workload from reopening a visible writable
cgroup hierarchy and migrating itself. Runtime wiring remains blocked until an
OS sandbox or launcher-owned supervisor hides the delegated parent tree from
the target, or a cgroup and mount namespace exposes only a non-escapable leaf.
The control filesystem must not remain writable and visible to untrusted target
code.

## Evidence and cleanup

Finalization follows one owner and one order:

1. If the leaf is populated, write `1` to `cgroup.kill`.
2. Wait until `cgroup.events` reports `populated 0`.
3. Read final counters and compute deltas from the baseline.
4. Remove the leaf. Removal is idempotent, and a failed removal remains owned
   and can be retried.

A transient `EBUSY` re-enters the drain/evidence sequence because a process can
arrive between the empty check and removal. `ENOTEMPTY` is different: an empty
nested cgroup survives `cgroup.kill`, so cleanup fails immediately with an
isolated-recovery error and retains ownership instead of burning the timeout.

There is deliberately no read-`cgroup.procs` then signal-by-PID fallback. PID
reuse between those two operations could terminate an unrelated process. A
kernel or delegated root without writable `cgroup.kill` cannot receive a
capability from this backend.

`resource_exhausted` with resource `memory` is emitted only when `oom` or
`oom_kill` increased. Exit code 137 and `SIGKILL` are insufficient by
themselves. Timeout, cancellation, ordinary signals, and ordinary exit remain
distinct. The result contains no fallback to a weaker host route.

## Validation

Unit tests use injected filesystem, `/proc`, clock, and UUID operations.
The real Linux integration test is skipped unless it is explicitly requested.
Once requested, an invalid platform or missing/relative path fails the test
instead of silently skipping it. The Node path must name a plain Node executable
rather than Electron:

```text
CGROUP_V2_INTEGRATION=1
CGROUP_V2_DELEGATED_TEST_ROOT=/absolute/empty/delegated/root
LVIS_TEST_NODE_EXEC_PATH=/absolute/path/to/node
```

That test proves attach-before-target execution, empty-leaf cleanup, forced
`cgroup.kill` cleanup of a live target, direct-workload and descendant-process
OOM evidence, controller PID and membership survival, and successful follow-up
invocations. The delegated test root must meet the same contract as production;
the test does not enable controllers or move the test runner on the caller's
behalf. A follow-up proves that isolating the controller prevents child OOM from
destroying its loop; it does not recover a controller that was already killed.

Before runtime integration, the following remain required: bind the resource
limits and cgroup capability generation into the execution grant, provide an
attach acknowledgement and protected environment handoff owned by the eventual
launcher, hide the writable parent hierarchy from the workload, add aggregate
concurrency admission and boot-time stale-leaf recovery, then exercise the real
product spawn path.
