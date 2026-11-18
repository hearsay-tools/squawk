import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHARED_ATTACH_REFUSAL } from '@open-mercato/cezar-contract/delegation';
import type { RunRecord } from '../runs/store.ts';
import { workspaceKinds } from './workspace-kinds.ts';

const shared = workspaceKinds.shared;
let root: string, repo: string, host: string, dataDir: string, baselineSha: string;
const workerId = randomUUID(), parentId = randomUUID();
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const init = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'gc.auto', '0'); git(dir, 'config', 'user.name', 'test'); git(dir, 'config', 'user.email', 'test@local');
};
const plan = (hostDirectory = host) => shared.plan({ repoRoot: repo, workerId, baselineSha, hostRunId: parentId, hostDirectory });
async function workerRun(context?: unknown, hostDirectory = host): Promise<RunRecord> {
  return { id: workerId, delegation: { role: 'worker', permissions: [], parentRunId: parentId, workspace: await plan(hostDirectory), ...(context ? { context } : {}) } } as unknown as RunRecord;
}
const request = (run: RunRecord) => ({ repoRoot: repo, dataDir, run, parentCwd: '/never-read' });
const dataFile = (name: string) => join(dataDir, 'runs', `${workerId}-images`, name);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-shared-workspace-')));
  repo = join(root, 'repo'); dataDir = join(repo, '.ai/squawk'); host = join(dataDir, 'worktrees', parentId);
  init(repo);
  writeFileSync(join(repo, 'notes.md'), 'at the baseline\n'); writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 255, 254, 10, 0, 128]));
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'parent-branch', host);
  baselineSha = git(host, 'rev-parse', 'HEAD');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the shared workspace kind', () => {
  it('states what a destroy removes, why it has no diff, and what its worker is told', () => {
    expect(shared.destroyResources).toEqual([]);
    expect(shared.noDiff).toContain('shared workspace');
    expect(shared.workerNotice).toBe("You share your parent's worktree: do not write there unless your task says so.");
  });

  it('plans a record that names the host directory and run, with no branch', async () => {
    const alias = join(root, 'alias'); symlinkSync(host, alias);
    expect(await plan(alias)).toEqual({ ownerRunId: workerId, resourceId: expect.any(String), kind: 'shared', path: host, hostRunId: parentId, baselineSha });
    expect(existsSync(join(dataDir, 'worktrees', workerId))).toBe(false);
  });

  it('opens a launch and a Continue in the recorded directory, whatever directory the parent has now', async () => {
    const run = await workerRun();
    expect(await shared.openForLaunch({ ...request(run), firstLaunch: true })).toEqual({ path: host, baseBranch: baselineSha });
    expect(existsSync(dataFile('worker-workspace-start.json'))).toBe(true);
    expect(await shared.openForContinue(request(run))).toBe(host);
    expect(await shared.readHead(repo, run)).toBe(baselineSha);
    await expect(shared.assertResumable(repo, run)).resolves.toBeUndefined();
    expect(git(host, 'status', '--porcelain')).toBe('');
  });

  it('records the end state at settlement, and drops it when the next session opens', async () => {
    const run = await workerRun();
    await shared.openForLaunch({ ...request(run), firstLaunch: true });
    expect(await shared.changeReport(dataDir, run, false)).toEqual({ state: 'unchanged' });
    writeFileSync(join(host, 'written.txt'), 'x\n');
    await shared.settle(request(run));
    expect(existsSync(dataFile('worker-workspace-end.json'))).toBe(true);
    expect(await shared.changeReport(dataDir, run, true)).toMatchObject({ state: 'changed', paths: ['written.txt'] });
    await shared.openForContinue(request(run));
    expect(existsSync(dataFile('worker-workspace-end.json'))).toBe(false);
    expect(await shared.changeReport(dataDir, run, true)).toEqual({ state: 'unavailable', reason: 'no workspace state was recorded when the worker settled' });
  });

  it('refuses a launch once the destroy began', async () => {
    const run = await workerRun();
    const destroyed = { ...run, delegation: { ...run.delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'requested', remaining: ['process'] } } } as unknown as RunRecord;
    await expect(shared.openForLaunch({ ...request(destroyed), firstLaunch: true })).rejects.toThrow('Worker destruction has begun');
  });

  it('fails closed when the directory is gone, replaced, redirected or no worktree of this repository, and creates nothing', async () => {
    const run = await workerRun();
    const open = () => shared.openForContinue(request(run));
    git(repo, 'worktree', 'remove', '--force', host);
    await expect(open()).rejects.toThrow(`the shared directory ${host} is gone or is no longer a directory`);
    await expect(shared.openForLaunch({ ...request(run), firstLaunch: true })).rejects.toThrow('is gone');
    await expect(shared.assertResumable(repo, run)).rejects.toThrow('is gone');
    expect(existsSync(host)).toBe(false);
    writeFileSync(host, 'a file now');
    await expect(open()).rejects.toThrow('is gone or is no longer a directory');
    rmSync(host);
    const other = join(root, 'other'); init(other); git(other, 'commit', '--allow-empty', '-qm', 'other');
    symlinkSync(other, host);
    await expect(open()).rejects.toThrow(`the shared directory ${host} is redirected`);
    rmSync(host);
    init(host); git(host, 'commit', '--allow-empty', '-qm', 'another repository');
    await expect(open()).rejects.toThrow(`the shared directory ${host} is no longer a worktree of this repository`);
    rmSync(host, { recursive: true, force: true });
    mkdirSync(host);
    await expect(open()).rejects.toThrow('is no longer a worktree of this repository');
  });

  it('refuses a directory inside a worktree, which is not the worktree itself', async () => {
    mkdirSync(join(host, 'packages'));
    const run = await workerRun(undefined, join(host, 'packages'));
    await expect(shared.openForContinue(request(run))).rejects.toThrow('is no longer a worktree of this repository');
  });

  it('has no diff, tears nothing down and removes nothing', async () => {
    const run = await workerRun();
    const workspace = await plan();
    await expect(shared.readDiff(repo, run)).rejects.toMatchObject({ code: 'unavailable_diff', message: expect.stringContaining('shared workspace') });
    expect(await shared.teardown(repo, { commands: ['touch teardown-ran'] }, workspace)).toBeUndefined();
    const forbidden = () => { throw new Error('a shared workspace has nothing to verify before removal'); };
    expect(await shared.remove(repo, workspace, { assertCurrent: forbidden, assertUnheld: forbidden })).toEqual({ workerId, state: 'complete', deleted: [], remaining: [] });
    expect(existsSync(join(host, 'teardown-ran'))).toBe(false);
    expect(readFileSync(join(host, 'notes.md'), 'utf8')).toBe('at the baseline\n');
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'parent-branch')).toBe('parent-branch');
  });
});

