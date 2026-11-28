import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { COMMIT_SLOT, commitSidecar, RENAMING, revokeSidecar, SETTLED, SIGNAL_BYTES } from './transcript-facts-sidecar.ts';

let dir: string;
const signal = () => new Int32Array(new SharedArrayBuffer(SIGNAL_BYTES));
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-facts-sidecar-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it('commits through a temp file and leaves only the sidecar', () => {
  const path = join(dir, 'a.facts.json');
  expect(commitSidecar(path, '{"bytes":1}', signal())).toEqual({ written: true });
  expect(readFileSync(path, 'utf8')).toBe('{"bytes":1}');
  expect(readdirSync(dir)).toEqual(['a.facts.json']);
});

it('a revoke before the rename keeps the old sidecar and removes the temp file', () => {
  const path = join(dir, 'a.facts.json');
  const first = signal();
  commitSidecar(path, '{"bytes":2}', first);
  // A revoke after the commit settled changes nothing on disk.
  revokeSidecar(first);
  const second = signal();
  revokeSidecar(second);
  expect(commitSidecar(path, '{"bytes":1}', second)).toEqual({ written: false });
  expect(readFileSync(path, 'utf8')).toBe('{"bytes":2}');
  expect(readdirSync(dir)).toEqual(['a.facts.json']);
});

it('reports a failed write without throwing', () => {
  const result = commitSidecar(join(dir, 'missing', 'a.facts.json'), '{}', signal());
  expect(result).toMatchObject({ error: expect.stringContaining('ENOENT'), cleaned: true });
});

it('a revoke waits for a rename under way, however long it takes', async () => {
  const slots = signal();
  const renamer = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const slots = new Int32Array(workerData);
    Atomics.store(slots, ${COMMIT_SLOT}, ${RENAMING});
    parentPort.postMessage('renaming');
    Atomics.wait(slots, 0, 0, 1_200);
    Atomics.store(slots, ${COMMIT_SLOT}, ${SETTLED});
    Atomics.notify(slots, ${COMMIT_SLOT});
  `, { eval: true, workerData: slots.buffer });
  try {
    // Real time: the rename outlasts the one-second bound a revoke once had. The worker settles
    // only after its sleep, so a revoke that returns early still sees RENAMING.
    await once(renamer, 'message');
    revokeSidecar(slots);
    expect(Atomics.load(slots, COMMIT_SLOT)).toBe(SETTLED);
  } finally { await renamer.terminate(); }
});

it('a revoke after the worker exited does not wait for its rename', () => {
  const slots = signal();
  Atomics.store(slots, COMMIT_SLOT, RENAMING);
  revokeSidecar(slots, false);
  expect(Atomics.load(slots, COMMIT_SLOT)).toBe(RENAMING);
});
