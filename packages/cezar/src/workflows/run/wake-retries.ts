import type { RunModuleContext } from './types.ts';
import type { RunMemory } from './run-memory.ts';
import type { RunRecord } from '../../runs/store.ts';
import { noJitter, retryDelayMs, WAKE_RETRY_BACKOFF, type Backoff } from '../../delegation/retry-backoff.ts';
import { LivenessTimers } from './liveness-timers.ts';

interface WakeRetriesHost {
  owesWake(run: RunRecord): boolean;
  queueWaitWake(runId: string): void;
  retryWaitAdmission(runId: string): void;
}

export class WakeRetries {
  // Overridable so tests need not wait out production cadence.
  wakeRetryBackoff: Backoff = WAKE_RETRY_BACKOFF;
  /** The last "retained; continuation unavailable" note per run is `RunMemory`'s `retainedNote`:
   *  the 1 Hz admission retry writes it on the transition into refusal or when the reason
   *  changes, never once per retry. */
  constructor(private readonly context: RunModuleContext, private readonly host: WakeRetriesHost, private readonly memory: RunMemory,
    private readonly timers = new LivenessTimers()) {}

  /** A wake that could not be admitted yet, retried once a second while one is owed. */
  retryWaitAdmission(runId: string): void {
    const run = this.context.store.getRun(runId);
    if (this.context.disposed() || this.timers.has('wake-retry', runId) || !run || !this.host.owesWake(run)) return;
    this.timers.arm({ kind: 'wake-retry', runId, delayMs: 1000 }, () => {
      try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
    });
  }

  clearWakeBackoff(runId: string): void {
    this.timers.clear('wake-backoff', runId);
  }

  stopRetry(runId: string): void {
    this.timers.clear('wake-retry', runId);
  }

  /** The wait before the next automatic delivery attempt after a failed one. */
  backoff(runId: string, failures: number): void {
    this.timers.arm({ kind: 'wake-backoff', runId, delayMs: retryDelayMs(failures - 1, this.wakeRetryBackoff, noJitter) }, () => {
      try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
    });
  }

  inBackoff(runId: string): boolean {
    return this.timers.has('wake-backoff', runId);
  }

  noteRetained(runId: string, message: string): boolean {
    if (this.memory.read(runId, 'retainedNote') !== message) {
      this.memory.write(runId, 'retainedNote', message);
      return true;
    }
    return false;
  }

  clearRetained(runId: string): void {
    this.memory.write(runId, 'retainedNote', undefined);
  }

  forget(runId: string): void {
    this.timers.clear('wake-retry', runId);
    this.clearRetained(runId);
  }

  dispose(): void {
    this.timers.clearKind('wake-retry');
    this.timers.clearKind('wake-backoff');
  }
}
