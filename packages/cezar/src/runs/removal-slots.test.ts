import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { expect, it } from 'vitest';
import {
  assertRunSlotsSealed, deletionRefusal, prepareReclaim, registerRunSlots, runRemovalCleanups, runSlotsSealed, sealRunSlots,
  type DeletionGate, type DeletionKind, type ReclaimPreparation, type RemovalCleanup,
} from './removal-slots.ts';
import type { WorkerResults } from './ports.ts';

// The cases run in order on one registry: this file's module registry is its own, so it starts
// empty and unsealed.
const calls: string[] = [];
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
const ready = preparation('ready'), broken = preparation('broken', true), late = preparation('late');
const kept = cleanup('kept', true), cleared = cleanup('cleared');
const run = makeRunRecord({ id: 'run-1' });
// The preparations here read no store.
const context = { repoRoot: '/repo', store: {} as WorkerResults };

it('throws on every read before the seal, naming the missing registration', async () => {
  registerRunSlots({ gates: [first] });
  expect(runSlotsSealed()).toBe(false);
  for (const read of [() => assertRunSlotsSealed(), () => deletionRefusal('run-1', 'history', '/data'), () => runRemovalCleanups('run-1', '/data')]) {
    expect(read).toThrow(/No removal slot is registered: call registerBuiltInRunSlots\(\)/);
  }
  await expect(prepareReclaim(run, context)).rejects.toThrow(/No removal slot is registered/);
  expect(calls).toEqual([]);
});

it('asks the gates in registration order and returns the first reason', () => {
  registerRunSlots({ gates: [first, second], preparations: [ready, broken, late], cleanups: [kept, cleared] });
  sealRunSlots();
  expect(runSlotsSealed()).toBe(true);
  expect(deletionRefusal('run-1', 'history', '/data')).toBe('first refuses');
  expect(deletionRefusal('run-1', 'archive-tmp', '/data')).toBe('second refuses');
  expect(deletionRefusal('run-1', 'worktree', '/data')).toBeUndefined();
  expect(calls.splice(0)).toEqual([
    'first:run-1:history:/data',
    'first:run-1:archive-tmp:/data', 'second:run-1:archive-tmp:/data',
    'first:run-1:worktree:/data', 'second:run-1:worktree:/data',
  ]);
});

it('stops the preparations at the first rejection', async () => {
  await expect(prepareReclaim(run, context)).rejects.toThrow('broken failed');
  expect(calls.splice(0)).toEqual(['ready:run-1', 'broken:run-1']);
});

it('runs every cleanup, then throws the first failure', () => {
  expect(() => runRemovalCleanups('run-1', '/data')).toThrow('kept failed');
  expect(calls.splice(0)).toEqual(['kept:run-1:/data', 'cleared:run-1:/data']);
});

it('ignores a slot registered again and refuses a new one after the seal', () => {
  expect(() => registerRunSlots({ gates: [first], cleanups: [cleared] })).not.toThrow();
  expect(() => registerRunSlots({ gates: [gate('new', undefined)] })).toThrow('The removal slots are sealed');
  expect(() => registerRunSlots({ preparations: [preparation('new')] })).toThrow('The removal slots are sealed');
  expect(() => registerRunSlots({ cleanups: [cleanup('new')] })).toThrow('The removal slots are sealed');
});
