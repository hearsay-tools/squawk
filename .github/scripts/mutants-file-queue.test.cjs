'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { enterQueue, alive } = require('./mutants-file-queue.cjs');

function queueDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Each wait parks until the test calls tick(), so the test decides when a waiter polls again. */
function manualClock() {
  const parked = [];
  return {
    wait: () => new Promise(resolve => parked.push(resolve)),
    async tick() {
      for (const resolve of parked.splice(0)) resolve();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

const settled = promise => Promise.race([promise.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
const entry = (dir, name, pid, file = `packages/cezar/src/p${pid}.ts`) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid, file }));

test('two runs on one host take turns, and the second prints its position', async t => {
  const dir = queueDir(t);
  const clock = manualClock();
  const logs = { 1: [], 2: [] };
  const run = pid => enterQueue({ file: `packages/cezar/src/f${pid}.ts`, signal: new AbortController().signal, log: line => logs[pid].push(line), dir, pid, wait: clock.wait, isAlive: () => true });
  const releaseFirst = await run(1);
  const second = run(2);
  assert.equal(await settled(second), false);
  assert.deepEqual(logs[2], ['Queue: position 2, 1 ahead; running: packages/cezar/src/f1.ts (pid 1)']);
  assert.deepEqual(logs[1], []);
  await clock.tick();
  assert.equal(await settled(second), false, 'the second run waits while the first holds the queue');
  assert.equal(logs[2].length, 1, 'an unchanged position is printed once');
  releaseFirst();
  await clock.tick();
  const releaseSecond = await second;
  assert.equal(logs[2].at(-1), 'Queue: this run starts now');
  releaseSecond();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a dead run ahead is removed, and two runs that arrive together never both enter', async t => {
  // The interleaving from the pre-PR review: a dead holder, then two waiters at once. Each file
  // belongs to one PID, so removing the dead one cannot remove a live run's entry.
  const dir = queueDir(t);
  const clock = manualClock();
  entry(dir, 't-000000000001-0000000007.json', 7);
  entry(dir, 'c-0000000010.json', 10);
  const opts = { signal: new AbortController().signal, log: () => {}, dir, wait: clock.wait, isAlive: pid => pid !== 7 };
  const first = enterQueue({ ...opts, file: 'packages/cezar/src/a.ts', pid: 20 });
  assert.equal(await settled(first), false, 'a live run that is still choosing a ticket holds the others back');
  assert.ok(!fs.readdirSync(dir).includes('t-000000000001-0000000007.json'), 'the dead run is removed');
  entry(dir, 't-000000000001-0000000010.json', 10);
  fs.rmSync(path.join(dir, 'c-0000000010.json'));
  await clock.tick();
  assert.equal(await settled(first), false, 'the run with the lower ticket goes first');
  fs.rmSync(path.join(dir, 't-000000000001-0000000010.json'));
  await clock.tick();
  const release = await first;
  const second = enterQueue({ ...opts, file: 'packages/cezar/src/b.ts', pid: 10 });
  assert.equal(await settled(second), false, 'a run that arrives while another runs waits');
  release();
  await clock.tick();
  (await second)();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('equal tickets go in PID order', async t => {
  const dir = queueDir(t);
  const clock = manualClock();
  entry(dir, 't-000000000001-0000000003.json', 3);
  const waiter = enterQueue({ signal: new AbortController().signal, log: () => {}, dir, wait: clock.wait, isAlive: () => true, file: 'packages/cezar/src/x.ts', pid: 5 });
  assert.ok(fs.readdirSync(dir).includes('t-000000000002-0000000005.json'));
  entry(dir, 't-000000000002-0000000004.json', 4);
  fs.rmSync(path.join(dir, 't-000000000001-0000000003.json'));
  await clock.tick();
  assert.equal(await settled(waiter), false, 'PID 4 holds the same ticket and goes first');
  fs.rmSync(path.join(dir, 't-000000000002-0000000004.json'));
  await clock.tick();
  (await waiter)();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an interrupted waiter leaves the queue; the default wait stops on the signal', async t => {
  const dir = queueDir(t);
  const logs = [];
  const release = await enterQueue({ signal: new AbortController().signal, log: line => logs.push(line), dir, pid: 1, isAlive: () => true, file: 'packages/cezar/src/a.ts' });
  const controller = new AbortController();
  const waiter = enterQueue({ signal: controller.signal, log: line => logs.push(line), dir, pid: 2, isAlive: () => true, file: 'packages/cezar/src/b.ts' });
  assert.equal(await settled(waiter), false);
  controller.abort();
  await assert.rejects(waiter, { name: 'AbortError' });
  assert.deepEqual(fs.readdirSync(dir), ['t-000000000001-0000000001.json']);
  assert.equal(logs.length, 1);
  release();
});

test('alive reports this process and not an exited one', () => {
  assert.equal(alive(process.pid), true);
  const exited = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.equal(alive(exited), false);
});
