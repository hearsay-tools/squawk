import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { beforeEach, expect, it, vi } from 'vitest';
import type { DeletionGate, DeletionKind, ReclaimPreparation, RemovalCleanup } from './removal-slots.ts';
import type { WorkerResults } from './ports.ts';

// Each case loads its own copy of the registry module, so it starts empty and unsealed and runs alone.
const calls: string[] = [];
const fresh = async () => { vi.resetModules(); return import('./removal-slots.ts'); };
beforeEach(() => { calls.length = 0; });

const gate = (name: string, refuses: DeletionKind | undefined): DeletionGate => ({
  name, refuse: (runId, kind, dataDir) => { calls.push(`${name}:${runId}:${kind}:${dataDir}`); return kind === refuses ? `${name} refuses` : undefined; },
});
const preparation = (name: string, fails = false): ReclaimPreparation => ({
  name, prepare: async (run) => { calls.push(`${name}:${run.id}`); if (fails) throw new Error(`${name} failed`); },
});
const cleanup = (name: string, fails = false): RemovalCleanup => ({
  name, removed: (runId, dataDir) => { calls.push(`${name}:${runId}:${dataDir}`); if (fails) throw new Error(`${name} failed`); },
});
const first = gate('first', 'history'), second = gate('second', 'archive-tmp');
const run = makeRunRecord({ id: 'run-1' });
// The preparations here read no store.
const context = { repoRoot: '/repo', store: {} as { workerResults: WorkerResults } };

it('throws on every read before the seal, naming the missing registration', async () => {
  const slots = await fresh();
  slots.registerRunSlots({ gates: [first], preparations: [preparation('ready')], cleanups: [cleanup('cleared')] });
  expect(slots.runSlotsSealed()).toBe(false);
  for (const read of [() => slots.assertRunSlotsSealed(), () => slots.deletionRefusal('run-1', 'history', '/data'), () => slots.runRemovalCleanups('run-1', '/data')]) {
    expect(read).toThrow(/No removal slot is registered: call registerBuiltInRunSlots\(\)/);
  }
  await expect(slots.prepareReclaim(run, context)).rejects.toThrow(/No removal slot is registered/);
  expect(calls).toEqual([]);
});

it('asks the gates in registration order and returns the first reason', async () => {
  const slots = await fresh();
  slots.registerRunSlots({ gates: [first, second] });
  slots.sealRunSlots();
  expect(slots.runSlotsSealed()).toBe(true);
  expect(slots.deletionRefusal('run-1', 'history', '/data')).toBe('first refuses');
  expect(slots.deletionRefusal('run-1', 'archive-tmp', '/data')).toBe('second refuses');
  expect(slots.deletionRefusal('run-1', 'worktree', '/data')).toBeUndefined();
  expect(calls).toEqual([
    'first:run-1:history:/data',
    'first:run-1:archive-tmp:/data', 'second:run-1:archive-tmp:/data',
    'first:run-1:worktree:/data', 'second:run-1:worktree:/data',
  ]);
});

it('stops the preparations at the first rejection', async () => {
  const slots = await fresh();
  slots.registerRunSlots({ preparations: [preparation('ready'), preparation('broken', true), preparation('late')] });
  slots.sealRunSlots();
  await expect(slots.prepareReclaim(run, context)).rejects.toThrow('broken failed');
  expect(calls).toEqual(['ready:run-1', 'broken:run-1']);
});

it('runs every cleanup, then throws the first failure', async () => {
  const slots = await fresh();
  slots.registerRunSlots({ cleanups: [cleanup('kept', true), cleanup('cleared')] });
  slots.sealRunSlots();
  expect(() => slots.runRemovalCleanups('run-1', '/data')).toThrow('kept failed');
  expect(calls).toEqual(['kept:run-1:/data', 'cleared:run-1:/data']);
});

it('ignores a slot registered again and refuses a new one after the seal', async () => {
  const slots = await fresh();
  const cleared = cleanup('cleared');
  slots.registerRunSlots({ gates: [first], cleanups: [cleared] });
  slots.sealRunSlots();
  expect(() => slots.registerRunSlots({ gates: [first], cleanups: [cleared] })).not.toThrow();
  expect(() => slots.registerRunSlots({ gates: [gate('new', undefined)] })).toThrow('The removal slots are sealed');
  expect(() => slots.registerRunSlots({ preparations: [preparation('new')] })).toThrow('The removal slots are sealed');
  expect(() => slots.registerRunSlots({ cleanups: [cleanup('new')] })).toThrow('The removal slots are sealed');
});
