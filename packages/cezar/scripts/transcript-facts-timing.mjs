/** Main-thread measurements only: worker CPU does not count as loop blocking. */
import { readFileSync } from 'node:fs';

export function readQueueWaitMs({ read = readFileSync, platform = process.platform } = {}) {
  // Linux schedstat field 2 is cumulative run-queue wait in nanoseconds.
  if (platform !== 'linux') return null;
  try {
    const waitNs = Number(read('/proc/thread-self/schedstat', 'utf8').trim().split(/\s+/)[1]);
    return Number.isFinite(waitNs) && waitNs >= 0 ? waitNs / 1e6 : null;
  }
  catch { return null; /* Optional diagnostic on restricted procfs mounts. */ }
}

/** libuv idle time: the loop waited in its poll phase for I/O, a timer or another thread. */
export function readLoopIdleMs() {
  return performance.eventLoopUtilization().idle;
}

export function timingSnapshot({ now = () => performance.now(), readQueue = readQueueWaitMs,
  readCpu = () => process.threadCpuUsage(), readLoopIdle = readLoopIdleMs } = {}) {
  const cpu = readCpu();
  const loopIdleMs = readLoopIdle();
  const queueBeforeMs = readQueue();
  const at = now();
  const queueAfterMs = readQueue();
  return { at, cpuMs: (cpu.user + cpu.system) / 1000, loopIdleMs, queueBeforeMs, queueAfterMs };
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
    blockedMs: queueWaitMs === null ? null : Math.max(0, elapsedMs - mainThreadCpuMs - Math.max(loopIdleMs, queueWaitMs)) };
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
