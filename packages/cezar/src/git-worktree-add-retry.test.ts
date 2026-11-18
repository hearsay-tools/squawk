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
 * `main` before failing, `pass` runs the real command).
 */
async function slowGit(script: Array<'slow' | 'fail' | 'pass' | 'symref'>) {
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
  # The real command first: a slow or failing add has already made its branch and registration.
  ${JSON.stringify(real)} "$@" || exit $?
  [ "$action" = slow ] && exec sleep 30
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

const branchExists = (repo: string) => exec('git', ['show-ref', '--verify', '--quiet', 'refs/heads/cez/66666666'], { cwd: repo }).then(() => true, () => false);

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
