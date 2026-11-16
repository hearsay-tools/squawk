# Slice 2: trigger seam evidence

2026-11-16. Implements hearsay-tools/squawk#3750. Shared workflow code does not send a
trigger in this slice. Each adapter owns its native trigger form.

## Real turns

The probe creates a git repo directly under `/tmp`, writes a native `probe-project` skill
whose body returns a random token, then drives the actual adapter. It removes the scratch
repo after the owned CLI exits. One CLI runs at a time. No credentials are read or copied.

```
node --import tsx .ai/analysis/2026-11-16-runner-native-skills/slice2-probe.mjs <runner> opening
node --import tsx .ai/analysis/2026-11-16-runner-native-skills/slice2-probe.mjs <claude|omp> mid
```

The mid-turn driver sends the native text trigger on the first native assistant/stream frame,
while the initial count reply runs. This bypasses the new seam admission rule to measure the
CLI itself. It does not wait for a normalized text delta. The seam then refuses such a send
where the measured fact is false. Slice 3 will hold that message until the current turn ends.

| Runner | Model | Token / tools | Time | Real-turn budget used | Result summary |
| --- | --- | --- | --- | --- | --- |
| Claude | haiku | returned / 0 | 3493 ms opening; 6582 ms mid check | 4, including failed hook attempt; coordinator authorized the two extra mid-check turns | [opening](slice2-claude-opening-result.json), [mid](slice2-claude-mid-result.json) |
| Codex | gpt-5.6-luna | returned / 0 | 4497 ms | 1 | [opening](slice2-codex-opening-result.json) |
| OpenCode | zai-coding-plan/glm-5.3-flash | returned / 0 | 5570 ms | 1 | [opening](slice2-opencode-opening-result.json) |
| pi | zai/glm-5.3-flash | returned / 0 | 2239 ms recorded turn | 2; first selector missed the expansion | [opening](slice2-pi-opening-result.json) |
| omp | cliproxy/gpt-5.6-luna | returned / 0 | 24109 ms | 2 | [mid](slice2-omp-mid-result.json) |

Claude queues the skill into a second turn: `skillTriggerMidTurn=false`. omp expands it within
one turn: `skillTriggerMidTurn=true`. pi stays true from the earlier real check. Codex and
OpenCode stay false. The five reports' “Slice 2 trigger checks” sections give the limits.

OpenCode's recorder returned exit 1 when Squawk sent cleanup SIGTERM, after the successful
model reply and boundary. Its summary retains that error. The wrapper now preserves signal
exit 143; the token result is evidence of native expansion, not of a clean whole session.

Claude's stdout recorder missed replay frames because its help process lacked the runner
environment. Its opening payload was recovered from the exact native session transcript,
as described in [claude.md](claude.md#slice-2-trigger-checks-2026-11-16). The summaries retain
`expansionFrames=0`. No additional paid capture was made. The driver now passes the runner
environment to help detection. These fixes do not rewrite the recorded outcomes.

## Captured native frames

`packages/cezar/src/core/__fixtures__/<runner>/skill-trigger.json` contains the minimal native
user/expansion payload. Scratch paths and random tokens are normalized. Claude also retains
the assistant text, with no thinking or signature. Other payload fields keep their native shape.
The packaged mock copy is `packages/cezar/scripts/mock-skill-trigger-data.mjs`.
`skill-trigger.test.ts` compares every copy to its fixture. The mock trigger routes clone these
payloads; they do not invent an expansion envelope. Claude's existing replay envelope carries
the native persisted payload. Fixtures were captured before those mock routes were added.

## Acceptance checks

| Criterion | Executable evidence |
| --- | --- |
| Arguments, opening context, later turn, resume, unknown id on all runners | Five `runner-skill-trigger-<runner>-parity.test.ts` files, seven rows each including invalid block position and unchanged plain-prompt whitespace; every-runner registry entry |
| OpenCode dropped command and turn beyond 300 s | `opencode-skill-trigger.test.ts`: two child commands gated by a file: one drops HTTP at once; one aborts its real fetch at a fake 300000 ms header deadline. Advance 301000 ms, require no error/boundary until gate release, then token. Only the parent deadline is fake; child/SSE keep real I/O |
| OpenCode error and receipt settlement | Same file: HTTP-only error, SSE-only error with HTTP held, and end/interrupt/process death before user ACK; receipt rejects, one boundary, v1/v2 error on native failures |
| Codex active turn/start refusal | `codex-steering.test.ts`: human and agent sends refuse synchronously during active turn or pending plain/skill start; no skill `turn/steer` and no extra `turn/start` |
| omp skill starts once above adapter | `omp-ui-mapper.test.ts` replays captured start plus repeated end messages to `skill-trigger.expected.json`; `runs/ui-event-sink.test.ts` pins persistence/live snapshots; `session-transcript.test.tsx` renders exactly one skill text, including full saved-human + runner-expansion histories for opening and mid-turn input; the saved human attachments remain. Unmatched and runner-only skill items stay visible |
| pi mid-turn correlation | pi trigger parity also sends human and agent skill triggers; the native expanded wrapper releases the human hold and consumes agent input before its reply, including literal XML and trailing spaces in arguments |
| Seam facts | Contract rows S45 unknown-name behavior, S46 mid-turn admission/expansion, S47 late skill visibility, on each native wire |
| Session identity | S3 requires one fresh session report; trigger resume rows require one same-id `resumed:true` report; OpenCode existing missing-session fallback reports false |
| Real CLI output and mid-turn facts | Real summary table above, with explicit capture limits |

## Shared-event reader sweep

`AgentEvent.session` now requires `resumed:boolean`. Every adapter reports one session per
start. Claude gains this report. pi and omp report it even when the resumed id stays the same.
The event remains v1; v2 `session.started` already has its own lifecycle.

- `workflows/run/session-events.ts` persists the reported native id and spreads the new field
  into saved events. It does not send a trigger.
- `workflows/run/launch-read-resolver.ts` checks a recorded session id when deciding whether a
  native session can resume. It does not depend on the number of reports or the new field.
- `packages/contract/src/events.ts` accepts open run-event records; no closed v1 session schema
  or API-client shim needs a new field. Saved events without `resumed` remain readable.
- The web reducer has no v1 session branch; it reads normalized UI events and turn items.
- S3, dry-run, lifecycle and continuation tests consume session reports. Typed fake producers
  now include the field. The pre-start no-session assertions stay unchanged.

A source search for `skillOf`, `openingContent`, `spec.skill` and the `skill` content variant
finds trigger delivery only in the five adapters and their adapter helper. No workflow,
launch resolver, conversation or cockpit sender uses the new trigger seam yet.

## Review correction: human skill echo

Round 1 identified that omp's skill display item duplicated the saved human `user-message`.
The transcript reducer now removes only an exact user-item echo in the same turn. It keeps
the saved human bubble, attachments and timestamp. It keeps unmatched runner user items and
runner-only skill starts. The adapter still maps and persists the native expansion once.

Native-capture guards in `skill-trigger.test.ts` check the same class on the other runners:
pi omits user expansion frames; Claude maps user tool results only; Codex omits userMessage;
OpenCode omits user text parts. None emits another UI user message for its captured expansion.

Red proof through Squeal: revision 58, run `f711e921-548e-409d-ba8b-13e0218d0a7b`.
Both `shows one human skill start ... opening input` and `... mid-turn input` failed before
the reducer change: expected zero extra user items, received one. Green verification: Squeal revision 59 reports current passing results for the full
`session-transcript.test.tsx`, `thread-state.test.ts`, and `skill-trigger.test.ts` files.
Lint, typecheck and citations also pass after the correction.
