/** The Linux `cgroup` backend: one private cgroup v2 child per worker, under the controller's own
 * cgroup. A process places itself before its command runs, so every descendant inherits the
 * group, detached ones too, and `cgroup.kill` ends them all (ADR 0032). */
import { posix } from 'node:path';
import {
  ensureNamedCgroup,
  realCgroupFs,
  type CgroupFs,
} from '../core/os-cgroup.ts';

const { join } = posix;

export {
  cgroupCommand,
  cgroupPopulated,
  killCgroup,
  ownCgroup,
  probeCgroups,
  realCgroupFs,
  removeCgroup,
  type CgroupFs,
} from '../core/os-cgroup.ts';

/** Where the worker's cgroup lives under `base`. */
export function workerCgroupPath(base: string, workerId: string): string {
  return join(base, `squawk-worker-${workerId}`);
}

/** The worker's cgroup under `base`, created when absent. A path that exists as anything but a
 * real directory throws: it is not ours. */
export function ensureCgroup(base: string, workerId: string, fs: CgroupFs = realCgroupFs): string {
  return ensureNamedCgroup(base, `squawk-worker-${workerId}`, fs);
}