describe('the context of a shared worker', () => {
  const prepare = async (artifacts: Array<{ kind: 'baseline-file'; path: string } | { kind: 'parent-file'; path: string }>) => shared.prepareContext({
    repoRoot: repo, dataDir, parentId, workspace: await plan(), parentCwd: host, context: { text: 'read these', artifacts }, containsSecret: () => false,
  });

  it('copies a baseline file from its blob into the worker\'s data directory, never into the host worktree', async () => {
    writeFileSync(join(host, 'notes.md'), 'edited by the parent, not committed\n');
    const { recipe } = await prepare([{ kind: 'baseline-file', path: 'notes.md' }, { kind: 'baseline-file', path: 'image.bin' }]);
    expect(recipe.inputs.map(input => input.path)).toEqual([dataFile('worker-context-0.input'), dataFile('worker-context-1.input')]);
    expect(readFileSync(recipe.inputs[0]!.path, 'utf8')).toBe('at the baseline\n');
    expect([...readFileSync(recipe.inputs[1]!.path)]).toEqual([0, 255, 254, 10, 0, 128]);
    expect(recipe.inputs[1]!.bytes).toBe(6);
    expect(git(host, 'status', '--porcelain')).toBe('M notes.md');
    expect(readFileSync(join(host, 'notes.md'), 'utf8')).toBe('edited by the parent, not committed\n');
  });

  it('refuses a file of the parent\'s worktree: it is already where the worker runs', async () => {
    writeFileSync(join(host, '.env'), 'A=1\n'); writeFileSync(join(repo, '.git/info/exclude'), '.env\n');
    await expect(prepare([{ kind: 'parent-file', path: '.env' }])).rejects.toMatchObject({ code: 'invalid_input', message: SHARED_ATTACH_REFUSAL });
    expect(existsSync(join(dataDir, 'runs', `${workerId}-images`))).toBe(false);
  });

  it('verifies the copies at launch, rebuilds a missing one from its blob and refuses a changed one', async () => {
    const { recipe } = await prepare([{ kind: 'baseline-file', path: 'image.bin' }]);
    const run = await workerRun(recipe);
    const copy = recipe.inputs[0]!.path;
    await expect(shared.openForLaunch({ ...request(run), firstLaunch: true })).resolves.toMatchObject({ path: host });
    rmSync(copy);
    await shared.openForContinue(request(run));
    expect([...readFileSync(copy)]).toEqual([0, 255, 254, 10, 0, 128]);
    writeFileSync(copy, Buffer.from([1, 2, 3, 4, 5, 6]));
    await expect(shared.openForContinue(request(run))).rejects.toMatchObject({ code: 'invalid_input' });
    const moved = { ...run, delegation: { ...run.delegation, context: { ...recipe, inputs: [{ ...recipe.inputs[0]!, path: join(host, 'image.bin') }] } } } as unknown as RunRecord;
    await expect(shared.openForContinue(request(moved))).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
