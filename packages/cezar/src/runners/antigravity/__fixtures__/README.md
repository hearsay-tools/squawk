# Antigravity ACP fixtures

Frames recorded from the Antigravity CLI `antigravity acp` 1.5.14 on 2026-11-22
(hearsay-tools/squawk#4058).
Each line is `{"t": <seconds since the agent started>, "from": "client" | "agent", "frame": <JSON-RPC frame>}`.
Host paths are replaced with `/work/...`.

Each `<name>.expected.json` holds the events the mapper makes of `<name>.ndjson`
(hearsay-tools/squawk#4060).

[`docs/runners/antigravity-wire.md`](../../../../../../docs/runners/antigravity-wire.md) says how
they were recorded, what each file shows and which runner facts they prove.
