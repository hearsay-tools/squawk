# Pending asks

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/contract/src/pending-ask.ts`, then `packages/cezar/src/workflows/run.ts` and `workflows/run/`

## Rules

The pending ask is built once from a run's `ask.requested` events by `pending-ask.ts`. Worker routing, the cockpit card, `hsq task status` and the task webhook read it from there; the oxlint AST rule `cez/ask-requested-read-outside-projection` checks equality comparisons and case labels with `ask.requested` in `.ts` files. It does not detect a direct `event.questions` read from an already typed event without a type comparison. Callers must still use the projection; the guard cannot catch every bypass. A new field goes in the projection's two output maps, `askStatusFields` and `askCardOf`, and `pending-ask.test.ts` stops compiling until it is placed. `hsq task status` and the webhook read the `ask.requested` event, not the human wait, so a design that follows the wait misses them. `workflows/run.ts` only writes the event and opens the human wait (hearsay-tools/cezarion#1471: `context` missed the CLI and webhook).

A human wait belongs to the question its `askSeq` names (`run/human-waits.ts`). `openHumanAlias` reuses only a wait with the caller's owner: Squawk's alias shares Squawk's own wait, and an agent's question shares an agent wait not shown yet or shown for the current question. An `answered` outcome with an `askSeq` settles Squawk's own waits and leaves open only an agent's wait shown for a later question. Code that asks whether a question is pending calls `isQuestionPending`, which reads the open human wait rows (hearsay-tools/squawk#1293).
