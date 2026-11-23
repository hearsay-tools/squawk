import type { ConversationMessage } from './conversations.ts';
import type { DelegationState, RunDelegationSummary } from './delegation.ts';
import type { RunRecord } from './runs.ts';
import { isUsageLimitHold } from './usage-limit-hold.ts';
import type { PeerWaitEntry, PluginWaitEntry, PrWaitEntry, ProcessWaitEntry, SubagentWaitEntry, TimerWaitEntry, Wait, WaitingOn, WorkerWaitEntry } from './waits.ts';

/**
 * What a run waits on, read from its wait list in `waits.ts`. The attention ladder, the run
 * summary and many Squawk modules read these functions without the wait schemas, so they live in
 * a module whose only runtime import is `usage-limit-hold.ts`; `waits.ts` re-exports them
 * (hearsay-tools/squawk#3245).
 */

/** Full records carry the full delegation state; summaries and index rows the slim projection. */
export type WaitingOnInput = Partial<Pick<RunRecord, 'status' | 'waits' | 'autoResumeAt'>> & {
  delegation?: DelegationState | RunDelegationSummary | undefined;
};

/** The requests a root sent to peer tasks, read from its own ledger: a request wait on one of them
 *  is not a wait on workers (hearsay-tools/cezarion#1995). A summary's slim delegation has none. */
function peerRequestIds(delegation: WaitingOnInput['delegation']): Set<string> {
  const conversation = delegation?.role === 'root' && 'conversation' in delegation ? delegation.conversation : undefined;
  // `toRunSummary` passes an unparsed ledger: a malformed one marks nothing and never throws.
  const messages: unknown[] = Array.isArray(conversation?.messages) ? conversation.messages : [];
  return new Set(messages.flatMap((message) => {
    const entry = message && typeof message === 'object' ? message as Partial<ConversationMessage> : undefined;
    return entry?.relationship === 'peer' && entry.kind === 'request' && typeof entry.id === 'string' ? [entry.id] : [];
  }));
}

/** A summary's slim root delegation with the root's own ledger, which the slim one drops, so
 *  `computeWaitingOn` still marks a wait on a peer's reply (hearsay-tools/cezarion#1995). The ledger
 *  is unparsed; `peerRequestIds` reads it defensively. */
export function withRootLedger(slim: RunDelegationSummary | undefined, raw: unknown): WaitingOnInput['delegation'] {
  const ledger = raw && typeof raw === 'object' ? raw as { role?: unknown; conversation?: unknown } : undefined;
  return slim?.role === 'root' && ledger?.role === 'root' ? { ...slim, conversation: ledger.conversation } as WaitingOnInput['delegation'] : slim;
}

/** Whether one of these requests went to a peer task: its wait reads "waiting on replies", never
 *  "worker replies" (hearsay-tools/cezarion#1995). */
export function requestsToPeers(delegation: WaitingOnInput['delegation'], requestIds: readonly string[] | undefined): boolean {
  const toPeers = peerRequestIds(delegation);
  return !!requestIds?.some((id) => toPeers.has(id));
}

/** One target of a worker entry: a request when the entry waits on replies, else a worker. Its key
 *  names the kind, so every count over several entries (`computeWaitingOn`, the activity view)
 *  counts each target once with the same keys (hearsay-tools/cezarion#2588). */
export interface WorkerWaitTarget { key: string; settled: boolean }

export function workerWaitTargets(wait: Pick<WorkerWaitEntry, 'requestIds' | 'requestOutcomes' | 'workerIds' | 'outcomes'>): WorkerWaitTarget[] {
  if (wait.requestIds) {
    const answered = new Set(wait.requestOutcomes?.map((outcome) => outcome.requestId));
    return wait.requestIds.map((id) => ({ key: `request:${id}`, settled: answered.has(id) }));
  }
  const reported = new Set(wait.outcomes?.map((outcome) => outcome.workerId));
  return (wait.workerIds ?? []).map((id) => ({ key: `worker:${id}`, settled: reported.has(id) }));
}

/** The distinct workers and requests still owed over every open worker entry; undefined when there
 *  is none. A worker in two open waits counts once (hearsay-tools/cezarion#2588). */
function workersOwed(open: readonly Wait[]): number | undefined {
  const entries = open.filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker');
  if (!entries.length) return undefined;
  return new Set(entries.flatMap((wait) => workerWaitTargets(wait).filter((target) => !target.settled).map((target) => target.key))).size;
}

function earliest<T extends PrWaitEntry | TimerWaitEntry | ProcessWaitEntry>(waits: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const wait of waits) {
    if (!best || Date.parse(wait.deadline) < Date.parse(best.deadline)) best = wait;
  }
  return best;
}

