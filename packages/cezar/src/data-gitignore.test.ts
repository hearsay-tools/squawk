import { projectPaths } from './project-paths.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDataGitignore } from './data-gitignore.ts';

describe('ensureDataGitignore', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-gitignore-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('writes each rule once and keeps a retired line a project already has', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const dir = projectPaths(repo).write;
    mkdirSync(dir, { recursive: true });
    // Voice mode wrote `voice/` here; its removal leaves the line and the directory alone.
    writeFileSync(join(dir, '.gitignore'), 'voice/\n', 'utf8');
    ensureDataGitignore(repo);
    const read = () => readFileSync(join(dir, '.gitignore'), 'utf8');
    const first = read();
    expect(first.split('\n')).toContain('voice/');
    expect(first.split('\n')).toContain('preview/');
    expect(first.split('\n')).toContain('context.local.yaml');
    ensureDataGitignore(repo);
    expect(read()).toBe(first);
    expect(read().split('\n').filter((line) => line === 'preview/')).toHaveLength(1);
    expect(read().split('\n').filter((line) => line === 'context.local.yaml')).toHaveLength(1);
  });

  it('gives a new project no voice rule', () => {
    ensureDataGitignore(repo);
    expect(readFileSync(join(projectPaths(repo).write, '.gitignore'), 'utf8').split('\n')).not.toContain('voice/');
  });
});

it('uses the common Git exclude in linked worktrees and leaves authored inputs committable', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'cez-linked-ignore-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    const linked = join(root, 'linked');
    git('worktree', 'add', '-b', 'linked', linked);
    mkdirSync(join(linked, '.ai/cezar'), { recursive: true });
    ensureDataGitignore(linked);
    expect(existsSync(join(linked, '.ai/squawk'))).toBe(false);
    const exclude = readFileSync(join(root, '.git/info/exclude'), 'utf8');
    expect(exclude).toContain('/.ai/squawk/runs.db-shm');
    expect(exclude).toContain('/.ai/cezar/context.local.yaml');
    expect(exclude).toContain('/.ai/squawk/context.local.yaml');
    for (const tree of ['cezar', 'squawk']) {
      for (const file of ['workflows/authored.yaml', 'skills/authored.md', 'context.yaml']) {
        const path = join(linked, '.ai', tree, file);
        mkdirSync((await import('node:path')).dirname(path), { recursive: true });
        writeFileSync(path, 'authored');
        expect(spawnSync('git', ['-C', linked, 'check-ignore', '--no-index', path], { encoding: 'utf8' }).status).toBe(1);
      }
      const localContext = join(linked, '.ai', tree, 'context.local.yaml');
      writeFileSync(localContext, 'version: 1\n');
      expect(execFileSync('git', ['-C', linked, 'check-ignore', `.ai/${tree}/context.local.yaml`], { encoding: 'utf8' }).trim()).toBe(`.ai/${tree}/context.local.yaml`);
    }
    writeFileSync(join(linked, '.ai/squawk/runs.db'), 'runtime');
    expect(execFileSync('git', ['-C', linked, 'check-ignore', '.ai/squawk/runs.db'], { encoding: 'utf8' }).trim()).toBe('.ai/squawk/runs.db');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('writes the shared exclude of its own repository when the process inherited GIT_DIR (hearsay-tools/squawk#3207)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { gitEnv } = await import('./git-command.ts');
  const root = mkdtempSync(join(tmpdir(), 'cez-inherited-git-dir-'));
  const repo = join(root, 'repo');
  const other = join(root, 'other');
  const exclude = (dir: string) => {
    const path = join(dir, '.git/info/exclude');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  try {
    for (const dir of [repo, other]) execFileSync('git', ['init', '-q', dir], { env: gitEnv() });
    vi.stubEnv('GIT_DIR', join(other, '.git'));
    ensureDataGitignore(repo);
    vi.unstubAllEnvs();
    expect(exclude(repo)).toContain('/.ai/squawk/runs.db-shm');
    expect(exclude(other)).not.toContain('/.ai/squawk/');
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
