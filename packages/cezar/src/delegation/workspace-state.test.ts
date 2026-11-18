import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKER_CHANGED_PATHS_CAP } from '@open-mercato/cezar-contract/delegation';
import { CONTENT_HASH_FILE_BYTES, boundedContentHash, captureWorkspaceState, clearWorkspaceEnds, compareWorkspaceStates, parseStatus, recordWorkspaceEnd, recordWorkspaceStart,
  workspaceChangeReport } from './workspace-state.ts';

let root: string, repo: string, dataDir: string;
const workerId = randomUUID();
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const startFile = () => join(dataDir, 'runs', `${workerId}-images`, 'worker-workspace-start.json');
const report = (settled = true, generation = 'generation-1') => workspaceChangeReport(dataDir, workerId, repo, { generation, settled });
const recordEnd = (generation = 'generation-1') => recordWorkspaceEnd(dataDir, workerId, repo, generation);
const endFiles = () => existsSync(join(dataDir, 'runs', `${workerId}-images`)) ? readdirSync(join(dataDir, 'runs', `${workerId}-images`)).filter(name => name.startsWith('worker-workspace-end.')) : [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-workspace-state-'));
  repo = join(root, 'repo'); dataDir = join(root, 'data');
  mkdirSync(repo); mkdirSync(join(dataDir, 'runs'), { recursive: true });
  git('init', '-q', '-b', 'main'); git('config', 'gc.auto', '0'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
  writeFileSync(join(repo, 'tracked.txt'), 'baseline\n'); writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
  git('add', '.'); git('commit', '-qm', 'base');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseStatus', () => {
  it('reads each entry, and the source a rename names after it', () => {
    expect(parseStatus(' M a.txt\0?? new file.txt\0R  moved.txt\0old.txt\0')).toEqual([
      ['a.txt', ' M'], ['new file.txt', '??'], ['moved.txt', 'R  old.txt'],
    ]);
    expect(parseStatus('')).toEqual([]);
  });
});

