import { ChildProcess, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHeadCommit, getRepoInfo } from './git.ts';

/**
 * getRepoInfo remote discovery: the forge seam (and so the GitHub tab) hangs
 * off `repo.remote`, so it must be found for HTTPS and SSH URLs alike, and for
 * repos whose only remote is NOT named `origin` (a plain `git remote get-url
 * origin` fails there). Genuinely remote-less repos still report no remote.
 */

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

describe('getRepoInfo — remote discovery', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-git-'));
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an HTTPS origin remote', async () => {
    g(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('https://github.com/acme/demo.git');
  });

  it('reads an SSH (scp-like) origin remote', async () => {
    g(dir, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('git@github.com:acme/demo.git');
  });

  it('uses a test-only global config, no system config, and a fixed commit identity', () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBeTruthy();
    // Only what vitest.setup.ts writes: automatic maintenance off, nothing from the host.
    expect(g(dir, 'config', '--global', '--list').trim().split('\n')).toEqual(['gc.auto=0', 'maintenance.auto=false']);
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(g(dir, 'var', 'GIT_AUTHOR_IDENT')).toMatch(/^Cezar Tests <tests@cezar.invalid> /);
    expect(g(dir, 'var', 'GIT_COMMITTER_IDENT')).toMatch(/^Cezar Tests <tests@cezar.invalid> /);
  });

  // hearsay-tools/cezarion#1279: Git 2.54+ maintenance repacks in the background and deletes
  // loose objects while a test still clones or removes the repository.
  it('starts no automatic maintenance after a fixture commit', () => {
    const commit = spawnSync('git', ['commit', '--allow-empty', '-qm', 'traced'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TRACE: '1' },
    });
    expect(commit.status, commit.stderr).toBe(0);
    expect(commit.stderr).not.toMatch(/\b(?:maintenance run|gc) --auto\b/);
  });

  it('falls back to the first configured remote when none is named origin', async () => {
    g(dir, 'remote', 'add', 'github', 'git@github.com:acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('git@github.com:acme/demo.git');
  });

  it('prefers origin when several remotes exist', async () => {
    g(dir, 'remote', 'add', 'upstream', 'https://github.com/upstream/demo.git');
    g(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('https://github.com/acme/demo.git');
  });

  it('reports no remote for a genuinely remote-less repo', async () => {
    const info = await getRepoInfo(dir);
    expect(info).not.toBeNull();
    expect(info?.remote).toBeUndefined();
  });

  it('keeps detached HEAD and insteadOf remote expansion', async () => {
    g(dir, 'checkout', '--detach', '-q');
    g(dir, 'config', 'url.https://github.com/.insteadOf', 'fixture:');
    g(dir, 'remote', 'add', 'origin', 'fixture:acme/demo.git');
    expect(await getRepoInfo(dir)).toEqual({ root: g(dir, 'rev-parse', '--show-toplevel').trim(), branch: 'HEAD', remote: 'https://github.com/acme/demo.git' });
  });

  it('returns null for a missing directory or an unborn HEAD', async () => {
    expect(await getRepoInfo(join(dir, 'missing'))).toBeNull();
    const unborn = join(dir, 'unborn');
    g(dir, 'init', '-q', unborn);
    expect(await getRepoInfo(unborn)).toBeNull();
  });

  it('pins the current commit as a full SHA', async () => {
    expect(await getHeadCommit(dir)).toBe(g(dir, 'rev-parse', 'HEAD').trim());
  });

  it('returns null outside a git repository', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'cez-nogit-'));
    try {
      expect(await getRepoInfo(bare)).toBeNull();
      expect(await getHeadCommit(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * hearsay-tools/squawk#3651, hearsay-tools/squawk#3658: each `git` start forks the large server
 * process, and the project list and `/health` ask for the same repositories every 5 s. A repeat
 * call with no branch or remote change starts no process; a change shows on the next call.
 */
describe('getRepoInfo — change-keyed cache', () => {
  let dir: string;
  const spawned = () => vi.spyOn(ChildProcess.prototype as unknown as { spawn(options: unknown): void }, 'spawn');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-git-cache-'));
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'commit', '--allow-empty', '-q', '-m', 'init');
    g(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts no git process for a repeat call', async () => {
    const first = await getRepoInfo(dir);
    const spawn = spawned();
    expect(await getRepoInfo(dir)).toEqual(first);
    expect(await getRepoInfo(dir)).toEqual(first);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('gives each caller its own copy', async () => {
    const first = await getRepoInfo(dir);
    first!.branch = 'edited';
    expect((await getRepoInfo(dir))?.branch).toBe('main');
  });

  it('shows a branch switch and a remote change on the next call', async () => {
    await getRepoInfo(dir);
    g(dir, 'checkout', '-q', '-b', 'feature');
    expect((await getRepoInfo(dir))?.branch).toBe('feature');
    g(dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/moved.git');
    expect((await getRepoInfo(dir))?.remote).toBe('https://github.com/acme/moved.git');
    g(dir, 'checkout', '-q', '--detach');
    expect((await getRepoInfo(dir))?.branch).toBe('HEAD');
  });

  it('follows a linked worktree to its own HEAD and to the shared config', async () => {
    const linked = join(dir, 'linked');
    g(dir, 'worktree', 'add', '-q', '-b', 'side', linked);
    expect((await getRepoInfo(linked))?.branch).toBe('side');
    const spawn = spawned();
    expect((await getRepoInfo(linked))?.branch).toBe('side');
    expect(spawn).not.toHaveBeenCalled();
    spawn.mockRestore();
    g(linked, 'checkout', '-q', '-b', 'side-2');
    expect((await getRepoInfo(linked))?.branch).toBe('side-2');
    g(dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/shared.git');
    expect((await getRepoInfo(linked))?.remote).toBe('https://github.com/acme/shared.git');
    expect((await getRepoInfo(dir))?.branch).toBe('main');
  });

  it('shows a remote rewritten in an included config file', async () => {
    const included = join(dir, 'remote.inc');
    writeFileSync(included, '[url "https://github.com/"]\n\tinsteadOf = fixture:\n');
    g(dir, 'config', 'include.path', '../remote.inc');
    g(dir, 'remote', 'set-url', 'origin', 'fixture:acme/demo.git');
    expect((await getRepoInfo(dir))?.remote).toBe('https://github.com/acme/demo.git');
    writeFileSync(included, '[url "https://example.com/"]\n\tinsteadOf = fixture:\n');
    expect((await getRepoInfo(dir))?.remote).toBe('https://example.com/acme/demo.git');
  });

  it('follows a quoted include path with a space, relative to the config file inside .git', async () => {
    const included = join(dir, '.git', 'my remote.inc');
    writeFileSync(included, '[url "https://github.com/"]\n\tinsteadOf = fixture:\n');
    writeFileSync(join(dir, '.git', 'config'), '[include]\n\tpath = "my remote.inc" ; quoted, with a comment\n', { flag: 'a' });
    g(dir, 'remote', 'set-url', 'origin', 'fixture:acme/demo.git');
    expect((await getRepoInfo(dir))?.remote).toBe('https://github.com/acme/demo.git');
    writeFileSync(included, '[url "https://example.com/"]\n\tinsteadOf = fixture:\n');
    expect((await getRepoInfo(dir))?.remote).toBe('https://example.com/acme/demo.git');
  });

  it('follows an include path written across a continuation line', async () => {
    const included = join(dir, '.git', 'remote.inc');
    writeFileSync(included, '[url "https://github.com/"]\n\tinsteadOf = fixture:\n');
    writeFileSync(join(dir, '.git', 'config'), '[include]\n\tpath = remote.\\\ninc\n', { flag: 'a' });
    g(dir, 'remote', 'set-url', 'origin', 'fixture:acme/demo.git');
    expect((await getRepoInfo(dir))?.remote).toBe('https://github.com/acme/demo.git');
    writeFileSync(included, '[url "https://example.com/"]\n\tinsteadOf = fixture:\n');
    expect((await getRepoInfo(dir))?.remote).toBe('https://example.com/acme/demo.git');
  });

  it('follows a file included through config in the environment', async () => {
    const included = join(dir, 'env.inc');
    writeFileSync(included, '[url "https://github.com/"]\n\tinsteadOf = fixture:\n');
    g(dir, 'remote', 'set-url', 'origin', 'fixture:acme/demo.git');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'include.path');
    vi.stubEnv('GIT_CONFIG_VALUE_0', included);
    try {
      expect((await getRepoInfo(dir))?.remote).toBe('https://github.com/acme/demo.git');
      writeFileSync(included, '[url "https://example.com/"]\n\tinsteadOf = fixture:\n');
      expect((await getRepoInfo(dir))?.remote).toBe('https://example.com/acme/demo.git');
    } finally { vi.unstubAllEnvs(); }
  });

  it('shows a remote rewritten through config in the environment', async () => {
    g(dir, 'remote', 'set-url', 'origin', 'fixture:acme/demo.git');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'url.https://github.com/.insteadOf');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'fixture:');
    try {
      expect((await getRepoInfo(dir))?.remote).toBe('https://github.com/acme/demo.git');
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'no-match:');
      expect((await getRepoInfo(dir))?.remote).toBe('fixture:acme/demo.git');
    } finally { vi.unstubAllEnvs(); }
  });

  it('asks Git each time when HEAD names a branch that is itself a symbolic ref', async () => {
    g(dir, 'branch', 'other');
    g(dir, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
    g(dir, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
    expect((await getRepoInfo(dir))?.branch).toBe('main');
    g(dir, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/other');
    expect((await getRepoInfo(dir))?.branch).toBe('other');
  });

  // A root user reads every file, so the unreadable path below needs an ordinary user.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('answers without keeping it when a watched config file cannot be read', async () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    vi.stubEnv('GIT_CONFIG_SYSTEM', join(locked, 'gitconfig'));
    chmodSync(locked, 0o000);
    try {
      expect((await getRepoInfo(dir))?.branch).toBe('main');
      const spawn = spawned();
      expect((await getRepoInfo(dir))?.branch).toBe('main');
      expect(spawn).toHaveBeenCalled();
      chmodSync(locked, 0o755);
      expect((await getRepoInfo(dir))?.branch).toBe('main');
      spawn.mockClear();
      expect((await getRepoInfo(dir))?.branch).toBe('main');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      chmodSync(locked, 0o755);
      vi.unstubAllEnvs();
    }
  });

  it('keeps null for a directory outside any repository until a repository appears', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-git-cache-plain-'));
    try {
      expect(await getRepoInfo(plain)).toBeNull();
      const spawn = spawned();
      expect(await getRepoInfo(plain)).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
      spawn.mockRestore();
      g(plain, 'init', '-q', '-b', 'trunk');
      g(plain, 'commit', '--allow-empty', '-q', '-m', 'init');
      expect((await getRepoInfo(plain))?.branch).toBe('trunk');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('asks Git again for an unborn HEAD, whose files do not change at the first commit', async () => {
    const unborn = join(dir, 'unborn');
    g(dir, 'init', '-q', '-b', 'main', unborn);
    expect(await getRepoInfo(unborn)).toBeNull();
    g(unborn, 'commit', '--allow-empty', '-q', '-m', 'first');
    expect((await getRepoInfo(unborn))?.branch).toBe('main');
  });
});
