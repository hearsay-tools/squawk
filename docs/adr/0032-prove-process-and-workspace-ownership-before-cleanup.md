# Prove process and workspace ownership before cleanup

A worker's processes belong to it because Squawk started them inside the worker's **scope**, never
because they use the worker's files. A process that works in a worker's worktree or scratch but
was not started in its scope is not the worker's: destroy, Continue and scratch cleanup never
signal it and never wait for it (hearsay-tools/squawk#2180). Squawk does not scan the host's
processes to decide anything about a worker.

## The scope

Every process Squawk starts for a worker starts inside its scope: worktree setup, every runner
session (and each Cursor turn, each OpenCode or OMP respawn), `check` steps, and what those
processes start in turn. Shared controller work (Git helpers, the cockpit) stays outside. The
scope lives from the worker's first spawn to its destroy, across Continue; a settled run does not
require an empty scope, so a worker's Squeal daemon or test server may keep running in it.

The controller picks one backend at start and logs it; it never changes inside that controller:

| Host | Backend | Guarantee |
| --- | --- | --- |
| Linux where a real probe can create, enter, kill and remove a child cgroup v2 | `cgroup`: a private child of the controller's own cgroup, `squawk-worker-<id>`. Each command runs as `sh -c 'echo 0 > <cgroup>/cgroup.procs && exec "$@"'`, so it places itself before it runs; a failed move runs nothing | `contained`: every descendant, `setsid` and Node `detached` included, ends with the scope |
| macOS, Linux without delegation, Windows until its Job Object helper lands | `groups`: the process groups of the leaders Squawk started | `scoped`: a descendant that leaves its group (`setsid`, `detached`) can survive destroy. The owner accepted this limit for macOS on 2026-10-29 and for Linux without delegation in hearsay-tools/squawk#2180 |

There is no runtime fallback. A backend error fails the spawn or the destroy step that met it;
it never switches to another mechanism. `hsq worker inspect` reports `scope.backend` and
`scope.guarantee`.

The scope record (`<run>.scope.json`, private, written with fsync and an atomic rename) names
every cgroup and recorded group the worker owns. A cgroup is recorded before it is created and
before anything enters it, so a crash at any point leaves nothing unrecorded. A record holds both
kinds, so a worker continued by a controller that runs elsewhere is stopped whole. A worker from
before scopes has its session groups only in its execution record (`<run>.processes.json`); the
scope reads them from there, so destroy has no separate path for it.

A recorded group is signalled while its leader is alive and is the recorded incarnation. A group
whose leader is gone keeps its number while it has members, and the kernel does not reuse a pid
while a group of that number exists; reuse needs the group to empty first. So a leaderless group
counts only where the record proves the current boot: on Linux the start token carries the boot
id, and a token from another boot is refused. The residual is a pid space that wraps within one
boot while the worker lives. On macOS (no boot id, a small pid space) a leaderless group is never
signalled; while the controller runs, a session group is reaped when its leader exits
(`core/session-process.ts`), and what a leaderless group keeps after a crash is outside the
`scoped` guarantee. A start that would
exceed the recorded-group cap is refused; a live group is never forgotten to make room.

## Lifecycle

- **Admission and Continue** refuse while another live Squawk controls the worker. A crashed
  controller's leftovers do not refuse: Continue SIGKILLs everything in the scope, waits briefly
  for the recorded session processes to end, settles the old generation and starts the new one.
  Recovery can settle a crashed generation first, once its recorded sessions are gone; it marks
  the checkpoint `interrupted`, so the next Continue still stops what the crash left in the scope.
  A generation that finished normally keeps its services across Continue.
- **Reclaim and history deletion** (retention, family end, `deleteRun`) need an empty scope as
  well as dead recorded processes: a service the worker left running still uses its worktree.
- **Destroy** runs one path, and every scheduled retry runs it in full:
  1. persist the destroy intent; from here the scope starts nothing new;
  2. stop the run and run the project's optional `worktreeTeardown` commands in the worktree
     (hearsay-tools/squawk#914), after proving the worktree is the one its receipt and identity
     marker name, at its own real path, so registered services stop gracefully while their root
     exists;
  3. prove the execution ended (a crashed generation: kill the scope, then wait for its recorded
     session processes);
  4. stop the scope, unless the generation's record names another live Squawk (then destroy
     stays incomplete and signals nothing): kill, wait until empty, remove each cgroup; kill the
     recorded groups and wait until each has no running process: its recorded leader, or for a
     leaderless group of ours a member that is not a zombie (a group of zombies under an init that
     never reaps still answers `kill(-pgid, 0)` and is never waited for). What cannot be
     stopped stays recorded and the destroy stays incomplete with `process` remaining;
  5. preserve the worker's result, diff and artifacts for the parent, then remove the worktree,
     its Git registration and its branch with the checks below; retry only Git or file-system
     failures;
  6. persist completion.
- **Scratch** (the agent's temp directory) is removed once the generation completed, its
  recorded processes are gone and its scope holds no process.
- **Workers from before scopes** have no scope record; their session groups in the execution
  record are the scope, under the same rules.

## Workspace checks

Persist intent before deletion and compare branch tip/reflog content, not inode identity, before
removing owned Git state. Cleanup and admission checks must not yield between their final
ownership check and mutation. Unknown evidence retains resources and retries.

On Windows, receipt directories, receipts, cleanup checkpoints and Git administration
markers use protected ACLs owned by the current user. Only that user, SYSTEM and
administrators may have access. An existing broader ACL is refused, never silently
repaired. The native helper validates the security descriptor and object type through
the open handle; it rejects reparse points and hard-linked identity files. It pins
ancestor directories without delete sharing while reading, creating or replacing an
identity. Checkpoints use a flushed temporary file and a handle-based atomic rename,
so an interruption preserves either the old or the new checkpoint. An incomplete
temporary file cannot authorize cleanup. This store requires a local drive with Windows
ACL support; unsupported or unreadable evidence retains resources. Windows refuses to delete
a directory another process holds open, so there the removal stays incomplete and names the path.

The ownership policy (`delegation/workspace-record.ts`, used by `workspace.ts` and
`workspace-removal.ts`) reaches these files only through the
`IdentityFileStore` port (`delegation/identity-file-store.ts`): directory, read, write and
replace. The POSIX store (`posix-workspace-identity.ts`) is the default on a non-Windows host.
On Windows the policy has no default and throws until a store is installed. Each process entry
that reaches the policy calls `installWindowsIdentityStore()` from `windows-identity-store.ts`.
Only process entries reach that module or the native helper `windows-workspace-identity.ts`,
so the policy's importers never load the Windows store.
`identity-store-entries.test.ts` holds both rules.

## Consequences

Destroy no longer refuses because an editor, a shell or another task's process works in the
worktree: those processes keep running with a deleted directory. On a `scoped` host, a detached
descendant the worker started can outlive destroy; teardown commands are the way to stop such a
service. Do not state that every descendant is always killed on such a host.

Session process groups (`core/session-process.ts`) still reap what a runner leaves in its own
group when the leader exits, and forward Squawk's own SIGINT/SIGTERM to them.

The test environment's lease, its idle-app watcher and their holder reclamation belong to the
repository's own scripts (`.ai/scripts/test-env-lease.mjs`), not to destroy: the product ships
no test-environment code (hearsay-tools/squawk#3515). Autosave keeps its own cwd observation
(`autosave-holders.ts`); it never decides a worker's cleanup.

Implementation: [worker-scope/](../../packages/cezar/src/worker-scope/), [session-process.ts](../../packages/cezar/src/core/session-process.ts), [worker-orphans.ts](../../packages/cezar/src/workflows/run/worker-orphans.ts), [worker-cleanup.ts](../../packages/cezar/src/delegation/worker-cleanup.ts), [workspace.ts](../../packages/cezar/src/delegation/workspace.ts), [workspace-record.ts](../../packages/cezar/src/delegation/workspace-record.ts), [workspace-removal.ts](../../packages/cezar/src/delegation/workspace-removal.ts), [worktree-teardown.ts](../../packages/cezar/src/delegation/worktree-teardown.ts).

Coverage: [worker-scopes.test.ts](../../packages/cezar/src/worker-scope/worker-scopes.test.ts), [cgroup.test.ts](../../packages/cezar/src/worker-scope/cgroup.test.ts), [session-process.test.ts](../../packages/cezar/src/core/session-process.test.ts), [workspace.test.ts](../../packages/cezar/src/delegation/workspace.test.ts), [workspace-destruction-identity.test.ts](../../packages/cezar/src/delegation/workspace-destruction-identity.test.ts), [workspace-destruction-refs.test.ts](../../packages/cezar/src/delegation/workspace-destruction-refs.test.ts), [workspace-generic-cleanup.test.ts](../../packages/cezar/src/delegation/workspace-generic-cleanup.test.ts), [scratch-cleanup.test.ts](../../packages/cezar/src/delegation/scratch-cleanup.test.ts) and the `worker-scope-native` CI job.