describe('the change report of a shared workspace', () => {
  it('is unavailable until a start state is recorded', async () => {
    expect(await report()).toEqual({ state: 'unavailable', reason: expect.stringContaining('the worker started no session') });
    await recordEnd();
    expect(endFiles()).toEqual([]);
  });

  it('says unchanged for a worker that only reads, and leaves the index file alone', async () => {
    const index = statSync(join(repo, '.git/index'));
    // An index older than the file it lists is what makes a plain `git status` rewrite it.
    utimesSync(join(repo, 'tracked.txt'), new Date(), new Date(Date.now() + 5_000));
    await recordWorkspaceStart(dataDir, workerId, repo);
    readFileSync(join(repo, 'tracked.txt'), 'utf8');
    await recordEnd();
    expect(await report()).toEqual({ state: 'unchanged' });
    expect(statSync(join(repo, '.git/index')).mtimeMs).toBe(index.mtimeMs);
  });

  it('names the file a worker wrote, and leaves an ignored file out', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    writeFileSync(join(repo, 'written-by-worker.txt'), 'new\n');
    mkdirSync(join(repo, 'ignored')); writeFileSync(join(repo, 'ignored/build.log'), 'out\n');
    await recordEnd();
    expect(await report()).toEqual({ state: 'changed', paths: ['written-by-worker.txt'], truncated: false, headMoved: false, branchMoved: false, indexMoved: false });
  });

  it('names a tracked file that was edited, and one that was already dirty and was edited again', async () => {
    writeFileSync(join(repo, 'dirty.txt'), 'first\n');
    await recordWorkspaceStart(dataDir, workerId, repo);
    writeFileSync(join(repo, 'tracked.txt'), 'edited\n');
    writeFileSync(join(repo, 'dirty.txt'), 'second edit, another size\n');
    await recordEnd();
    expect(await report()).toMatchObject({ state: 'changed', paths: ['dirty.txt', 'tracked.txt'], indexMoved: false });
  });

  it('compares content: a second edit that keeps the size and the modification time of a dirty file shows', async () => {
    const dirty = join(repo, 'tracked.txt'), untracked = join(repo, 'untracked.txt');
    const at = new Date('2026-11-01T00:00:00.000Z');
    writeFileSync(dirty, 'aaaa\n'); writeFileSync(untracked, 'cccc\n');
    utimesSync(dirty, at, at); utimesSync(untracked, at, at);
    const before = [statSync(dirty), statSync(untracked)];
    await recordWorkspaceStart(dataDir, workerId, repo);
    writeFileSync(dirty, 'bbbb\n'); writeFileSync(untracked, 'dddd\n');
    utimesSync(dirty, at, at); utimesSync(untracked, at, at);
    expect([statSync(dirty), statSync(untracked)].map(entry => [entry.size, entry.mtimeMs])).toEqual(before.map(entry => [entry.size, entry.mtimeMs]));
    await recordEnd();
    expect(await report()).toMatchObject({ state: 'changed', paths: ['tracked.txt', 'untracked.txt'], indexMoved: false });
  });

  it('follows a submodule: an edit inside one that was already dirty shows as the submodule path', async () => {
    const library = join(root, 'library');
    mkdirSync(library);
    const lib = (...args: string[]) => execFileSync('git', args, { cwd: library, encoding: 'utf8', stdio: 'pipe' }).trim();
    lib('init', '-q', '-b', 'main'); lib('config', 'user.name', 'test'); lib('config', 'user.email', 'test@local');
    writeFileSync(join(library, 'lib.txt'), 'v1\n'); lib('add', '.'); lib('commit', '-qm', 'lib');
    git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib'); git('commit', '-qm', 'add submodule');
    writeFileSync(join(repo, 'lib/lib.txt'), 'dirty before the worker\n');
    await recordWorkspaceStart(dataDir, workerId, repo);
    await recordEnd();
    expect(await report()).toEqual({ state: 'unchanged' });
    writeFileSync(join(repo, 'lib/lib.txt'), 'edited by the worker!!!\n');
    await recordEnd();
    expect(await report()).toMatchObject({ state: 'changed', paths: ['lib'], headMoved: false });
  });

  it('falls back to size, modification time and mode for a file over the content bound', async () => {
    const large = join(repo, 'large.bin');
    const at = new Date('2026-11-01T00:00:00.000Z');
    writeFileSync(large, Buffer.alloc(CONTENT_HASH_FILE_BYTES + 1, 1)); utimesSync(large, at, at);
    await recordWorkspaceStart(dataDir, workerId, repo);
    writeFileSync(large, Buffer.alloc(CONTENT_HASH_FILE_BYTES + 1, 2)); utimesSync(large, at, at);
    await recordEnd();
    expect(await report()).toEqual({ state: 'unchanged' });
    writeFileSync(large, Buffer.alloc(CONTENT_HASH_FILE_BYTES + 2, 2));
    await recordEnd();
    expect(await report()).toMatchObject({ state: 'changed', paths: ['large.bin'] });
  });

  it('says that HEAD moved and names the committed paths', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    writeFileSync(join(repo, 'committed.txt'), 'x\n'); git('add', 'committed.txt'); git('commit', '-qm', 'worker commit');
    await recordEnd();
    expect(await report()).toEqual({ state: 'changed', paths: ['committed.txt'], truncated: false, headMoved: true, branchMoved: false, indexMoved: true });
  });

  it('says that the branch moved when another branch is checked out at the same commit', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    git('checkout', '-q', '-b', 'other');
    await recordEnd();
    expect(await report()).toEqual({ state: 'changed', paths: [], truncated: false, headMoved: false, branchMoved: true, indexMoved: false });
    git('checkout', '-q', '--detach');
    expect((await captureWorkspaceState(repo)).branch).toBeNull();
  });

  it('says that the index moved when a change is staged', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'edited\n');
    await recordWorkspaceStart(dataDir, workerId, repo);
    git('add', 'tracked.txt');
    await recordEnd();
    expect(await report()).toMatchObject({ state: 'changed', paths: ['tracked.txt'], indexMoved: true, headMoved: false });
  });

  it('caps the list of paths and says that it is truncated', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    for (let n = 0; n < WORKER_CHANGED_PATHS_CAP + 5; n++) writeFileSync(join(repo, `file-${String(n).padStart(3, '0')}.txt`), 'x\n');
    await recordEnd();
    const result = await report();
    expect(result).toMatchObject({ state: 'changed', truncated: true });
    expect(result.state === 'changed' && result.paths).toHaveLength(WORKER_CHANGED_PATHS_CAP);
    expect(result.state === 'changed' && result.paths[0]).toBe('file-000.txt');
  });

  it('says truncated when entries past the kept ones changed, and never lists a path only because one state could not read its content', async () => {
    writeFileSync(join(repo, 'untracked.txt'), 'x\n');
    const start = await captureWorkspaceState(repo);
    expect(start.entries).toEqual([{ path: 'untracked.txt', code: '??', meta: expect.any(String), content: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }]);
    expect(start.overflow).toBeNull();
    expect(await compareWorkspaceStates(repo, { ...start, overflow: 'a'.repeat(64) }, { ...start, overflow: 'b'.repeat(64) }))
      .toEqual({ state: 'changed', paths: [], truncated: true, headMoved: false, branchMoved: false, indexMoved: false });
    const withoutContent = { ...start, entries: start.entries.map(({ content: _content, ...entry }) => entry) };
    expect(await compareWorkspaceStates(repo, start, withoutContent)).toEqual({ state: 'unchanged' });
    expect(await compareWorkspaceStates(repo, withoutContent, start)).toEqual({ state: 'unchanged' });
    const touched = { ...start, entries: start.entries.map(entry => ({ ...entry, meta: 'another-time' })) };
    expect(await compareWorkspaceStates(repo, start, touched)).toEqual({ state: 'unchanged' });
    expect(await compareWorkspaceStates(repo, withoutContent, touched)).toMatchObject({ state: 'changed', paths: ['untracked.txt'] });
  });

  it('never reads through a link: a link entry is its target, and a file under a directory replaced by a link gets no content', async () => {
    const outside = join(root, 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside the workspace\n'); writeFileSync(join(outside, 'a.txt'), 'outside copy\n');
    mkdirSync(join(repo, 'docs')); writeFileSync(join(repo, 'docs/a.txt'), 'tracked\n'); git('add', '.'); git('commit', '-qm', 'docs');
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'link.txt'));
    rmSync(join(repo, 'docs'), { recursive: true }); symlinkSync(outside, join(repo, 'docs'));
    writeFileSync(join(repo, 'plain.txt'), 'inside\n');
    const state = await captureWorkspaceState(repo);
    const entry = (path: string) => state.entries.find(candidate => candidate.path === path);
    expect(entry('link.txt')).toMatchObject({ content: `link:${join(outside, 'secret.txt')}` });
    expect(entry('plain.txt')?.content).toBe(`sha256:${createHash('sha256').update('inside\n').digest('hex')}`);
    const redirected = state.entries.filter(candidate => candidate.path.startsWith('docs/'));
    expect(redirected.length).toBeGreaterThan(0);
    for (const candidate of redirected) expect(candidate.content, candidate.path).toBeUndefined();
    await recordWorkspaceStart(dataDir, workerId, repo);
    writeFileSync(join(outside, 'secret.txt'), 'changed outside, same link\n');
    await recordEnd();
    expect(await report()).toEqual({ state: 'unchanged' });
  });

  it('reads content through a bounded handle that follows no link and stops at the limit', async () => {
    const small = join(repo, 'small.txt'), large = join(repo, 'large.bin'), link = join(repo, 'link');
    writeFileSync(small, 'content\n'); writeFileSync(large, Buffer.alloc(300_000, 7)); symlinkSync(small, link);
    expect(await boundedContentHash(small, 1_000)).toEqual({ hash: createHash('sha256').update('content\n').digest('hex'), read: 8 });
    expect(await boundedContentHash(large, 300_000)).toMatchObject({ read: 300_000, hash: expect.any(String) });
    expect(await boundedContentHash(large, 299_999)).toEqual({ read: 0 });
    expect(await boundedContentHash(link, 1_000)).toEqual({ read: 0 });
    expect(await boundedContentHash(repo, 1_000)).toEqual({ read: 0 });
    expect(await boundedContentHash(join(repo, 'missing'), 1_000)).toEqual({ read: 0 });
  });

  it('keeps the first start state: a later launch or Continue does not overwrite it', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    const first = readFileSync(startFile(), 'utf8');
    writeFileSync(join(repo, 'during-first-session.txt'), 'x\n');
    await recordWorkspaceStart(dataDir, workerId, repo);
    expect(readFileSync(startFile(), 'utf8')).toBe(first);
    await recordEnd();
    expect(await report()).toMatchObject({ state: 'changed', paths: ['during-first-session.txt'] });
  });

  it('compares a running worker with the directory as it is, and never a settled one', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    await recordEnd();
    writeFileSync(join(repo, 'after-settle.txt'), 'x\n');
    expect(await report(true)).toEqual({ state: 'unchanged' });
    await clearWorkspaceEnds(dataDir, workerId);
    expect(endFiles()).toEqual([]);
    expect(await report(false)).toMatchObject({ state: 'changed', paths: ['after-settle.txt'] });
    expect(await report(true)).toEqual({ state: 'unavailable', reason: 'no workspace state was recorded when the worker settled' });
  });

  it('ignores the end state of an earlier execution once the next one runs, also one written late', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    await recordEnd('generation-1');
    writeFileSync(join(repo, 'second-execution.txt'), 'x\n');
    expect(await report(false, 'generation-2')).toMatchObject({ state: 'changed', paths: ['second-execution.txt'] });
    expect(await report(true, 'generation-2')).toEqual({ state: 'unavailable', reason: 'no workspace state was recorded when the worker settled' });
    await recordEnd('generation-2');
    rmSync(join(repo, 'second-execution.txt'));
    await recordEnd('generation-1');
    expect(await report(true, 'generation-2')).toMatchObject({ state: 'changed', paths: ['second-execution.txt'] });
    expect(await report(true, 'generation-1')).toEqual({ state: 'unchanged' });
    expect(await workspaceChangeReport(dataDir, workerId, repo, { generation: undefined, settled: true })).toMatchObject({ state: 'unavailable' });
  });

  it('leaves a settled worker without a report when the end state could not be read', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    await recordEnd();
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    await expect(recordEnd()).rejects.toThrow('failed in the shared workspace');
    expect(endFiles()).toEqual([]);
    expect(await report(true)).toMatchObject({ state: 'unavailable', reason: 'no workspace state was recorded when the worker settled' });
  });

  it('is unavailable with the reason when the directory is gone', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    rmSync(repo, { recursive: true, force: true });
    expect(await report(false)).toEqual({ state: 'unavailable', reason: 'the shared workspace directory is gone' });
  });
});
