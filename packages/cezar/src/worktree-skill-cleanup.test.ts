import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanupTaskWorktreeSkills, removeProvisionedSkills } from './worktree-skill-cleanup.ts';
import { seedOldSkills } from './worktree-skill-cleanup.testkit.ts';

let worktree: string;
beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'cez-skill-cleanup-'));
  execFileSync('git', ['init', '-q', worktree]);
});
afterEach(() => rmSync(worktree, { recursive: true, force: true }));

it.each(['main', 'symlink', 'trailing slash', 'parent segment'])('does not clean the main checkout through %s', async kind => {
  const { paths, manifest } = await seedOldSkills(worktree);
  mkdirSync(join(worktree, 'child'));
  const alias = join(worktree, 'alias');
  symlinkSync(worktree, alias);
  const cwd = kind === 'symlink' ? alias : kind === 'trailing slash' ? `${worktree}/` : kind === 'parent segment' ? `${worktree}/child/..` : worktree;
  await cleanupTaskWorktreeSkills(cwd, cwd, worktree, vi.fn());
  expect(paths.every(path => existsSync(join(worktree, path)))).toBe(true);
  expect(existsSync(manifest)).toBe(true);
});

it('cleans the recorded task worktree after comparing realpaths', async () => {
  const { paths, manifest } = await seedOldSkills(worktree);
  const repo = join(worktree, 'main');
  mkdirSync(repo);
  const alias = join(worktree, 'alias');
  symlinkSync(worktree, alias);
  await cleanupTaskWorktreeSkills(alias, worktree, repo, vi.fn());
  expect(paths.some(path => existsSync(join(worktree, path)))).toBe(false);
  expect(existsSync(manifest)).toBe(false);
});

it.each(['different', 'unresolved', 'unrecorded'])('does not clean a task with a %s worktree record', async kind => {
  const { paths, manifest } = await seedOldSkills(worktree);
  const repo = join(worktree, 'main');
  mkdirSync(repo);
  const recorded = kind === 'unrecorded' ? undefined : kind === 'unresolved' ? join(worktree, 'missing') : repo;
  await cleanupTaskWorktreeSkills(worktree, recorded, repo, vi.fn());
  expect(paths.every(path => existsSync(join(worktree, path)))).toBe(true);
  expect(existsSync(manifest)).toBe(true);
});

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
  expect(execFileSync('git', ['check-ignore', `${paths[0]}/SKILL.md`], { cwd: worktree, encoding: 'utf8' }).trim())
    .toBe(`${paths[0]}/SKILL.md`);
  expect(JSON.parse(readFileSync(manifest, 'utf8')).entries).toEqual([seed]);
});

it.each(['file', 'symlink', 'directory'])('keeps a changed %s ignored after removing its ignore file', async kind => {
  const { paths, manifest } = await seedOldSkills(worktree);
  const path = paths[0]!;
  if (kind === 'directory') writeFileSync(join(worktree, path, 'SKILL.md'), 'changed directory\n');
  else {
    rmSync(join(worktree, path), { recursive: true });
    if (kind === 'file') writeFileSync(join(worktree, path), 'changed file\n');
    else {
      const target = join(worktree, 'changed-target.md');
      writeFileSync(target, 'changed link target\n');
      symlinkSync(target, join(worktree, path));
      const saved = JSON.parse(readFileSync(manifest, 'utf8'));
      Object.assign(saved.entries.find((entry: { path: string }) => entry.path === path), { kind: 'link', identity: 'link:/old-target' });
      writeFileSync(manifest, JSON.stringify(saved));
    }
  }
  await removeProvisionedSkills(worktree);
  expect(existsSync(join(worktree, path))).toBe(true);
  expect(existsSync(join(worktree, dirname(path), '.gitignore'))).toBe(false);
  expect(execFileSync('git', ['check-ignore', path], { cwd: worktree, encoding: 'utf8' }).trim()).toBe(path);
  expect(existsSync(manifest)).toBe(false);
});

it.each([
  ['plain', 'plain-sibling'],
  ['star*', 'star-match'],
  ['question?', 'questionx'],
  ['[a]', 'a'],
  ['trailing  ', 'trailing'],
  ['#leading', 'leading'],
  ['!leading', 'leading'],
  ['internal space', 'internalspace'],
])('excludes only the literal kept path %j and not sibling %j', async (name, sibling) => {
  const { paths, manifest } = await seedOldSkills(worktree);
  const parent = dirname(paths[0]!);
  const path = `${parent}/${name}`;
  const siblingPath = `${parent}/${sibling}`;
  renameSync(join(worktree, paths[0]!), join(worktree, path));
  writeFileSync(join(worktree, path, 'SKILL.md'), 'user edit\n');
  mkdirSync(join(worktree, siblingPath));
  writeFileSync(join(worktree, siblingPath, 'SKILL.md'), 'user sibling\n');
  const saved = JSON.parse(readFileSync(manifest, 'utf8'));
  saved.entries.find((entry: { path: string }) => entry.path === paths[0]).path = path;
  writeFileSync(manifest, JSON.stringify(saved));
  await removeProvisionedSkills(worktree);
  expect(existsSync(join(worktree, parent, '.gitignore'))).toBe(false);
  expect(existsSync(manifest)).toBe(false);
  expect(execFileSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd: worktree, encoding: 'utf8', input: `${path}\0${siblingPath}\0`,
  })).toBe(`${path}\0`);
});

