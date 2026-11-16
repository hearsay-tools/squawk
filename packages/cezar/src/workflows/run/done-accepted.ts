import type { AgentInput } from '@open-mercato/cezar-contract';
import type { DoneOwedInput } from '@open-mercato/cezar-contract/waits';
import type { RunRecord } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import { resolvedWaits, waitInputId } from '../waits.ts';
import { harnessHoldsHumanInput } from './input-timers.ts';
import { WAIT_KINDS } from './wait-kinds.ts';

/**
 * Reads of the accepted-done record (`RunRecord.doneAccepted`, ADR 0064,
 * hearsay-tools/squawk#2587). `run-finish.ts` records it and `turn-settler.ts` retires it; this
 * module only reads: what the run still owes the agent when it calls `cezar_done`, and whether
 * input that arrives after the done withdraws it.
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

/** What the run still owes the agent when it calls `cezar_done`: resolved wait results not yet
 *  delivered, input queued for it, and input handed to its harness that the model has not read
 *  (`input_pending`). The input that opened this turn is read once the turn runs: a continuation's
 *  opening input, and input the harness reported read before its acknowledgement. A harness that
 *  cannot report reads takes input only at a turn boundary, so its flight opened this turn. */
export function owedAtDone(run: RunRecord, state: ActiveRun): DoneOwedInput[] {
  const owed: DoneOwedInput[] = [];
  const results = resolvedWaits(run);
  for (const wait of results) owed.push({ kind: 'wait_result', wait_id: wait.id, wait_kind: wait.kind });
  const resultIds = new Set(results.map(waitInputId));
  const input = state.inputState;
  const flight = input.agentInputFlight;
  const opening = input.openingAgentInputId;
  const observable = input.inputDelivery?.consumption === 'observable';
  const unread = (id: string) => id !== opening && observable && !input.consumedBeforeAck?.has(id);
  for (const id of flight?.inputIds ?? []) if (unread(id)) owed.push({ kind: 'in_flight', input_id: id });
  for (const id of input.unreadInputIds ?? []) if (id !== opening && !flight?.inputIds.includes(id)) owed.push({ kind: 'in_flight', input_id: id });
  for (const queued of run.agentInputs ?? []) {
    if (queued.deliveredAt || resultIds.has(queued.id) || queued.id === opening || flight?.inputIds.includes(queued.id)) continue;
    owed.push({ kind: 'queued', input_id: queued.id, source: queued.conversation?.relationship === 'peer' ? 'peer' : queued.source });
  }
  if (harnessHoldsHumanInput(state)) owed.push({ kind: 'queued', source: 'human' });
  return owed.slice(0, 64);
}
