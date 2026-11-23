import type { Wait, WaitPhase } from '@open-mercato/cezar-contract/waits';
import type { FiredBy } from '../workflows/run-states.ts';
import { reportStoreViolation } from './run-exits.ts';
import type { RunRecord } from './store.ts';

/** The phases a wait entry moves through. Their writes go through RunStore.commitOutcome (hearsay-tools/cezarion#1805). */
export const WAIT_PHASES: { readonly [P in WaitPhase]: readonly { to: WaitPhase; firedBy: readonly FiredBy[] }[] } = {
  open: [
    { to: 'open', firedBy: ['agent', 'human', 'engine', 'runner', 'worker'] },
    { to: 'delivered', firedBy: ['human'] },
    { to: 'resolved', firedBy: ['watcher', 'timer', 'worker', 'peer', 'human', 'parent', 'runner', 'recovery'] },
    { to: 'cancelled', firedBy: ['agent', 'human', 'engine', 'runner'] },
  ],
  resolved: [
    { to: 'resolved', firedBy: ['recovery'] },
    { to: 'delivered', firedBy: ['runner'] },
    { to: 'cancelled', firedBy: ['human', 'engine'] },
  ],
  delivered: [],
  cancelled: [],
};

/** Check the entry a store write puts in place; an undeclared write still lands. */
export function checkWaitWrite(run: Pick<RunRecord, 'waits' | 'lastWaits'>, entry: Wait): void {
  const prior = run.waits?.find(wait => wait.id === entry.id);
  const from = prior?.phase ?? (run.lastWaits?.some(wait => wait.id === entry.id) ? 'settled' : 'new');
  if (prior ? WAIT_PHASES[prior.phase].some(row => row.to === entry.phase) : from === 'new' && entry.phase === 'open') return;
  reportStoreViolation(`undeclared wait transition: ${entry.kind} wait ${entry.id} from ${from} to ${entry.phase} (declare it in runs/wait-phases.ts WAIT_PHASES)`);
}
