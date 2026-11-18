import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import { workerOperationSchema, type SpawnGrant } from '@open-mercato/cezar-contract/delegation';
import { runRecordSchema, type RunRecord } from './store.ts';
import {
  childSpawnGrant, DEFAULT_GRANTS, defaultSpawnKind, familyRecordIdOf, familyRecordOf, grantsOf, hasSpawnRoom, inspectableReceipts, mayOperate, maySpawn,
  messageRelation, relationOf, supervisedByFamilyRecord, supervisedReceipts, supervisorIdOf, type TaskRelation,
} from './task-rights.ts';

const [ROOT, OTHER, WORKER, SIBLING, FOREIGN, PLAIN, CHILD] = ['1', '2', '3', '4', '5', '6', '7'].map(n => `00000000-0000-4000-8000-00000000000${n}`) as [string, string, string, string, string, string, string];
const operations = workerOperationSchema.options;
const kinds = ['owned-isolated', 'shared'] as const;
const receipt = (workerId: string, extra: { deleted?: boolean; supervisorRunId?: string } = {}) => ({ requestId: workerId, workerId, requestHash: 'a'.repeat(64),
  ...(extra.supervisorRunId ? { supervisorRunId: extra.supervisorRunId } : {}),
  ...(extra.deleted ? { deletion: { phase: 'complete' as const, revision: 0, resourceId: workerId, generation: workerId } } : {}) });

function run(id: string, delegation?: unknown): RunRecord {
  return runRecordSchema.parse({ id, title: id, task: 'task', workflow: 'quick-task', status: RUN_STATUS.running, createdAt: '2026-11-18T12:00:00.000Z',
    tokensUsed: 0, steps: [], ...(delegation ? { delegation } : {}) });
}
const root = (id = ROOT, workers = [WORKER, SIBLING], extra: object = {}) =>
  run(id, { role: 'root', permissions: operations, receipts: workers.map(worker => receipt(worker)), ...extra });
/** A worker as a record saved before workers had grants: no operation, no spawn grant. */
const worker = (id = WORKER, parentRunId = ROOT, extra: object = {}) => run(id, { role: 'worker', permissions: [], parentRunId,
  workspace: { ownerRunId: id, resourceId: id, kind: 'owned-isolated', path: `/managed/${id}`, branch: `cez/${id}`, baselineSha: 'a'.repeat(40) }, ...extra });
/** A worker as Squawk writes it now: every operation, and the spawn grant its supervisor's grant gives. */
const granted = (id: string, supervisor: RunRecord, extra: object = {}) => {
  const spawnGrant = childSpawnGrant(supervisor);
  return worker(id, ROOT, { permissions: operations, ...(spawnGrant ? { spawnGrant } : {}), ...(supervisor.id === ROOT ? {} : { supervisorRunId: supervisor.id }), ...extra });
};

/** R: a root. W and S: its workers. C: the worker W started. X: an unrelated root with its own worker. P: a task with no record yet. */
const R = root(ROOT, [], { receipts: [receipt(WORKER), receipt(SIBLING), receipt(CHILD, { supervisorRunId: WORKER })] });
const W = granted(WORKER, R);
const S = granted(SIBLING, R);
const C = granted(CHILD, W);
const records = new Map([R, root(OTHER, [FOREIGN]), W, S, C, granted(FOREIGN, root(OTHER, [FOREIGN]), { parentRunId: OTHER }), run(PLAIN)].map(record => [record.id, record]));
const get = (id: string) => records.get(id);
const NAMES: Record<string, string> = { [ROOT]: 'R', [OTHER]: 'X', [WORKER]: 'W', [SIBLING]: 'S', [CHILD]: 'C', [FOREIGN]: 'F', [PLAIN]: 'P' };
const all = [ROOT, WORKER, CHILD, SIBLING, OTHER, FOREIGN, PLAIN];
const pairs = (allowed: (actor: string, target: string) => unknown) =>
  all.flatMap(actor => all.flatMap(target => { const answer = allowed(actor, target); return answer ? [`${NAMES[actor]}>${NAMES[target]}${answer === true ? '' : `:${String(answer)}`}`] : []; }));

