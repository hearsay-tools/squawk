import { testHome } from '../home/test-home.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { ownedWorkspace, workerCollectedResultSchema, workerInspectionSchema } from '@open-mercato/cezar-contract/delegation';
import { createFixtureManager, fixtureWorkSettled, drainFixtureManagers } from './fixture-manager.testkit.ts';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDelegationCli } from './delegation-cli-build.testkit.ts';
import { promisify } from 'node:util';
import { onTestFinished, afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerCollectedResult, WorkerDestroyResult, WorkerInspection, WorkerSpawnResult, WorkerWaitResult } from '@open-mercato/cezar-contract';
import { DelegationController } from '../delegation/provision.ts';
import { RunStore } from '../runs/store.ts';
import { createApp } from '../server/server.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager, WORKER_FALLBACK_QUESTION } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { monitoringWakeOf } from './waits.testkit.ts';
import type { WorkerCleanupFactory } from '../delegation/service.ts';

const execFile = promisify(execFileCallback);

/** `cleanup` is the worker cleanup for groups that destroy workers; the reviewed-integration group passes `workerCleanups()`. */
export function registerDelegationIntegrationGroup(group: 'reviewed-integration' | 'failure-authority' | 'parent-cancellation', cleanup?: WorkerCleanupFactory): void {
  describe('public delegation completion integration', () => {
  let cli: Awaited<ReturnType<typeof buildDelegationCli>>;
  beforeAll(async () => { cli = await buildDelegationCli(); });
  afterAll(() => cli?.close());

  let root: string, repo: string, control: string, store: RunStore, manager: RunManager, controller: DelegationController;

  const environments = new Map<string, Record<string, string>>();

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

  // hearsay-tools/cezarion#1233: a monitoring park is a waiting run with an open monitoring timer.
  const monitoringPark = (id: string) => store.getRun(id)?.status === RUN_STATUS.waiting && !!monitoringWakeOf(store.getRun(id));

  async function until(predicate: () => boolean, label: string) {
    await vi.waitFor(() => expect(predicate(), `${label}: ${JSON.stringify(store.listRuns().map(r => ({ id: r.id, status: r.status, error: r.error })))}`).toBe(true), { timeout: 15_000, interval: 20 });
  }

  function track() {
    // Observe actual session provisioning and await existing asynchronous lifecycle
    // tasks at teardown; no scheduling, result, or runner method is replaced.
    const provision = manager.setDelegationProvisioner.bind(manager);
    manager.setDelegationProvisioner = factory => provision(id => {
      const session = factory(id);
      if (session) environments.set(id, session.env);
      return session;
    });

  }

  beforeEach(async () => {
    onTestFinished(scopeFixtureProcesses());
    root = mkdtempSync(join(tmpdir(), 'cez-delegation-integration-'));
    repo = join(root, 'repo'); control = join(root, 'wire'); mkdirSync(repo); mkdirSync(control);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'gc.auto', '0'); git(repo, 'config', 'maintenance.auto', 'false');
    git(repo, 'config', 'user.name', 'test'); git(repo, 'config', 'user.email', 'test@local');
    writeFileSync(join(repo, 'shared.txt'), 'baseline\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    const wire = join(root, 'agent.mjs');
    writeFileSync(wire, `#!${process.execPath}\nimport { runWire } from ${JSON.stringify(new URL('./__fixtures__/delegation-wire.mjs', import.meta.url).href)};\nrunWire(${JSON.stringify(control)});\n`, { mode: 0o755 });
    const claudeHome = join(root, 'claude'); const codexHome = join(root, 'codex'); mkdirSync(claudeHome); mkdirSync(codexHome);
    for (const [name, value] of Object.entries({ CEZ_HOME: join(root, 'home'), CEZ_DRY_RUN: '0', CEZ_AUTONAME: '0', CEZ_REVIEW_GATE: '1',
      CEZ_CLAUDE_BIN: wire, CEZ_CODEX_BIN: wire, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })) vi.stubEnv(name, value);
    store = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true });
    manager = createFixtureManager(store, repo, { home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 3 } }) }); track();
    controller = await DelegationController.start(cleanup); controller.attachProject({ home: testHome(), id: 'integration', root: repo, store, manager });
  });

  afterEach(async () => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    await until(() => store.listRuns().every(run => !manager.isActive(run.id)), 'all sessions stopped');
    await fixtureWorkSettled(repo);
    await drainFixtureManagers(repo);
    manager.dispose(); store.flush(); await controller.close();
    environments.clear(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }, 30_000);

  async function input(id: string, turn = 1) {
    const path = join(control, `${id}.${turn}.input.json`);
    await until(() => existsSync(path), `wire receives ${id} turn ${turn}`);
    return JSON.parse(readFileSync(path, 'utf8')) as { text: string; cwd: string; backend: string };
  }

  /** The answer the wire's cezar_done got in that turn. */
  async function done(id: string, turn: number) {
    const path = join(control, `${id}.${turn}.done.json`);
    await until(() => existsSync(path), `wire calls cezar_done in ${id} turn ${turn}`);
    return JSON.parse(readFileSync(path, 'utf8')) as { ok: boolean; code?: string; message: string };
  }

  function reply(id: string, turn: number, value: { text?: string; commit?: string; error?: string; done?: true } = {}) {
    const path = join(control, `${id}.${turn}.reply.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  }

  async function command<T = Record<string, unknown>>(id: string, args: string[], code = 0): Promise<T> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...environments.get(id), PATH: '' };
    for (const name of Object.keys(env)) {
      if (!name.startsWith('CEZ_')) continue;
      const preferred = 'HSQ_' + name.slice(4);
      env[preferred] = env[name];
      delete env[name];
    }
    const result = await execFile(process.execPath, [cli.entry, 'worker', ...args], {
      cwd: root, env, timeout: 45_000,
    }).then(value => ({ ...value, code: 0 }), (error: { stdout: string; stderr: string; code: number }) => error);
    expect(result.stderr).toBe(''); expect(result.code, result.stdout).toBe(code);
    return JSON.parse(result.stdout) as T;
  }

  async function parent() {
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'Coordinate independent implementations', runner: 'claude' });
    await input(run.id); return run;
  }

  async function spawn(parentId: string, backend: 'claude' | 'codex', task: string, context = 'Only selected context') {
    const result = await command<WorkerSpawnResult>(parentId, ['spawn', '--baseline', 'parent-head', '--request-id', randomUUID(), '--backend', backend, '--context', context, task]);
    await input(result.workerId); return result.workerId;
  }

  async function settled(id: string, status: string = RUN_STATUS.review) {
    await until(() => store.getRun(id)?.status === status, `${id} reaches ${status}`);
    expect(await manager.awaitRunTermination(id, 15_000)).toBe(true);
  }

  async function finishWorker(parentId: string, id: string, change: string) {
    reply(id, 1); await until(() => store.getRun(id)?.status === RUN_STATUS.waiting, 'worker ready for steering');
    expect(['queued', 'delivered']).toContain((await command(parentId, ['steer', id, `Commit ${change} and report the result`])).state);
    expect((await input(id, 2)).text).toContain(`Commit ${change}`);
    await until(() => store.getRun(id)?.agentInputs?.some(item => item.source === 'agent' && !!item.deliveredAt) === true, 'steering delivery persisted');
    expect(store.readEvents(id).filter(event => event.type === 'user-message')).toEqual([]);
    reply(id, 2, { commit: change, text: `Implemented ${change}; Git commit ready for inspection.`, done: true });
    await settled(id);
  }

  const collect = (parentId: string, id: string) => command<WorkerCollectedResult>(parentId, ['collect', id]);

  const destroy = (parentId: string, id: string, code = 0, ...flags: string[]) => command<WorkerDestroyResult>(parentId, ['destroy', id, ...flags], code);

if (group === 'reviewed-integration') {

  // Catches lost gate/wake wiring, backend/context mixing, mistaken auto-integration,
  // and removal of the only retained evidence during real branch cleanup failure.
  it('coordinates two isolated backends, explicitly integrates a reviewed commit, and retries cleanup after restart', async () => {
    const p = await parent(); const parentPath = (await input(p.id)).cwd;
    const baseline = git(parentPath, 'rev-parse', 'HEAD');
    writeFileSync(join(parentPath, 'untracked-parent.txt'), 'private parent scratch');
    const a = await spawn(p.id, 'claude', 'Implement alpha', 'Alpha selected context');
    const b = await spawn(p.id, 'codex', 'Implement beta', 'Beta selected context');
    const firstA = await input(a); const firstB = await input(b);
    expect(firstA).toMatchObject({ backend: 'claude', text: expect.stringContaining('Alpha selected context') });
    expect(firstB).toMatchObject({ backend: 'codex', text: expect.stringContaining('Beta selected context') });
    expect(firstB.text).not.toContain('Alpha selected context');
    expect(new Set([parentPath, firstA.cwd, firstB.cwd]).size).toBe(3);
    for (const path of [firstA.cwd, firstB.cwd]) {
      expect(git(path, 'rev-parse', 'HEAD')).toBe(baseline);
      expect(existsSync(join(path, 'untracked-parent.txt'))).toBe(false);
    }
    rmSync(join(parentPath, 'untracked-parent.txt'));
    expect(environments.get(a)?.CEZ_DELEGATION_TOKEN).not.toBe(environments.get(p.id)?.CEZ_DELEGATION_TOKEN);
    expect(environments.get(b)?.CEZ_DELEGATION_TOKEN).not.toBe(environments.get(a)?.CEZ_DELEGATION_TOKEN);

    reply(p.id, 1, { text: 'Attempted completion before observing workers', done: true });
    // hearsay-tools/cezarion#1301, hearsay-tools/cezarion#2397: cezar_done answers the blocked done
    // with the refusal itself, and Squawk opens no wait for it.
    const refusal = await done(p.id, 1);
    expect(refusal).toMatchObject({ ok: false, code: 'workers_outstanding' });
    expect(refusal.message).toContain('Workers are still live:');
    for (const id of [a, b]) expect(refusal.message).toContain(`worker stop ${id}`);
    await until(() => monitoringPark(p.id), 'parent ends its refused turn');
    const gate = store.getRun(p.id)!.delegation;
    expect(gate).not.toHaveProperty('wait');
    expect(gate).not.toHaveProperty('completion');
    expect(manager.finish(p.id)).toBe(false);
    const wait = await command<WorkerWaitResult>(p.id, ['wait', a, b, '--mode', 'any']);
    expect(wait.wait.mode).toBe('any');
    await finishWorker(p.id, a, 'alpha');
    // hearsay-tools/cezarion#1301: worker a ended its first turn idle, so after its no-wait nudge its
    // fallback question woke the parent before the steer superseded it; the wait-any wake follows.
    const question = await input(p.id, 2); reply(p.id, 2);
    expect(question.text).toContain(WORKER_FALLBACK_QUESTION(a));
    if (!question.text.includes(`Worker wait ${wait.wait.id}`)) { await input(p.id, 3); reply(p.id, 3); }
    await until(() => monitoringPark(p.id), 'parent observes wait-any wake');
    expect(store.getRun(p.id)?.agentInputs?.filter(item => item.id === wait.wait.id && item.deliveredAt)).toHaveLength(1);
    expect(store.getRun(b)?.status).toBe(RUN_STATUS.running);
    expect(await collect(p.id, b)).toMatchObject({ backend: 'codex', settled: false, partial: true });
    const resultA = await collect(p.id, a);
    expect(resultA).toMatchObject({ status: workerCollectedResultSchema.shape.status.enum.review, outcome: workerCollectedResultSchema.shape.outcome.enum['review-ready'], settled: true, partial: false, summary: { text: expect.stringContaining('Implemented alpha') }, head: { state: 'available' }, diff: { state: 'available' } });
    expect(await command<WorkerInspection>(p.id, ['inspect', a])).toMatchObject({ status: workerInspectionSchema.shape.status.enum.review, backend: 'claude', parentRunId: p.id });
    expect(manager.finish(p.id)).toBe(false);
    await finishWorker(p.id, b, 'beta');
    const resultB = await collect(p.id, b);
    expect(resultB).toMatchObject({ backend: 'codex', settled: true, partial: false, summary: { text: expect.stringContaining('Implemented beta') } });
    if (resultA.head.state !== 'available' || resultB.head.state !== 'available' || resultA.diff.state !== 'available') throw Error('review evidence absent');
    const betaHead = resultB.head.sha;
    expect(JSON.parse(readFileSync(resultA.diff.path, 'utf8')).diffSnapshot).toContain('+alpha');
    expect(git(parentPath, 'rev-parse', 'HEAD')).toBe(baseline);
    expect(readFileSync(join(parentPath, 'shared.txt'), 'utf8')).toBe('baseline\n');
    git(parentPath, 'cherry-pick', resultA.head.sha);
    const integratedHead = git(parentPath, 'rev-parse', 'HEAD');
    expect(readFileSync(join(parentPath, 'shared.txt'), 'utf8')).toBe('alpha\n');
    expect(() => git(parentPath, 'cherry-pick', betaHead)).toThrow();
    expect(git(parentPath, 'diff', '--name-only', '--diff-filter=U')).toBe('shared.txt');
    git(parentPath, 'cherry-pick', '--abort');
    expect(git(parentPath, 'rev-parse', 'HEAD')).toBe(integratedHead);
    expect(git(parentPath, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    expect(readFileSync(join(parentPath, 'shared.txt'), 'utf8')).toBe('alpha\n');

    // Actual Git CAS failure after worktree removal, not a stubbed cleanup result.
    const branchLock = git(repo, 'rev-parse', '--git-path', `refs/heads/${ownedWorkspace(resultA.workspace).branch}.lock`);
    const lockPath = join(repo, branchLock); writeFileSync(lockPath, 'held by integration test');
    // No ref reaches the commit the parent did not integrate: a plain destroy names it, and the
    // parent discards it (hearsay-tools/squawk#3553). A's cherry-pick may reproduce its SHA.
    expect(await destroy(p.id, b, 1)).toMatchObject({ state: 'incomplete', remaining: ['process', 'worktree', 'branch'], work: { uncommittedFiles: 0, commits: 1 } });
    expect(await destroy(p.id, a, 1, '--discard-work')).toMatchObject({ state: 'incomplete', remaining: ['branch'], deleted: [{ kind: 'worktree', path: firstA.cwd }] });
    expect(existsSync(firstA.cwd)).toBe(false);
    expect(git(repo, 'rev-parse', `refs/heads/${ownedWorkspace(resultA.workspace).branch}`)).toBe(resultA.head.sha);
    expect(store.canDeleteRun(a)).toBe(false);
    expect(store.readWorkerResultDiff(p.id, a)).toContain('+alpha');
    expect(await destroy(p.id, b, 0, '--discard-work')).toMatchObject({ state: 'complete', remaining: [] });
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id), 'parent session closes at review');
    expect(store.getRun(p.id)?.status).toBe(RUN_STATUS.review);
    await fixtureWorkSettled(repo);
    manager.dispose(); store.close(); await controller.close();
    store = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true });
    manager = createFixtureManager(store, repo); track();
    controller = await DelegationController.start(cleanup); controller.attachProject({ home: testHome(), id: 'integration', root: repo, store, manager });
    await manager.recover();
    expect(store.getRun(p.id)?.status).toBe(RUN_STATUS.review);
    expect(store.readWorkerResultDiff(p.id, a)).toContain('+alpha');
    expect(store.getRun(a)?.delegation).toMatchObject({ destroy: { phase: 'incomplete', remaining: ['branch'] } });
    for (const path of readdirSync(control).filter(path => path.startsWith(p.id))) rmSync(join(control, path));
    expect(manager.continueRun(p.id, { text: 'Retry owned cleanup and inspect retained evidence' }).ok).toBe(true);
    await input(p.id); rmSync(lockPath);
    expect(await destroy(p.id, a)).toMatchObject({ state: 'complete', remaining: [] });
    expect(await destroy(p.id, a)).toMatchObject({ state: 'complete', remaining: [] });
    const app = createApp({ home: testHome(), repoRoot: repo, store, manager, version: 'test', bootProjectId: 'integration' });
    for (const id of [a, b]) {
      const response = await app.request(`http://127.0.0.1/api/v1/runs/${id}`, { method: 'DELETE', headers: { host: '127.0.0.1' } });
      expect(response.status, await response.text()).toBe(200);
      expect(store.getRun(id)).toBeUndefined();
      expect(existsSync(join(repo, '.ai/cezar/runs', `${id}.ndjson`))).toBe(false);
      expect(await collect(p.id, id)).toMatchObject({ outcome: workerCollectedResultSchema.shape.outcome.enum.destroyed, settled: true, cleanup: 'complete', workspace: { state: 'deleted' }, summary: { state: 'available' }, diff: { state: 'available' }, head: { state: 'deleted' } });
    }
    expect(store.readWorkerResultDiff(p.id, a)).toContain('+alpha');
    expect(store.readWorkerResultDiff(p.id, b)).toContain('+beta');
    expect(git(parentPath, 'show', 'HEAD:shared.txt')).toBe('alpha');
    expect(git(parentPath, 'rev-parse', 'HEAD')).toBe(integratedHead);
    const publicState = JSON.stringify([store.listRuns(), ...store.listRuns().map(run => store.readEvents(run.id))]);
    for (const env of environments.values()) expect(publicState).not.toContain(env.CEZ_DELEGATION_TOKEN!);
    reply(p.id, 1, { text: 'Reviewed alpha integration; beta conflict deliberately aborted.', done: true });
    await until(() => store.getRun(p.id)?.status === RUN_STATUS.review, 'collected deleted workers permit honest parent review');
  }, 120_000);
}

