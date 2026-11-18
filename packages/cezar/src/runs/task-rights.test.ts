import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it } from 'vitest';
import { workerOperationSchema, type SpawnGrant } from '@open-mercato/cezar-contract/delegation';
import { runRecordSchema, type RunRecord } from './store.ts';
import {
  childSpawnGrant, DEFAULT_GRANTS, familyRecordIdOf, familyRecordOf, grantsOf, hasSpawnRoom, holdsOperation, mayOperate, maySpawn,
  messageRelation, relationOf, supervisorIdOf, type TaskRelation,
} from './task-rights.ts';

const [ROOT, OTHER, WORKER, SIBLING, FOREIGN, PLAIN] = ['1', '2', '3', '4', '5', '6'].map(n => `00000000-0000-4000-8000-00000000000${n}`) as [string, string, string, string, string, string];
const operations = workerOperationSchema.options;
const kinds = ['owned-isolated', 'shared'] as const;
const receipt = (workerId: string, deleted = false) => ({ requestId: workerId, workerId, requestHash: 'a'.repeat(64),
  ...(deleted ? { deletion: { phase: 'complete' as const, revision: 0, resourceId: workerId, generation: workerId } } : {}) });

function run(id: string, delegation?: unknown): RunRecord {
  return runRecordSchema.parse({ id, title: id, task: 'task', workflow: 'quick-task', status: RUN_STATUS.running, createdAt: '2026-11-18T12:00:00.000Z',
    tokensUsed: 0, steps: [], ...(delegation ? { delegation } : {}) });
}
const root = (id = ROOT, workers = [WORKER, SIBLING], extra: object = {}) =>
  run(id, { role: 'root', permissions: operations, receipts: workers.map(worker => receipt(worker)), ...extra });
const worker = (id = WORKER, parentRunId = ROOT, extra: object = {}) => run(id, { role: 'worker', permissions: [], parentRunId,
  workspace: { ownerRunId: id, resourceId: id, kind: 'owned-isolated', path: `/managed/${id}`, branch: `cez/${id}`, baselineSha: 'a'.repeat(40) }, ...extra });

/** One family (a root with two workers), a second root with its own worker, and a task with no record yet. */
const records = new Map([root(), root(OTHER, [FOREIGN]), worker(), worker(SIBLING), worker(FOREIGN, OTHER), run(PLAIN)].map(record => [record.id, record]));
const get = (id: string) => records.get(id);

describe('task relations', () => {
  it.each<[string, string, TaskRelation | undefined]>([
    [ROOT, WORKER, 'supervised'], [WORKER, ROOT, 'supervisor'],
    [ROOT, OTHER, 'peer'], [ROOT, PLAIN, 'peer'], [PLAIN, ROOT, 'peer'],
    [WORKER, OTHER, undefined], [OTHER, WORKER, undefined], [ROOT, FOREIGN, undefined],
    [WORKER, SIBLING, undefined], [WORKER, FOREIGN, undefined], [WORKER, PLAIN, undefined],
    [ROOT, ROOT, undefined], [WORKER, WORKER, undefined],
  ])('names the relation of %s to %s as %s', (from, to, relation) => {
    expect(relationOf(get(from), get(to))).toBe(relation);
  });

  it('names none for a deleted record, a quarantined one and a worker that does not own its record', () => {
    expect(relationOf(get(ROOT), undefined)).toBeUndefined();
    expect(relationOf(undefined, get(ROOT))).toBeUndefined();
    expect(relationOf(get(ROOT), run(OTHER, { role: 'invalid' }))).toBeUndefined();
    const adopted = worker();
    if (adopted.delegation?.role !== 'worker') throw new Error('fixture');
    adopted.delegation.workspace.ownerRunId = SIBLING;
    expect(relationOf(get(ROOT), adopted)).toBeUndefined();
  });

  it('reads the supervisor and the family record of a task each from its own function', () => {
    expect([ROOT, WORKER, PLAIN].map(id => supervisorIdOf(get(id)))).toEqual([undefined, ROOT, undefined]);
    expect([ROOT, WORKER, PLAIN].map(id => familyRecordIdOf(get(id)))).toEqual([ROOT, ROOT, undefined]);
    expect(familyRecordOf(get(WORKER), get)).toBe(get(ROOT));
    expect(familyRecordOf(get(WORKER), () => run(ROOT))).toBeUndefined();
    expect(familyRecordOf(get(PLAIN), get)).toBeUndefined();
  });
});

