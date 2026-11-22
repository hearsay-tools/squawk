import type { RemovalCleanup } from '../runs/removal-slots.ts';
import { removeArtifacts } from './lifecycle.ts';

/** Removes the run's published artifacts with its history. */
export const artifactsRemovalCleanup: RemovalCleanup = {
  name: 'artifacts',
  removed: (runId, dataDir) => removeArtifacts(dataDir, runId),
};
