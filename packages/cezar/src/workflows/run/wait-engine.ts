import { waitKindForWait, registeredWaitKinds, type WaitFeatureServices, type WaitLifecycle, type WaitWatchContext } from './wait-kind-registry.ts';
import type { AgentInput } from '@open-mercato/cezar-contract/agent-input';
import type { Wait, WaitErrorCode, AskErrorCode, WorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import type { ActiveRun } from '../active-run.ts';
import type { RunModuleContext } from './types.ts';
import type { RunRecord } from '../../runs/store.ts';
import { recordedDirectory } from '../../runs/shared-hosts.ts';
import { assertWaitCapacity, WaitCapacityError } from '../../runs/wait-capacity.ts';
import { waitErrorMessage } from '../../ci-wait/errors.ts';
import { ProcessWaitSupervisor } from '../../process-wait/supervisor.ts';
import type { ExitFileRoots } from '../../process-wait/exit-file.ts';
import { agentTmpDirEnabled, resolveAgentTmpDir } from '../../runs/agent-tmpdir.ts';
import { chargesBudget, openWaits, waitInputId, waitResultText, settledWaitEntry, type WaitResult } from '../waits.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import { registrationReceipt, type RegistrationIdentity } from './wait-registration.ts';
import { watchDeadline } from './wait-watches.ts';

export function warnRegistrationRefused(code: WaitErrorCode | AskErrorCode): void {
  console.warn(`[hsq] wait registration refused: ${code}`);
}

// Deadline timers stop through clearTimeout on waitTimers (disarm and dispose); this signal never fires.
const deadlineSignal = new AbortController().signal;

/** What the engine asks the rest of the run manager (ADR 0053): wake admission, the run line,
 *  the family reconcile, human waits and the subagent session. Feature wait kinds add their own
 *  services through `WaitFeatureServices`. */
export interface WaitEngineHost extends WaitFeatureServices {
  active(id: string): ActiveRun | undefined;
  canProceedWithRun(id: string, run: RunRecord | undefined): run is RunRecord;
  reconcileWorkerWaits(family?: string): void;
  noticeParkedWorkers(id: string): void;
  withdrawSquawkHumanWaits(id: string): void;
  /** The session that holds a subagent wait's children is live (hearsay-tools/cezarion#2431). */
  subagentSessionLive(id: string): boolean;
  /** Resolve a subagent wait whose session is gone `interrupted`, ending its running children in the transcript (hearsay-tools/cezarion#2431). */
  interruptSubagentWait(id: string, waitId: string): void;
  countAutomaticWakes(id: string): number;
  /** Cancel these waits at the wake cap, then repark the session or wait on the user without one. */
  wakeCapReached(id: string, waits: readonly Wait[], state: ActiveRun | undefined): void;
  queueWaitWake(id: string): void;
  retryWaitAdmission(id: string): void;
  isParked(id: string): boolean;
  parkOnWaits(id: string, state: ActiveRun): void;
  abortRegistrations(id: string): void;
  /** Forget the run's wake retries, wake delivery, queued wake and admission, in that order. */
  forgetWakes(id: string): void;
}

/** The steps a registration path chooses; the row decides the arm, the park guard and the entry returned. */
interface OpenOptions {
  /** Withdraw Squawk's human waits after the compare, before the commit. */
  withdraw: boolean;
  receipt?: RegistrationIdentity | undefined;
  onCommitFailure?: CommitFailure;
  /** Park when the run is at its turn boundary or parked. */
  park: boolean;
  /** Present: the caller already holds the result (undefined takes the row's default), so the
   *  wait arms nothing and resolves with it at once. */
  result?: WaitResult | undefined;
}
/** Absent: the commit error escapes as it is. `persistence`: the tool's coded `capacity` or
 *  `persistence` error. `log`: warn and refuse. `capacity`: a full list throws the path's own error. */
type CommitFailure = 'persistence' | { log: string } | { capacity: () => Error };
export type OpenResult<W extends Wait> = { status: 'opened'; wait: W } | { status: 'refused'; wait?: undefined };

interface CancelWaitsOptions { onCommitFailure?: 'throw' | 'skip'; superseded?: true; log?: string }

/** Executes the wait-kind rows behind the run facade: open, arm, resolve, re-arm, cancel and forget. */
export class WaitEngine {
  /** A resolution whose checkpoint failed, retried by wait id. */
  private readonly settleRetries = new Map<string, { runId: string; timer: NodeJS.Timeout }>();
  /** Each armed wait's watch, by wait id: the context its row's lifecycle reads, and the signal
   *  the engine aborts when it disarms the wait. */
  private readonly armedWatches = new Map<string, { context: WaitWatchContext; abort: AbortController; armed: boolean }>();
  private readonly workerResolveRetries = new Set<string>();
  /** One timer per wait with an armed deadline, keyed by wait id. */
  private readonly waitTimers = new Map<string, { runId: string; timer: NodeJS.Timeout }>();

  constructor(private readonly context: RunModuleContext, private readonly host: WaitEngineHost, private readonly maxAutoContinues: number,
    private readonly processSupervisor: Pick<ProcessWaitSupervisor, 'watch' | 'close'> = new ProcessWaitSupervisor()) {}

  /** Whether the run's open-wait list has room. Each caller keeps its own refusal shape. */
  hasRoom(run: Pick<RunRecord, 'waits'>): boolean {
    try { assertWaitCapacity(run); return true; }
    catch (error) {
      if (error instanceof WaitCapacityError) return false;
      throw error;
    }
  }

  /** Commit, arm and (at a boundary) park on a newly registered wait. A wait opened with the
   *  result its caller already holds arms nothing and resolves with it after the park. */
  open<W extends Wait>(runId: string, state: ActiveRun | undefined, wait: W, options: OpenOptions): OpenResult<W> {
    if (options.withdraw) this.host.withdrawSquawkHumanWaits(runId);
    if (!this.commitOpened(runId, wait, options.onCommitFailure, options.receipt)) return { status: 'refused' };
    const settled = 'result' in options;
    const hooks = waitKindForWait(wait)?.lifecycle;
    if (!settled) this.armOpened(runId, wait, hooks);
    if (hooks?.postOpen && this.context.store.getRun(runId)?.waits?.some(entry => entry.id === wait.id && entry.phase === 'open')) {
      hooks.postOpen(this.watchContext(runId, wait));
    }
    if (options.park) this.park(runId, state, wait, hooks);
    // The answer is the wait as opened, even when the result resolves it at once.
    const opened = this.openedEntry(runId, wait);
    if (settled) this.settleWait(runId, wait.id, options.result);
    return { status: 'opened', wait: opened };
  }

  /** A row's open hook replaces the arm a newly opened wait takes. */
  private armOpened(runId: string, wait: Wait, hooks: WaitLifecycle | undefined): void {
    if (hooks?.open) hooks.open(this.watchContext(runId, wait));
    else this.armWait(runId, wait);
  }

  /**
   * Commit a changed open wait, then arm it. A moved deadline disarms the old one first; an
   * unchanged one keeps what is armed, including a checkpoint retry. False when the commit failed
   * under a `log` policy: the saved wait and what is armed stay as they were.
   */
  refresh(runId: string, previous: Wait, next: Wait, onCommitFailure?: { log: string }): boolean {
    if (next !== previous && !this.commitOpened(runId, next, onCommitFailure)) return false;
    const deadline = (wait: Wait) => 'deadline' in wait ? wait.deadline : undefined;
    if (deadline(next) !== deadline(previous)) this.disarmWait(previous.id);
    this.armWait(runId, next);
    return true;
  }

  private commitOpened(runId: string, wait: Wait, policy: CommitFailure | undefined, receipt?: RegistrationIdentity): boolean {
    try {
      if (receipt) this.context.store.commitWait(runId, wait, undefined, registrationReceipt(receipt, wait));
      else this.context.store.commitWait(runId, wait);
      return true;
    } catch (error) {
      if (typeof policy === 'object' && 'capacity' in policy) throw error instanceof WaitCapacityError ? policy.capacity() : error;
      if (typeof policy === 'object') {
        console.warn(`${policy.log}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      if (policy !== 'persistence') throw error;
      if (error instanceof WaitCapacityError) {
        warnRegistrationRefused('capacity');
        throw Object.assign(new Error(waitErrorMessage('capacity')), { code: 'capacity' });
      }
      throw Object.assign(new Error(waitErrorMessage('persistence')), { code: 'persistence' });
    }
  }

  /** A wait its open hook already settled is no longer listed, and parks nothing. */
  private park(runId: string, state: ActiveRun | undefined, wait: Wait, hooks: WaitLifecycle | undefined): void {
    if (!state) return;
    if (hooks?.parkOnlyWhileListed && !this.context.store.getRun(runId)?.waits?.some(entry => entry.id === wait.id)) return;
    if (state.boundary.atTurnBoundary === state.liveSession.session || this.host.isParked(runId)) this.host.parkOnWaits(runId, state);
  }

  /** The entry as recorded now: the store keeps the entry it was given, and only its phase can
   *  have moved since. A row's lookup can read a wait its open hook already settled. */
  private openedEntry<W extends Wait>(runId: string, wait: W): W {
    const latest = this.context.store.getRun(runId);
    const lookup = waitKindForWait(wait)?.lifecycle?.openedEntry;
    if (lookup) return lookup(wait, [...latest?.waits ?? [], ...latest?.lastWaits ?? []]) as W;
    return (latest?.waits?.find(entry => entry.id === wait.id) as W | undefined) ?? wait;
  }

  /** Where a process wait's exit file may sit: the run's worktree (the checkout for a run without
   *  one) and, unless turned off, the Squawk temp directory its agent gets as `TMPDIR`. */
  exitFileRoots(runId: string, run = this.context.store.getRun(runId)): ExitFileRoots {
    return { worktree: recordedDirectory(run, this.context.repoRoot), ...(agentTmpDirEnabled() ? { tmpDir: resolveAgentTmpDir(this.context.dataDir, runId) } : {}) };
  }

  /** Start what resolves an open wait: the lifecycle its row registers. An overdue deadline
   *  (restart) resolves at once. A plugin kind's arm runs once per watch; a built-in kind's
   *  own guard keeps it idempotent across refreshes and recovery. */
  private armWait(runId: string, wait: Wait): void {
    if (this.context.disposed() || wait.phase !== 'open') return;
    const row = waitKindForWait(wait);
    if (!row && wait.kind === 'plugin') {
      console.warn(`[hsq] no wait adapter registered for plugin kind ${wait.pluginKind}; retaining wait ${wait.id}`);
      return;
    }
    // Only the user's answer, or a cancel, ends a wait without an arm hook: nothing to arm.
    if (!row?.lifecycle?.arm || (row.isPlugin && this.armedWatches.get(wait.id)?.armed)) return;
    const context = this.watchContext(runId, wait);
    this.armedWatches.get(wait.id)!.armed = true;
    row.lifecycle.arm(context);
  }

  /** The wait's watch context: the armed one, now reading this entry, or a new one. */
  private watchContext(runId: string, wait: Wait): WaitWatchContext {
    const current = this.armedWatches.get(wait.id);
    if (current) { current.context.wait = wait; return current.context; }
    const abort = new AbortController();
    const isCurrent = () => !abort.signal.aborted && !this.context.disposed() && this.armedWatches.get(wait.id)?.context === context;
    const context: WaitWatchContext = {
      runId, store: this.context.store, host: this.host, wait, signal: abort.signal,
      resolve: result => { if (isCurrent()) this.settleWait(runId, wait.id, result); },
      disposed: () => this.context.disposed(),
      deadlineArmed: () => this.waitTimers.has(wait.id),
      armTimer: (delay, due) => { if (isCurrent()) this.armTimer(runId, context.wait, delay, () => { if (isCurrent()) due(); }); },
      armDeadline: (due = () => context.resolve()) => { if (isCurrent()) this.armDeadline(runId, context.wait, () => { if (isCurrent()) due(); }); },
      processes: this.processSupervisor,
      exitFileRoots: () => this.exitFileRoots(runId),
    };
    this.armedWatches.set(wait.id, { context, abort, armed: false });
    return context;
  }

  /** The wait's one timer. A newer timer clears the previous one, and disarm clears the current one. */
  private armTimer(runId: string, wait: Wait, delay: number, due: () => void): void {
    const previous = this.waitTimers.get(wait.id);
    if (previous) clearTimeout(previous.timer);
    const timer = watchDeadline({ deadline: 'deadline' in wait ? wait.deadline : undefined, delay }, deadlineSignal, () => {
      if (this.waitTimers.get(wait.id)?.timer !== timer) return;
      this.waitTimers.delete(wait.id);
      due();
    });
    this.waitTimers.set(wait.id, { runId, timer });
  }

  /** A timer, peer or subagent deadline. A stopping, stopped or finishing run takes no
   *  self-generated wake: the wait stays open for that transition to cancel, as the monitoring
   *  timer did before it was a wait. */
  private armDeadline(runId: string, wait: Wait, due: () => void): void {
    if (this.waitTimers.has(wait.id) || !('deadline' in wait) || wait.deadline === undefined) return;
    const fire = () => {
      const run = this.context.store.getRun(runId);
      if (!this.host.canProceedWithRun(runId, run)) return;
      due();
    };
    const delay = Date.parse(wait.deadline) - Date.now();
    if (delay <= 0) { fire(); return; }
    this.armTimer(runId, wait, delay, fire);
  }

  /** Stop everything that could still resolve this wait. */
  private disarmWait(waitId: string): void {
    const watch = this.armedWatches.get(waitId);
    if (watch) {
      watch.abort.abort();
      this.armedWatches.delete(waitId);
    }
    const timer = this.waitTimers.get(waitId); if (timer) clearTimeout(timer.timer); this.waitTimers.delete(waitId);
    const retry = this.settleRetries.get(waitId); if (retry) clearTimeout(retry.timer); this.settleRetries.delete(waitId);
    this.workerResolveRetries.delete(waitId);
    if (watch) {
      try { waitKindForWait(watch.context.wait)?.lifecycle?.disarm?.(watch.context); }
      catch (error) { console.warn(`[hsq] wait disarm hook failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /** `resolveWait`, retried while its durable checkpoint is unavailable: a failed write may not
   *  drop the accepted intent or publish a false result. */
  settleWait(runId: string, waitId: string, result?: WaitResult): void {
    if (this.context.disposed() || this.settleRetries.has(waitId)) return;
    try { this.resolveWait(runId, waitId, result); }
    catch {
      console.warn(`[hsq] wait checkpoint unavailable; retaining result for retry.`);
      const timer = setTimeout(() => { this.settleRetries.delete(waitId); this.settleWait(runId, waitId, result); }, 1000);
      timer.unref(); this.settleRetries.set(waitId, { runId, timer });
    }
  }

  private disarmRun(runId: string): void {
    for (const [id, watch] of this.armedWatches) if (watch.context.runId === runId) this.disarmWait(id);
    for (const [id, entry] of this.waitTimers) if (entry.runId === runId) this.disarmWait(id);
    for (const [id, retry] of this.settleRetries) if (retry.runId === runId) this.disarmWait(id);
  }

  /** Re-arm the caller's recovery snapshot. Do not re-read between waits: an overdue
   *  deadline can resolve synchronously, but the remaining snapshot entries still arm. */
  rearm(run: RunRecord): void {
    for (const wait of openWaits(run)) this.armWait(run.id, wait);
  }

  disposeWatches(): void {
    for (const id of this.armedWatches.keys()) this.disarmWait(id);
    for (const row of registeredWaitKinds()) row.lifecycle?.dispose?.();
    this.processSupervisor.close();
  }
  disposeRetries(): void {
    for (const retry of this.settleRetries.values()) clearTimeout(retry.timer);
    this.settleRetries.clear();
  }
  dispose(): void {
    for (const entry of this.waitTimers.values()) clearTimeout(entry.timer);
    this.waitTimers.clear();
  }

  /** The open peer waits of these runs whose named peer already wrote, settled or was deleted resolve now. */
  resolvePeerWaits(runIds: readonly string[]): void {
    for (const id of runIds) for (const wait of WAIT_KINDS.peer.select(openWaits(this.context.store.getRun(id) ?? {}))) this.resolvePeerWait(id, wait);
  }

  /** The wait's row re-observes its target now. True when the wait is no longer open. */
  private resolvePeerWait(runId: string, wait: Wait): boolean {
    if (this.context.disposed()) return false;
    return waitKindForWait(wait)?.lifecycle?.reconcile?.(this.watchContext(runId, wait)) ?? false;
  }

  /** Commit an open wait as resolved together with its lifecycle input (id = wait id, or an
   *  upgraded worker wait's `wakeInputId`), then queue the run's wake. A worker wait passes the
   *  entry as reconciled, with its outcomes and `result`. Throws when the checkpoint fails; a wait
   *  no longer open is ignored. */
  resolveWait(runId: string, waitId: string, result?: WaitResult, observed?: WorkerWaitEntry): void {
    const latest = this.context.store.getRun(runId)?.waits?.find(wait => wait.id === waitId);
    if (!latest || latest.phase !== 'open') return;
    const state = this.host.active(runId);
    const resolvedAt = new Date().toISOString();
    const settled = settledWaitEntry(latest, result, observed, resolvedAt);
    // The count includes a batch still awaiting acknowledgement. The kind row reads the durable
    // result so an empty dependency deadline is free, including at a spent budget.
    if (chargesBudget(settled) && this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) {
      this.host.wakeCapReached(runId, [latest], state);
      return;
    }
    const input: AgentInput = { id: waitInputId(settled), parentRunId: runId, source: 'lifecycle', createdAt: resolvedAt,
      text: waitResultText(settled, { workerStatus: this.workerStatus }) };
    this.context.store.commitWait(runId, settled, input);
    if (this.armedWatches.has(waitId)) this.disarmWait(waitId);
    try { this.host.queueWaitWake(runId); }
    catch { this.host.retryWaitAdmission(runId); }
  }

  /** A worker's current status, as a worker wait's result names it. */
  readonly workerStatus = (workerId: string): string => this.context.store.getRun(workerId)?.status ?? 'unavailable';

  resolveWorkerWait(runId: string, entry: WorkerWaitEntry, observed: WorkerWaitEntry): boolean {
    // The deadline stays armed until the resolution is durable. A failed write is retried in a
    // second, since nothing else may touch this family again before the deadline.
    try { this.resolveWait(runId, entry.id, undefined, observed); }
    catch {
      if (!this.workerResolveRetries.has(entry.id)) console.warn(`[hsq] worker wait checkpoint failed; retrying in 1 second`);
      this.disarmWait(entry.id);
      this.workerResolveRetries.add(entry.id);
      waitKindForWait(entry)?.lifecycle?.rearm?.(this.watchContext(runId, entry), 1_000);
      return false;
    }
    this.disarmWait(entry.id);
    return true;
  }

  /** Keep watches armed until cancellation is durable. A skipped write disarms nothing. */
  cancel(runId: string, ids: readonly string[], opts: CancelWaitsOptions = {}): Wait[] {
    let settled: Wait[];
    try {
      ({ settled } = this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: ids, ...(opts.superseded ? { superseded: true } : {}) }));
    } catch (error) {
      if (opts.onCommitFailure !== 'skip') throw error;
      console.warn(`${opts.log ?? `[hsq] wait cancellation failed`}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    for (const id of ids) this.disarmWait(id);
    return settled;
  }

  /**
   * Cancel every open or resolved wait of a run without waking the agent: stop, Finish, cancel,
   * deletion, DONE and any terminal status. Human input cancels none (hearsay-tools/cezarion#1233).
   * A failed commit leaves the record as a crash would and never stops the disarm, so Stop still
   * reaches the session when the store is closed or broken (hearsay-tools/cezarion#1234).
   */
  cancelAll(runId: string): void {
    const before = this.context.store.getRun(runId)?.waits ?? [];
    const remaining = (this.context.store.getRun(runId)?.waits ?? []).map(wait => wait.id);
    try { if (remaining.length) this.context.store.commitOutcome(runId, { kind: 'cancelled', waitIds: remaining }); }
    catch (error) { console.warn(`[hsq] wait cancellation failed: ${error instanceof Error ? error.message : String(error)}`); }
    for (const wait of before) this.disarmWait(wait.id);
    this.forgetRun(runId);
  }

  /** Stop every watch, timer, retry and queued wake a run's waits hold in memory. */
  forgetRun(runId: string): void {
    this.host.abortRegistrations(runId);
    this.disarmRun(runId);
    this.host.forgetWakes(runId);
  }
}