describe('task relations', () => {
  it('names the relation of each pair from the two records', () => {
    expect(pairs((from, to) => relationOf(get(from), get(to)))).toEqual([
      'R>W:supervised', 'R>S:supervised', 'R>X:peer', 'R>P:peer',
      'W>R:supervisor', 'W>C:supervised', 'C>W:supervisor', 'S>R:supervisor',
      'X>R:peer', 'X>F:supervised', 'X>P:peer', 'F>X:supervisor', 'P>R:peer', 'P>X:peer',
    ]);
  });

  it('names none for a deleted record, a quarantined one, a worker that does not own its record and a supervisor of another family', () => {
    expect(relationOf(R, undefined)).toBeUndefined();
    expect(relationOf(undefined, R)).toBeUndefined();
    expect(relationOf(R, run(OTHER, { role: 'invalid' }))).toBeUndefined();
    const adopted = worker();
    if (adopted.delegation?.role !== 'worker') throw new Error('fixture');
    adopted.delegation.workspace.ownerRunId = SIBLING;
    expect(relationOf(R, adopted)).toBeUndefined();
    const stray = worker(CHILD, ROOT, { supervisorRunId: FOREIGN });
    expect(relationOf(get(FOREIGN), stray)).toBeUndefined();
    expect(relationOf(stray, get(FOREIGN))).toBeUndefined();
  });

  it('reads the supervisor and the family record of a task each from its own function', () => {
    expect([ROOT, WORKER, CHILD, PLAIN].map(id => supervisorIdOf(get(id)))).toEqual([undefined, ROOT, WORKER, undefined]);
    expect([ROOT, WORKER, CHILD, PLAIN].map(id => familyRecordIdOf(get(id)))).toEqual([ROOT, ROOT, ROOT, undefined]);
    expect([ROOT, WORKER, CHILD, PLAIN].map(id => supervisedByFamilyRecord(get(id)))).toEqual([false, true, false, false]);
    expect(familyRecordOf(C, get)).toBe(R);
    expect(familyRecordOf(W, () => run(ROOT))).toBeUndefined();
    expect(familyRecordOf(get(PLAIN), get)).toBeUndefined();
  });

  it('lists the receipts of one supervisor, and for the record holder every receipt it may inspect', () => {
    expect(supervisedReceipts(R, ROOT).map(entry => entry.workerId)).toEqual([WORKER, SIBLING]);
    expect(supervisedReceipts(R, WORKER).map(entry => entry.workerId)).toEqual([CHILD]);
    expect(supervisedReceipts(undefined, WORKER)).toEqual([]);
    expect(inspectableReceipts(R, R).map(entry => entry.workerId)).toEqual([WORKER, SIBLING, CHILD]);
    expect(inspectableReceipts(W, R).map(entry => entry.workerId)).toEqual([CHILD]);
    expect(inspectableReceipts(S, R)).toEqual([]);
    expect(inspectableReceipts(W, undefined)).toEqual([]);
  });
});

describe('task grants', () => {
  it('reads a saved root without grant fields as today\'s root default, with the grant its workers get', () => {
    expect(grantsOf(root())).toEqual(DEFAULT_GRANTS.root);
    expect(grantsOf(root()).spawn).toEqual({ kinds: ['owned-isolated', 'shared'], live: 32, children: { kinds: ['shared'], live: 1 } });
    expect(grantsOf(root()).operateFamily).toEqual(['inspect', 'wait', 'stop', 'destroy']);
  });

  it('reads a saved worker without grant fields as a worker with no spawn grant and no operation', () => {
    expect(grantsOf(worker())).toEqual({ spawn: undefined, operate: [], operateFamily: [], message: ['supervisor', 'supervised'] });
    expect(maySpawn(worker())).toBe(false);
    expect(operations.filter(operation => mayOperate(worker(), C, operation))).toEqual([]);
  });

  it('gives no grant to a task with no record, a quarantined record or a deleted one', () => {
    for (const record of [get(PLAIN), run(OTHER, { role: 'invalid' }), undefined]) {
      expect(grantsOf(record)).toEqual({ spawn: undefined, operate: [], operateFamily: [], message: [] });
    }
  });

  it('reads the stored operate and spawn grants over the defaults', () => {
    const stored: SpawnGrant = { kinds: ['shared'], live: 1 };
    expect(grantsOf(root(ROOT, [], { permissions: ['inspect'], spawnGrant: stored }))).toMatchObject({ spawn: stored, operate: ['inspect'] });
    expect(grantsOf(worker(WORKER, ROOT, { permissions: ['wait'], spawnGrant: stored }))).toMatchObject({ spawn: stored, operate: ['wait'] });
  });

  it('derives each generation\'s spawn grant from its supervisor\'s `children`: one shared worker, then none', () => {
    expect(childSpawnGrant(R)).toEqual({ kinds: ['shared'], live: 1 });
    expect(grantsOf(W).spawn).toEqual({ kinds: ['shared'], live: 1 });
    expect(childSpawnGrant(W)).toBeUndefined();
    expect(grantsOf(C).spawn).toBeUndefined();
    const deep: SpawnGrant = { kinds: ['shared'], live: 2, children: { kinds: ['shared'], live: 1 } };
    expect(childSpawnGrant(worker(WORKER, ROOT, { spawnGrant: deep }))).toEqual(deep.children);
  });
});

