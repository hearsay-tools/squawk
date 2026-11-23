import type { Wait, WorkerWaitEntry } from '@open-mercato/cezar-contract';

/**
 * Store-side wait rules: leaf helpers the run store reads without importing `workflows/`.
 * `workflows/run/wait-kinds.ts` and `workflows/waits.ts` reuse them, so each rule has one definition.
 */

/** The one wait kind the user answers. */
export function isUserAnsweredKind(kind: Wait['kind']): boolean {
  return kind === 'human';
}

/** A human question: the one wait kind the user answers. */
export function isHumanWait(wait: Wait): wait is Extract<Wait, { kind: 'human' }> {
  return wait.kind === 'human';
}

/** A wait the user answers: only a human question. */
export function isUserAnsweredWait(wait: Wait): boolean {
  return isUserAnsweredKind(wait.kind);
}

/** What a superseded subagent wait records as its result. */
export const SUBAGENT_SUPERSEDED_RESULT = { reason: 'superseded' } as const;

/** The result a superseded wait of this kind records; undefined for a kind that keeps none. */
export function supersededResult(wait: Wait): { reason: 'superseded' } | undefined {
  return wait.kind === 'subagent' ? { ...SUBAGENT_SUPERSEDED_RESULT } : undefined;
}

/** Squawk's own human wait (`no-wait`, `budget`): it stands in for a wait the agent never registered
 *  and is replaced by the agent's own (hearsay-tools/cezarion#1234), so the agent is never told of
 *  it as one of its waits. */
export function isSquawkHumanWait(wait: Wait): boolean {
  return isHumanWait(wait) && wait.source === 'cezar';
}

/** The agent input that delivers a resolved wait's result: the wait's own id, or for an upgraded
 *  worker wait whose wake was already queued, that input (`wakeInputId`). */
export function waitInputId(wait: Wait): string {
  return wait.kind === 'worker' ? (wait as WorkerWaitEntry).wakeInputId ?? wait.id : wait.id;
}
