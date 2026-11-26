const test = require('node:test');
const assert = require('node:assert/strict');

const timing = import('../../packages/cezar/scripts/transcript-facts-timing.mjs');

test('separates CPU, loop idle, run-queue wait and residual blocked time', async () => {
  const { timingDelta } = await timing;
  assert.deepEqual(timingDelta({ at: 0, cpuMs: 10, loopIdleMs: 7, queueAfterMs: 5 },
    { at: 100, cpuMs: 12, loopIdleMs: 47, queueBeforeMs: 35 }),
  { elapsedMs: 100, mainThreadCpuMs: 2, loopIdleMs: 40, queueWaitMs: 30, blockedMs: 58 });
});

test('does not invent scheduler evidence when procfs is absent', async () => {
  const { timingDelta } = await timing;
  assert.deepEqual(timingDelta({ at: 0, cpuMs: 10, loopIdleMs: 0, queueAfterMs: null },
    { at: 100, cpuMs: 12, loopIdleMs: 0, queueBeforeMs: null }),
  { elapsedMs: 100, mainThreadCpuMs: 2, loopIdleMs: 0, queueWaitMs: null, blockedMs: null });
});

test('clamps residual skew from independently sampled clocks', async () => {
  const { timingDelta } = await timing;
  assert.equal(timingDelta({ at: 0, cpuMs: 0, loopIdleMs: 0, queueAfterMs: 0 },
    { at: 1, cpuMs: 1, loopIdleMs: 0, queueBeforeMs: 1 }).blockedMs, 0);
  assert.equal(timingDelta({ at: 0, cpuMs: 0, loopIdleMs: 0, queueAfterMs: 0 },
    { at: 1, cpuMs: 0, loopIdleMs: 3, queueBeforeMs: 0 }).loopIdleMs, 1);
});

test('takes a finite current-thread CPU snapshot and optional scheduler snapshot', async () => {
  const { timingSnapshot } = await timing;
  const sample = timingSnapshot();
  assert.ok(Number.isFinite(sample.at));
  assert.ok(Number.isFinite(sample.cpuMs));
  assert.ok(Number.isFinite(sample.loopIdleMs));
  assert.ok(sample.queueBeforeMs === null || Number.isFinite(sample.queueBeforeMs));
});

test('excludes run-queue delay and loop idle time but keeps synchronous blocking and CPU', async () => {
  const { blockingBudget } = await timing;
  assert.deepEqual(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 2, loopIdleMs: 118, queueWaitMs: 0 }),
    { mode: 'scheduler-adjusted', blockingMs: 2 });
  // Off-CPU time outside the poll phase is synchronous disk I/O or a lock: it blocks.
  assert.equal(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 2, loopIdleMs: 20, queueWaitMs: 0 }).blockingMs, 100);
  assert.equal(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 110, loopIdleMs: 10, queueWaitMs: 0 }).blockingMs, 110);
  assert.equal(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 2, loopIdleMs: 0, queueWaitMs: 100 }).blockingMs, 20);
  assert.equal(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 2, loopIdleMs: 0, queueWaitMs: 0 }).blockingMs, 120);
  assert.equal(blockingBudget({ elapsedMs: 1, mainThreadCpuMs: 0, loopIdleMs: 0, queueWaitMs: 2 }).blockingMs, 0);
  // Run-queue wait after a poll wake-up is in both idle and queue time: subtract it once.
  // 80 ms synchronous stall, 5 ms poll sleep, then 100 ms queued after the wake-up.
  assert.equal(blockingBudget({ elapsedMs: 185, mainThreadCpuMs: 2, loopIdleMs: 105, queueWaitMs: 100 }).blockingMs, 80);
  assert.equal(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 15, loopIdleMs: 110, queueWaitMs: 60 }).blockingMs, 15);
  assert.deepEqual(blockingBudget({ elapsedMs: 120, mainThreadCpuMs: 2, loopIdleMs: 0, queueWaitMs: null }),
    { mode: 'cpu-only', blockingMs: 2 });
});

