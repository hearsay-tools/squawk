/** Main-thread measurements only: worker CPU does not count as loop blocking. */
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

export function readQueueWaitMs({ read = readFileSync, platform = process.platform } = {}) {
  // Linux schedstat field 2 is cumulative run-queue wait in nanoseconds.
  if (platform !== 'linux') return null;
  try {
    const waitNs = Number(read('/proc/thread-self/schedstat', 'utf8').trim().split(/\s+/)[1]);
    return Number.isFinite(waitNs) && waitNs >= 0 ? waitNs / 1e6 : null;
  }
  catch { return null; /* Optional diagnostic on restricted procfs mounts. */ }
}

/** Linux per-thread major page faults and voluntary context switches: optional diagnostics
 * that tell a disk page-in from a lock or I/O wait. Null where procfs cannot answer. */
export function readThreadStats({ read = readFileSync, platform = process.platform } = {}) {
  if (platform !== 'linux') return null;
  try {
    const stat = read('/proc/thread-self/stat', 'utf8');
    // Field 12 (majflt); the command name in field 2 may contain spaces, so count after ')'.
    const majorFaults = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[9]);
    const switches = /^voluntary_ctxt_switches:\s*(\d+)$/m.exec(read('/proc/thread-self/status', 'utf8'));
    return Number.isFinite(majorFaults) && switches ? { majorFaults, voluntarySwitches: Number(switches[1]) } : null;
  }
  catch { return null; /* Optional diagnostic on restricted procfs mounts. */ }
}

/** libuv idle time: the loop waited in its poll phase for I/O, a timer or another thread. */
export function readLoopIdleMs() {
  return performance.eventLoopUtilization().idle;
}

export function timingSnapshot({ now = () => performance.now(), readQueue = readQueueWaitMs,
  readCpu = () => process.threadCpuUsage(), readLoopIdle = readLoopIdleMs, readThread = readThreadStats } = {}) {
  const thread = readThread();
  const cpu = readCpu();
  const loopIdleMs = readLoopIdle();
  const queueBeforeMs = readQueue();
  const at = now();
  const queueAfterMs = readQueue();
  return { at, cpuMs: (cpu.user + cpu.system) / 1000, loopIdleMs, queueBeforeMs, queueAfterMs, thread };
}

export function timingDelta(start, end) {
  const elapsedMs = end.at - start.at;
  const mainThreadCpuMs = end.cpuMs - start.cpuMs;
  // Snapshots run JavaScript, never inside the poll phase, so the idle delta lies in the interval.
  const loopIdleMs = Math.max(0, Math.min(elapsedMs, end.loopIdleMs - start.loopIdleMs));
  // Previous AFTER -> next BEFORE is contained in the wall-clock interval.
  // Subtract only this inner queue-wait delta. A pause between a scheduler
  // read and the clock must never credit wait from outside the interval.
  const queueWaitMs = start.queueAfterMs === null || end.queueBeforeMs === null ? null
    : Math.max(0, Math.min(elapsedMs, end.queueBeforeMs - start.queueAfterMs));
  // Residual: off-CPU time outside the poll phase (synchronous disk I/O, locks, Atomics.wait)
  // plus measurement overhead. See blockingBudget for why the larger wait is subtracted once.
  return { elapsedMs, mainThreadCpuMs, loopIdleMs, queueWaitMs,
    blockedMs: queueWaitMs === null ? null : Math.max(0, elapsedMs - mainThreadCpuMs - Math.max(loopIdleMs, queueWaitMs)),
    ...(start.thread && end.thread ? { majorFaults: end.thread.majorFaults - start.thread.majorFaults,
      voluntarySwitches: end.thread.voluntarySwitches - start.thread.voluntarySwitches } : {}) };
}

/** Main-thread blocking is loop-active time without run-queue wait. Loop idle time is excluded:
 * a planned timer sleep, and a request waiting on the thread pool, a worker or the kernel, are
 * latency but do not block the loop. CPU, synchronous disk I/O and Atomics.wait still count.
 * libuv counts a run-queue wait after a poll wake-up as idle time too, and the two cannot be
 * told apart, so only the larger of idle and run-queue wait is subtracted. Subtracting both
 * could hide a synchronous stall; this choice can only over-count, never above elapsed minus
 * run-queue wait. It never drops below main-thread CPU. */
export function blockingBudget(sample) {
  const mode = sample.queueWaitMs === null ? 'cpu-only' : 'scheduler-adjusted';
  const blockingMs = sample.queueWaitMs === null ? sample.mainThreadCpuMs
    : Math.max(sample.mainThreadCpuMs, sample.elapsedMs - Math.max(sample.loopIdleMs, sample.queueWaitMs));
  return { mode, blockingMs: Math.max(0, blockingMs) };
}

/** Light per-call timing (clock and thread CPU only), so many hooked calls add little loop time.
 * Each call records its start; nested hooked calls are recorded too, under their own phase. */
export function hookCalls(hooks, calls) {
  const restore = hooks.map(([target, name]) => {
    const original = target[name];
    target[name] = function (...args) {
      const at = performance.now();
      const cpu = process.threadCpuUsage();
      try { return original.apply(this, args); }
      finally {
        const used = process.threadCpuUsage(cpu);
        calls.push({ phase: name, at, elapsedMs: performance.now() - at, mainThreadCpuMs: (used.user + used.system) / 1000 });
      }
    };
    return () => { target[name] = original; };
  });
  return () => { for (const undo of restore) undo(); };
}

