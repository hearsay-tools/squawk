import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTmpDir, agentTmpDirMayExist, agentTmpEnv, removeAgentTmpDir } from '../runs/agent-tmpdir.ts';
import { manager, store, root, worker, reopenRuntime, useWorkerWaitFixture } from '../workflows/worker-wait-claude.testkit.ts';
import { groupHolder, readableHolder } from './non-dumpable.testkit.ts';
import { setHostScope } from '../worker-scope/worker-scopes.ts';
import { WorkerScratchCleanup } from './scratch-cleanup.ts';
import { claimJob, jobPaths } from '../jobs/job.ts';
import { processStartToken } from '../detached-process.ts';
import { setRunStatus, readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';

// os.tmpdir reads Node's original environment even after the workflow fixture replaces process.env.
const nativeEnvironment = process.env;
function setTmpRoot(value: string | undefined) {
  for (const env of [nativeEnvironment, process.env]) {
    if (value === undefined) delete env.TMPDIR; else env.TMPDIR = value;
  }
}

/** Records `pid`'s group in the worker's scope, as a spawn site does. The host backend is pinned to
 * process groups, so the same test holds on every host. */
const own = (runId: string, pid: number) => store.scopes.spawnScope(runId).started(pid);

describe('durable scratch cleanup evidence', () => {
  useWorkerWaitFixture();
  beforeEach(() => { setHostScope({ backend: 'groups', reason: 'test' }); });
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); setHostScope(undefined); });

  async function completed(location = 'local') {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    setRunStatus(store, parent.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const run = await worker(parent.id);
    const generation = store.commitWorkerExecutionStart(run.id);
    setRunStatus(store, run.id, RUN_STATUS.cancelled); store.commitWorkerExecutionComplete(run.id, generation);
    manager.pauseWorkerCleanup();
    const dataDir = join(root, '.ai/cezar'), scratch = location === 'local' ? agentTmpDir(dataDir, run.id) : agentTmpEnv(dataDir, run.id, {}).TMPDIR!;
    if (location === 'fallback') {
      expect(scratch).not.toBe(agentTmpDir(dataDir, run.id));
      expect(existsSync(join(scratch, '.cez-owner'))).toBe(true);
    }
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'keep'), 'durable');
    return { run, generation, dataDir, scratch };
  }

  it('keeps worker scratch while a job recorded in it runs and removes it at the first check after the job ends', async () => {
    const { run, dataDir, scratch } = await completed();
    // A record naming this live process stands for a running supervisor (hearsay-tools/squawk#3138).
    const exitFile = join(scratch, 'bench.1.exit');
    const start = processStartToken(process.pid);
    claimJob(jobPaths(scratch, 'bench'), { name: 'bench', pid: process.pid, ...(start === undefined ? {} : { start }), command: ['x'],
      startedAt: new Date().toISOString(), log: join(scratch, 'bench.1.log'), exitFile });
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      cleanup.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(readFileSync(join(scratch, 'keep'), 'utf8')).toBe('durable');
      writeFileSync(exitFile, '0\n');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { cleanup.pause(); vi.useRealTimers(); removeAgentTmpDir(dataDir, run.id); }
  });

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('retains an unreadable old fallback owner and its pointer until ownership clears and the worker\'s process exits', async () => {
    const priorTmpdir = process.env.TMPDIR;
    const oldRoot = mkdtempSync('/tmp/cez-old-');
    setTmpRoot(oldRoot);
    const { run, generation, dataDir, scratch } = await completed('fallback');
    expect(dirname(scratch)).toBe(oldRoot);
    const local = agentTmpDir(dataDir, run.id), pointer = join(local, '.cez-fallback'), owner = join(scratch, '.cez-owner');
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs'); process.stdout.write('ready');
      process.stdin.on('data', data => { fs.appendFileSync('holder-writes', data); process.stdout.write('written'); });
      process.stdin.on('end', () => process.exit(0));
    `], { cwd: scratch, stdio: ['pipe', 'pipe', 'inherit'], detached: true });
    const exited = once(child, 'exit'); await once(child.stdout, 'data');
    own(run.id, child.pid!);
    const write = async () => { const done = once(child.stdout, 'data'); child.stdin.write('still writable\n'); await done; };
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    try {
      expect(readlinkSync(`/proc/${child.pid}/cwd`)).toBe(scratch);
      setTmpRoot('/tmp');
      if (run.delegation?.role !== 'worker') throw Error('missing worker');
      expect(store.workerScratchResourcesSafe(run.id, generation, run.delegation.workspace.resourceId)).toBe(false);
      chmodSync(owner, 0);
      expect(() => readFileSync(owner)).toThrow(/EACCES/);
      expect(store.workerScratchResourcesSafe(run.id, generation, run.delegation.workspace.resourceId)).toBe(false);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cleanup.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(readFileSync(pointer, 'utf8')).toBe(scratch);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      await write();
      // Restart reconstruction must also retain the only route to this old temp root.
      cleanup.pause(); cleanup.recover(); await vi.advanceTimersByTimeAsync(60_000);
      chmodSync(owner, 0o600);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(readFileSync(pointer, 'utf8')).toBe(scratch);
      await write();
      expect(readFileSync(join(scratch, 'holder-writes'), 'utf8')).toBe('still writable\nstill writable\n');
      child.stdin.end(); await exited;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(local)).toBe(false);
    } finally {
      cleanup.pause(); vi.useRealTimers(); child.stdin.end(); await exited;
      if (existsSync(owner)) chmodSync(owner, 0o600);
      rmSync(oldRoot, { recursive: true, force: true });
      setTmpRoot(priorTmpdir);
    }
  });

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('retains the old fallback pointer after partial removal and retries after its parent becomes writable', async () => {
    const priorTmpdir = process.env.TMPDIR;
    const oldRoot = mkdtempSync('/tmp/cez-old-'); setTmpRoot(oldRoot);
    const { run, dataDir, scratch } = await completed('fallback');
    expect(dirname(scratch)).toBe(oldRoot);
    const pointer = join(agentTmpDir(dataDir, run.id), '.cez-fallback');
    setTmpRoot('/tmp');
    let cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      chmodSync(oldRoot, 0o500);
      cleanup.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(scratch)).toBe(true);
      expect(existsSync(pointer)).toBe(true);
      expect(readFileSync(pointer, 'utf8')).toBe(scratch);
      // A new cleanup instance must recover even if recursive rm already removed .cez-owner.
      cleanup.pause(); cleanup = new WorkerScratchCleanup(store, dataDir, () => false); cleanup.recover();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(true);
      chmodSync(oldRoot, 0o700);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(agentTmpDir(dataDir, run.id))).toBe(false);
    } finally { cleanup.pause(); chmodSync(oldRoot, 0o700); rmSync(oldRoot, { recursive: true, force: true }); vi.useRealTimers();
      setTmpRoot(priorTmpdir);
    }
  });

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0).each(['missing owner', 'foreign owner'])('a partial-removal receipt cannot delete a replacement fallback with %s', async ownership => {
    const priorTmpdir = process.env.TMPDIR, oldRoot = mkdtempSync('/tmp/cez-old-'); setTmpRoot(oldRoot);
    const { run, dataDir, scratch } = await completed('fallback');
    expect(dirname(scratch)).toBe(oldRoot); setTmpRoot('/tmp');
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    const displaced = `${scratch}.original`, pointer = join(agentTmpDir(dataDir, run.id), '.cez-fallback');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      chmodSync(oldRoot, 0o500); cleanup.recover(); await vi.advanceTimersByTimeAsync(0);
      expect(existsSync(scratch)).toBe(true);
      chmodSync(oldRoot, 0o700); renameSync(scratch, displaced); mkdirSync(scratch);
      writeFileSync(join(scratch, 'foreign'), 'replacement files');
      if (ownership === 'foreign owner') writeFileSync(join(scratch, '.cez-owner'), 'another project');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(readFileSync(join(scratch, 'foreign'), 'utf8')).toBe('replacement files');
      expect(readFileSync(pointer, 'utf8')).toBe(scratch);
      rmSync(scratch, { recursive: true }); renameSync(displaced, scratch);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(pointer)).toBe(false);
    } finally {
      cleanup.pause(); chmodSync(oldRoot, 0o700); rmSync(oldRoot, { recursive: true, force: true });
      vi.useRealTimers(); setTmpRoot(priorTmpdir);
    }
  });

  it.runIf(process.platform === 'linux').each(['corrupt', 'missing', 'quarantined'].flatMap(mode => ['local', 'fallback'].map(location => ({ mode, location }))))('retains held $location scratch across $mode index recovery and retries after the holder exits', async ({ mode, location }) => {
    const { run, dataDir, scratch } = await completed(location);
    const holder = await groupHolder(scratch);
    own(run.id, holder.pid);
    try {
      // A real process in the worker's scope; no liveness read is mocked.
      await holder.write();
      manager.dispose(); store.close();
      const database = join(dataDir, 'runs.db');
      if (mode === 'corrupt') writeFileSync(database, '{corrupt');
      else if (mode === 'missing') for (const file of [database, `${database}-wal`, `${database}-shm`]) rmSync(file, { force: true });
      else {
        const rows = readPersistedRuns(dataDir);
        delete rows.find((row: { id: string }) => row.id === run.id)!.delegation.workspace.resourceId;
        seedRuns(dataDir, rows);
      }
      reopenRuntime();
      // An unreadable database is never reset: the store is unavailable, not empty (#779).
      if (mode === 'corrupt') expect(store.unavailable?.kind).toBe('corrupt');
      expect(store.getRun(run.id)?.delegation?.role).not.toBe('worker');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await manager.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      expect(existsSync(join(dataDir, 'runs', `${run.id}.execution.json`))).toBe(true);
      expect(existsSync(join(dataDir, 'runs', `${run.id}.processes.json`))).toBe(true);
      await holder.write();
      expect(readFileSync(join(scratch, 'holder-writes'), 'utf8')).toBe('still writable\nstill writable\n');
      await holder.close();
      await vi.advanceTimersByTimeAsync(60_000);
      // Without an index nothing is cleaned up, held or not: it waits for the database to be restored.
      expect(existsSync(scratch)).toBe(mode === 'corrupt');
    } finally { await holder.close(); removeAgentTmpDir(dataDir, run.id); vi.useRealTimers(); }
  });

  it.each(['legacy intent', 'unknown execution', 'unknown processes'].flatMap(condition => ['local', 'fallback'].map(location => ({ condition, location }))))('retains unindexed $location scratch with $condition until its evidence can authorize cleanup', async ({ condition, location }) => {
    const { run, dataDir, scratch } = await completed(location);
    const evidence = join(dataDir, 'runs', `${run.id}.${condition === 'unknown processes' ? 'processes' : 'execution'}.json`);
    const original = readFileSync(evidence);
    if (condition === 'legacy intent') {
      const proof = JSON.parse(original.toString()); delete proof.scratchCleanup;
      writeFileSync(evidence, JSON.stringify(proof));
    } else writeFileSync(evidence, '{corrupt');
    manager.dispose(); store.close(); seedRuns(dataDir, []);
    reopenRuntime(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await manager.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(readFileSync(join(scratch, 'keep'), 'utf8')).toBe('durable');
      writeFileSync(evidence, original);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { removeAgentTmpDir(dataDir, run.id); vi.useRealTimers(); }
  });

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('retries private evidence discovery after directory denial, then clears ordinary orphans too', async () => {
    const { dataDir, scratch } = await completed();
    const files = join(dataDir, 'runs'), orphan = agentTmpDir(dataDir, 'ordinary-orphan');
    mkdirSync(orphan, { recursive: true });
    manager.dispose(); store.close(); seedRuns(dataDir, []);
    reopenRuntime(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      chmodSync(files, 0);
      await manager.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      expect(existsSync(orphan)).toBe(true);
      chmodSync(files, 0o700);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(orphan)).toBe(false);
    } finally { chmodSync(files, 0o700); vi.useRealTimers(); }
  });

  it('cannot treat a worker with stripped role metadata as an ordinary terminal run or deletable history', async () => {
    const { run, dataDir, scratch } = await completed();
    manager.dispose(); store.close();
    const rows = readPersistedRuns(dataDir);
    delete rows.find((row: { id: string }) => row.id === run.id)!.delegation;
    seedRuns(dataDir, rows); reopenRuntime();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await manager.recover(); setRunStatus(store, run.id, RUN_STATUS.cancelled);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(store.deleteRun(run.id)).toBe(false);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      // Restoration of valid ownership permits the existing recovery path to retry it.
      store.updateRun(run.id, { delegation: run.delegation }); manager.recoverWorkerCleanup();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.runIf(process.platform === 'linux')('a process outside the worker\'s scope never refuses admission, even inside its retained scratch (ADR 0032)', async () => {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    setRunStatus(store, parent.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const run = await worker(parent.id);
    if (run.delegation?.role !== 'worker') throw Error('missing worker');
    const scratch = agentTmpDir(join(root, '.ai/cezar'), run.id);
    const generation = store.commitWorkerExecutionStart(run.id);
    setRunStatus(store, run.id, RUN_STATUS.cancelled); store.commitWorkerExecutionComplete(run.id, generation);
    manager.pauseWorkerCleanup();
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'retained'), 'task files');
    const outsider = await readableHolder(scratch);
    try {
      expect(store.commitWorkerExecutionStart(run.id)).not.toBe(generation);
      expect(readFileSync(join(scratch, 'retained'), 'utf8')).toBe('task files');
      await outsider.write();
    } finally { await outsider.close(); }
  });

  it.runIf(process.platform !== 'win32')('reclaim needs an empty scope; admission does not (ADR 0032)', async () => {
    const { run, generation, scratch } = await completed();
    if (run.delegation?.role !== 'worker') throw Error('missing worker');
    const service = await groupHolder(scratch);
    own(run.id, service.pid);
    try {
      expect(store.workerResourcesSafe(run.id, generation, run.delegation.workspace.resourceId)).toBe(false);
      expect(store.workerResourceHolders(run.id, generation, run.delegation.workspace.resourceId)).toBe('safe');
    } finally { await service.close(); }
    expect(store.workerResourcesSafe(run.id, generation, run.delegation.workspace.resourceId)).toBe(true);
  });

  it.each(['execution', 'processes'])('reconstructs and keeps retrying while the private %s evidence is unreadable', async sidecar => {
    const { run, dataDir, scratch } = await completed();
    const path = join(dataDir, 'runs', `${run.id}.${sidecar}.json`), evidence = readFileSync(path);
    writeFileSync(path, '{unreadable');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    try {
      cleanup.recover(); await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(join(scratch, 'keep'))).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('{unreadable');
      writeFileSync(path, evidence);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { writeFileSync(path, evidence); cleanup.pause(); vi.useRealTimers(); }
  });

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('permission denial retains a scratch cleanup intent until its path becomes readable', async () => {
    const { run, dataDir, scratch } = await completed();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    try {
      chmodSync(dirname(scratch), 0);
      expect(existsSync(scratch)).toBe(false); // the ambiguous check the old retry path used
      expect(agentTmpDirMayExist(dataDir, run.id)).toBe(true);
      cleanup.recover(); await vi.advanceTimersByTimeAsync(120_000);
      chmodSync(dirname(scratch), 0o700);
      expect(readFileSync(join(scratch, 'keep'), 'utf8')).toBe('durable');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(existsSync(scratch)).toBe(false);
    } finally { chmodSync(dirname(scratch), 0o700); cleanup.pause(); vi.useRealTimers(); }
  });
});

describe('scratch reprobe cadence (hearsay-tools/cezarion#879)', () => {
  useWorkerWaitFixture();
  beforeEach(() => { setHostScope({ backend: 'groups', reason: 'test' }); });
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.useRealTimers(); setHostScope(undefined); });

  async function completed() {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    setRunStatus(store, parent.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const run = await worker(parent.id);
    const generation = store.commitWorkerExecutionStart(run.id);
    setRunStatus(store, run.id, RUN_STATUS.cancelled); store.commitWorkerExecutionComplete(run.id, generation);
    manager.pauseWorkerCleanup();
    const dataDir = join(root, '.ai/cezar'), scratch = agentTmpDir(dataDir, run.id);
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'keep'), 'durable');
    return { run, dataDir, scratch };
  }
  /** One probe is one ownership check of one id. */
  const probes = () => vi.mocked(store.workerScratchResourcesSafe).mock.calls.length;
  type Due = Map<string, { at: number; attempts: number; generation?: string }>;
  const dueOf = (cleanup: WorkerScratchCleanup) => (cleanup as unknown as { due: Due }).due;

  it.runIf(process.platform === 'linux')('a held dir backs off to hourly and is still removed once its holder exits', async () => {
    const { run, dataDir, scratch } = await completed();
    const holder = await groupHolder(scratch);
    own(run.id, holder.pid);
    vi.spyOn(store, 'workerScratchResourcesSafe');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    try {
      const before = probes();
      cleanup.schedule(run.id);
      // The fast window: a probe at once, then five a minute apart.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(probes() - before).toBe(6);
      // Then two minutes: nothing at 6 or 6:59, a probe by 7:00.
      await vi.advanceTimersByTimeAsync(119_000);
      expect(probes() - before).toBe(6);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probes() - before).toBe(7);
      await vi.advanceTimersByTimeAsync(4 * 3_600_000);
      expect(dueOf(cleanup).get(run.id)!.at - Date.now()).toBeGreaterThan(3_000_000);
      expect(readFileSync(join(scratch, 'keep'), 'utf8')).toBe('durable');
      await holder.close();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(existsSync(scratch)).toBe(false);
      expect(dueOf(cleanup).has(run.id)).toBe(false);
    } finally { cleanup.pause(); vi.useRealTimers(); await holder.close(); }
  });

  it.runIf(process.platform === 'linux')('keeps a pending id in its backoff, and probes a new generation at once', async () => {
    const { run, dataDir, scratch } = await completed();
    const holder = await groupHolder(scratch);
    own(run.id, holder.pid);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cleanup = new WorkerScratchCleanup(store, dataDir, () => false);
    try {
      cleanup.schedule(run.id);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      const backedOff = dueOf(cleanup).get(run.id)!;
      expect(backedOff.attempts).toBeGreaterThan(5);
      // The same generation asking again (any terminal `run` event) keeps its place.
      cleanup.schedule(run.id);
      expect(dueOf(cleanup).get(run.id)).toEqual(backedOff);
      await holder.close();
      const next = store.commitWorkerExecutionStart(run.id);
      expect(store.commitWorkerExecutionComplete(run.id, next)).toBe(true);
      cleanup.schedule(run.id);
      expect(dueOf(cleanup).get(run.id)).toMatchObject({ attempts: 0, generation: next });
      await vi.advanceTimersByTimeAsync(0);
      expect(existsSync(scratch)).toBe(false);
    } finally { cleanup.pause(); vi.useRealTimers(); await holder.close(); }
  });
});
