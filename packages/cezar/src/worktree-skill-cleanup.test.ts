import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { removeProvisionedSkills } from './worktree-skill-cleanup.ts';
import { seedOldSkills } from './worktree-skill-cleanup.testkit.ts';

let worktree: string;
beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'cez-skill-cleanup-'));
  execFileSync('git', ['init', '-q', worktree]);
});
afterEach(() => rmSync(worktree, { recursive: true, force: true }));

it('removes recorded unchanged copies and owned ignore files, then records', async () => {
  const { paths, manifest } = await seedOldSkills(worktree);
  await removeProvisionedSkills(worktree);
  for (const path of paths) {
    expect(existsSync(join(worktree, path))).toBe(false);
    expect(existsSync(join(worktree, dirname(path), '.gitignore'))).toBe(false);
  }
  expect(existsSync(manifest)).toBe(false);
  await removeProvisionedSkills(worktree);
  expect(existsSync(manifest)).toBe(false);
});

it('keeps user-changed entries and ignore files, and other writers records', async () => {
  const { paths, manifest } = await seedOldSkills(worktree);
  writeFileSync(join(worktree, paths[0]!, 'SKILL.md'), 'user edit\n');
  const ignore = join(worktree, dirname(paths[0]!), '.gitignore');
  writeFileSync(ignore, '# user edit\n');
  const saved = JSON.parse(readFileSync(manifest, 'utf8'));
  const seed = { writer: 'seed', path: 'seed-config.txt', kind: 'file', identity: 'tree2:unrelated' };
  saved.entries.push(seed);
  writeFileSync(manifest, JSON.stringify(saved));
  await removeProvisionedSkills(worktree);
  expect(readFileSync(join(worktree, paths[0]!, 'SKILL.md'), 'utf8')).toBe('user edit\n');
  expect(readFileSync(ignore, 'utf8')).toBe('# user edit\n');
  expect(JSON.parse(readFileSync(manifest, 'utf8')).entries).toEqual([seed]);
});

it('leaves durable records after a crash between removals and repeats safely', async () => {
  const { paths, manifest } = await seedOldSkills(worktree);
  const saved = readFileSync(manifest, 'utf8');
  await removeProvisionedSkills(worktree, { faults: boundary => { if (boundary === 'removed') throw new Error('crash'); } });
  expect(existsSync(join(worktree, paths[0]!))).toBe(false);
  expect(existsSync(join(worktree, paths[1]!))).toBe(true);
  expect(readFileSync(manifest, 'utf8')).toBe(saved);
  await removeProvisionedSkills(worktree);
  expect(paths.some(path => existsSync(join(worktree, path)))).toBe(false);
  expect(existsSync(manifest)).toBe(false);
});

it('keeps unverifiable legacy team copies excluded after their ignore file is removed', async () => {
  const { paths, manifest } = await seedOldSkills(worktree);
  const saved = JSON.parse(readFileSync(manifest, 'utf8'));
  const legacy = join(worktree, '.git/cezar-skills.json');
  writeFileSync(legacy, JSON.stringify({ version: 1, roots: saved.skills.roots,
    entries: saved.entries.map(({ writer: _writer, ...entry }: { writer: string; path: string; kind: string; identity: string }) =>
      entry.path === paths[0] ? { ...entry, kind: 'team-copy', identity: 'marker:{}' } : entry),
  }));
  rmSync(manifest);
  await removeProvisionedSkills(worktree);
  expect(readFileSync(join(worktree, paths[0]!, 'SKILL.md'), 'utf8')).toBe('old installed copy\n');
  expect(readFileSync(join(worktree, '.git/info/exclude'), 'utf8')).toContain(`${paths[0]}/\n`);
  expect(existsSync(join(worktree, paths[1]!))).toBe(false);
  expect(existsSync(join(worktree, '.agents/skills/.gitignore'))).toBe(false);
  expect(existsSync(manifest)).toBe(false);
  expect(existsSync(legacy)).toBe(false);
});

it('leaves a worktree with no records untouched', async () => {
  const path = join(worktree, '.agents/skills/mine');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), 'mine\n');
  const ignore = join(dirname(path), '.gitignore');
  writeFileSync(ignore, '# mine\n');
  await removeProvisionedSkills(worktree);
  expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toBe('mine\n');
  expect(readFileSync(ignore, 'utf8')).toBe('# mine\n');
  expect(existsSync(join(worktree, '.git/cezar-manifest.json'))).toBe(false);
});

it('does not follow a redirected agent directory outside the worktree', async () => {
  const { manifest } = await seedOldSkills(worktree);
  const moved = `${worktree}-outside`;
  try {
    renameSync(join(worktree, '.agents'), moved);
    symlinkSync(moved, join(worktree, '.agents'));
    await removeProvisionedSkills(worktree);
    expect(readFileSync(join(moved, 'skills/old-copy/SKILL.md'), 'utf8')).toBe('old installed copy\n');
    expect(existsSync(join(moved, 'skills/.gitignore'))).toBe(true);
    expect(existsSync(manifest)).toBe(false);
  } finally { rmSync(moved, { recursive: true, force: true }); }
});
