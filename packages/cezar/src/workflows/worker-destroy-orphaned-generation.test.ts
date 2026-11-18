import { productName } from '../home/display.ts'
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA, WORKER_OUTCOME_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { WorkerOrphans } from './run/worker-orphans.ts';
import { fixtureWork } from './fixture-cleanup.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { nonDumpableHolder } from '../delegation/non-dumpable.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { resolveAgentTmpDir } from '../runs/agent-tmpdir.ts';
import { ensureOwnedWorkspace } from '../delegation/workspace.ts';
import * as runners from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunManager } from './run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import { DelegationService } from '../delegation/service.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { until, root, store, manager, parent, releases, worker, workspace, useWorkerDestroyFixture } from './worker-destroy.testkit.ts';
import { createRunner } from '../core/runner-factory.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';
import { workerCleanups } from '../delegation/worker-cleanup.ts';
import { setHostScope } from '../worker-scope/worker-scopes.ts';

describe('worker termination barrier', { timeout: 30_000 }, () => {
  useWorkerDestroyFixture();
  // Ownership is the worker's recorded process groups on every host (ADR 0032).
  beforeEach(() => { setHostScope({ backend: 'groups', reason: 'test' }); });
  afterEach(() => { setHostScope(undefined); });
  describe('orphaned generation after a controller crash (#469)', () => {
    const TERM_IGNORING = "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)";
    const spawnReady = async (cwd: string, script = TERM_IGNORING) => {
      const proc = spawn(process.execPath, ['-e', script], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
      releases.push(() => proc.kill('SIGKILL'));
      const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
      await new Promise<void>(resolve => proc.stdout!.once('data', () => resolve()));
      return { proc, exited };
    };
    const deadPid = async () => { const proc = spawn(process.execPath, ['-e', '']); await new Promise(resolve => proc.once('exit', resolve)); return proc.pid!; };
    const recordPath = (id: string) => join(root, '.ai/cezar/runs', `${id}.processes.json`);
    const readRecord = (id: string) => JSON.parse(readFileSync(recordPath(id), 'utf8')) as { generation: string; controller: { pid: number; startToken?: string }; processes: { pid: number; startToken?: string }[] };
    const setController = (id: string, controller: { pid: number; startToken?: string }) => writeFileSync(recordPath(id), JSON.stringify({ ...readRecord(id), controller }));
    const branchExists = (branch: string) => execFileSync('git', ['branch', '--list', branch], { cwd: root, encoding: 'utf8' }).includes(branch);

    /** Launch 1 is a real child in the worktree; later launches (recovery's Continue) close at once. */
    async function crashed(status: RunRecord['status'] = 'running') {
      const w = await worker(); let first: Awaited<ReturnType<typeof spawnReady>> | undefined; let launches = 0; let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      vi.spyOn(runners, 'createRunner').mockReturnValue({ backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', interrupt: async () => undefined,
        run: async () => { throw Error('unused'); }, startSession: () => {
          if (++launches > 1) return { result: Promise.resolve({ text: 'resumed', toolCalls: [], tokensUsed: 0 }), open: false,
            sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt() {}, end() {} };
          // Its own group leader, as a runner's session is, so a test can put it in the worker's scope.
          const proc = spawn(process.execPath, ['-e', TERM_IGNORING], { cwd: workspace(w).path, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
          releases.push(() => proc.kill('SIGKILL'));
          const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
          first = { proc, exited }; proc.stdout!.once('data', () => ready());
          const result = exited.then(() => ({ text: '', toolCalls: [] as [], tokensUsed: 0 }));
          return { pid: proc.pid, result, open: true, sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages: () => {}, holdsHumanInput: () => false,
            interrupt: () => { proc.kill('SIGTERM'); }, end: () => { proc.kill('SIGTERM'); } };
        } });
      manager.enqueueOwnedRun(w.id); await started;
      const prior = store.readWorkerExecution(w.id)!;
      expect(prior.phase).toBe('starting');
      expect(readRecord(w.id)).toMatchObject({ generation: prior.generation, controller: { pid: process.pid }, processes: [{ pid: first!.proc.pid }] });
      manager.dispose(); setRunStatus(store, w.id, status); store.flush();
      setController(w.id, { pid: await deadPid(), startToken: '1' });
      store.close(); const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() });
      const service = new DelegationService(workerCleanups()); service.registerProject({ home: testHome(), id: 'reopened', root, store: reopened, manager: other });
      return { w, child: first!, prior, reopened, other, service, launches: () => launches };
    }

    it('the process record is generation-bound and never drops an entry past its cap', async () => {
      const w = await worker(); const generation = store.commitWorkerExecutionStart(w.id);
      expect(store.appendWorkerProcess(w.id, randomUUID(), 100)).toBe(false);
      for (let pid = 100; pid < 132; pid++) expect(store.appendWorkerProcess(w.id, generation, pid)).toBe(true);
      expect(store.appendWorkerProcess(w.id, generation, 132)).toBe(false);
      const record = store.readWorkerProcesses(w.id, generation);
      expect(typeof record === 'string' ? record : record.processes.map(entry => entry.pid)).toEqual(Array.from({ length: 32 }, (_, index) => 100 + index));
      expect(store.readWorkerProcesses(w.id, randomUUID())).toBe('unknown');
      rmSync(recordPath(w.id)); expect(store.readWorkerProcesses(w.id, generation)).toBe('absent');
    });

    it('a dead child is finalized by recovery, re-launches, and destroy completes', async () => {
      const { w, child, prior, reopened, other, service, launches } = await crashed();
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        await other.recover();
        await until(() => !other.isActive(w.id) && reopened.getRun(w.id)?.status !== 'queued');
        expect(launches()).toBe(2);
        expect(reopened.readEvents(w.id).some(event => event.type === 'lifecycle' && String(event.message).includes('processes are gone'))).toBe(true);
        expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete' });
        expect(reopened.readWorkerExecution(w.id)?.generation).not.toBe(prior.generation);
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
      } finally { other.dispose(); reopened.flush(); }
    });

    it("destroy ends a crashed generation's owned child that ignores SIGTERM, then completes", async () => {
      const { w, child, prior, reopened, other, service } = await crashed('failed');
      // The mock spawns outside spawnSessionLeader, so the record has no group; the worker's scope owns it.
      expect(readRecord(w.id).processes.map(entry => 'pgid' in entry)).toEqual([false]);
      reopened.scopes.spawnScope(w.id).started(child.proc.pid!);
      try {
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        await child.exited;
        expect(child.proc.signalCode).toBe('SIGKILL');
        expect(reopened.readWorkerExecution(w.id)).toMatchObject({ ...prior, phase: 'complete' });
        expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
      } finally { other.dispose(); reopened.flush(); }
    });

    it('a live foreign controller keeps the generation: nothing is finalized or signalled', async () => {
      const { w, child, prior, reopened, other, service } = await crashed('failed');
      const foreign = await spawnReady(tmpdir());
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        const token = processStartToken(foreign.proc.pid!);
        setController(w.id, { pid: foreign.proc.pid!, ...(token ? { startToken: token } : {}) });
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
        expect(other.continueRun(w.id, { text: 'try again' })).toEqual({ ok: false,
          error: expect.stringContaining(`another live controller ${foreign.proc.pid}`),
          next: 'wait for that controller to end the worker execution, then retry the same command' });
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'incomplete', remaining: expect.arrayContaining(['process']),
          error: `Worker termination is not proven: the worker is still controlled by a live ${productName("cezar")} (pid ${foreign.proc.pid}); retry cleanup later` });
        expect(existsSync(workspace(w).path)).toBe(true);
        expect(foreign.proc.exitCode).toBeNull(); expect(foreign.proc.signalCode).toBeNull();
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
      } finally { other.dispose(); reopened.flush(); }
    });

    it.each(['malformed', 'another generation'] as const)('a present but %s record proves nothing: no finalization, no reap', async shape => {
      const { w, child, prior, reopened, other, service } = await crashed('failed');
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        writeFileSync(recordPath(w.id), shape === 'malformed' ? '{broken' : JSON.stringify({ ...readRecord(w.id), generation: randomUUID() }));
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'incomplete', remaining: expect.arrayContaining(['process']),
          error: 'worker process record is unreadable; termination cannot be proven' });
        expect(existsSync(workspace(w).path)).toBe(true);
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior);
      } finally { other.dispose(); reopened.flush(); }
    });

    it('resume right after a cached alive probe re-probes, so a survivor that just died does not refuse it', async () => {
      const { w, child, prior, reopened, other, launches } = await crashed('failed');
      try {
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toEqual(prior); // cached "alive" for 2 s
        child.proc.kill('SIGKILL'); await child.exited;
        expect(other.continueRun(w.id, { text: 'resume' })).toEqual({ ok: true });
        await until(() => launches() === 2);
        expect(reopened.readWorkerExecution(w.id)?.generation).not.toBe(prior.generation);
      } finally { other.dispose(); reopened.flush(); }
    });

    it('recovery preserves a live worker scratchpad after finalizing its dead generation (#515)', async () => {
      const { w, child, reopened, other } = await crashed('waiting');
      const scratch = resolveAgentTmpDir(join(root, '.ai/cezar'), w.id);
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, 'notes'), 'answer still needed');
      // The question waits for the parent's answer (hearsay-tools/cezarion#2410): a parent that may
      // not message its workers would have Squawk answer it, and resume the worker, instead.
      reopened.commitDelegation([{ id: parent.id, delegation: { role: 'root', permissions: ['spawn', 'steer'], receipts: [] } }]);
      reopened.appendEvent(w.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
        header: 'Choice', question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }],
      }] });
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)?.phase).toBe('complete');
        expect(reopened.getRun(w.id)?.status).toBe('waiting');
        expect(readFileSync(join(scratch, 'notes'), 'utf8')).toBe('answer still needed');
      } finally { other.dispose(); reopened.flush(); }
    });

    it("a process outside the worker's scope working in its scratch neither keeps a dead generation alive nor is signalled", async () => {
      const { w, child, reopened, other } = await crashed('failed');
      const scratch = resolveAgentTmpDir(join(root, '.ai/cezar'), w.id); mkdirSync(scratch, { recursive: true });
      const holder = await spawnReady(scratch);
      const kills = vi.spyOn(process, 'kill'); const own = vi.spyOn(holder.proc, 'kill');
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete' });
        expect(holder.proc.exitCode).toBeNull(); expect(holder.proc.signalCode).toBeNull();
        expect(kills.mock.calls.filter(([pid, signal]) => Math.abs(pid) === holder.proc.pid && signal !== 0)).toEqual([]);
        expect(own.mock.calls).toEqual([]);
      } finally { other.dispose(); reopened.flush(); }
    });

    it.each(['inside', 'after'] as const)('a parked parent wait resolves once a survivor dies %s the fast re-probe window', async window => {
      const { w, child, reopened, other } = await crashed('failed');
      // Drive the shipped 15-second cadence and its 15-minute fast window.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      // The parent's worker wait is a wait-list entry (hearsay-tools/cezarion#1301).
      // Keep the parent wait open beyond the shipped 15-minute fast window.
      const waitId = randomUUID(); const now = Date.now();
      reopened.commitWait(parent.id, { kind: WAIT_KIND.worker, id: waitId, source: WAIT_SOURCE.agent, via: WAIT_VIA['cez-worker-wait'], registeredAt: new Date(now).toISOString(),
        deadline: new Date(now + 1_800_000).toISOString(), timeoutSeconds: 1_800, phase: WAIT_PHASE.open, turnId: 'turn-1', mode: 'all',
        workerIds: [w.id], revisions: [{ workerId: w.id, revision: 0 }], outcomes: [] });
      const wait = () => { const run = reopened.getRun(parent.id); return [...(run?.waits ?? []), ...(run?.lastWaits ?? [])].find((entry): entry is Extract<typeof entry, { kind: 'worker' }> => entry.id === waitId && entry.kind === 'worker'); };
      try {
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)?.phase).toBe('starting');
        expect(wait()?.outcomes).toEqual([]);
        if (window === 'after') await vi.advanceTimersByTimeAsync(15_000 * 60);
        child.proc.kill('SIGKILL'); await child.exited;
        await vi.advanceTimersByTimeAsync(window === 'inside' ? 15_000 : 30_000);
        expect(reopened.readWorkerExecution(w.id)?.phase).toBe('complete');
        expect(wait()?.outcomes?.some(outcome => outcome.workerId === w.id)).toBe(true);
        expect(wait()!.outcomes).toEqual([expect.objectContaining({ workerId: w.id, revision: 0, status: WORKER_OUTCOME_STATUS.failed })]);
      } finally { vi.useRealTimers(); other.dispose(); reopened.flush(); }
    });

    it('a recorded survivor is re-probed on the backoff cadence until it dies (hearsay-tools/cezarion#879)', async () => {
      const ids: string[] = []; const holders: Awaited<ReturnType<typeof spawnReady>>[] = [];
      for (let i = 0; i < 2; i++) {
        const w = await worker(); const generation = store.commitWorkerExecutionStart(w.id);
        setRunStatus(store, w.id, RUN_STATUS.failed);
        const holder = await spawnReady(tmpdir());
        expect(store.appendWorkerProcess(w.id, generation, holder.proc.pid!)).toBe(true);
        setController(w.id, { pid: await deadPid(), startToken: '1' });
        holders.push(holder); ids.push(w.id);
      }
      // This case owns one small module: only its retry cadence matters.
      const cadence = new WorkerOrphans({ createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'),
        semaphore: new WorkspaceSemaphore({ home: testHome() }), work: fixtureWork(root), disposed: () => false }, {
        holds: () => false, reapTerminalScratch: () => {},
        settleOrphanedWorkerExecution: (id, options) => cadence.settleOrphanedWorkerExecution(id, options),
      });
      cadence.orphanBackoff = { fastMs: 400, fastCount: 2, capMs: 1_600 };
      // The clock is fake too, so arming the two orphans one after the other cannot drift them apart
      // under load: recovery arms its orphans in one synchronous pass.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        for (const id of ids) cadence.armOrphanReprobe(id);
        await vi.advanceTimersByTimeAsync(400);
        expect(ids.map(id => store.readWorkerExecution(id)?.phase)).toEqual(['starting', 'starting']);
        expect(ids.map(id => cadence.orphanDue.get(id)?.attempts)).toEqual([1, 1]);
        // Then 400, 800 and 1,600 ms: past the fast window it doubles to the cap.
        await vi.advanceTimersByTimeAsync(400 + 800 + 1_600);
        expect(ids.map(id => cadence.orphanDue.get(id)?.attempts)).toEqual([4, 4]);
        expect(cadence.orphanDue.get(ids[0]!)!.at - Date.now()).toBeGreaterThan(1_500);
        for (const holder of holders) { holder.proc.kill('SIGKILL'); await holder.exited; }
        await vi.advanceTimersByTimeAsync(1_700);
        expect(ids.map(id => store.readWorkerExecution(id)?.phase)).toEqual(['complete', 'complete']);
        expect(cadence.orphanDue.size).toBe(0);
      } finally { cadence.dispose(); vi.useRealTimers(); }
    });

    it.runIf(process.platform === 'linux')('an unreadable process in the worktree is no evidence: destroy finalizes a legacy generation without signalling it (hearsay-tools/cezarion#889)', async () => {
      const w = await worker(); await ensureOwnedWorkspace(root, w);
      store.commitWorkerExecutionStart(w.id); setRunStatus(store, w.id, RUN_STATUS.failed); store.flush();
      manager.dispose(); store.close(); rmSync(recordPath(w.id)); // an absent legacy ledger leaves the scan as the only evidence
      const holder = await nonDumpableHolder(workspace(w).path);
      const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }); const other = new RunManager(reopened, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() });
      const service = new DelegationService(workerCleanups({ terminationTimeoutMs: 1_500 })); const detach = service.registerProject({ home: testHome(), id: 'reopened', root, store: reopened, manager: other });
      try {
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete' });
        expect(reopened.readWorkerExecution(w.id)?.abandoned).toBeUndefined();
        expect(existsSync(workspace(w).path)).toBe(false);
        expect(holder.running).toBe(true); // its cwd is gone, but nothing signalled it
      } finally { detach(); other.dispose(); reopened.flush(); await holder.close(); }
    });

    it('a legacy generation (no record) with no process in the worktree is finalized', async () => {
      const { w, child, reopened, other, service } = await crashed('failed');
      try {
        child.proc.kill('SIGKILL'); await child.exited;
        rmSync(recordPath(w.id));
        await other.recover();
        expect(reopened.readWorkerExecution(w.id)).toMatchObject({ phase: 'complete' });
        expect(await service.destroyForHuman('reopened', w.id)).toMatchObject({ state: 'complete', remaining: [] });
        expect(existsSync(workspace(w).path)).toBe(false); expect(branchExists(workspace(w).branch)).toBe(false);
      } finally { other.dispose(); reopened.flush(); }
    });
  });

});
