# Coordinate live demand across browser documents

Visible documents share a SharedWorker owner for workspace SSE, multiplexed task SSE,
topic WebSocket subscriptions and recurring reads, in local and remote mode alike. Each document retains its own cursor and
recovery state. Leases expire dead documents; subscriber byte and task limits bound retained
work. Publishers start on first demand and stop after the last subscriber leaves.

## Consequences

Hidden documents release demand. The transport follows what connects, not the deployment
mode (hearsay-tools/squawk#4014). A remote cockpit behind a proxy that carries same-origin
cookies on upgrades and streams gets the same pushes as a local one. A different service base,
an unavailable worker, a worker request that fails authentication, or a channel that never
connects uses finite authenticated HTTP reads with backoff. A shared channel (the topic socket,
the workspace or task stream) gets `LIVE_CONNECT_ATTEMPTS` (3) attempts until it first carries a
frame; then the worker tells every document, and a document that heard it stays on finite HTTP
until its next session. The worker answers a later document the same way at once, so a proxy
that refuses the upgrade (Basic Auth, hearsay-tools/squawk#783) costs three attempts per worker,
not a loop. A stream that falls silent for 40 s counts as an attempt even after a frame (a proxy
that passes the first frame and buffers the rest); a frame 10 s into an attempt resets the count.
A channel that connected once otherwise reconnects without a limit (a server restart). Finite HTTP does not open a permanent stream in
every tab. Epochs and server generations reject stale delivery and trigger authoritative
hydration after restart.

The preview is a deliberate separate socket per open viewer. It carries binary frames and
input for one task, including remote mode, with bounded connection attempts. It does not share
the small-topic subscription bus. The older one-socket-per-tab description no longer states
the browser ownership model.

Implementation: [live-coordinator.ts](../../packages/web/src/api/live-coordinator.ts), [live-owner.ts](../../packages/web/src/api/live-owner.ts), [topic-socket.ts](../../packages/web/src/api/topic-socket.ts), [live-fallback.ts](../../packages/web/src/api/live-fallback.ts), [ws.ts](../../packages/cezar/src/server/ws.ts), [preview-socket.ts](../../packages/web/src/api/preview-socket.ts).

Coverage: [live-owner.test.ts](../../packages/web/src/api/live-owner.test.ts), [ws.test.ts](../../packages/web/src/api/ws.test.ts), [tab-coordination.e2e.ts](../../packages/web/e2e/tab-coordination.e2e.ts), [live-coordinator.test.ts](../../packages/web/src/api/live-coordinator.test.ts), [live-fallback.test.ts](../../packages/web/src/api/live-fallback.test.ts).