test('a request that waits off the main thread is latency, not blocking (hearsay-tools/squawk#3355)', async () => {
  const { timingDelta, blockingBudget } = await timing;
  // Run 45709481384, first health sample: 122.8 ms elapsed, 19.9 ms CPU, no run-queue wait.
  // The response waited for gzip on the thread pool while the loop polled.
  const waited = timingDelta({ at: 0, cpuMs: 0, loopIdleMs: 0, queueAfterMs: 0 },
    { at: 122.8, cpuMs: 19.9, loopIdleMs: 100, queueBeforeMs: 0 });
  assert.ok(Math.abs(blockingBudget(waited).blockingMs - 22.8) < 1e-9);
  // The same wall time spent in synchronous disk I/O on the main thread is blocking.
  const synchronous = timingDelta({ at: 0, cpuMs: 0, loopIdleMs: 0, queueAfterMs: 0 },
    { at: 122.8, cpuMs: 19.9, loopIdleMs: 0, queueBeforeMs: 0 });
  assert.equal(blockingBudget(synchronous).blockingMs, 122.8);
});

test('measures real loop idle time and real synchronous blocking', async () => {
  const { timingSnapshot, timingDelta, blockingBudget } = await timing;
  const { setTimeout: delay } = require('node:timers/promises');
  // Leave the module-loading turn so the event loop has started.
  await delay(1);
  const idleStart = timingSnapshot();
  await delay(60);
  const idle = timingDelta(idleStart, timingSnapshot());
  assert.ok(idle.loopIdleMs > 0, JSON.stringify(idle));
  assert.ok(idle.loopIdleMs <= idle.elapsedMs, JSON.stringify(idle));
  const blockedStart = timingSnapshot();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  const blocked = timingDelta(blockedStart, timingSnapshot());
  assert.equal(blocked.loopIdleMs, 0);
  // Without procfs scheduler data the budget is CPU-only and cannot see off-CPU waits.
  const floor = blocked.queueWaitMs === null ? blocked.mainThreadCpuMs : 60 - blocked.queueWaitMs;
  assert.ok(blockingBudget(blocked).blockingMs >= floor, JSON.stringify(blocked));
});

test('does not credit queue wait before the measured interval (B1)', async () => {
  const { timingSnapshot, timingDelta, blockingBudget } = await timing;
  let wall = 0;
  let queue = 0;
  let reads = 0;
  const readQueue = () => {
    const value = queue;
    if (reads++ === 0) { wall += 80; queue += 80; }
    return value;
  };
  const sources = { now: () => wall, readQueue, readCpu: () => ({ user: 0, system: 0 }), readLoopIdle: () => 0 };
  const start = timingSnapshot(sources);
  wall += 60; // Synchronous off-CPU blocking inside the measured interval.
  const end = timingSnapshot(sources);
  const sample = timingDelta(start, end);
  assert.equal(sample.elapsedMs, 60);
  assert.equal(sample.queueWaitMs, 0);
  assert.equal(blockingBudget(sample).blockingMs, 60);
});

test('malformed schedstat data selects CPU-only mode through the real reader', async () => {
  const { readQueueWaitMs, timingSnapshot, timingDelta, blockingBudget } = await timing;
  for (const content of ['', '1', '1 nope 3', '1 Infinity 3', '1 -1 3']) {
    const readQueue = () => readQueueWaitMs({ read: () => content, platform: 'linux' });
    assert.equal(readQueue(), null, JSON.stringify(content));
    const start = timingSnapshot({ now: () => 0, readQueue, readCpu: () => ({ user: 0, system: 0 }), readLoopIdle: () => 0 });
    const end = timingSnapshot({ now: () => 100, readQueue, readCpu: () => ({ user: 2000, system: 0 }), readLoopIdle: () => 0 });
    assert.deepEqual(blockingBudget(timingDelta(start, end)), { mode: 'cpu-only', blockingMs: 2 });
  }
  assert.equal(readQueueWaitMs({ read: () => '1 2500000 3', platform: 'linux' }), 2.5);
});

