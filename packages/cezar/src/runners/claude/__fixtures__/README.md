# Claude partial-message captures

`partial-text.ndjson` and `partial-thinking.ndjson` were captured live on
2026-11-26 with Claude Code **2.1.332 (Claude Code)**, model `haiku`
(`claude-haiku-5-5`). No constructed frames occur in these two fixtures.
Session/message/frame IDs, timestamps and thinking signatures are scrubbed.
Unrelated hook frames and init metadata are omitted. All other captured fields,
block indices, deltas and frame order are preserved.

Commands used piped stdin/stdout and these arguments:

```
claude --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --no-session-persistence --tools "" --model haiku
```

The text prompt was `Reply with exactly three words: hello streaming world.`
A second probe added `-p` and also emitted partial frames. Therefore `-p` is not
needed for the runner's piped transport, despite help saying partial messages
require `--print` and `--output-format=stream-json`.

The thinking probe added `--effort high` and asked:
`Think carefully about 17 times 23. Explain the calculation, then give the answer.`
It emitted empty thinking deltas and a signature, followed by text deltas.
Visible thinking deltas are covered by constructed unit-test frames based on
this captured `thinking_delta` shape; this CLI concealed the thinking text.

Observed order: `message_start`, block start, block deltas, **assistant**, block
stop, message delta, message stop, result. The thinking and text blocks each
produced a separate singleton `assistant.message.content` array with the same
`message.id`. Its array index is therefore not the streaming block index.
The stream envelopes carry `session_id`, `parent_tool_use_id: null`, `uuid`,
and `api_message_id`; the first also carries `ttft_ms` and `thinking_display`.
Tool JSON streaming was not captured live in these probes.
