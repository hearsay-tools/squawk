import '../built-in-wait-kinds.testkit.ts';
import { vi } from 'vitest';
import type { RunStore } from '../runs/store.ts';
import { RunRecovery } from './run/run-recovery.ts';
import type { RunModuleContext } from './run/types.ts';
import { unused } from './unused.testkit.ts';

export type RecoveryHost = ConstructorParameters<typeof RunRecovery>[4];

/**
 * `RunRecovery` over a real store and no engine: no run is active or stopped, and the
 * collaborators a restart pass always calls are no-op spies. Any other read throws.
 * `move` is the store's own exit, as `RunManager` passes it.
 */
export function recoveryOver(store: RunStore, overrides: Partial<RecoveryHost> = {}): { recovery: RunRecovery; host: RecoveryHost } {
  const host = unused<RecoveryHost>('RunRecovery.host', {
    waitEngine: unused<RecoveryHost['waitEngine']>('WaitEngine', { rearm: vi.fn(), cancelAll: vi.fn() }),
    workerScratchCleanup: unused<RecoveryHost['workerScratchCleanup']>('WorkerScratchCleanup', { recover: vi.fn(), schedule: vi.fn() }),
    humanWaits: unused<RecoveryHost['humanWaits']>('HumanWaits', { unsurfacedHumanWait: () => undefined }),
    inboxClaims: unused<RecoveryHost['inboxClaims']>('InboxClaims', { armInboxClaimExpiry: vi.fn() }),
    isActive: () => false,
    workerExecutionStopped: () => false,
    move: vi.fn<RecoveryHost['move']>((id, exit, patch) => store.move(id, exit, patch)),
    reconcileWorkerWaits: vi.fn(),
    deliverConversationInput: vi.fn(),
    reviveQueuedRun: vi.fn<RecoveryHost['reviveQueuedRun']>(async () => undefined),
    settleSuccess: vi.fn<RecoveryHost['settleSuccess']>(async () => undefined),
    answerRoutedQuestion: vi.fn(),
    owesWake: () => false,
    queueWaitWake: vi.fn(),
    pump: vi.fn<RecoveryHost['pump']>(async () => undefined),
    ...overrides,
  });
  const familyReconciler = unused<ConstructorParameters<typeof RunRecovery>[1]>('FamilyReconciler', {
    setRecoveryFactsPending: vi.fn(), reconcileRecoveryWorkerFamilies: vi.fn(async () => undefined),
    reapDeferredScratch: vi.fn(), liveFamilyMembers: () => [], familyMembers: () => [],
  });
  const workerQuestions = unused<ConstructorParameters<typeof RunRecovery>[2]>('WorkerQuestions', {
    recoverWorkerMessages: vi.fn(), closeRoutedQuestions: vi.fn(), supersedeWorkerFallback: () => false,
  });
  const autoResume = unused<ConstructorParameters<typeof RunRecovery>[3]>('AutoResumeScheduler', { reconcileAutoResumes: vi.fn() });
  const context = unused<RunModuleContext>('RunModuleContext', { store, disposed: () => false });
  return { recovery: new RunRecovery(context, familyReconciler, workerQuestions, autoResume, host, ''), host };
}
