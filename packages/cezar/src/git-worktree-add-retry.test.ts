import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorktree, worktreePathFor } from './git-worktree.ts';
import { withWorktreeMutation } from './git-worktree-lock.ts';

const exec = promisify(execFile);
const roots: string[] = [];
const WORKER = '66666666-6666-4666-8666-666666666666';
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

/**
 * A repository, and a `git` on PATH that runs the real one except for `worktree add`: there it
 * records its arguments, then acts as `script` says for that attempt (`slow` sleeps past any test
 * bound, `fail` prints a reason and exits 1, `symref` also turns the new branch into a symbolic ref to
 * `main` before failing, `litter` writes a file into the reserved path and fails before Git runs,
 * `stuck` leaves a child that ignores SIGTERM and then sleeps past the bound, `pass` runs the real command).
 */
async function slowGit(script: Array<'slow' | 'fail' | 'pass' | 'symref' | 'litter' | 'stuck'>) {
  const root = await mkdtemp(join(tmpdir(), 'cezar-worktree-add-'));
  roots.push(root);
  await exec('git', ['init', '-q', '-b', 'main', join(root, 'repo')]);
  await exec('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: join(root, 'repo') });
  const real = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  const bin = join(root, 'bin');
  await exec('mkdir', [bin]);
  const log = join(root, 'adds');
  await writeFile(join(bin, 'git'), `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = add ]; then
  echo "$*" >> ${JSON.stringify(log)}
  n=$(wc -l < ${JSON.stringify(log)})
  case "$n" in ${script.map((action, index) => `${index + 1}) action=${action};;`).join(' ')} *) action=pass;; esac
  [ "$action" = litter ] && { echo kept > "$7/kept"; echo "fatal: example failure" >&2; exit 1; }
  # The real command first: a slow or failing add has already made its branch and registration.
  ${JSON.stringify(real)} "$@" || exit $?
  [ "$action" = slow ] && exec sleep 30
  if [ "$action" = stuck ]; then (trap '' TERM; sleep 60) & exec sleep 30; fi
  [ "$action" = fail ] && { echo "fatal: example failure" >&2; exit 1; }
  if [ "$action" = symref ]; then
    ${JSON.stringify(real)} worktree remove --force "$7" && ${JSON.stringify(real)} symbolic-ref refs/heads/cez/66666666 refs/heads/main
    echo "fatal: example failure" >&2; exit 1
  fi
  exit 0
fi
exec ${JSON.stringify(real)} "$@"
`);
  await chmod(join(bin, 'git'), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  return { repo: join(root, 'repo'), adds: async () => (await readFile(log, 'utf8')).trim().split('\n') };
}

/** Whether the worker branch exists; a git that fails rejects, so it never reads as absent. */
const branchExists = async (repo: string) => (await exec('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/cez/66666666'], { cwd: repo })).stdout
  .split('\n').includes('refs/heads/cez/66666666');

it('retries a worker worktree add that timed out once, after removing what it made (hearsay-tools/squawk#3817)', async () => {
  const { repo, adds } = await slowGit(['slow', 'pass']);
  const info = await createWorktree(repo, WORKER, 'main', { freshOnly: true, addTimeoutMs: 3_000 });
  expect(info.branch).toBe('cez/66666666');
  const attempts = await adds();
  expect(attempts).toHaveLength(2);
  for (const attempt of attempts) expect(attempt).toContain('--quiet');
  expect(existsSync(join(info.path, '.git'))).toBe(true);
});

it('reports a second timeout with its bound and leaves no worktree, registration or branch', async () => {
  const { repo } = await slowGit(['slow', 'slow']);
  await expect(createWorktree(repo, WORKER, 'main', { freshOnly: true, addTimeoutMs: 3_000 }))
    .rejects.toThrow(/^git worktree add failed: timed out after 3 s/);
  expect(existsSync(worktreePathFor(repo, WORKER))).toBe(false);
  expect((await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repo })).stdout).not.toContain(WORKER);
  expect(await branchExists(repo)).toBe(false);
});

it("carries git's stderr when worktree add fails", async () => {
  const { repo } = await slowGit(['fail', 'fail']);
  await expect(createWorktree(repo, WORKER, 'main', { freshOnly: true })).rejects.toThrow('git worktree add failed: fatal: example failure');
  expect(existsSync(worktreePathFor(repo, WORKER))).toBe(false);
  expect(await branchExists(repo)).toBe(false);
});

it('waits in the lock queue while another task holds the lock, with a claim that names the worker', async () => {
  const { repo } = await slowGit([]);
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = withWorktreeMutation(repo, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); },
    { label: { operation: 'task-worktree-create', owner: 'holder-task' } });
  await ready;
  const claims = join(repo, '.git/cezar-worktree-mutations');
  const created = createWorktree(repo, WORKER, 'main', { freshOnly: true });
  try {
    // The product's own signal that the spawn is queued: its keeper's claim beside the holder's.
    await vi.waitFor(async () => {
      const labels = await Promise.all((await readdir(claims)).filter(entry => entry.endsWith('.json'))
        .map(async entry => (JSON.parse(await readFile(join(claims, entry), 'utf8')) as { operation?: string; owner?: string })));
      expect(labels).toContainEqual(expect.objectContaining({ operation: 'worker-spawn', owner: WORKER }));
    }, { timeout: 15_000 });
  } finally { release(); await held; }
  expect((await created).branch).toBe('cez/66666666');
});

it('leaves a branch that became a symbolic ref, and the branch it names, in place', async () => {
  const { repo } = await slowGit(['symref']);
  await expect(createWorktree(repo, WORKER, 'main', { freshOnly: true })).rejects.toThrow('git worktree add failed: fatal: example failure');
  expect((await exec('git', ['symbolic-ref', 'refs/heads/cez/66666666'], { cwd: repo })).stdout.trim()).toBe('refs/heads/main');
  await expect(exec('git', ['rev-parse', '--verify', 'refs/heads/main'], { cwd: repo })).resolves.toBeDefined();
});

it('keeps an unregistered path that something else wrote into, and does not retry', async () => {
  const { repo, adds } = await slowGit(['litter', 'pass']);
  await expect(createWorktree(repo, WORKER, 'main', { freshOnly: true })).rejects.toThrow(/fatal: example failure; rollback stopped: .* is not empty/);
  expect(await readFile(join(worktreePathFor(repo, WORKER), 'kept'), 'utf8')).toBe('kept\n');
  expect(await adds()).toHaveLength(1);
});

it.runIf(process.platform === 'linux')('neither rolls back nor releases the lock while a timed-out add leaves Git children running', { timeout: 60_000 }, async () => {
  const { repo, adds } = await slowGit(['stuck', 'pass']);
  const claims = join(repo, '.git/cezar-worktree-mutations');
  try {
    await expect(createWorktree(repo, WORKER, 'main', { freshOnly: true, addTimeoutMs: 3_000 }))
      .rejects.toThrow(/timed out after 3 s.*rollback skipped: its Git child processes may still be running/s);
    expect(await adds()).toHaveLength(1);
    // The checkout it left stays for a destroy to report, and the claim stays until its group is gone.
    expect(existsSync(worktreePathFor(repo, WORKER))).toBe(true);
    expect((await readdir(claims)).filter(entry => entry.endsWith('.json'))).toHaveLength(1);
  } finally {
    for (const entry of await readdir(claims).catch(() => [] as string[])) {
      const pid = Number(entry.split('-')[0]);
      if (pid > 0) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
});