/** Per-phase totals of the calls that started in [from, to). */
export function callsWithin(calls, from, to) {
  const phases = {};
  for (const call of calls) {
    if (call.at < from || call.at >= to) continue;
    const total = phases[call.phase] ??= { count: 0, elapsedMs: 0, mainThreadCpuMs: 0, maxElapsedMs: 0 };
    total.count++;
    total.elapsedMs += call.elapsedMs;
    total.mainThreadCpuMs += call.mainThreadCpuMs;
    total.maxElapsedMs = Math.max(total.maxElapsedMs, call.elapsedMs);
  }
  return phases;
}

// Polls the main thread's kernel state from another thread; records it whenever it is not running.
const WATCH_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const flag = new Int32Array(workerData.flag);
const base = '/proc/' + workerData.pid + '/task/' + workerData.pid + '/';
const read = name => { try { return readFileSync(base + name, 'utf8').trim(); } catch { return null; } };
const seen = [];
parentPort.postMessage('ready');
for (let mode; (mode = Atomics.load(flag, 0)) !== 2;) {
  if (mode === 0) { Atomics.wait(flag, 0, 0); continue; }
  const stat = read('stat');
  const state = stat === null ? '?' : stat.charAt(stat.lastIndexOf(')') + 2);
  if (state !== 'R') {
    seen.push({ at: performance.timeOrigin + performance.now(), state, wchan: read('wchan'),
      syscall: read('syscall')?.split(' ')[0] ?? null });
    Atomics.add(flag, 1, 1);
    Atomics.notify(flag, 1);
  }
  Atomics.wait(flag, 0, 1, 1);
}
parentPort.postMessage(seen);
`;

/** Diagnostics only (Linux): name what the main thread waits in, such as a futex, a sleep, a
 * child process or a page fault, about once a millisecond while watching is on. */
export async function startThreadWatch() {
  if (process.platform !== 'linux') return null;
  // [0]: 0 paused, 1 watching, 2 stop. [1]: samples recorded so far.
  const flag = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(WATCH_SOURCE, { eval: true, workerData: { flag: flag.buffer, pid: process.pid } });
  await once(worker, 'message');
  const set = mode => { Atomics.store(flag, 0, mode); Atomics.notify(flag, 0); };
  return {
    watch: on => set(on ? 1 : 0),
    /** Block the main thread until the watcher records one more sample: 'ok' or 'timed-out'. */
    awaitRecord: timeoutMs => Atomics.wait(flag, 1, Atomics.load(flag, 1), timeoutMs) === 'timed-out' ? 'timed-out' : 'ok',
    async stop() {
      const reply = once(worker, 'message');
      set(2);
      const [seen] = await reply;
      await worker.terminate();
      return seen.map(entry => ({ ...entry, at: entry.at - performance.timeOrigin }));
    },
  };
}

/** Counts of watched waits by state, syscall number and kernel wait channel. */
export function summarizeWaits(seen) {
  const counts = {};
  for (const entry of seen) {
    const key = `${entry.state} syscall=${entry.syscall} ${entry.wchan}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Name the waits of every sample whose blocking reached the budget, not only the first one.
 * `window(sample)` gives the sample's [from, to) on the performance.now() clock. */
export function attachWaitsOverBudget(samples, seen, budgetMs, window) {
  for (const sample of samples) {
    if (sample.blockingMs < budgetMs) continue;
    const [from, to] = window(sample);
    sample.waits = summarizeWaits(seen.filter(entry => entry.at >= from && entry.at < to));
  }
}

/** Instrument only the synchronous open call. Imports and hook setup are outside its budget.
 * These diagnostic wrappers restore every method even when open throws. */
export async function prepareOpenTiming(runtime) {
  const [{ RunDatabase }, { RunClaimsTopic }, { RunTranscriptFacts }, { ExitEvents }] = await Promise.all([
    import(new URL('runs/run-database.' + runtime.ext, runtime.url)),
    import(new URL('runs/run-claims-topic.' + runtime.ext, runtime.url)),
    import(new URL('runs/transcript-facts-topic.' + runtime.ext, runtime.url)),
    import(new URL('runs/exit-events.' + runtime.ext, runtime.url)),
  ]);
  return (RunStore, dataDir) => {
    const phases = [];
    const hooks = [[RunDatabase, 'open'], [RunDatabase.prototype, 'listWhere'],
      [RunClaimsTopic.prototype, 'loadHeldRows'], [RunTranscriptFacts.prototype, 'warmTranscriptFacts'],
      [ExitEvents.prototype, 'writeLoaded']];
    const restore = hooks.map(([target, name]) => {
      const original = target[name];
      target[name] = function (...args) {
        const start = timingSnapshot();
        try { return original.apply(this, args); }
        finally { phases.push({ phase: name, ...(name === 'listWhere' ? { sql: args[0] } : {}),
          ...timingDelta(start, timingSnapshot()) }); }
      };
      return () => { target[name] = original; };
    });
    const start = timingSnapshot();
    try {
      const store = RunStore.open(dataDir);
      return { store, timing: { ...timingDelta(start, timingSnapshot()), phases } };
    } finally { for (const undo of restore) undo(); }
  };
}
