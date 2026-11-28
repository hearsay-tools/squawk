# Cache transcript facts as rebuildable projections

Message delivery and delegation reconciliation need a small set of transcript facts, not
a full replay on every check. Fold those facts as events append and save a per-run sidecar.
The transcript remains authoritative; validate the cache against plain byte length or archive
identity before use.

## Consequences

Missing, unreadable or stale sidecars rebuild from history. Hot peeks do not decode a stale
tail; readiness can schedule the fold off the main event loop. The worker that folds also
writes the rebuilt sidecar, so a slow disk write cannot block the main event loop. The index
can revoke that write first (a forgotten run, a stopped store, its own newer write), so a deleted
run gets no late sidecar. Concurrent demand shares one owner, and append integration must not
count a fact twice while a load finishes.

The cache can be deleted without changing task semantics. Its validation and cancellation
bounds matter because a stale fact can hide a question or duplicate a projection, while a
blocked initializer can prevent process shutdown.

Implementation: [transcript-facts.ts](../../packages/cezar/src/runs/transcript-facts.ts), [transcript-facts-queue.ts](../../packages/cezar/src/runs/transcript-facts-queue.ts), [transcript-facts-sidecar.ts](../../packages/cezar/src/runs/transcript-facts-sidecar.ts).

Coverage: [transcript-facts.test.ts](../../packages/cezar/src/runs/transcript-facts.test.ts), [transcript-facts-queue.test.ts](../../packages/cezar/src/runs/transcript-facts-queue.test.ts), [transcript-facts-sidecar.test.ts](../../packages/cezar/src/runs/transcript-facts-sidecar.test.ts), [store-transcript-facts.test.ts](../../packages/cezar/src/runs/store-transcript-facts.test.ts).
