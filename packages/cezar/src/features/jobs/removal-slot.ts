import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeletionGate, DeletionGateContext } from '../../runs/removal-slots.ts';
import { agentTmpDirLocations } from '../../runs/agent-tmpdir.ts';
import { jobRunsIn } from './job.ts';

const REASON = 'a job runs in the task tmp directory';

/** Names the task end whose reap kept the scratch for a running job. */
const JOB_KEPT_FILE = '.hsq-job-kept';

/**
 * A job started with the default directory keeps the task's scratch past the end it was running at
 * (hearsay-tools/squawk#3138). Every later reap of that same end keeps it too, even after the job
 * exits: a read mark or another run event is not an end. The task's next end (a Continue clears
 * `finishedAt`, and the end sets a new one), its archive or the startup sweep removes it once no
 * job in it runs. Archive is a removal point, so an archived run's mark holds nothing: every archive
 * path commits the run, and that event reaps.
 */
export function jobHoldsScratch(dataDir: string, runId: string, run: DeletionGateContext): boolean {
  const locations = agentTmpDirLocations(dataDir, runId), mark = run.finishedAt ?? '';
  const kept = !run.archived && locations.some((dir) => { try { return readFileSync(join(dir, JOB_KEPT_FILE), 'utf8') === mark; } catch { return false; } });
  if (kept) return true;
  if (!jobRunsIn(locations)) return false;
  // Without the mark the scratch still stays while the job runs; it goes at the first reap after.
  for (const dir of locations) { try { writeFileSync(join(dir, JOB_KEPT_FILE), mark); } catch { /* not this location */ } }
  return true;
}

/** Keeps an archived family member's tmp directory, and a run's scratch, while a job runs in it,
 *  so the job's log and exit code outlive the task. The reap at a run's end passes the run's end,
 *  and then the scratch stays for every reap of that end (`jobHoldsScratch`). */
export const jobsDeletionGate: DeletionGate = {
  name: 'jobs',
  refuse(runId, kind, dataDir, context) {
    if (kind !== 'archive-tmp' && kind !== 'scratch') return undefined;
    const held = kind === 'scratch' && context ? jobHoldsScratch(dataDir, runId, context) : jobRunsIn(agentTmpDirLocations(dataDir, runId));
    return held ? REASON : undefined;
  },
  refuseDirectory: (dir) => (jobRunsIn([dir]) ? REASON : undefined),
};