describe('rights case table', () => {
  it('lets a root spawn both kinds, its worker one shared worker, and that worker\'s child none', () => {
    expect(all.map(id => `${NAMES[id]}:${kinds.filter(kind => maySpawn(get(id), kind)).join('+')}`)).toEqual([
      'R:owned-isolated+shared', 'W:shared', 'C:', 'S:shared', 'X:owned-isolated+shared', 'F:shared', 'P:',
    ]);
    expect(all.map(id => defaultSpawnKind(get(id)))).toEqual(['owned-isolated', 'shared', undefined, 'shared', 'owned-isolated', 'shared', undefined]);
    expect([0, 1].map(outstanding => hasSpawnRoom(W, outstanding))).toEqual([true, false]);
    expect([31, 32].map(outstanding => hasSpawnRoom(R, outstanding))).toEqual([true, false]);
    expect(hasSpawnRoom(C, 0)).toBe(false);
    expect(maySpawn(root(ROOT, [], { permissions: ['inspect'] }), 'shared')).toBe(false);
  });

  it.each<[string, string[]]>([
    ['spawn', ['R>W', 'R>S', 'W>C', 'X>F']],
    ['inspect', ['R>W', 'R>C', 'R>S', 'W>C', 'X>F']],
    ['steer', ['R>W', 'R>S', 'W>C', 'X>F']],
    ['stop', ['R>W', 'R>C', 'R>S', 'W>C', 'X>F']],
    ['destroy', ['R>W', 'R>C', 'R>S', 'W>C', 'X>F']],
    ['diff', ['R>W', 'R>S', 'W>C', 'X>F']],
    ['wait', ['R>W', 'R>C', 'R>S', 'W>C', 'X>F']],
  ])('lets a supervisor apply %s to the workers it started, and a root the family operations to every worker of its family', (operation, expected) => {
    expect(pairs((actor, target) => mayOperate(get(actor), get(target), operation as typeof operations[number]))).toEqual(expected);
  });

  it('lets a task message its supervisor, the workers it started and, for a root, its peers', () => {
    expect(pairs((from, to) => messageRelation(get(from), get(to), get))).toEqual([
      'R>W:supervised', 'R>S:supervised', 'R>X:peer', 'R>P:peer',
      'W>R:supervisor', 'W>C:supervised', 'C>W:supervisor', 'S>R:supervisor',
      'X>R:peer', 'X>F:supervised', 'X>P:peer', 'F>X:supervisor',
    ]);
  });
});

describe('message relation', () => {
  it('names none while either task\'s family record deletes its history', () => {
    const deleting = root(ROOT, [WORKER], { historyDeletion: 'pending' });
    expect(messageRelation(deleting, get(OTHER), get)).toBeUndefined();
    expect(messageRelation(get(OTHER), deleting, get)).toBeUndefined();
    expect(messageRelation(deleting, W, get)).toBeUndefined();
    expect(messageRelation(W, deleting, id => id === ROOT ? deleting : get(id))).toBeUndefined();
    expect(messageRelation(W, C, id => id === ROOT ? deleting : get(id))).toBeUndefined();
  });

  it('names none for a worker whose receipt is deleted, missing or names another supervisor', () => {
    for (const receipts of [[receipt(WORKER, { deleted: true })], [], [receipt(WORKER, { supervisorRunId: SIBLING })]]) {
      const parent = root(ROOT, [], { receipts });
      const lookup = (id: string) => id === ROOT ? parent : get(id);
      expect(messageRelation(parent, W, lookup)).toBeUndefined();
      expect(messageRelation(W, parent, lookup)).toBeUndefined();
    }
    const unnamed = root(ROOT, [], { receipts: [receipt(WORKER), receipt(CHILD)] });
    expect(messageRelation(W, C, id => id === ROOT ? unnamed : get(id))).toBeUndefined();
  });

  it('reads the receipt from the family record the lookup returns, not from the supervisor in hand', () => {
    const supervisor = root(ROOT, []);
    expect(messageRelation(supervisor, W, get)).toBe('supervised');
    expect(messageRelation(W, supervisor, get)).toBe('supervisor');
    expect(messageRelation(R, W, () => supervisor)).toBeUndefined();
    expect(messageRelation(R, W, () => undefined)).toBeUndefined();
  });
});
