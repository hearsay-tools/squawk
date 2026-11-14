# Bound natural-language actions to confirmed proposals

**Retired.** Voice mode is removed (hearsay-tools/squawk#3576): the ⌘K palette's voice rows,
the `/api/v1/p/:projectId/voice/*` routes, `capabilities.voice` and `packages/cezar/src/voice/`
are gone, and `HSQ_VOICE` / `CEZ_VOICE` turn nothing on. This record describes the removed
policy, not a current capability.

Voice mode sends one sentence to a typed decision engine. The engine chooses from supplied
questions and candidates; execution code consumes only applicable answers. Keep model choice
behind an engine seam, with a deterministic dry-run implementation.

## Consequences

Opening a task can execute directly. Mutations and other actions become proposals that need
a separate confirming input. The Return that submits a sentence cannot also confirm its result.
Decisions are tied to the exact input and current selection so a late response cannot take over
an action the user already selected. The server resolves meaning; browser code owns debounce,
cancellation and confirmation timing.

Implementation: [engine.ts](https://github.com/hearsay-tools/squawk/blob/523bac443f9629950c0bb23a37af12a31a3861da/packages/cezar/src/voice/engine.ts), [use-voice-command.ts](https://github.com/hearsay-tools/squawk/blob/523bac443f9629950c0bb23a37af12a31a3861da/packages/web/src/components/voice/use-voice-command.ts), [2026-10-21-voice-mode.md](https://github.com/hearsay-tools/squawk/blob/523bac443f9629950c0bb23a37af12a31a3861da/.ai/specs/2026-10-21-voice-mode.md).

Coverage: [use-voice-command.test.tsx](https://github.com/hearsay-tools/squawk/blob/523bac443f9629950c0bb23a37af12a31a3861da/packages/web/src/components/voice/use-voice-command.test.tsx).