it.each([['LF', '\n'], ['CR', '\r'], ['NUL', '\0']])('retains exclusions and records for an unrepresentable %s path', async (_name, character) => {
  const { paths, manifest } = await seedOldSkills(worktree);
  const path = `${paths[0]}${character}`;
  const saved = JSON.parse(readFileSync(manifest, 'utf8'));
  const entry = saved.entries.find((entry: { path: string }) => entry.path === paths[0]);
  entry.path = path;
  if (character === '\0') entry.kind = 'future-kind'; // A saved unknown kind can hold a path the filesystem cannot represent.
  else {
    renameSync(join(worktree, paths[0]!), join(worktree, path));
    writeFileSync(join(worktree, path, 'SKILL.md'), 'user edit\n');
  }
  const records = JSON.stringify(saved);
  writeFileSync(manifest, records);
  const exclude = join(worktree, '.git/info/exclude');
  const exclusions = readFileSync(exclude, 'utf8');
  const repo = join(worktree, 'main');
  mkdirSync(repo);
  const note = vi.fn();
  await cleanupTaskWorktreeSkills(worktree, worktree, repo, note);
  expect(readFileSync(exclude, 'utf8')).toBe(exclusions);
  expect(readFileSync(manifest, 'utf8')).toBe(records);
  for (const path of paths) expect(existsSync(join(worktree, dirname(path), '.gitignore'))).toBe(true);
  expect(note).toHaveBeenCalledTimes(1);
  expect(note.mock.calls[0]![0]).toContain(`Could not exclude ${path} from git`);
});

it.each([false, true])('retains ignore files and records if exclusion fails (note write fails: %s)', async noteFails => {
  const { paths, manifest } = await seedOldSkills(worktree);
  const saved = readFileSync(manifest, 'utf8');
  writeFileSync(join(worktree, paths[0]!, 'SKILL.md'), 'user edit\n');
  const exclude = join(worktree, '.git/info/exclude');
  rmSync(exclude);
  mkdirSync(exclude);
  const repo = join(worktree, 'main');
  mkdirSync(repo);
  const note = vi.fn((_message: string) => { if (noteFails) throw new Error('run note write failed'); });
  await expect(cleanupTaskWorktreeSkills(worktree, worktree, repo, note)).resolves.toBeUndefined();
  expect(note).toHaveBeenCalledTimes(1);
  expect(note.mock.calls[0]![0]).toContain(worktree);
  expect(note.mock.calls[0]![0]).toContain(`Could not exclude ${paths[0]} from git`);
  for (const path of paths) expect(existsSync(join(worktree, dirname(path), '.gitignore'))).toBe(true);
  expect(readFileSync(manifest, 'utf8')).toBe(saved);
  expect(readFileSync(join(worktree, paths[0]!, 'SKILL.md'), 'utf8')).toBe('user edit\n');
});

it('keeps ignore files until skills are handled when an old manifest cleanup fails', async () => {
  const { paths, manifest } = await seedOldSkills(worktree);
  const saved = readFileSync(manifest, 'utf8');
  expect(JSON.parse(saved).entries[0].kind).toBe('ignore-file');
  let removed: string | undefined;
  const onError = vi.fn();
  await removeProvisionedSkills(worktree, { faults: (boundary, path) => {
    if (boundary === 'removed') { removed = path; throw new Error('filesystem interruption'); }
  }, onError });
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0]![0]).toEqual(new Error('filesystem interruption'));
  expect(removed).toBe(paths[0]);
  expect(existsSync(join(worktree, paths[0]!))).toBe(false);
  expect(existsSync(join(worktree, paths[1]!))).toBe(true);
  for (const path of paths) expect(existsSync(join(worktree, dirname(path), '.gitignore'))).toBe(true);
  expect(execFileSync('git', ['check-ignore', `${paths[1]}/SKILL.md`], { cwd: worktree, encoding: 'utf8' }).trim())
    .toBe(`${paths[1]}/SKILL.md`);
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
  expect(readFileSync(join(worktree, '.git/info/exclude'), 'utf8')).toContain(`/${paths[0]}\n`);
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
