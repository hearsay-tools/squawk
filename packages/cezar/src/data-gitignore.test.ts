import { projectPaths } from './project-paths.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    ensureDataGitignore(repo);
    expect(read()).toBe(first);
    expect(read().split('\n').filter((line) => line === 'preview/')).toHaveLength(1);
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
    for (const tree of ['cezar', 'squawk']) {
      for (const file of ['workflows/authored.yaml', 'skills/authored.md', 'context.yaml']) {
        const path = join(linked, '.ai', tree, file);
        mkdirSync((await import('node:path')).dirname(path), { recursive: true });
        writeFileSync(path, 'authored');
        expect(spawnSync('git', ['-C', linked, 'check-ignore', '--no-index', path], { encoding: 'utf8' }).status).toBe(1);
      }
    }
    writeFileSync(join(linked, '.ai/squawk/runs.db'), 'runtime');
    expect(execFileSync('git', ['-C', linked, 'check-ignore', '.ai/squawk/runs.db'], { encoding: 'utf8' }).trim()).toBe('.ai/squawk/runs.db');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
