# Antigravity ACP fixtures

Frames recorded from the real `agy_acp_server.par` 1.5.0 on 2026-11-21 (hearsay-tools/squawk#4000),
and, in the `cli-*` files, from the Antigravity CLI `antigravity acp` 1.5.14 on 2026-11-22
(hearsay-tools/squawk#4058).
Each line is `{"t": <seconds since the agent started>, "from": "client" | "agent", "frame": <JSON-RPC frame>}`.
Host paths are replaced with `/work/...`.

Each `<name>.expected.json` holds the events the mapper makes of `<name>.ndjson`. The `cli-*`
expectations record what the 1.5.0 mapper does with CLI frames today; hearsay-tools/squawk#4060
changes them where the wire note lists a mismatch.

[`docs/runners/antigravity-wire.md`](../../../../../../docs/runners/antigravity-wire.md) says how
they were recorded, what each file shows and which runner facts they prove.
