import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKER_CHANGED_PATHS_CAP } from '@open-mercato/cezar-contract/delegation';
import { CONTENT_HASH_FILE_BYTES, captureWorkspaceState, clearWorkspaceEnd, compareWorkspaceStates, parseStatus, recordWorkspaceEnd, recordWorkspaceStart,
  workspaceChangeReport } from './workspace-state.ts';

let root: string, repo: string, dataDir: string;
const workerId = randomUUID();
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const stateFile = (name: 'start' | 'end') => join(dataDir, 'runs', `${workerId}-images`, `worker-workspace-${name}.json`);
const report = (settled = true) => workspaceChangeReport(dataDir, workerId, repo, settled);

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
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(existsSync(stateFile('end'))).toBe(false);
  });

  it('says unchanged for a worker that only reads, and leaves the index file alone', async () => {
    const index = statSync(join(repo, '.git/index'));
    // An index older than the file it lists is what makes a plain `git status` rewrite it.
    utimesSync(join(repo, 'tracked.txt'), new Date(), new Date(Date.now() + 5_000));
    await recordWorkspaceStart(dataDir, workerId, repo);
    readFileSync(join(repo, 'tracked.txt'), 'utf8');
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(await report()).toEqual({ state: 'unchanged' });
    expect(statSync(join(repo, '.git/index')).mtimeMs).toBe(index.mtimeMs);
  });

  it('names the file a worker wrote, and leaves an ignored file out', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    writeFileSync(join(repo, 'written-by-worker.txt'), 'new\n');
    mkdirSync(join(repo, 'ignored')); writeFileSync(join(repo, 'ignored/build.log'), 'out\n');
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(await report()).toEqual({ state: 'changed', paths: ['written-by-worker.txt'], truncated: false, headMoved: false, branchMoved: false, indexMoved: false });
  });

  it('names a tracked file that was edited, and one that was already dirty and was edited again', async () => {
    writeFileSync(join(repo, 'dirty.txt'), 'first\n');
    await recordWorkspaceStart(dataDir, workerId, repo);
    writeFileSync(join(repo, 'tracked.txt'), 'edited\n');
    writeFileSync(join(repo, 'dirty.txt'), 'second edit, another size\n');
    await recordWorkspaceEnd(dataDir, workerId, repo);
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
    await recordWorkspaceEnd(dataDir, workerId, repo);
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
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(await report()).toEqual({ state: 'unchanged' });
    writeFileSync(join(repo, 'lib/lib.txt'), 'edited by the worker!!!\n');
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(await report()).toMatchObject({ state: 'changed', paths: ['lib'], headMoved: false });
  });

  it('falls back to size, modification time and mode for a file over the content bound', async () => {
    const large = join(repo, 'large.bin');
    const at = new Date('2026-11-01T00:00:00.000Z');
    writeFileSync(large, Buffer.alloc(CONTENT_HASH_FILE_BYTES + 1, 1)); utimesSync(large, at, at);
    await recordWorkspaceStart(dataDir, workerId, repo);
    writeFileSync(large, Buffer.alloc(CONTENT_HASH_FILE_BYTES + 1, 2)); utimesSync(large, at, at);
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(await report()).toEqual({ state: 'unchanged' });
    writeFileSync(large, Buffer.alloc(CONTENT_HASH_FILE_BYTES + 2, 2));
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(await report()).toMatchObject({ state: 'changed', paths: ['large.bin'] });
  });

  it('says that HEAD moved and names the committed paths', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    writeFileSync(join(repo, 'committed.txt'), 'x\n'); git('add', 'committed.txt'); git('commit', '-qm', 'worker commit');
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(await report()).toEqual({ state: 'changed', paths: ['committed.txt'], truncated: false, headMoved: true, branchMoved: false, indexMoved: true });
  });

  it('says that the branch moved when another branch is checked out at the same commit', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    git('checkout', '-q', '-b', 'other');
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(await report()).toEqual({ state: 'changed', paths: [], truncated: false, headMoved: false, branchMoved: true, indexMoved: false });
    git('checkout', '-q', '--detach');
    expect((await captureWorkspaceState(repo)).branch).toBeNull();
  });

  it('says that the index moved when a change is staged', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'edited\n');
    await recordWorkspaceStart(dataDir, workerId, repo);
    git('add', 'tracked.txt');
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(await report()).toMatchObject({ state: 'changed', paths: ['tracked.txt'], indexMoved: true, headMoved: false });
  });

  it('caps the list of paths and says that it is truncated', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    for (let n = 0; n < WORKER_CHANGED_PATHS_CAP + 5; n++) writeFileSync(join(repo, `file-${String(n).padStart(3, '0')}.txt`), 'x\n');
    await recordWorkspaceEnd(dataDir, workerId, repo);
    const result = await report();
    expect(result).toMatchObject({ state: 'changed', truncated: true });
    expect(result.state === 'changed' && result.paths).toHaveLength(WORKER_CHANGED_PATHS_CAP);
    expect(result.state === 'changed' && result.paths[0]).toBe('file-000.txt');
  });

  it('says truncated when a recorded state dropped entries and the status changed', async () => {
    const start = await captureWorkspaceState(repo);
    writeFileSync(join(repo, 'late.txt'), 'x\n');
    const end = await captureWorkspaceState(repo);
    expect(await compareWorkspaceStates(repo, { ...start, entriesTruncated: true }, end)).toMatchObject({ state: 'changed', truncated: true });
    expect(await compareWorkspaceStates(repo, { ...start, entriesTruncated: true }, { ...start, entriesTruncated: true })).toEqual({ state: 'unchanged' });
  });

  it('keeps the first start state: a later launch or Continue does not overwrite it', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    const first = readFileSync(stateFile('start'), 'utf8');
    writeFileSync(join(repo, 'during-first-session.txt'), 'x\n');
    await recordWorkspaceStart(dataDir, workerId, repo);
    expect(readFileSync(stateFile('start'), 'utf8')).toBe(first);
    await recordWorkspaceEnd(dataDir, workerId, repo);
    expect(await report()).toMatchObject({ state: 'changed', paths: ['during-first-session.txt'] });
  });

  it('compares a running worker with the directory as it is, and never a settled one', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    await recordWorkspaceEnd(dataDir, workerId, repo);
    writeFileSync(join(repo, 'after-settle.txt'), 'x\n');
    expect(await report(true)).toEqual({ state: 'unchanged' });
    await clearWorkspaceEnd(dataDir, workerId);
    expect(await report(false)).toMatchObject({ state: 'changed', paths: ['after-settle.txt'] });
    expect(await report(true)).toEqual({ state: 'unavailable', reason: 'no workspace state was recorded when the worker settled' });
  });

  it('leaves a settled worker without a report when the end state could not be read', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    await recordWorkspaceEnd(dataDir, workerId, repo);
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    await expect(recordWorkspaceEnd(dataDir, workerId, repo)).rejects.toThrow('failed in the shared workspace');
    expect(existsSync(stateFile('end'))).toBe(false);
    expect(await report(true)).toMatchObject({ state: 'unavailable', reason: 'no workspace state was recorded when the worker settled' });
  });

  it('is unavailable with the reason when the directory is gone', async () => {
    await recordWorkspaceStart(dataDir, workerId, repo);
    rmSync(repo, { recursive: true, force: true });
    expect(await report(false)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('failed in the shared workspace') });
  });
});