test('reads per-thread major faults and voluntary switches, or nothing', async () => {
  const { readThreadStats, timingDelta } = await timing;
  const stat = '42 (node (main) x) S 1 2 3 4 5 6 7 8 17 11 12 13';
  const status = 'Name:\tnode\nvoluntary_ctxt_switches:\t31\nnonvoluntary_ctxt_switches:\t2\n';
  const read = path => path.endsWith('/stat') ? stat : status;
  assert.deepEqual(readThreadStats({ read, platform: 'linux' }), { majorFaults: 17, voluntarySwitches: 31 });
  assert.equal(readThreadStats({ read, platform: 'darwin' }), null);
  assert.equal(readThreadStats({ read: () => { throw new Error('EACCES'); }, platform: 'linux' }), null);
  assert.equal(readThreadStats({ read: path => path.endsWith('/stat') ? stat : 'Name:\tnode\n', platform: 'linux' }), null);
  const base = { cpuMs: 0, loopIdleMs: 0, queueBeforeMs: 0, queueAfterMs: 0 };
  const delta = timingDelta({ ...base, at: 0, thread: { majorFaults: 3, voluntarySwitches: 10 } },
    { ...base, at: 5, thread: { majorFaults: 5, voluntarySwitches: 14 } });
  assert.equal(delta.majorFaults, 2);
  assert.equal(delta.voluntarySwitches, 4);
  assert.equal('majorFaults' in timingDelta({ ...base, at: 0, thread: null }, { ...base, at: 5, thread: null }), false);
});

test('records hooked calls, restores them even on throw, and totals them per phase', async () => {
  const { hookCalls, callsWithin } = await timing;
  const target = { work(value) { return value * 2; }, fail() { throw new Error('boom'); } };
  const { work, fail } = target;
  const calls = [];
  const unhook = hookCalls([[target, 'work'], [target, 'fail']], calls);
  assert.equal(target.work(21), 42);
  assert.throws(() => target.fail(), /boom/);
  unhook();
  assert.equal(target.work, work);
  assert.equal(target.fail, fail);
  assert.deepEqual(calls.map(call => call.phase), ['work', 'fail']);
  const totals = callsWithin([{ phase: 'a', at: 1, elapsedMs: 2, mainThreadCpuMs: 1 },
    { phase: 'a', at: 3, elapsedMs: 5, mainThreadCpuMs: 4 }, { phase: 'b', at: 9, elapsedMs: 1, mainThreadCpuMs: 1 }], 0, 9);
  assert.deepEqual(totals, { a: { count: 2, elapsedMs: 7, mainThreadCpuMs: 5, maxElapsedMs: 5 } });
});

test('names the main-thread wait a watcher thread sees', async () => {
  const { startThreadWatch, summarizeWaits } = await timing;
  assert.deepEqual(summarizeWaits([{ state: 'S', syscall: '202', wchan: 'futex_wait_queue' },
    { state: 'S', syscall: '202', wchan: 'futex_wait_queue' }, { state: 'D', syscall: '74', wchan: 'jbd2' }]),
  { 'S syscall=202 futex_wait_queue': 2, 'D syscall=74 jbd2': 1 });
  const watch = await startThreadWatch();
  if (process.platform !== 'linux') { assert.equal(watch, null); return; }
  watch.watch(true);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  watch.watch(false);
  const seen = await watch.stop();
  // Atomics.wait parks the main thread in futex(2), syscall 202 on x86-64 and 98 on arm64.
  assert.ok(seen.some(entry => entry.state === 'S' && ['202', '98'].includes(entry.syscall)), JSON.stringify(seen.slice(0, 5)));
});
