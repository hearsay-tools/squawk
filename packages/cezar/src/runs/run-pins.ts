/**
 * The holds that keep a run loaded while a process works on it (hearsay-tools/squawk#4042), and
 * the publish of a held record without a write. `RunStore` keeps one of these as `store.runPins`.
 * The user's pin (`setPinned`) is a read flag (`run-read-flags.ts`).
 */
import { snapshotRun, type RunLifecycle } from './lifecycle.ts';
import type { RunPins } from './ports.ts';
import type { RunRecord } from './store.ts';

/** Who may hold a run in memory besides its own record (see `RunPinsTopic.pin`). `maintenance` is the
 *  RunManager's publish, worktree-reclaim and branch-cleanup claims, held across their async work. */
export type RunPinHolder = 'active' | 'continue' | 'cleanup' | 'maintenance';

/** What the topic asks of the store; no import of `store.ts` values. */
export interface PinsState {
  /** Who holds a run beyond its record, by holder, so one holder's unpin never releases another. */
  readonly pins: Map<string, Set<RunPinHolder>>;
  readonly published: Pick<RunLifecycle, 'publish'>;
  /** The record a store write changes in place: held, or loaded to be. */
  record(id: string): RunRecord | undefined;
  /** Read held legacy family members, or a detached cold record. */
  peek(id: string): RunRecord | undefined;
  sweepIfSettled(ids: Iterable<string>): void;
}

export class RunPinsTopic implements RunPins {
  constructor(private readonly state: PinsState) {}

  /**
   * Keep a run in memory for `holder` until `unpin(id, holder)`: a RunManager pins the runs it is
   * executing (`active`) and the run a Continue is admitting (`continue`). A finished run is
   * loaded. Pins are per holder, so releasing one never releases another. Returns the held record.
   */
  pin(id: string, holder: RunPinHolder): RunRecord | undefined {
    const run = this.state.record(id);
    if (!run) return undefined;
    let holders = this.state.pins.get(id);
    if (!holders) this.state.pins.set(id, holders = new Set());
    holders.add(holder);
    return run;
  }

  /** Publish a run's current record again without a write: something read beside the record
   *  changed, such as the run leaving the manager's live registries, which a detail's finish
   *  verdict reads (hearsay-tools/cezarion#1301). */
  republish(id: string): void {
    const run = this.state.peek(id);
    if (run) this.state.published.publish('run.updated', { run, before: snapshotRun(run), source: 'live-release' });
  }

  /** Release `holder`'s pin. The run leaves memory at the next sweep once nothing else holds it. */
  unpin(id: string, holder: RunPinHolder): void {
    const holders = this.state.pins.get(id);
    if (!holders?.delete(holder)) return;
    if (holders.size === 0) this.state.pins.delete(id);
    this.state.sweepIfSettled([id]);
  }
}
