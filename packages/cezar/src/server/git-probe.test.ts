import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Each git call as `exec(bin, args, options)`: it resolves to git's output or rejects with its error. */
const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => {
  type Callback = (error: Error | null, stdout: string, stderr: string) => void;
  const execFile = vi.fn((bin: string, args: string[], options: unknown, callback: Callback) => {
    (exec(bin, args, options) as Promise<{ stdout: string }>).then(({ stdout }) => callback(null, stdout, ''), (error: Error) => callback(error, '', ''));
  });
  return { execFile };
});
const { getRepoInfo } = await import('./git.ts');

describe('Git probe commands', () => {
  beforeEach(() => exec.mockReset());

  it('combines root and branch and retains remote get-url', async () => {
    exec.mockResolvedValueOnce({ stdout: '/repo\nmain\n' }).mockResolvedValueOnce({ stdout: 'https://github.com/acme/demo.git\n' });
    expect(await getRepoInfo('/repo')).toEqual({ root: '/repo', branch: 'main', remote: 'https://github.com/acme/demo.git' });
    expect(exec.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['git', ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD']],
      ['git', ['remote', 'get-url', 'origin']],
    ]);
  });

  it('keeps both fallback commands when origin is absent', async () => {
    exec.mockResolvedValueOnce({ stdout: '/repo\nmain\n' }).mockRejectedValueOnce(new Error('no origin'))
      .mockResolvedValueOnce({ stdout: 'upstream\n' }).mockResolvedValueOnce({ stdout: 'remote\n' });
    expect((await getRepoInfo('/repo'))?.remote).toBe('remote');
    expect(exec.mock.calls.map((call) => call[1])).toEqual([
      ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], ['remote', 'get-url', 'origin'],
      ['remote'], ['remote', 'get-url', 'upstream'],
    ]);
  });

  it('stops after the first failed spawn when Git is missing', async () => {
    exec.mockRejectedValueOnce(Object.assign(new Error('missing git'), { code: 'ENOENT' }));
    expect(await getRepoInfo('/repo')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('Git probe cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-git-probe-cache-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => exec.mockReset());

  /** One answer: the config listing, then rev-parse, then the remote lookups as given. */
  const answer = (...remote: Array<{ stdout: string } | Error>) => {
    exec.mockResolvedValueOnce({ stdout: '' }).mockResolvedValueOnce({ stdout: `${root}\nmain\n` });
    for (const step of remote) {
      if (step instanceof Error) exec.mockRejectedValueOnce(step);
      else exec.mockResolvedValueOnce(step);
    }
  };

  it('asks Git again when remote discovery failed, and keeps the answer once it finishes', async () => {
    answer(new Error('no origin'), new Error('spawn EAGAIN'));
    expect((await getRepoInfo(root))?.remote).toBeUndefined();
    answer({ stdout: 'https://github.com/acme/demo.git\n' });
    expect((await getRepoInfo(root))?.remote).toBe('https://github.com/acme/demo.git');
    const calls = exec.mock.calls.length;
    expect((await getRepoInfo(root))?.remote).toBe('https://github.com/acme/demo.git');
    expect(exec.mock.calls.length).toBe(calls);
  });

  it('keeps the answer for a repository whose remote list is empty', async () => {
    const other = mkdtempSync(join(tmpdir(), 'cez-git-probe-none-'));
    try {
      mkdirSync(join(other, '.git'));
      writeFileSync(join(other, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      exec.mockResolvedValueOnce({ stdout: '' }).mockResolvedValueOnce({ stdout: `${other}\nmain\n` })
        .mockRejectedValueOnce(new Error('no origin')).mockResolvedValueOnce({ stdout: '' });
      expect((await getRepoInfo(other))?.remote).toBeUndefined();
      const calls = exec.mock.calls.length;
      expect(await getRepoInfo(other)).toMatchObject({ branch: 'main' });
      expect(exec.mock.calls.length).toBe(calls);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});
