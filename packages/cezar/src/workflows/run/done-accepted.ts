import type { AgentInput, RunEvent } from '@open-mercato/cezar-contract';
import type { DoneOwedInput } from '@open-mercato/cezar-contract/waits';
import type { RunRecord } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import { resolvedWaits, waitInputId } from '../waits.ts';
import { harnessHoldsHumanInput } from './input-timers.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import { acceptedDoneHolds } from './turn-settler.ts';

/**
 * Reads of the accepted-done record (`RunRecord.doneAccepted`, ADR 0064,
 * hearsay-tools/squawk#2587). `run-finish.ts` records it and `turn-settler.ts` decides at each
 * turn end whether it still holds; this module only reads: what the run still owes the agent when
 * it calls `cezar_done`, and the facts recorded after it.
 */

/** An agent input that asks something of the agent: a request or follow-up from a peer or the
 *  family, or the parent's instruction to its worker. A progress note, a reply and a lifecycle
 *  observation ask nothing. */
function instruction(input: AgentInput): string | undefined {
  if (input.source !== 'agent') return undefined;
  if (!input.conversation) return 'a new instruction from the parent';
  if (input.conversation.kind !== 'request' && input.conversation.kind !== 'follow-up') return undefined;
  return input.conversation.relationship === 'peer' ? 'a new peer request' : 'a new agent request';
}

/** Why the input `inputIds` names withdraws an accepted done, or undefined when it keeps the done:
 *  a failed wait result or a new instruction. */
export function reconsideredBy(run: RunRecord, inputIds: readonly string[]): string | undefined {
  const ids = new Set(inputIds);
  const failed = resolvedWaits(run).find(wait => ids.has(waitInputId(wait)) && WAIT_KINDS[wait.kind].failedResult(wait));
  if (failed) return `a failed ${failed.kind} wait result`;
  for (const input of run.agentInputs ?? []) {
    const reason = ids.has(input.id) ? instruction(input) : undefined;
    if (reason) return reason;
  }
  return undefined;
}

/** What the run still owes the agent when it calls `cezar_done` (`input_pending`): resolved wait
 *  results not yet delivered, input queued for it, a human follow-up its harness holds, a
 *  submission still waiting for its acknowledgement, and input its harness acknowledged but the
 *  model has not read: an acknowledgement is not a read. Input the harness reported read is this
 *  turn's own, as are the input submitted at the boundary that opened this turn (a harness may
 *  report its read only when the turn completes) and a continuation's opening input. A harness
 *  that cannot report reads takes input only at a turn boundary, so what it holds opened this turn. */
export function owedAtDone(run: RunRecord, state: ActiveRun): DoneOwedInput[] {
  const input = state.inputState;
  const flight = new Set(input.agentInputFlight?.inputIds ?? []);
  const unread = notReadYet(state);
  const results = resolvedWaits(run);
  const resultIds = new Set(results.map(waitInputId));
  const owed: DoneOwedInput[] = results.filter(wait => !flight.has(waitInputId(wait)))
    .map(wait => ({ kind: 'wait_result', wait_id: wait.id, wait_kind: wait.kind }));
  for (const id of flight) if (unread(id)) owed.push({ kind: 'in_flight', input_id: id });
  const awaiting = new Set([...input.unreadInputIds ?? [], ...(run.agentInputs ?? []).filter(entry => entry.awaitingRead).map(entry => entry.id)]);
  for (const id of awaiting) if (!flight.has(id) && unread(id)) owed.push({ kind: 'unread', input_id: id });
  for (const queued of run.agentInputs ?? []) {
    if (queued.deliveredAt || resultIds.has(queued.id) || queued.id === input.openingAgentInputId || flight.has(queued.id)) continue;
    owed.push({ kind: 'queued', input_id: queued.id, source: queued.conversation?.relationship === 'peer' ? 'peer' : queued.source });
  }
  if (harnessHoldsHumanInput(state)) owed.push({ kind: 'queued', source: 'human' });
  return owed.slice(0, 64);
}

/** Whether input handed to the harness is still unread by the model (`owedAtDone`). */
function notReadYet(state: ActiveRun): (id: string) => boolean {
  const input = state.inputState;
  if (input.inputDelivery?.consumption !== 'observable') return () => false;
  const thisTurn = new Set([...input.turnOpenerIds ?? [], ...input.consumedBeforeAck ?? [], ...(input.openingAgentInputId ? [input.openingAgentInputId] : [])]);
  return id => !thisTurn.has(id);
}

/** Recorded after the accepted done (strictly later than `at`): the first instruction among the
 *  agent inputs, on any path (a steer, an inbox read, a continuation's opening input). */
export function instructionAfter(run: RunRecord, at: string): string | undefined {
  for (const entry of run.agentInputs ?? []) {
    const reason = entry.createdAt > at ? instruction(entry) : undefined;
    if (reason) return reason;
  }
  return undefined;
}

/** Every wait the run holds or settled, but cancelled ones. */
function liveAndSettledWaits(run: RunRecord) {
  return [...run.waits ?? [], ...run.lastWaits ?? []].filter(wait => wait.phase !== 'cancelled');
}

/** A wait result that failed and resolved after the done. */
export function failedResultAfter(run: RunRecord, at: string): string | undefined {
  const failed = liveAndSettledWaits(run).find(wait => (wait.resolvedAt ?? '') > at && WAIT_KINDS[wait.kind].failedResult(wait));
  return failed && `a failed ${failed.kind} wait result`;
}

/** A wait or a question the agent registered after the done, by any path: the tool, the CLI, a
 *  native ask. A replayed registration keeps its first time, and Squawk's own waits and its
 *  live-workers timer are not the agent's. */
export function registeredAfter(run: RunRecord, at: string): string | undefined {
  const wait = liveAndSettledWaits(run).find(entry => entry.registeredAt > at && entry.source === 'agent' && entry.via !== 'monitoring-line');
  if (!wait) return undefined;
  return WAIT_KINDS[wait.kind].userAnswers ? 'the agent asked the user' : 'the agent registered a wait';
}

/** A human message recorded after the done: its `user-message` event. */
export function humanMessageAfter(events: readonly RunEvent[], seq: number): string | undefined {
  return events.some(event => event.seq > seq && event.type === 'user-message') ? 'a new human message' : undefined;
}

/** A turn started after the done: the turn end that reads it is not the done's own. */
export function laterTurn(events: readonly RunEvent[], seq: number): boolean {
  return events.some(event => event.seq > seq && event.type === 'turn.started');
}

/** How input delivered while a done is on record goes (hearsay-tools/squawk#2587): `free`, the
 *  done's one delivery turn that costs no wake; `kept`, the done holds but that turn is spent;
 *  `withdrawn`, the input or a fact recorded since withdraws it. Undefined with no done or no input. */
export function acceptedDoneDelivery(run: RunRecord, events: readonly RunEvent[], inputIds: readonly string[]): 'free' | 'kept' | 'withdrawn' | undefined {
  if (!run.doneAccepted || !inputIds.length) return undefined;
  if (!acceptedDoneHolds(run, events).holds || reconsideredBy(run, inputIds)) return 'withdrawn';
  return run.doneAccepted.freeTurn ? 'kept' : 'free';
}