if (group === 'failure-authority') {

  it('reports a real provider failure and a stopped worker without allowing peer authority or premature success', async () => {
    const p = await parent(); const failed = await spawn(p.id, 'codex', 'Exercise provider failure'); const stopped = await spawn(p.id, 'claude', 'Exercise explicit stop');
    expect(await command(failed, ['steer', stopped, 'Unauthorized peer steering'], 1)).toMatchObject({ code: 'denied_scope' });
    expect(store.getRun(stopped)?.agentInputs).toBeUndefined();
    // hearsay-tools/squawk#3819: a worker may start one shared worker; a worker with its own worktree stays outside its grant.
    expect(await command(failed, ['spawn', '--workspace', 'isolated', '--baseline', 'parent-head', '--request-id', randomUUID(), 'Unauthorized nested worker'], 1))
      .toMatchObject({ code: 'denied_scope', error: expect.stringContaining('Allowed: --workspace shared') });
    expect(store.listRuns()).toHaveLength(3);
    reply(p.id, 1); await until(() => monitoringPark(p.id), 'parent idle');
    const wait = await command<WorkerWaitResult>(p.id, ['wait', failed, stopped, '--mode', 'all']);
    reply(failed, 1, { error: 'integration provider unavailable' }); await settled(failed, RUN_STATUS.failed);
    expect(store.getRun(p.id)?.agentInputs?.some(item => item.id === wait.wait.id && item.deliveredAt)).not.toBe(true);
    expect(['stopping', 'terminated']).toContain((await command(p.id, ['stop', stopped])).state); await settled(stopped, RUN_STATUS.cancelled);
    expect(await command(p.id, ['stop', stopped])).toMatchObject({ state: 'terminated' });
    await input(p.id, 2); reply(p.id, 2);
    expect(manager.finish(p.id)).toBe(false);
    expect(await collect(p.id, failed)).toMatchObject({ outcome: workerCollectedResultSchema.shape.outcome.enum.failed, lastExecutionOutcome: workerCollectedResultSchema.shape.lastExecutionOutcome.enum.failed, partial: true, settled: true, error: expect.stringContaining('integration provider unavailable') });
    expect(await collect(p.id, stopped)).toMatchObject({ outcome: workerCollectedResultSchema.shape.outcome.enum.cancelled, partial: true, settled: true });
    expect(await command(p.id, ['steer', stopped, 'Late input must not reopen'], 1)).toMatchObject({ code: 'incompatible_state' });
    expect(store.getRun(stopped)?.status).toBe(RUN_STATUS.cancelled);
    expect(manager.finish(p.id)).toBe(true);
    await until(() => store.getRun(p.id)?.status === RUN_STATUS.done, 'collected failures allow explicit human Finish');
  }, 90_000);
}

if (group === 'parent-cancellation') {

  it('parent cancellation proves live child termination while preserving another child review worktree', async () => {
    const p = await parent(); const completed = await spawn(p.id, 'claude', 'Complete useful work'); const live = await spawn(p.id, 'codex', 'Long running work');
    await finishWorker(p.id, completed, 'retained');
    const result = await collect(p.id, completed);
    manager.cancel(p.id);
    await settled(live, RUN_STATUS.cancelled);
    await until(() => !manager.isActive(p.id), 'cancelled parent closes');
    expect(store.getRun(p.id)?.status).toBe(RUN_STATUS.cancelled);
    expect(store.getRun(completed)?.status).toBe(RUN_STATUS.review);
    expect(readFileSync(join(result.workspace.path, 'shared.txt'), 'utf8')).toBe('retained\n');
    expect(store.readWorkerResultDiff(p.id, completed)).toContain('+retained');
    expect(store.readWorkerExecution(live)?.phase).toBe('complete');
    expect(store.getRun(live)?.worktreePath && existsSync(store.getRun(live)!.worktreePath!)).toBe(true);
  }, 90_000);
}

  });
}
