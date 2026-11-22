import type { DeletionGate, RemovalCleanup } from './runs/removal-slots.ts';
import { autosaveCleanupBlocker, clearAutosaveCleanup } from './autosave-cleanup.ts';

/** Refuses a run's history and worktree deletion while its autosave cleanup is not confirmed. The
 *  tmp directory of an archived family member is not the autosave's to keep. */
export const autosaveDeletionGate: DeletionGate = {
  name: 'autosave cleanup',
  refuse: (runId, kind, dataDir) => kind === 'archive-tmp' ? undefined : autosaveCleanupBlocker(dataDir, runId),
};

/** Clears the run's autosave cleanup evidence with its history. */
export const autosaveRemovalCleanup: RemovalCleanup = {
  name: 'autosave cleanup',
  removed: (runId, dataDir) => clearAutosaveCleanup(dataDir, runId),
};
