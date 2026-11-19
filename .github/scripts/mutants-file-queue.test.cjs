'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { enterQueue } = require('./mutants-file-queue.cjs');

function queueDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Each wait parks until the test calls tick(), so the test decides when a waiter polls again. */
function manualClock() {
  const parked = [];
  let ms = 1_000;
  return {
    now: () => ms++,
    wait: () => new Promise(resolve => parked.push(resolve)),
    async tick() {
      for (const resolve of parked.splice(0)) resolve();
      await new Promise(resolve => setImmediate(resolve));
    },
    parked: () => parked.length,
  };
}

const settled = promise => Promise.race([promise.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);

test('two runs on one host take turns, and the second prints its position', async t => {
  const dir = queueDir(t);
  const clock = manualClock();
  const logs = { 1: [], 2: [] };
  const run = pid => enterQueue({ file: `packages/cezar/src/f${pid}.ts`, signal: new AbortController().signal, log: line => logs[pid].push(line), dir, pid, now: clock.now, wait: clock.wait, isAlive: () => true });
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

test('a waiter removes the entries of a process that died without cleanup', async t => {
  const dir = queueDir(t);
  const clock = manualClock();
  const dead = new Set([7]);
  const opts = { signal: new AbortController().signal, log: () => {}, dir, now: clock.now, wait: clock.wait, isAlive: pid => !dead.has(pid) };
  await enterQueue({ ...opts, file: 'packages/cezar/src/dead.ts', pid: 7 });
  fs.writeFileSync(path.join(dir, 'q-000000000000001-0000000008.json'), JSON.stringify({ pid: 8, file: 'packages/cezar/src/gone.ts' }));
  dead.add(8);
  const release = await enterQueue({ ...opts, file: 'packages/cezar/src/next.ts', pid: 9 });
  assert.deepEqual(fs.readdirSync(dir), ['running.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'running.json'), 'utf8')).pid, 9);
  release();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an interrupted waiter leaves the queue and keeps the running lock', async t => {
  const dir = queueDir(t);
  const clock = manualClock();
  const opts = { log: () => {}, dir, now: clock.now, wait: clock.wait, isAlive: () => true };
  const release = await enterQueue({ ...opts, signal: new AbortController().signal, file: 'packages/cezar/src/a.ts', pid: 1 });
  const controller = new AbortController();
  const waiter = enterQueue({ ...opts, signal: controller.signal, file: 'packages/cezar/src/b.ts', pid: 2 });
  assert.equal(await settled(waiter), false);
  controller.abort();
  await clock.tick();
  await assert.rejects(waiter, { name: 'AbortError' });
  assert.deepEqual(fs.readdirSync(dir), ['running.json']);
  release();
});