/** Reads only `open` waits; among several of one kind the earliest deadline wins. */
export function computeWaitingOn(run: WaitingOnInput): WaitingOn | undefined {
  // `Array.isArray`: the cockpit also projects streamed records, whose shape only `id` was checked on.
  const open = (Array.isArray(run.waits) ? run.waits : []).filter((wait) => wait?.phase === 'open');
  const human = open.filter((wait) => wait.kind === 'human');
  if (human.length) return human.some((wait) => wait.askSeq !== undefined) ? { kind: 'human', shown: true } : { kind: 'human' };
  if (isUsageLimitHold(run)) return { kind: 'usage-limit', at: run.autoResumeAt };
  const workers = workersOwed(open);
  if (workers !== undefined) {
    const entries = open.filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker');
    const replies = entries.every((wait) => wait.requestIds !== undefined);
    const peers = replies && entries.some((wait) => requestsToPeers(run.delegation, wait.requestIds));
    return { kind: 'workers', count: workers, ...(replies ? { replies: true as const } : {}), ...(peers ? { peers: true as const } : {}) };
  }
  const peerWaits = open.filter((wait): wait is PeerWaitEntry => wait.kind === 'peer');
  if (peerWaits.length) return { kind: 'peers', count: new Set(peerWaits.flatMap((wait) => wait.peerIds)).size };
  const subagentWaits = open.filter((wait): wait is SubagentWaitEntry => wait.kind === 'subagent');
  // Each running child once, however many open entries name it (hearsay-tools/cezarion#2588).
  if (subagentWaits.length) return { kind: 'subagents', count: new Set(subagentWaits.flatMap((wait) => wait.children.filter((child) => child.status === 'running').map((child) => child.id))).size };
  const pr = earliest(open.filter((wait): wait is PrWaitEntry => wait.kind === 'pr'));
  if (pr) {
    return { kind: 'pr', until: pr.until, waitId: pr.id, prUrl: pr.prUrl, repository: pr.repository, prNumber: pr.prNumber, deadline: pr.deadline };
  }
  const process = earliest(open.filter((wait): wait is ProcessWaitEntry => wait.kind === 'process'));
  if (process) return { kind: 'process', waitId: process.id, pid: process.pid, deadline: process.deadline, ...(process.note === undefined ? {} : { note: process.note }) };
  const plugins = open.filter((wait): wait is PluginWaitEntry => wait.kind === 'plugin');
  plugins.sort((a, b) => {
    const deadlineOrder = (a.deadline ? Date.parse(a.deadline) : Infinity) - (b.deadline ? Date.parse(b.deadline) : Infinity);
    return deadlineOrder || Date.parse(a.registeredAt) - Date.parse(b.registeredAt);
  });
  const plugin = plugins[0];
  if (plugin) return { kind: 'plugin', pluginKind: plugin.pluginKind, waitId: plugin.id, summary: plugin.summary, ...(plugin.deadline === undefined ? {} : { deadline: plugin.deadline }) };
  const timer = earliest(open.filter((wait): wait is TimerWaitEntry => wait.kind === 'timer'));
  if (timer) return { kind: 'timer', waitId: timer.id, at: timer.deadline, ...(timer.note === undefined ? {} : { note: timer.note }) };
  return undefined;
}

/** Whether the run waits on the user: an open human wait (phase 4b, hearsay-tools/cezarion#1236). */
export function asksHuman(run: Pick<WaitingOnInput, 'waits'>): boolean {
  return Array.isArray(run.waits) && run.waits.some((wait) => wait?.kind === 'human' && wait.phase === 'open');
}

/** Whether a question waits on the user: an open human wait the agent opened, or one of Squawk's
 *  that carries a card (a worker's fallback question to its parent). Squawk's other waits
 *  (`no-wait`, `budget`, `completion`) wait for the user without a question. */
export function asksQuestion(run: Pick<WaitingOnInput, 'waits'>): boolean {
  return Array.isArray(run.waits) && run.waits.some((wait) => wait?.kind === 'human' && wait.phase === 'open' && (wait.source === 'agent' || !!wait.questions?.length));
}

/** A resolved wait is a wake owed to the agent: its result is in, its turn has not started.
 *  Rung 10 of the attention ladder ("waiting for capacity"); a summary carries it as
 *  `waitWakePending`. */
export function hasResolvedWait(run: { waitWakePending?: true | undefined } & Pick<WaitingOnInput, 'waits'>): boolean {
  if (run.waitWakePending) return true;
  return Array.isArray(run.waits) && run.waits.some((wait) => wait?.phase === 'resolved');
}

/** A summary's `waitingOn` when it has one; a full or stream-patched record computes it. */
export function resolveWaitingOn(run: { waitingOn?: WaitingOn | undefined } & WaitingOnInput): WaitingOn | undefined {
  return run.waitingOn ?? computeWaitingOn(run);
}