describe('task grants', () => {
  it('reads a saved record without grant fields as the defaults of its role', () => {
    expect(grantsOf(get(ROOT))).toEqual({ spawn: { kinds: ['owned-isolated', 'shared'], live: 32 }, operate: operations, message: ['supervised', 'peer'] });
    expect(grantsOf(get(WORKER))).toEqual({ spawn: undefined, operate: [], message: ['supervisor', 'supervised'] });
    expect(grantsOf(get(ROOT))).toEqual(DEFAULT_GRANTS.root);
    expect(grantsOf(get(WORKER))).toEqual(DEFAULT_GRANTS.worker);
  });

  it('gives no grant to a task with no record, a quarantined record or a deleted one', () => {
    for (const record of [get(PLAIN), run(OTHER, { role: 'invalid' }), undefined]) {
      expect(grantsOf(record)).toEqual({ spawn: undefined, operate: [], message: [] });
    }
  });

  it('reads the stored operate and spawn grants over the defaults', () => {
    const stored: SpawnGrant = { kinds: ['shared'], live: 1 };
    expect(grantsOf(root(ROOT, [], { permissions: ['inspect'], spawnGrant: stored }))).toMatchObject({ spawn: stored, operate: ['inspect'] });
    expect(grantsOf(worker(WORKER, ROOT, { permissions: ['wait'], spawnGrant: stored }))).toMatchObject({ spawn: stored, operate: ['wait'] });
  });

  it('derives a worker\'s spawn grant from its parent\'s `children`, to any depth', () => {
    expect(childSpawnGrant(get(ROOT))).toBeUndefined();
    expect(childSpawnGrant(get(WORKER))).toBeUndefined();
    const grandchild: SpawnGrant = { kinds: ['shared'], live: 1 };
    const child: SpawnGrant = { kinds: ['shared'], live: 2, children: grandchild };
    const parent = root(ROOT, [], { spawnGrant: { kinds: [...kinds], live: 32, children: child } });
    expect(childSpawnGrant(parent)).toEqual(child);
    expect(childSpawnGrant(worker(WORKER, ROOT, { spawnGrant: childSpawnGrant(parent) }))).toEqual(grandchild);
    expect(childSpawnGrant(worker(WORKER, ROOT, { spawnGrant: grandchild }))).toBeUndefined();
  });
});

describe('today\'s rights matrix', () => {
  const actors = [ROOT, WORKER, PLAIN];
  const targets = [ROOT, OTHER, WORKER, SIBLING, FOREIGN, PLAIN];

  it.each(kinds)('lets only a root spawn a %s worker', kind => {
    expect(actors.filter(actor => maySpawn(get(actor), kind))).toEqual([ROOT]);
    expect(actors.filter(actor => maySpawn(get(actor)))).toEqual([ROOT]);
  });

  it.each(operations)('lets only a root apply %s, and only to its own workers', operation => {
    const allowed = actors.flatMap(actor => targets.filter(target => mayOperate(get(actor), get(target), operation)).map(target => [actor, target]));
    expect(allowed).toEqual([[ROOT, WORKER], [ROOT, SIBLING]]);
    expect(actors.filter(actor => holdsOperation(get(actor), operation))).toEqual([ROOT]);
  });

  it('lets a root message its workers and its peers, and a worker only its parent', () => {
    const allowed = actors.flatMap(actor => targets.flatMap(target => {
      const relation = messageRelation(get(actor), get(target), get);
      return relation ? [`${actor} ${relation} ${target}`] : [];
    }));
    expect(allowed).toEqual([
      `${ROOT} peer ${OTHER}`, `${ROOT} supervised ${WORKER}`, `${ROOT} supervised ${SIBLING}`, `${ROOT} peer ${PLAIN}`,
      `${WORKER} supervisor ${ROOT}`,
    ]);
  });

  it('holds a spawn to the grant\'s kinds and the caller\'s own live limit', () => {
    const shared = root(ROOT, [], { spawnGrant: { kinds: ['shared'], live: 1 } });
    expect(kinds.map(kind => maySpawn(shared, kind))).toEqual([false, true]);
    expect(maySpawn(root(ROOT, [], { permissions: ['inspect'] }), 'shared')).toBe(false);
    expect([0, 1].map(outstanding => hasSpawnRoom(shared, outstanding))).toEqual([true, false]);
    expect([31, 32].map(outstanding => hasSpawnRoom(get(ROOT), outstanding))).toEqual([true, false]);
    expect(hasSpawnRoom(get(WORKER), 0)).toBe(false);
  });
});

describe('message relation', () => {
  it('names none while either task\'s family record deletes its history', () => {
    const deleting = root(ROOT, [WORKER], { historyDeletion: 'pending' });
    expect(messageRelation(deleting, get(OTHER), get)).toBeUndefined();
    expect(messageRelation(get(OTHER), deleting, get)).toBeUndefined();
    expect(messageRelation(deleting, get(WORKER), get)).toBeUndefined();
    expect(messageRelation(get(WORKER), deleting, id => id === ROOT ? deleting : get(id))).toBeUndefined();
  });

  it('names none for a worker whose receipt is deleted or missing', () => {
    for (const receipts of [[receipt(WORKER, true)], []]) {
      const parent = root(ROOT, [], { receipts });
      const lookup = (id: string) => id === ROOT ? parent : get(id);
      expect(messageRelation(parent, get(WORKER), lookup)).toBeUndefined();
      expect(messageRelation(get(WORKER), parent, lookup)).toBeUndefined();
    }
  });

  it('reads the receipt from the family record the lookup returns, not from the supervisor in hand', () => {
    const supervisor = root(ROOT, []);
    expect(messageRelation(supervisor, get(WORKER), get)).toBe('supervised');
    expect(messageRelation(get(WORKER), supervisor, get)).toBe('supervisor');
    expect(messageRelation(get(ROOT), get(WORKER), () => supervisor)).toBeUndefined();
    expect(messageRelation(get(ROOT), get(WORKER), () => undefined)).toBeUndefined();
  });
});
