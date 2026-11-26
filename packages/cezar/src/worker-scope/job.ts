/** The Windows `job` backend: one named Job Object per worker (ADR 0032). A keeper process holds
 * the job's only lasting handle with KILL_ON_JOB_CLOSE; the controller holds the keeper's stdin, so
 * the worker's processes end with the controller (product decision 4). Each command starts inside
 * the job at creation through `scripts/windows-worker-job.ps1 run`. */
export {
  jobCommand,
  jobEmpty,
  probeJobs,
  realJobHelper,
  terminateJob,
  type JobHelper,
} from '../core/os-win-job.ts';

/** The job's name in this session's namespace. */
export function workerJobName(workerId: string): string {
  return `Local\\squawk-worker-${workerId}`;
}
