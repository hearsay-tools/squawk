import type { DeletionGate } from '../runs/removal-slots.ts';
import { agentTmpDirLocations } from '../runs/agent-tmpdir.ts';
import { jobRunsIn } from './job.ts';

/** Keeps an archived family member's tmp directory, and a run's scratch, while a job runs in it,
 *  so the job's log and exit code outlive the task. */
export const jobsDeletionGate: DeletionGate = {
  name: 'jobs',
  refuse: (runId, kind, dataDir) => (kind === 'archive-tmp' || kind === 'scratch') && jobRunsIn(agentTmpDirLocations(dataDir, runId))
    ? 'a job runs in the task tmp directory' : undefined,
};
