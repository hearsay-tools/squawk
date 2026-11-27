# Antigravity ACP fixtures

Frames recorded from the Antigravity CLI `antigravity acp` 1.5.14 on 2026-11-22
(hearsay-tools/squawk#4058) and `1.5.18` on 2026-11-26 (hearsay-tools/squawk#4197).
Each line is `{"t": <seconds since the agent started>, "from": "client" | "agent", "frame": <JSON-RPC frame>}`.
Host paths are replaced with `/work/...`.

Each `<name>.expected.json` holds the events the mapper makes of `<name>.ndjson`
(hearsay-tools/squawk#4060). `cli-hooks.expected.json` holds the `UiHookItem` events
the transcript reader makes of `cli-hooks.transcript.jsonl` (live CLI 1.5.14
`SYSTEM_SDK` `SYSTEM_MESSAGE` rows). `cli-subagent-1.5.18.ndjson` and
`cli-subagent-1.5.18.child.transcript.jsonl` record live CLI 1.5.18 subagent
permission forwarding (`<childId>:<callId>`) and child transcript steps.

[`docs/runners/antigravity-wire.md`](../../../../../../docs/runners/antigravity-wire.md) says how
they were recorded, what each file shows and which runner facts they prove.
