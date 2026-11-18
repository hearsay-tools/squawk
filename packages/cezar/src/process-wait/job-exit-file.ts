import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The file names of an `hsq job` (hearsay-tools/cezarion#3097): `<name>.job.db` holds the claim
 * record, and each start writes `<name>.<run>.exit`, where `<run>` is `<base36 time>-<supervisor PID>`.
 * They live here, in core, so a process wait can prove a job's exit file without the jobs feature.
 */
export const JOB_RECORD_SUFFIX = '.job.db';
export const JOB_EXIT_SUFFIX = '.exit';
export const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Whether the record database holds a claimed job record for `name`. */
function recordedJob(path: string, name: string): boolean {
  if (!existsSync(path)) return false;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare('SELECT record FROM job WHERE id = 1').get();
    return typeof row?.record === 'string' && (JSON.parse(row.record) as { name?: unknown } | null)?.name === name;
  } catch { return false; } finally { try { db?.close(); } catch { /* never opened */ } }
}

/**
 * Whether `exitFile` is the exit file of the job start whose supervisor is `pid` (hearsay-tools/squawk#3909):
 * its name ends in that PID, and a job record for its name sits beside it. A later start of the name
 * replaces the record but not the earlier start's file name, so a wait on the earlier start keeps its
 * proof. An unreadable record proves nothing.
 */
export function isJobExitFile(exitFile: string, pid: number): boolean {
  const file = basename(exitFile);
  if (!file.endsWith(JOB_EXIT_SUFFIX)) return false;
  const stem = file.slice(0, -JOB_EXIT_SUFFIX.length);
  const dot = stem.lastIndexOf('.');
  const name = stem.slice(0, dot);
  if (dot < 1 || !JOB_NAME.test(name) || !new RegExp(`^[0-9a-z]+-${pid}$`).test(stem.slice(dot + 1))) return false;
  return recordedJob(join(dirname(exitFile), `${name}${JOB_RECORD_SUFFIX}`), name);
}
