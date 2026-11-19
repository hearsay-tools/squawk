import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SHARED_ATTACH_REFUSAL, SHARED_BASELINE_REFUSAL } from '@open-mercato/cezar-contract/delegation';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import * as runners from '../core/runner-factory.ts';
import { clearAutosaveCleanup, retainAutosaveCleanup } from '../autosave-cleanup.ts';
import '../core/every-runner.testkit.ts';
import { ensureDataGitignore } from '../data-gitignore.ts';
import { projectPaths } from '../project-paths.ts';
import { isReclaimable, reclaimWorktree } from '../runs/retention.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { workerCapacity } from './capacity.ts';
import { releaseEndedWorkerBranches } from './family-end.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { fixture } from './service.testkit.ts';
import { workerCleanups } from './worker-cleanup.ts';
import { ownedWorkspaceReceipts } from './workspace-record.ts';

const mutationLock = vi.hoisted(() => ({ taken: 0 }));
vi.mock('../git-worktree-lock.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../git-worktree-lock.ts')>();
  return { ...actual, withWorktreeMutation: ((...args: Parameters<typeof actual.withWorktreeMutation>) => { mutationLock.taken += 1; return actual.withWorktreeMutation(...args); }) as typeof actual.withWorktreeMutation };
});

let f: ReturnType<typeof fixture>;
/** The parent's own worktree: the directory a shared worker runs in. */
let host: string;
let hostHead: string;
const sessions: Array<{ spec: AgentRunSpec; finish(): void }> = [];
/** What the next session does in its directory before the test finishes it. */
let onSession: (cwd: string) => void = () => {};

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const until = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 });
const shared = () => ({ task: 'review the change', workspace: 'shared' as const, requestId: randomUUID() });
const worker = (workerId: string) => f.store.getRun(workerId)!;
const notes = (workerId: string) => f.store.readEvents(workerId).filter(event => event.type === 'note').map(event => String(event.message));

/** Launch the queued worker, let its session act, end the session and wait for its execution to settle. */
async function runSession(workerId: string, act: (cwd: string) => void = () => {}): Promise<AgentRunSpec> {
  const before = sessions.length;
  onSession = act;
  await f.releaseAdmission();
  await until(() => sessions.length > before);
  const session = sessions.at(-1)!;
  session.finish();
  expect(await f.manager.awaitRunTermination(workerId, 15_000)).toBe(true);
  return session.spec;
}

beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
  onTestFinished(scopeFixtureProcesses());
  mutationLock.taken = 0; sessions.length = 0; onSession = () => {};
  f = fixture(workerCleanups());
  vi.spyOn(runners, 'createRunner').mockImplementation(backend => ({
    backend: backend ?? 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    interrupt: async () => {}, run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: spec => {
      let open = true;
      let resolve!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(done => { resolve = done; });
      const finish = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      onSession(spec.cwd);
      sessions.push({ spec, finish });
      return { result, get open() { return open; }, sendMessage: () => open, sendAgentMessage: () => open ? Promise.resolve() : false,
        discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt: finish, end: finish };
    },
  }));
  host = join(f.root, '.ai/cezar/worktrees', f.parent.id);
  git(f.root, 'worktree', 'add', '-q', '-b', 'parent-branch', host);
  writeFileSync(join(host, 'parent-work.txt'), 'committed by the parent\n');
  git(host, 'add', '.'); git(host, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'parent work');
  hostHead = git(host, 'rev-parse', 'HEAD');
  host = realpathSync(host);
  setRunStatus(f.store, f.parent.id, RUN_STATUS.running, { worktreePath: host, branch: 'parent-branch' });
  vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: host, runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default',
    accountBinding: { provider: 'claude', profileId: 'default', homePath: f.root, claudeLayout: { kind: 'relocated' } } });
});
afterEach(async () => {
  for (const session of sessions) session.finish();
  try { await f.close(); } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

describe('a worker in a shared workspace (hearsay-tools/squawk#3819)', { timeout: 60_000 }, () => {
  it('is spawned at the parent\'s HEAD with no worktree, no branch and no owned-workspace receipt', async () => {
    const spawned = await f.service.spawn(f.caller, shared());
    expect(spawned.baselineSha).toBe(hostHead);
    expect(hostHead).not.toBe(f.sha);
    const run = worker(spawned.workerId);
    expect(run.delegation).toMatchObject({ role: 'worker', parentRunId: f.parent.id,
      workspace: { ownerRunId: run.id, resourceId: expect.any(String), kind: 'shared', path: host, hostRunId: f.parent.id, baselineSha: hostHead } });
    expect(run.delegation?.role === 'worker' && 'branch' in run.delegation.workspace).toBe(false);
    expect(run.worktreePath).toBeUndefined(); expect(run.branch).toBeUndefined();
    expect(existsSync(join(f.root, '.ai/cezar/worktrees', run.id))).toBe(false);
    expect(git(f.root, 'branch', '--list', `cez/${run.id.slice(0, 8)}`)).toBe('');
    expect(await ownedWorkspaceReceipts(f.root)).toEqual([]);
    expect(mutationLock.taken).toBe(0);
    expect((await f.service.inspect(f.caller, { workerId: run.id })).workspace).toMatchObject({ kind: 'shared', path: host });
  });

  it('refuses --baseline and --attach with clear words, and creates no worker', async () => {
    await expect(f.service.spawn(f.caller, { ...shared(), baseline: 'main' })).rejects.toMatchObject({ code: 'invalid_input', message: SHARED_BASELINE_REFUSAL });
    expect(SHARED_BASELINE_REFUSAL).toContain('leave --baseline out or pass parent-head');
    await expect(f.service.spawn(f.caller, { ...shared(), context: { artifacts: [{ kind: 'parent-file', path: '.env' }] } }))
      .rejects.toMatchObject({ code: 'invalid_input', message: SHARED_ATTACH_REFUSAL });
    await expect(f.service.spawn(f.caller, { task: 'isolated without a baseline', requestId: randomUUID() })).rejects.toThrow();
    expect(f.store.listWorkerIds()).toEqual([]);
  });

  it('returns the same worker for the same request, with or without --baseline parent-head, and refuses another kind under the same request id', async () => {
    const request = shared();
    const first = await f.service.spawn(f.caller, request);
    expect(await f.service.spawn(f.caller, request)).toEqual(first);
    // `parent-head` names the HEAD a shared worker runs at anyway: the same request, the same worker.
    expect(await f.service.spawn(f.caller, { ...request, baseline: 'parent-head' })).toEqual(first);
    expect(first.baselineSha).toBe(hostHead);
    await expect(f.service.spawn(f.caller, { task: request.task, baseline: 'parent-head', requestId: request.requestId }))
      .rejects.toMatchObject({ code: 'invalid_input', message: 'Request ID payload conflict' });
    await expect(f.service.spawn(f.caller, { ...request, workspace: 'isolated', baseline: 'parent-head' }))
      .rejects.toMatchObject({ message: 'Request ID payload conflict' });
    expect(f.store.listWorkerIds()).toEqual([first.workerId]);
  });

  it('keeps an isolated request\'s identity whether or not it names the default workspace', async () => {
    const request = { task: 'isolated', baseline: 'parent-head', requestId: randomUUID() };
    const first = await f.service.spawn(f.caller, request);
    expect(await f.service.spawn(f.caller, { ...request, workspace: 'isolated' })).toEqual(first);
    expect(worker(first.workerId).delegation).toMatchObject({ workspace: { kind: 'owned-isolated' } });
  });

  it('counts toward the parent\'s 32 outstanding workers', async () => {
    for (let n = 0; n < 32; n++) await f.service.spawn(f.caller, shared());
    expect(workerCapacity(f.store.getRun(f.parent.id)!, id => f.store.getRun(id))).toMatchObject({ outstanding: 32, created: 32 });
    await expect(f.service.spawn(f.caller, shared())).rejects.toMatchObject({ code: 'capacity_limit' });
  });

  it('runs in the parent\'s directory with no seeding, setup, autosave commit or record of a worktree, and reports the file it wrote', async () => {
    mkdirSync(join(f.root, '.claude'), { recursive: true });
    writeFileSync(join(f.root, '.claude/settings.local.json'), '{}');
    writeFileSync(join(f.root, '.git/info/exclude'), '.claude/settings.local.json\nsetup-ran\n');
    mkdirSync(projectPaths(f.root).write, { recursive: true });
    writeFileSync(join(projectPaths(f.root).write, 'config.json'), JSON.stringify({ worktreeSetup: { commands: ['touch setup-ran'] } }));
    const { workerId } = await f.service.spawn(f.caller, shared());
    const spec = await runSession(workerId, cwd => writeFileSync(join(cwd, 'written-by-worker.txt'), 'the worker wrote this\n'));
    expect(spec.cwd).toBe(host);
    const run = worker(workerId);
    expect(run).toMatchObject({ baseBranch: hostHead });
    expect(run.worktreePath).toBeUndefined(); expect(run.branch).toBeUndefined(); expect(run.worktreeSetup).toBeUndefined();
    expect(notes(workerId)).toEqual(expect.arrayContaining(['shared workspace — running in the parent\'s worktree', `shared workspace ready — ${host} (base ${hostHead})`]));
    expect(notes(workerId).join('\n')).not.toMatch(/seeded personal agent config|worktree setup/i);
    expect(existsSync(join(host, '.claude/settings.local.json'))).toBe(false);
    expect(existsSync(join(host, 'setup-ran'))).toBe(false);
    // The run finalized: an owning run's final autosave would have committed the file by now.
    expect(git(host, 'rev-parse', 'HEAD')).toBe(hostHead);
    expect(git(host, 'status', '--porcelain')).toBe('?? written-by-worker.txt');
    expect(mutationLock.taken).toBe(0);

    const result = await f.service.collect(f.caller, { workerId });
    expect(result).toMatchObject({
      settled: true, baselineSha: hostHead, workspace: { kind: 'shared', path: host, state: 'available' },
      head: { state: 'available', sha: hostHead },
      diff: { state: 'unavailable', reason: 'unsupported', detail: expect.stringContaining('shared workspace') },
      changes: { state: 'changed', paths: ['written-by-worker.txt'], truncated: false, headMoved: false, branchMoved: false, indexMoved: false },
    });
    await expect(f.service.diff(f.caller, { workerId })).rejects.toMatchObject({ code: 'unavailable_diff', message: expect.stringContaining('shared workspace') });
  });

  it('commits the same file by autosave when the worker has its own worktree', async () => {
    const { workerId } = await f.service.spawn(f.caller, { task: 'isolated control', baseline: 'parent-head', requestId: randomUUID() });
    const spec = await runSession(workerId, cwd => writeFileSync(join(cwd, 'written-by-worker.txt'), 'the worker wrote this\n'));
    expect(spec.cwd).toBe(worker(workerId).worktreePath);
    expect(git(spec.cwd, 'status', '--porcelain')).toBe('');
    expect(git(spec.cwd, 'rev-parse', 'HEAD')).not.toBe(hostHead);
    expect((await f.service.collect(f.caller, { workerId })).changes).toBeUndefined();
  });

  it('runs in the repository root for a parent that runs in place, without waiting for the repository-root lease', async () => {
    const rootDirectory = realpathSync(f.root);
    // As a registered project has it: the run store and each run's files are ignored, so they are no part of the report.
    ensureDataGitignore(f.root);
    setRunStatus(f.store, f.parent.id, RUN_STATUS.running, { worktreePath: undefined, branch: undefined, worktree: false });
    vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ cwd: f.root, runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default',
      accountBinding: { provider: 'claude', profileId: 'default', homePath: f.root, claudeLayout: { kind: 'relocated' } } });
    const { workerId } = await f.service.spawn(f.caller, shared());
    expect(worker(workerId).delegation).toMatchObject({ workspace: { kind: 'shared', path: rootDirectory, baselineSha: f.sha } });
    const spec = await runSession(workerId, cwd => writeFileSync(join(cwd, 'written-in-place.txt'), 'x\n'));
    expect(realpathSync(spec.cwd)).toBe(rootDirectory);
    expect(notes(workerId).join('\n')).not.toContain('waiting for exclusive access to the repository working tree');
    expect(worker(workerId).worktreePath).toBeUndefined();
    expect((await f.service.collect(f.caller, { workerId })).changes).toMatchObject({ state: 'changed', paths: ['written-in-place.txt'] });
  });

  it('continues in the same directory and still compares with the first session\'s start', async () => {
    const { workerId } = await f.service.spawn(f.caller, shared());
    await runSession(workerId, cwd => writeFileSync(join(cwd, 'first-session.txt'), 'x\n'));
    expect(f.manager.continueRun(workerId, { text: 'again' })).toMatchObject({ ok: true });
    await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.cwd).toBe(host);
    sessions[1]!.finish();
    expect(await f.manager.awaitRunTermination(workerId, 15_000)).toBe(true);
    expect(worker(workerId).worktreePath).toBeUndefined();
    expect((await f.service.collect(f.caller, { workerId })).changes).toMatchObject({ state: 'changed', paths: ['first-session.txt'] });
  });

  it('fails closed at launch and at Continue when the parent\'s directory is gone, and creates nothing', async () => {
    const { workerId: continued } = await f.service.spawn(f.caller, shared());
    await runSession(continued);
    await f.holdAdmission();
    const { workerId: launched } = await f.service.spawn(f.caller, shared());
    git(f.root, 'worktree', 'remove', '--force', host);
    await f.releaseAdmission();
    await until(() => worker(launched).status === RUN_STATUS.failed);
    expect(worker(launched).error).toContain(`shared workspace unavailable: the shared directory ${host} is gone`);
    expect(f.manager.continueRun(continued, { text: 'again' })).toMatchObject({ ok: true });
    await until(() => worker(continued).status === RUN_STATUS.failed);
    expect(worker(continued).error).toContain(`the shared directory ${host} is gone`);
    expect(existsSync(host)).toBe(false);
    expect(sessions).toHaveLength(1);
  });

  it('is destroyed without touching the parent\'s worktree, branch, files or the worktree mutation lock', async () => {
    mkdirSync(projectPaths(f.root).write, { recursive: true });
    writeFileSync(join(projectPaths(f.root).write, 'config.json'), JSON.stringify({ worktreeTeardown: { commands: ['touch teardown-ran'], timeoutSeconds: 10 } }));
    const { workerId } = await f.service.spawn(f.caller, shared());
    await runSession(workerId, cwd => writeFileSync(join(cwd, 'written-by-worker.txt'), 'kept\n'));
    expect(await f.service.destroy(f.caller, { workerId })).toEqual({ workerId, state: 'complete', deleted: [], remaining: [] });
    expect(worker(workerId).delegation).toMatchObject({ destroy: { phase: 'complete', remaining: [] } });
    expect(readFileSync(join(host, 'written-by-worker.txt'), 'utf8')).toBe('kept\n');
    expect(existsSync(join(host, 'teardown-ran'))).toBe(false);
    expect(git(f.root, 'branch', '--list', '--format=%(refname:short)', 'parent-branch')).toBe('parent-branch');
    expect(git(host, 'rev-parse', 'HEAD')).toBe(hostHead);
    expect(mutationLock.taken).toBe(0);
    expect(workerCapacity(f.store.getRun(f.parent.id)!, id => f.store.getRun(id)).outstanding).toBe(0);
    expect(await f.service.collect(f.caller, { workerId })).toMatchObject({
      outcome: 'destroyed', cleanup: 'complete', workspace: { kind: 'shared', state: 'available' }, head: { state: 'available', sha: hostHead },
      changes: { state: 'changed', paths: ['written-by-worker.txt'] },
    });
  });

  it('keeps a failed parent\'s worktree from being reclaimed while its shared worker runs, and frees it once the worker is destroyed', async () => {
    const { workerId } = await f.service.spawn(f.caller, shared());
    await f.releaseAdmission();
    await until(() => sessions.length === 1);
    setRunStatus(f.store, f.parent.id, RUN_STATUS.failed, { finishedAt: new Date().toISOString() });
    const parent = () => f.store.getRun(f.parent.id)!;
    expect(isReclaimable(parent(), id => f.store.getRun(id))).toBe(true);
    expect(worker(workerId).status).toBe(RUN_STATUS.running);
    expect(f.manager.claimWorktreeReclaim(f.parent.id)).toBeNull();
    expect(f.manager.claimForBranchCleanup([f.parent.id])).toBeNull();
    expect(existsSync(join(host, 'parent-work.txt'))).toBe(true);
    sessions[0]!.finish();
    expect(await f.manager.awaitRunTermination(workerId, 15_000)).toBe(true);
    expect(await f.service.destroyForHuman('project', workerId)).toMatchObject({ state: 'complete' });
    const release = f.manager.claimWorktreeReclaim(f.parent.id);
    expect(release).toEqual(expect.any(Function));
    release?.();
  });

  it('refuses a Continue of the shared worker while its host\'s worktree is claimed for a reclaim, and admits it after the release', async () => {
    const { workerId } = await f.service.spawn(f.caller, shared());
    await runSession(workerId);
    setRunStatus(f.store, f.parent.id, RUN_STATUS.failed, { finishedAt: new Date().toISOString() });
    const release = f.manager.claimWorktreeReclaim(f.parent.id);
    expect(release).toEqual(expect.any(Function));
    expect(f.manager.continueRun(workerId, { text: 'again' })).toEqual({ ok: false, error: 'its worktree or branch is being cleaned up — retry in a moment' });
    expect(worker(workerId).status).not.toBe(RUN_STATUS.running);
    expect(sessions).toHaveLength(1);
    release?.();
    expect(f.manager.continueRun(workerId, { text: 'again' })).toMatchObject({ ok: true });
    await until(() => sessions.length === 2);
    expect(f.manager.claimWorktreeReclaim(f.parent.id)).toBeNull();
  });

  it('holds a shared worker off its host\'s worktree while autosave cleanup evidence marks it unsafe: no launch, and a Continue refused in the host\'s words', async () => {
    const dataDir = join(f.root, '.ai/cezar'), blocker = 'autosave unsuccessful in the host worktree; worktree reuse blocked';
    const { workerId: settled } = await f.service.spawn(f.caller, shared());
    await runSession(settled);
    await f.holdAdmission();
    retainAutosaveCleanup(dataDir, f.parent.id, host, blocker, { processes: [], groups: [], uncertain: true });
    expect(f.manager.continueRun(settled, { text: 'again' })).toEqual({ ok: false, error: blocker });
    const { workerId: queued } = await f.service.spawn(f.caller, shared());
    const isolated = await f.service.spawn(f.caller, { task: 'isolated', baseline: 'parent-head', requestId: randomUUID() });
    // The line was pumped with capacity free: the isolated worker left it, the shared one did not.
    await f.releaseAdmission();
    await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.cwd).toBe(worker(isolated.workerId).worktreePath);
    expect(worker(queued).status).toBe(RUN_STATUS.queued);
    clearAutosaveCleanup(dataDir, f.parent.id);
    await f.holdAdmission(); await f.releaseAdmission();
    await until(() => sessions.length === 3);
    expect(sessions[2]!.spec.cwd).toBe(host);
  });

  it('compares only a queued, running or waiting worker with the directory as it is: a failed or cancelled one without a complete execution gets no report', async () => {
    const { workerId } = await f.service.spawn(f.caller, shared());
    await f.releaseAdmission();
    await until(() => sessions.length === 1);
    writeFileSync(join(host, 'written-while-running.txt'), 'x\n');
    expect((await f.service.collect(f.caller, { workerId })).changes).toMatchObject({ state: 'changed', paths: ['written-while-running.txt'] });
    for (const status of [RUN_STATUS.failed, RUN_STATUS.cancelled]) {
      setRunStatus(f.store, workerId, status);
      expect(await f.service.collect(f.caller, { workerId }), status).toMatchObject({ settled: false, changes: { state: 'unavailable', reason: 'no workspace state was recorded when the worker settled' } });
    }
    setRunStatus(f.store, workerId, RUN_STATUS.running);
  });

  it('is never a reason for retention, the family end or history deletion to remove the parent\'s directory or branch', async () => {
    const { workerId } = await f.service.spawn(f.caller, shared());
    await runSession(workerId);
    setRunStatus(f.store, f.parent.id, RUN_STATUS.done, { archived: true });
    const run = worker(workerId);
    expect(isReclaimable(run, id => f.store.getRun(id))).toBe(false);
    expect(await reclaimWorktree(f.root, f.store, run)).toBeNull();
    expect(await releaseEndedWorkerBranches(f.root, f.store, () => () => undefined)).toEqual([]);
    expect(existsSync(join(host, 'parent-work.txt'))).toBe(true);
    expect(await f.service.destroyForHuman('project', workerId)).toMatchObject({ state: 'complete', remaining: [] });
    expect(f.store.deleteRun(workerId)).toBe(true);
    expect(f.store.getRun(workerId)).toBeUndefined();
    expect(existsSync(join(host, 'parent-work.txt'))).toBe(true);
    expect(git(f.root, 'branch', '--list', '--format=%(refname:short)', 'parent-branch')).toBe('parent-branch');
    expect(git(host, 'status', '--porcelain')).toBe('');
    expect(mutationLock.taken).toBe(0);
  });
});
