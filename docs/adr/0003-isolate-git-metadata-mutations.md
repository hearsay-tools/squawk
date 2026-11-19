# Isolate Git reads and serialize shared mutations

Git diff operations can refresh an index, and intent-to-add writes it. Cezar reads diffs
through a private index so concurrent autosave and inspection do not compete for the task’s
real index. The copy retains the source mtime so same-size edits in Git’s racy timestamp
window remain visible.

## Consequences

Scratch indexes try the OS temp directory and then the Git directory. If neither works,
the read uses the real index instead of reporting an empty diff. That fallback is not the
normal isolation guarantee. A worktree under read-only `.ai/squawk` project data refuses
instead of using the real index (`fallbackProjectWriteError`).

Worktree mutations use a separate cross-process lock keyed by the canonical Git common
directory. A short-lived keeper owns the lock and its Git children until they exit, even if
the caller disconnects. A git killed at its timeout leaves its children in the keeper's
process group, so cleanup after a timeout proves the group has exited (Linux: the `/proc` member
list, then the group probe) before it retries, rolls back or releases the claim; where it cannot
prove that, the state is unknown and the claim stays, except on Windows, which has no group probe
and releases it while skipping the rollback and retry (hearsay-tools/squawk#3941). Task branches use `--no-track`; explicit base refs make upstream
configuration unnecessary and avoid a shared config write.

## Considered Options

- **Read through the live index.** Retained only as a degraded fallback; normally it races staging and commits.
- **Expire a mutation lock by heartbeat.** The keeper instead ties release to child completion, so a slow or stopped Git command cannot overlap a new mutation.

A claim may name its operation and its owner (task or worker id). A waiter that times out names the holder by its keeper PID, with the operation and owner when the claim carries them; a caller may extend its wait by a fixed amount per claim queued ahead of it, up to 10 minutes (hearsay-tools/squawk#3817).

Implementation: [git-index-copy.ts](../../packages/cezar/src/git-index-copy.ts), [git-worktree-lock.ts](../../packages/cezar/src/git-worktree-lock.ts), [git-worktree.ts](../../packages/cezar/src/git-worktree.ts).

Coverage: [git-index-copy.test.ts](../../packages/cezar/src/git-index-copy.test.ts), [git-worktree-lock.test.ts](../../packages/cezar/src/git-worktree-lock.test.ts), [git-changes.test.ts](../../packages/cezar/src/server/git-changes.test.ts).
