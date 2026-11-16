import type { AgentSession } from '../../core/agent-runner.ts';

/** How long an armed bound lives: `execution` ends at `dropActive`, `run` when the run is released. */
export type LivenessScope = 'execution' | 'run';

/**
 * Every liveness bound of a run, one row per kind (spec 2026-11-15-run-lifecycle-facts, ADR 0064).
 * A kind exists only as a row here, so arming a bound with no row fails typecheck. Wait deadlines
 * and checkpoint retries stay in the wait engine (ADR 0061).
 */
export const LIVENESS_BOUNDS = {
  /** A parked session with no activity closes (`TurnSettler.armIdleTimer`). */
  'idle-close': { scope: 'execution' },
  /** A nudge the harness never answers parks on the no-wait human wait (`TurnNudges.armNoWaitNudgeReplyTimer`). */
  'nudge-reply': { scope: 'execution' },
  /** An autonomous nudge the harness never acknowledges closes through the idle path (`TurnNudges.armAutonomousNudgeBound`, hearsay-tools/squawk#2443). */
  'acknowledgement': { scope: 'execution' },
  /** An acknowledged autonomous nudge that gets no turn or reply closes through the idle path (`TurnNudges.armAutonomousNudgeAnswerBound`, hearsay-tools/squawk#3741). Heartbeats do not move it. */
  'nudge-answer': { scope: 'execution' },
  /** Accepted input the harness never reads (`InputDelivery.armUnreadInputTimer`, hearsay-tools/cezarion#505). */
  'unread-input': { scope: 'execution' },
  /** A turn end deferred on a held human follow-up (`InputDelivery.armHeldHumanInputTimer`, hearsay-tools/cezarion#486). */
  'held-human-input': { scope: 'execution' },
  /** A wake that could not be admitted yet (`WakeRetries.retryWaitAdmission`). */
  'wake-retry': { scope: 'run' },
  /** The pause after a failed automatic delivery (`WakeRetries.backoff`). */
  'wake-backoff': { scope: 'run' },
  /** A usage-limit or provider-error hold (`AutoResumeScheduler.armAutoResume`). */
  'auto-resume': { scope: 'run' },
  /** The grace after the last native subagent ended (`SubagentWaits.armGrace`). */
  'subagent-grace': { scope: 'execution' },
  /** A native ask's hold for its live native subagents, moved by each child event (`SubagentWaits.boundNativeAskHold`, hearsay-tools/squawk#2701). */
  'subagent-ask-hold': { scope: 'execution' },
  /** The retry of a stopped child's transcript end, after its session is gone (`SubagentWaits.armRetry`). */
  'subagent-retry': { scope: 'run' },
  /** The earliest inbox claim expiry (`InboxClaims.armInboxClaimExpiry`). */
  'inbox-claim': { scope: 'run' },
  /** The earliest unanswered request deadline of a root's conversation (`FamilyReconciler`). */
  'request-deadline': { scope: 'run' },
} as const satisfies Readonly<Record<string, { readonly scope: LivenessScope }>>;

export type LivenessKind = keyof typeof LIVENESS_BOUNDS;

export interface LivenessBound {
  readonly kind: LivenessKind;
  readonly runId: string;
  /** Tells apart two bounds of one kind and run. */
  readonly key?: string | undefined;
  readonly delayMs: number;
  /** The session the bound was armed in: the expiry runs only while `current()` still returns it. */
  readonly session?: { readonly armed: AgentSession; readonly current: () => AgentSession | undefined } | undefined;
  /** Forgets the caller's copy of the handle when it expires, before the session check. */
  readonly forget?: (() => void) | undefined;
}

interface Armed { readonly kind: LivenessKind; readonly runId: string; readonly handle: NodeJS.Timeout }

/** The owner of each handle, so a state group can cancel the handle it shows. */
const owners = new WeakMap<object, () => void>();

/** Cancel a handle `LivenessTimers.arm` returned, wherever the caller keeps it. */
export function cancelLivenessTimer(handle: NodeJS.Timeout | undefined): void {
  if (handle === undefined) return;
  clearTimeout(handle);
  owners.get(handle)?.();
}

/**
 * The one timer owner of a run's liveness bounds (hearsay-tools/squawk#3662). `arm` replaces the
 * handle armed for the same kind, run and key. An expiry runs only while its handle is current
 * and its session still matches. `clearScope` ends every bound of one scope of a run.
 * `runScopeEnded` hears when a run's last run-scope bound ends, by expiry, clear or cancel; an
 * expiry that arms the bound again keeps it.
 */
export class LivenessTimers {
  readonly #armed = new Map<string, Armed>();

  constructor(private readonly runScopeEnded?: (runId: string) => void) {}

  arm(bound: LivenessBound, expire: () => void): NodeJS.Timeout {
    const slot = slotOf(bound.kind, bound.runId, bound.key);
    this.#remove(slot);
    const handle = setTimeout(() => {
      if (this.#armed.get(slot)?.handle !== handle) return;
      this.#armed.delete(slot);
      try {
        bound.forget?.();
        if (bound.session && bound.session.current() !== bound.session.armed) return;
        expire();
      } finally { this.#ended(bound.kind, bound.runId); }
    }, bound.delayMs);
    handle.unref?.();
    this.#armed.set(slot, { kind: bound.kind, runId: bound.runId, handle });
    owners.set(handle, () => {
      if (this.#armed.get(slot)?.handle !== handle) return;
      this.#armed.delete(slot);
      this.#ended(bound.kind, bound.runId);
    });
    return handle;
  }

  clear(kind: LivenessKind, runId: string, key?: string): void {
    this.#cancel(slotOf(kind, runId, key));
  }

  has(kind: LivenessKind, runId: string, key?: string): boolean {
    return this.#armed.has(slotOf(kind, runId, key));
  }

  /** The runs that hold an armed bound of this kind. */
  runsOf(kind: LivenessKind): string[] {
    return [...new Set([...this.#armed.values()].filter(armed => armed.kind === kind).map(armed => armed.runId))];
  }

  /** The kinds armed for this run in this scope. */
  armedIn(runId: string, scope: LivenessScope): LivenessKind[] {
    return [...this.#armed.values()].filter(armed => armed.runId === runId && LIVENESS_BOUNDS[armed.kind].scope === scope).map(armed => armed.kind);
  }

  clearScope(runId: string, scope: LivenessScope): void {
    for (const [slot, armed] of this.#armed) if (armed.runId === runId && LIVENESS_BOUNDS[armed.kind].scope === scope) this.#cancel(slot);
  }

  clearKind(kind: LivenessKind): void {
    for (const [slot, armed] of this.#armed) if (armed.kind === kind) this.#cancel(slot);
  }

  dispose(): void {
    for (const slot of [...this.#armed.keys()]) this.#cancel(slot);
  }

  #cancel(slot: string): void {
    const armed = this.#remove(slot);
    if (armed) this.#ended(armed.kind, armed.runId);
  }

  #remove(slot: string): Armed | undefined {
    const armed = this.#armed.get(slot);
    if (!armed) return undefined;
    this.#armed.delete(slot);
    clearTimeout(armed.handle);
    return armed;
  }

  #ended(kind: LivenessKind, runId: string): void {
    if (LIVENESS_BOUNDS[kind].scope === 'run' && !this.armedIn(runId, 'run').length) this.runScopeEnded?.(runId);
  }
}

function slotOf(kind: LivenessKind, runId: string, key = ''): string {
  return JSON.stringify([kind, runId, key]);
}
