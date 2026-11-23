import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationState } from '@open-mercato/cezar-contract';
import { spawnCapacityRefusal } from '../delegation/capacity.ts';
import { sealTestRunSlots } from './removal-slots.testkit.ts';
import { cleanupSafety } from './retention.ts';
import { RunStore } from './store.ts';
import { workerExecutionsRegistered } from './worker-executions-registry.ts';

// No worker-executions factory is registered in this file: Vitest gives each test file its own
// module registry, and nothing here imports `delegation/worker-executions.testkit.ts` or the
// built-in run slots. The removal slots are sealed empty, so only the missing factory can refuse.
sealTestRunSlots();

const MISSING = /No worker-executions factory is registered/;
const input = { title: 'fix tests', task: 'fix tests', workflow: 'quick-task', steps: [] };
const root: DelegationState = { role: 'root', permissions: ['spawn', 'wait'], receipts: [] };
function worker(parentRunId: string, id: string): DelegationState {
  return { role: 'worker', parentRunId, permissions: [], workspace: { ownerRunId: id, resourceId: randomUUID(),
    kind: 'owned-isolated', path: `/managed/${id}`, branch: `cez/${id.slice(0, 8)}`, baselineSha: 'a'.repeat(40) } };
}

describe('a process that registered no worker-executions factory (hearsay-tools/squawk#4039)', () => {
  let dataDir: string;
  let store: RunStore;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'worker-executions-missing-'));
    store = RunStore.open(dataDir, { keepLive: true });
  });
  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const workerFiles = () => readdirSync(join(dataDir, 'runs')).filter(name => /\.(identity|execution|processes|scope)\.json$/.test(name));

  it('throws at the first use of the worker executions, naming the registration', () => {
    expect(workerExecutionsRegistered()).toBe(false);
    expect(() => store.workerExecutions).toThrow(MISSING);
  });

  it('creates no owned worker run, receipt or private record', () => {
    const parent = store.createRun(input);
    store.commitDelegation([{ id: parent.id, delegation: root }]);
    const id = randomUUID();
    expect(() => store.createOwnedRun(input, parent.id, randomUUID(), worker(parent.id, id), 'b'.repeat(64), spawnCapacityRefusal)).toThrow(MISSING);
    expect(store.queries.listRuns().map(run => run.id)).toEqual([parent.id]);
    expect(store.getRun(parent.id)?.delegation).toEqual(root);
    expect(workerFiles()).toEqual([]);
  });

  it('refuses to judge a worker deletion or a worker reclaim', () => {
    const parent = store.createRun(input);
    store.commitDelegation([{ id: parent.id, delegation: root }]);
    const child = store.createRun(input);
    store.commitDelegation([{ id: child.id, delegation: worker(parent.id, child.id) }]);
    const run = store.getRun(child.id)!;
    expect(run.delegation?.role).toBe('worker');
    expect(() => store.retention.canDeleteRun(child.id)).toThrow(MISSING);
    expect(() => cleanupSafety(dataDir, store, run)).toThrow(MISSING);
    expect(store.getRun(child.id)).toBeDefined();
  });
});

it('requires a seal even with a registered factory, and rejects a sealed empty registry', async () => {
  vi.resetModules();
  const registry = await import('./worker-executions-registry.ts');
  const { createWorkerExecutions } = await import('../delegation/worker-executions.ts');
  registry.registerWorkerExecutions(createWorkerExecutions);
  expect(registry.workerExecutionsSealed()).toBe(false);
  expect(registry.workerExecutionsRegistered()).toBe(false);
  expect(registry.workerExecutionsFactory).toThrow(/worker-executions.*registerBuiltInRunSlots/);
  registry.sealWorkerExecutions();
  expect(registry.workerExecutionsSealed()).toBe(true);
  expect(registry.workerExecutionsRegistered()).toBe(true);
  expect(registry.workerExecutionsFactory()).toBe(createWorkerExecutions);
  registry.registerWorkerExecutions(createWorkerExecutions);
  expect(() => registry.registerWorkerExecutions(() => { throw new Error('unused'); })).toThrow(/different value/);

  vi.resetModules();
  const empty = await import('./worker-executions-registry.ts');
  empty.sealWorkerExecutions();
  expect(empty.workerExecutionsRegistered()).toBe(false);
  expect(empty.workerExecutionsFactory).toThrow(/worker-executions.*registerBuiltInRunSlots/);
  expect(() => empty.registerWorkerExecutions(createWorkerExecutions)).toThrow(/sealed/);
});
