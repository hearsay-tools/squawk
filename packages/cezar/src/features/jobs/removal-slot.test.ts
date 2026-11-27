import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processStartToken } from '../../detached-process.ts';
import { agentTmpDir, agentTmpDirLocations, agentTmpEnv } from '../../runs/agent-tmpdir.ts';
import type { DeletionKind } from '../../runs/removal-slots.ts';
import { claimJob, jobPaths } from './job.ts';
import { jobHoldsScratch, jobsDeletionGate } from './removal-slot.ts';

let root: string;
let dataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-job-gate-'));
  dataDir = join(root, '.ai/cezar');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A record naming this live process stands for a running supervisor. Returns its exit file. */
function runningJob(scratch: string): string {
  const start = processStartToken(process.pid), exitFile = join(scratch, 'bench.1.exit');
  claimJob(jobPaths(scratch, 'bench'), { name: 'bench', pid: process.pid, ...(start === undefined ? {} : { start }), command: ['x'],
    startedAt: new Date().toISOString(), log: join(scratch, 'bench.1.log'), exitFile });
  return exitFile;
}

describe('jobHoldsScratch', () => {
  it('holds scratch for the end a job was running at, after the job exits, and not for a later end or an archive', () => {
    const runId = randomUUID(), scratch = agentTmpDir(dataDir, runId);
    mkdirSync(scratch, { recursive: true });
    expect(jobHoldsScratch(dataDir, runId, { finishedAt: 'end-1', archived: false })).toBe(false);
    const exitFile = runningJob(scratch);
    expect(jobHoldsScratch(dataDir, runId, { finishedAt: 'end-1', archived: false })).toBe(true);
    writeFileSync(exitFile, '0\n');
    expect(jobHoldsScratch(dataDir, runId, { finishedAt: 'end-1', archived: false })).toBe(true);
    expect(jobHoldsScratch(dataDir, runId, { finishedAt: 'end-2', archived: false })).toBe(false);
    // Archive is a removal point: the mark holds nothing once the run is archived.
    expect(jobHoldsScratch(dataDir, runId, { finishedAt: 'end-1', archived: true })).toBe(false);
  });
});

describe('jobsDeletionGate', () => {
  const kinds: DeletionKind[] = ['history', 'worktree', 'archive-tmp', 'scratch'];

  it('keeps scratch and an archived member tmp directory while a job runs in it', () => {
    const id = randomUUID();
    agentTmpEnv(dataDir, id, {});
    // A record that cannot be read may belong to a supervisor that still runs (`jobRunsIn`).
    writeFileSync(join(agentTmpDirLocations(dataDir, id)[0]!, 'bench.job.db'), 'damaged');
    expect(kinds.map(kind => jobsDeletionGate.refuse(id, kind, dataDir) !== undefined)).toEqual([false, false, true, true]);
  });

  it('keeps scratch for the end the reap passes, after the job exits', () => {
    const runId = randomUUID(), scratch = agentTmpDir(dataDir, runId);
    mkdirSync(scratch, { recursive: true });
    const exitFile = runningJob(scratch);
    expect(jobsDeletionGate.refuse(runId, 'scratch', dataDir, { finishedAt: 'end-1', archived: false })).toBeDefined();
    writeFileSync(exitFile, '0\n');
    // Without the run's end (the startup sweep, the worker cleanup) only a running job holds it.
    expect(jobsDeletionGate.refuse(runId, 'scratch', dataDir)).toBeUndefined();
    expect(jobsDeletionGate.refuse(runId, 'scratch', dataDir, { finishedAt: 'end-1', archived: false })).toBeDefined();
    expect(jobsDeletionGate.refuse(runId, 'scratch', dataDir, { finishedAt: 'end-2', archived: false })).toBeUndefined();
    // The run's end is for scratch only: the archive path asks about running jobs.
    expect(jobsDeletionGate.refuse(runId, 'archive-tmp', dataDir, { finishedAt: 'end-1', archived: false })).toBeUndefined();
  });

  it('keeps a directory of no known run while a job runs in it', () => {
    const dir = join(root, 'orphan');
    mkdirSync(dir);
    expect(jobsDeletionGate.refuseDirectory?.(dir, 'scratch')).toBeUndefined();
    const exitFile = runningJob(dir);
    expect(jobsDeletionGate.refuseDirectory?.(dir, 'scratch')).toBeDefined();
    writeFileSync(exitFile, '0\n');
    expect(jobsDeletionGate.refuseDirectory?.(dir, 'scratch')).toBeUndefined();
  });
});
