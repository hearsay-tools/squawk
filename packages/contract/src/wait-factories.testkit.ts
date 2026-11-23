import { NOW, next } from './test-factories.testkit.ts';
import {
  humanWaitEntrySchema,
  pluginWaitEntrySchema,
  peerWaitEntrySchema,
  prWaitEntrySchema,
  processWaitEntrySchema,
  subagentChildSchema,
  subagentWaitEntrySchema,
  timerWaitEntrySchema,
  waitPhaseSchema,
  waitViaSchema,
  workerWaitEntrySchema,
} from './waits.ts';
import type { HumanWaitEntry, PluginWaitEntry, PeerWaitEntry, PrWaitEntry, ProcessWaitEntry, SubagentWaitEntry, TimerWaitEntry, WorkerWaitEntry } from './waits.ts';

/**
 * Typed test data for waits (hearsay-tools/squawk#4143): the wait enum constants and the `make*Wait`
 * factories, split from `test-factories.testkit.ts` so a test that builds no wait does not load
 * `waits.ts`. The same rules hold: each constant is the schema's own value list, each factory
 * returns a value the contract's own schema accepts (`test-factories.test.ts` proves it with
 * `parse`), and the cockpit's tests reach this file through
 * `@open-mercato/cezar-api-client/contract/wait-factories.testkit`. The ids come from the sequence
 * `test-factories.testkit.ts` keeps, so a test that mixes both kits sees the same numbers as before.
 */

// ---- enum constants -----------------------------------------------------------------------

// Each constant is the schema's own value list, never a copy: a value the contract renames is a
// compile error at its uses, and one it adds is here already. Keys equal values, so `via`'s
// hyphenated values read `WAIT_VIA['monitoring-line']`.
export const WAIT_PHASE = waitPhaseSchema.enum;
export const WAIT_VIA = waitViaSchema.enum;
export const WAIT_SOURCE = timerWaitEntrySchema.shape.source.enum;
export const WAIT_KIND = {
  plugin: pluginWaitEntrySchema.shape.kind.value,
  pr: prWaitEntrySchema.shape.kind.value,
  timer: timerWaitEntrySchema.shape.kind.value,
  human: humanWaitEntrySchema.shape.kind.value,
  worker: workerWaitEntrySchema.shape.kind.value,
  process: processWaitEntrySchema.shape.kind.value,
  peer: peerWaitEntrySchema.shape.kind.value,
  subagent: subagentWaitEntrySchema.shape.kind.value,
} as const;
// A native subagent's status inside a subagent wait (hearsay-tools/cezarion#2431).
export const SUBAGENT_STATUS = subagentChildSchema.shape.status.enum;

// ---- shared defaults ----------------------------------------------------------------------

const LATER = '2026-10-26T00:05:00.000Z';

/** A distinct id that passes `z.uuid()`; the counter restarts with each test file's module graph. */
const uuid = (): string => `f0000000-0000-4000-8000-${next().toString(16).padStart(12, '0')}`;

// ---- waits --------------------------------------------------------------------------------

const waitBase = () => ({
  id: uuid(),
  source: WAIT_SOURCE.agent,
  registeredAt: NOW,
  phase: WAIT_PHASE.open,
  turnId: 'turn-1',
});

/** The agent's open monitoring-line timer. */
export function makeTimerWait(over: Partial<TimerWaitEntry> = {}): TimerWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.timer,
    via: WAIT_VIA['monitoring-line'],
    deadline: LATER,
    seconds: 300,
    ...over,
  };
}

/** The agent's open wait on a pull request's checks. */
export function makePrWait(over: Partial<PrWaitEntry> = {}): PrWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.pr,
    via: WAIT_VIA.cezar_wait,
    deadline: LATER,
    prUrl: 'https://github.com/acme/repo/pull/12',
    repository: 'acme/repo',
    prNumber: 12,
    headSha: 'a'.repeat(40),
    generation: 'session',
    timeoutSeconds: 1800,
    until: 'checks',
    wakeOnConflict: true,
    ...over,
  };
}

/** The agent's open question to the user, with no card. */
export function makeHumanWait(over: Partial<HumanWaitEntry> = {}): HumanWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.human,
    via: WAIT_VIA.cezar_ask,
    ...over,
  };
}

/** The agent's open wait on one worker. */
export function makeWorkerWait(over: Partial<WorkerWaitEntry> = {}): WorkerWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.worker,
    via: WAIT_VIA['cez-worker-wait'],
    deadline: LATER,
    timeoutSeconds: 600,
    workerIds: [uuid()],
    revisions: [],
    outcomes: [],
    ...over,
  };
}

/** The agent's open wait on the replies to one request, which a worker wait names instead of workers. */
export function makeWorkerRequestWait(over: Partial<WorkerWaitEntry> = {}): WorkerWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.worker,
    via: WAIT_VIA['cez-worker-wait'],
    deadline: LATER,
    timeoutSeconds: 600,
    requestIds: [uuid()],
    requestOutcomes: [],
    ...over,
  };
}

/** The agent's open wait on a background process. */
export function makeProcessWait(over: Partial<ProcessWaitEntry> = {}): ProcessWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.process,
    via: WAIT_VIA.cezar_wait,
    deadline: LATER,
    timeoutSeconds: 1800,
    pid: 4242,
    ...over,
  };
}

/** The agent's open wait on one named peer task (hearsay-tools/cezarion#1995). */
export function makePeerWait(over: Partial<PeerWaitEntry> = {}): PeerWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.peer,
    via: WAIT_VIA.cezar_wait,
    deadline: LATER,
    timeoutSeconds: 600,
    peerIds: [uuid()],
    ...over,
  };
}

/** Squawk's open wait on one running native subagent (hearsay-tools/cezarion#2431). */
export function makeSubagentWait(over: Partial<SubagentWaitEntry> = {}): SubagentWaitEntry {
  return {
    ...waitBase(),
    kind: WAIT_KIND.subagent,
    source: WAIT_SOURCE.cezar,
    via: WAIT_VIA['native-subagents'],
    deadline: LATER,
    children: [{ id: 'toolu_bg_01', status: SUBAGENT_STATUS.running }],
    ...over,
  };
}

/** A plugin wait that remains readable without its plugin. */
export function makePluginWait(over: Partial<PluginWaitEntry> = {}): PluginWaitEntry {
  return {
    ...waitBase(), kind: WAIT_KIND.plugin, via: 'example-plugin',
    pluginKind: 'example.check', summary: 'Waiting for example check', payload: {}, ...over,
  };
}
