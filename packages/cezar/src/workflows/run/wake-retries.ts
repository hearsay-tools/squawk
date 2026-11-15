import type { RunModuleContext } from './types.ts';
import type { RunMemory } from './run-memory.ts';
import type { RunRecord } from '../../runs/store.ts';
import { noJitter, retryDelayMs, WAKE_RETRY_BACKOFF, type Backoff } from '../../delegation/retry-backoff.ts';

interface WakeRetriesHost {
  owesWake(run: RunRecord): boolean;
  queueWaitWake(runId: string): void;
  retryWaitAdmission(runId: string): void;
}

export class WakeRetries {
  // Overridable so tests need not wait out production cadence.
  wakeRetryBackoff: Backoff = WAKE_RETRY_BACKOFF;
  /** A wake that could not be admitted yet, retried by run id. Kept here: a timer handle, which
   *  slice S5 (hearsay-tools/squawk#3662) moves into `LivenessTimers`. */
  readonly wakeRetries = new Map<string, NodeJS.Timeout>();
  /** The wait before the next automatic delivery attempt after a failed one, by run id. Kept here:
   *  a timer handle, which slice S5 (hearsay-tools/squawk#3662) moves into `LivenessTimers`. */
  readonly wakeBackoffs = new Map<string, NodeJS.Timeout>();

  /** The last "retained; continuation unavailable" note per run is `RunMemory`'s `retainedNote`:
   *  the 1 Hz admission retry writes it on the transition into refusal or when the reason
   *  changes, never once per retry. */
  constructor(private readonly context: RunModuleContext, private readonly host: WakeRetriesHost, private readonly memory: RunMemory) {}

  retryWaitAdmission(runId: string): void {
    const run = this.context.store.getRun(runId);
    if (this.context.disposed() || this.wakeRetries.has(runId) || !run || !this.host.owesWake(run)) return;
    const timer = setTimeout(() => {
      this.wakeRetries.delete(runId);
      try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
    }, 1000);
    timer.unref(); this.wakeRetries.set(runId, timer);
  }

  clearWakeBackoff(runId: string): void {
    const timer = this.wakeBackoffs.get(runId); if (timer) clearTimeout(timer); this.wakeBackoffs.delete(runId);
  }

  stopRetry(runId: string): void {
    const retry = this.wakeRetries.get(runId); if (retry) clearTimeout(retry); this.wakeRetries.delete(runId);
  }

  backoff(runId: string, failures: number): void {
    const previous = this.wakeBackoffs.get(runId); if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.wakeBackoffs.get(runId) !== timer) return;
      this.wakeBackoffs.delete(runId);
      try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
    }, retryDelayMs(failures - 1, this.wakeRetryBackoff, noJitter));
    timer.unref(); this.wakeBackoffs.set(runId, timer);
  }

  inBackoff(runId: string): boolean {
    return this.wakeBackoffs.has(runId);
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
    const timer = this.wakeRetries.get(runId); if (timer) clearTimeout(timer); this.wakeRetries.delete(runId);
    this.clearRetained(runId);
  }

  dispose(): void {
    for (const timer of this.wakeRetries.values()) clearTimeout(timer);
    this.wakeRetries.clear();
    for (const timer of this.wakeBackoffs.values()) clearTimeout(timer);
    this.wakeBackoffs.clear();
  }
}
